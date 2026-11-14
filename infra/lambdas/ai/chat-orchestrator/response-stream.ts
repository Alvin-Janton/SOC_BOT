import { encodeModelInput, parseModelInput } from './model-input';
import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';
import { ChatError } from './config';
import { AssistantBlock, groupBytes, jsonBytes, jsonValue, MAX_CONTENT_BLOCKS, MAX_GROUP_BYTES, MAX_TOOL_INPUT_BYTES,
  ModelResponse, protocolError, ResponsePurpose, Thinking, validateBlocks } from './response';

interface StreamBlock { index: number; stopped: boolean; kind: 'text' | 'thinking' | 'tool_use';
  text: string; signature: string; redacted?: Uint8Array; thinkingMode?: 'text' | 'redacted';
  id?: string; name?: string; raw: string; input?: unknown }

/** Recognizes one actual SDK union member, rejecting mixed/unknown variants instead of guessing. */
function member(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError();
  const keys = Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined);
  if (keys.length !== 1) throw protocolError();
  return keys[0];
}

/** Assembles complete private blocks; public callbacks receive text/activity only, never provider reasoning. */
export class ResponseAssembler {
  private readonly blocks = new Map<number, StreamBlock>();
  private readonly chunks: string[] = [];
  private started = false;
  private metadataSeen = false;
  private thinkingEmitted = false;
  private stopReason = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private textBytes = 0;
  public constructor(private readonly modelId: string, private readonly purpose: ResponsePurpose,
    private readonly allowTools: boolean, private readonly maxTextBytes: number, private readonly maxTokens: number,
    private readonly emitText: (text: string) => Promise<void>, private readonly emitThinking: () => Promise<void>,
    private readonly ids = new Set<string>(), private readonly usage: (input: number, output: number) => void = () => {}) {}

  /** Retains provider indexes and enforces sequential complete block lifecycles. */
  private block(index: unknown, kind?: StreamBlock['kind']): StreamBlock {
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= MAX_CONTENT_BLOCKS) throw protocolError();
    const existing = this.blocks.get(index as number);
    if (existing) {
      if (existing.stopped || (kind && existing.kind !== kind)) throw protocolError();
      return existing;
    }
    if (!kind || index !== this.blocks.size || [...this.blocks.values()].some(block => !block.stopped)) throw protocolError();
    const block: StreamBlock = { index: index as number, stopped: false, kind, text: '', signature: '', raw: '' };
    this.blocks.set(block.index, block);
    return block;
  }

  /** Converts only the supported complete block forms; open tool buffers use a bounded temporary placeholder. */
  private content(): AssistantBlock[] {
    return [...this.blocks.values()].map(block => {
      if (block.kind === 'text') return { index: block.index, type: 'text', text: block.text };
      if (block.kind === 'tool_use') {
        const input = block.stopped ? block.input : null;
        jsonValue(input);
        return { index: block.index, type: 'tool_use', id: block.id!, name: block.name!, input };
      }
      const thinking: Thinking = block.thinkingMode === 'redacted'
        ? { type: 'redacted', data: Buffer.from(block.redacted ?? []).toString('base64') }
        : { type: 'text', text: block.text, signature: block.signature };
      return { index: block.index, type: 'thinking', thinking };
    });
  }

  /** Applies raw-buffer limits while parsing and the exact serialized aggregate limit as blocks accumulate. */
  private bound(): void {
    if (groupBytes(this.content()) > MAX_GROUP_BYTES) throw new ChatError('MODEL_GROUP_LIMIT', 'The complete model response exceeds its supported group limit.', 502);
  }

  /** Consumes Converse events, including implicit text/reasoning starts and explicit client-tool starts. */
  public async accept(event: ConverseStreamOutput): Promise<void> {
    const key = member(event);
    if (['internalServerException', 'modelStreamErrorException', 'serviceUnavailableException', 'throttlingException', 'validationException'].includes(key)) {
      throw new ChatError('MODEL_SERVICE_ERROR', 'The model could not complete the response.');
    }
    if (event.messageStart) {
      if (this.started || event.messageStart.role !== 'assistant') throw protocolError();
      this.started = true; return;
    }
    if (event.metadata) {
      if (!this.stopReason || this.metadataSeen) throw protocolError();
      this.metadataSeen = true;
      const input = event.metadata.usage?.inputTokens;
      const output = event.metadata.usage?.outputTokens;
      if (![input, output].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) throw protocolError();
      this.inputTokens = input!; this.outputTokens = output!;
      this.usage(input!, output!);
      if (output! > this.maxTokens) throw new ChatError('MODEL_OUTPUT_LIMIT', 'The model response exceeds its output limit.', 502);
      return;
    }
    if (!this.started || this.stopReason) throw protocolError();
    if (event.contentBlockStart) {
      const start = event.contentBlockStart.start;
      if (member(start) !== 'toolUse' || !start?.toolUse) throw protocolError();
      if (!this.allowTools) throw new ChatError('TOOLS_DISABLED', 'The model requested a tool after tool execution was disabled.', 502);
      const tool = start.toolUse;
      if (Object.keys(tool).some(key => !['toolUseId', 'name', 'type'].includes(key))) throw protocolError();
      if (typeof tool.toolUseId !== 'string' || typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.toolUseId)
        || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || this.ids.has(tool.toolUseId)
        || tool.type !== undefined) throw protocolError();
      if (this.blocks.has(event.contentBlockStart.contentBlockIndex!)) throw protocolError();
      const block = this.block(event.contentBlockStart.contentBlockIndex, 'tool_use');
      block.id = tool.toolUseId; block.name = tool.name; this.ids.add(tool.toolUseId);
    } else if (event.contentBlockDelta) {
      const delta = event.contentBlockDelta.delta;
      const field = member(delta);
      const kind = field === 'text' ? 'text' : field === 'reasoningContent' ? 'thinking' : field === 'toolUse' ? 'tool_use' : undefined;
      if (!kind || (kind === 'tool_use' && !this.blocks.has(event.contentBlockDelta.contentBlockIndex!))) throw protocolError();
      const block = this.block(event.contentBlockDelta.contentBlockIndex, kind);
      if (field === 'text') {
        if (typeof delta?.text !== 'string') throw protocolError();
        this.textBytes += Buffer.byteLength(delta.text, 'utf8');
        if (this.textBytes > this.maxTextBytes) throw new ChatError('MODEL_OUTPUT_LIMIT', 'The model response exceeds its output limit.', 502);
        block.text += delta.text; this.chunks.push(delta.text);
        if (!this.allowTools && delta.text) await this.emitText(delta.text);
      } else if (field === 'toolUse') {
        if (member(delta?.toolUse) !== 'input' || typeof delta?.toolUse?.input !== 'string') throw protocolError();
        block.raw += delta.toolUse.input;
        if (Buffer.byteLength(block.raw, 'utf8') > MAX_TOOL_INPUT_BYTES) throw new ChatError('MODEL_TOOL_INPUT_LIMIT', 'The model tool request exceeds its input limit.', 502);
      } else {
        if (this.purpose === 'summary') throw protocolError();
        const reasoning = delta?.reasoningContent;
        const part = member(reasoning);
        if (!['text', 'signature', 'redactedContent'].includes(part)) throw protocolError();
        const mode = part === 'redactedContent' ? 'redacted' : 'text';
        if (block.thinkingMode && block.thinkingMode !== mode) throw protocolError();
        block.thinkingMode = mode;
        if (part === 'redactedContent') {
          if (!(reasoning?.redactedContent instanceof Uint8Array) || reasoning.redactedContent.byteLength > MAX_GROUP_BYTES) throw protocolError();
          block.redacted = new Uint8Array(Buffer.concat([block.redacted ?? new Uint8Array(), reasoning.redactedContent]));
        } else if (part === 'text') {
          if (typeof reasoning?.text !== 'string') throw protocolError();
          block.text += reasoning.text;
        } else {
          if (typeof reasoning?.signature !== 'string') throw protocolError();
          block.signature += reasoning.signature;
        }
        if (!this.thinkingEmitted) { this.thinkingEmitted = true; await this.emitThinking(); }
      }
    } else if (event.contentBlockStop) {
      const block = this.block(event.contentBlockStop.contentBlockIndex);
      if (block.kind === 'tool_use') {
        if (block.name === 'describe_documents' && block.raw === '') block.input = {};
        else {
          block.input = parseModelInput(block.raw);
        }
        jsonValue(block.input);
        if (jsonBytes(encodeModelInput(block.input)) > MAX_TOOL_INPUT_BYTES) throw new ChatError('MODEL_TOOL_INPUT_LIMIT', 'The model tool request exceeds its input limit.', 502);
      }
      if (block.kind === 'thinking' && block.thinkingMode === 'text' && !block.signature) throw protocolError();
      block.stopped = true;
    } else if (event.messageStop) {
      if ([...this.blocks.values()].some(block => !block.stopped) || typeof event.messageStop.stopReason !== 'string') throw protocolError();
      this.stopReason = event.messageStop.stopReason;
    } else throw protocolError();
    this.bound();
  }

  /** Returns a complete, independently copied response or fails without exposing partial private blocks. */
  public async finish(): Promise<ModelResponse> {
    if (!this.started || !this.stopReason || !this.metadataSeen || [...this.blocks.values()].some(block => !block.stopped)) throw protocolError();
    const blocks = this.content();
    validateBlocks(blocks, this.stopReason, this.purpose);
    const text = this.chunks.join('');
    const toolUses = blocks.flatMap(block => block.type === 'tool_use' ? [{ id: block.id, name: block.name, index: block.index, input: block.input }] : []);
    if (!toolUses.length && !text.trim()) throw new ChatError('MODEL_EMPTY_RESPONSE', 'The model returned no answer.');
    if (this.allowTools && !toolUses.length) for (const chunk of this.chunks) if (chunk) await this.emitText(chunk);
    return { responseId: randomUUID(), modelId: this.modelId, purpose: this.purpose, blocks,
      text, toolUses, stopReason: this.stopReason, inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }
}
