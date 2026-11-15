import { diagnosticFailure, FailureCode, ParserDiagnostics, ParserState } from './parser-diagnostics';
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
function member(value: unknown, code: FailureCode, diagnostics?: ParserDiagnostics): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError(code, diagnostics);
  const keys = Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined);
  if (keys.length !== 1) throw protocolError(code, diagnostics);
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
    private readonly ids = new Set<string>(), private readonly usage: (input: number, output: number) => void = () => {},
    private readonly diagnostics?: ParserDiagnostics) {}

  /** Retains provider indexes and enforces sequential complete block lifecycles. */
  private block(index: unknown, kind?: StreamBlock['kind']): StreamBlock {
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= MAX_CONTENT_BLOCKS) throw protocolError('BLOCK_INDEX_INVALID', this.diagnostics);
    const existing = this.blocks.get(index as number);
    if (existing) {
      if (existing.stopped || (kind && existing.kind !== kind)) throw protocolError(existing.stopped ? 'BLOCK_ALREADY_CLOSED' : 'BLOCK_KIND_MISMATCH', this.diagnostics);
      return existing;
    }
    if (!kind || index !== this.blocks.size || [...this.blocks.values()].some(block => !block.stopped)) throw protocolError(
      !kind ? 'STOP_UNKNOWN_BLOCK' : index !== this.blocks.size ? 'BLOCK_INDEX_NONCONSECUTIVE' : 'BLOCK_START_WHILE_OPEN', this.diagnostics);
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
        jsonValue(input, 0, this.diagnostics);
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
    if (groupBytes(this.content(), this.diagnostics) > MAX_GROUP_BYTES) throw diagnosticFailure(new ChatError('MODEL_GROUP_LIMIT', 'The complete model response exceeds its supported group limit.', 502), 'GROUP_SIZE_OR_COUNT_LIMIT', this.diagnostics);
  }

  /** Consumes Converse events, including implicit text/reasoning starts and explicit client-tool starts. */
  public async accept(event: ConverseStreamOutput): Promise<void> {
    if (this.diagnostics) this.diagnostics.observe(event, () => this.diagnosticState());
    const key = member(event, 'EVENT_UNION_INVALID', this.diagnostics);
    if (['internalServerException', 'modelStreamErrorException', 'serviceUnavailableException', 'throttlingException', 'validationException'].includes(key)) {
      throw new ChatError('MODEL_SERVICE_ERROR', 'The model could not complete the response.');
    }
    if (event.messageStart) {
      if (this.started || event.messageStart.role !== 'assistant') throw protocolError(this.started ? 'MESSAGE_START_DUPLICATE' : 'MESSAGE_START_ROLE_INVALID', this.diagnostics);
      this.started = true; return;
    }
    if (event.metadata) {
      if (!this.stopReason || this.metadataSeen) throw protocolError(!this.stopReason ? 'METADATA_BEFORE_STOP' : 'METADATA_DUPLICATE', this.diagnostics);
      this.metadataSeen = true;
      const input = event.metadata.usage?.inputTokens;
      const output = event.metadata.usage?.outputTokens;
      if (![input, output].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) throw protocolError('USAGE_INVALID', this.diagnostics);
      this.inputTokens = input!; this.outputTokens = output!;
      this.usage(input!, output!);
      if (output! > this.maxTokens) throw diagnosticFailure(new ChatError('MODEL_OUTPUT_LIMIT', 'The model response exceeds its output limit.', 502), 'OUTPUT_TOKEN_LIMIT', this.diagnostics);
      return;
    }
    if (!this.started || this.stopReason) throw protocolError(!this.started ? 'EVENT_BEFORE_MESSAGE_START' : 'EVENT_AFTER_MESSAGE_STOP', this.diagnostics);
    if (event.contentBlockStart) {
      const start = event.contentBlockStart.start;
      if (member(start, 'START_UNION_INVALID', this.diagnostics) !== 'toolUse' || !start?.toolUse) throw protocolError('START_MEMBER_UNSUPPORTED', this.diagnostics);
      if (!this.allowTools) throw diagnosticFailure(new ChatError('TOOLS_DISABLED', 'The model requested a tool after tool execution was disabled.', 502), 'TOOLS_DISABLED_START', this.diagnostics);
      const tool = start.toolUse;
      if (Object.keys(tool).some(key => !['toolUseId', 'name', 'type'].includes(key))) throw protocolError('TOOL_FIELDS_UNEXPECTED', this.diagnostics);
      if (typeof tool.toolUseId !== 'string' || typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.toolUseId)
        || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || this.ids.has(tool.toolUseId)
        || tool.type !== undefined) throw protocolError(
          tool.type !== undefined ? 'TOOL_TYPE_UNSUPPORTED' : typeof tool.toolUseId === 'string' && this.ids.has(tool.toolUseId) ? 'TOOL_IDENTITY_DUPLICATE' : 'TOOL_IDENTITY_INVALID', this.diagnostics);
      if (this.blocks.has(event.contentBlockStart.contentBlockIndex!)) throw protocolError('TOOL_START_DUPLICATE', this.diagnostics);
      const block = this.block(event.contentBlockStart.contentBlockIndex, 'tool_use');
      block.id = tool.toolUseId; block.name = tool.name; this.ids.add(tool.toolUseId);
    } else if (event.contentBlockDelta) {
      const delta = event.contentBlockDelta.delta;
      const field = member(delta, 'DELTA_UNION_INVALID', this.diagnostics);
      const kind = field === 'text' ? 'text' : field === 'reasoningContent' ? 'thinking' : field === 'toolUse' ? 'tool_use' : undefined;
      if (!kind || (kind === 'tool_use' && !this.blocks.has(event.contentBlockDelta.contentBlockIndex!))) throw protocolError(
        !kind ? 'DELTA_MEMBER_UNSUPPORTED' : 'TOOL_DELTA_BEFORE_START', this.diagnostics);
      const block = this.block(event.contentBlockDelta.contentBlockIndex, kind);
      if (field === 'text') {
        if (typeof delta?.text !== 'string') throw protocolError('TEXT_DELTA_TYPE_INVALID', this.diagnostics);
        this.textBytes += Buffer.byteLength(delta.text, 'utf8');
        if (this.textBytes > this.maxTextBytes) throw diagnosticFailure(new ChatError('MODEL_OUTPUT_LIMIT', 'The model response exceeds its output limit.', 502), 'OUTPUT_TEXT_LIMIT', this.diagnostics);
        block.text += delta.text; this.chunks.push(delta.text);
        if (!this.allowTools && delta.text) await this.emitText(delta.text);
      } else if (field === 'toolUse') {
        if (member(delta?.toolUse, 'TOOL_DELTA_UNION_INVALID', this.diagnostics) !== 'input' || typeof delta?.toolUse?.input !== 'string') throw protocolError('TOOL_DELTA_INPUT_INVALID', this.diagnostics);
        block.raw += delta.toolUse.input;
        if (Buffer.byteLength(block.raw, 'utf8') > MAX_TOOL_INPUT_BYTES) throw diagnosticFailure(new ChatError('MODEL_TOOL_INPUT_LIMIT', 'The model tool request exceeds its input limit.', 502), 'RAW_INPUT_LIMIT', this.diagnostics);
      } else {
        if (this.purpose === 'summary') throw protocolError('REASONING_IN_SUMMARY', this.diagnostics);
        const reasoning = delta?.reasoningContent;
        const part = member(reasoning, 'REASONING_UNION_INVALID', this.diagnostics);
        if (!['text', 'signature', 'redactedContent'].includes(part)) throw protocolError('REASONING_MEMBER_UNSUPPORTED', this.diagnostics);
        const mode = part === 'redactedContent' ? 'redacted' : 'text';
        if (block.thinkingMode && block.thinkingMode !== mode) throw protocolError('REASONING_MODE_MIXED', this.diagnostics);
        block.thinkingMode = mode;
        if (part === 'redactedContent') {
          if (!(reasoning?.redactedContent instanceof Uint8Array) || reasoning.redactedContent.byteLength > MAX_GROUP_BYTES) throw protocolError('REDACTED_BYTES_INVALID', this.diagnostics);
          block.redacted = new Uint8Array(Buffer.concat([block.redacted ?? new Uint8Array(), reasoning.redactedContent]));
        } else if (part === 'text') {
          if (typeof reasoning?.text !== 'string') throw protocolError('REASONING_TEXT_TYPE_INVALID', this.diagnostics);
          block.text += reasoning.text;
        } else {
          if (typeof reasoning?.signature !== 'string') throw protocolError('SIGNATURE_TYPE_INVALID', this.diagnostics);
          block.signature += reasoning.signature;
        }
        if (!this.thinkingEmitted) { this.thinkingEmitted = true; await this.emitThinking(); }
      }
    } else if (event.contentBlockStop) {
      const block = this.block(event.contentBlockStop.contentBlockIndex);
      if (block.kind === 'tool_use') {
        if (block.name === 'describe_documents' && block.raw === '') block.input = {};
        else {
          try { block.input = parseModelInput(block.raw); }
          catch (error) { throw diagnosticFailure(error, 'TOOL_INPUT_PARSE_REJECTED', this.diagnostics); }
        }
        jsonValue(block.input, 0, this.diagnostics);
        try {
          if (jsonBytes(encodeModelInput(block.input)) > MAX_TOOL_INPUT_BYTES) throw new ChatError('MODEL_TOOL_INPUT_LIMIT', 'The model tool request exceeds its input limit.', 502);
        } catch (error) { throw diagnosticFailure(error, 'ENCODED_INPUT_REJECTED', this.diagnostics); }
      }
      if (block.kind === 'thinking' && block.thinkingMode === 'text' && !block.signature) throw protocolError('SIGNATURE_MISSING_AT_STOP', this.diagnostics);
      block.stopped = true;
    } else if (event.messageStop) {
      if ([...this.blocks.values()].some(block => !block.stopped) || typeof event.messageStop.stopReason !== 'string') throw protocolError(
        [...this.blocks.values()].some(block => !block.stopped) ? 'MESSAGE_STOP_WITH_OPEN_BLOCKS' : 'MESSAGE_STOP_REASON_TYPE_INVALID', this.diagnostics);
      this.stopReason = event.messageStop.stopReason;
    } else throw protocolError('EVENT_MEMBER_UNSUPPORTED', this.diagnostics);
    this.bound();
  }

  /** Supplies a content-free state snapshot only to the invocation-local dev observer. */
  public diagnosticState(): ParserState {
    const blocks = [...this.blocks.values()];
    const index = this.diagnostics?.blockIndex;
    const current = typeof index === 'number' ? this.blocks.get(index) : blocks.at(-1);
    const input = current?.input;
    const inputType = typeof input;
    return { expectedNextIndex: this.blocks.size, blockCount: this.blocks.size,
      toolBlockCount: blocks.filter(block => block.kind === 'tool_use').length, openBlockCount: blocks.filter(block => !block.stopped).length,
      messageStarted: this.started, messageStopped: Boolean(this.stopReason), metadataSeen: this.metadataSeen, thinkingActivityEmitted: this.thinkingEmitted,
      blockKind: current?.kind ?? 'missing', blockOpen: Boolean(current && !current.stopped), blockStopped: current?.stopped === true,
      signaturePresent: Boolean(current?.signature), textBytes: this.textBytes,
      inputBytes: blocks.reduce((size, block) => size + Buffer.byteLength(block.raw, 'utf8'), 0),
      signatureBytes: blocks.reduce((size, block) => size + Buffer.byteLength(block.signature, 'utf8'), 0),
      redactedBytes: blocks.reduce((size, block) => size + (block.redacted?.byteLength ?? 0), 0),
      inputKind: input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input === 'object' ? 'object'
        : inputType === 'string' || inputType === 'number' || inputType === 'boolean' ? inputType : 'unknown',
      stopReason: this.stopReason };
  }

  /** Returns a complete, independently copied response or fails without exposing partial private blocks. */
  public async finish(): Promise<ModelResponse> {
    if (!this.started || !this.stopReason || !this.metadataSeen || [...this.blocks.values()].some(block => !block.stopped)) throw protocolError(
      !this.started ? 'STREAM_END_WITHOUT_START' : !this.stopReason ? 'STREAM_END_WITHOUT_STOP'
        : !this.metadataSeen ? 'STREAM_END_WITHOUT_METADATA' : 'STREAM_END_WITH_OPEN_BLOCKS', this.diagnostics);
    const blocks = this.content();
    validateBlocks(blocks, this.stopReason, this.purpose, this.diagnostics);
    const text = this.chunks.join('');
    const toolUses = blocks.flatMap(block => block.type === 'tool_use' ? [{ id: block.id, name: block.name, index: block.index, input: block.input }] : []);
    if (!toolUses.length && !text.trim()) throw diagnosticFailure(new ChatError('MODEL_EMPTY_RESPONSE', 'The model returned no answer.'), 'PUBLIC_ANSWER_EMPTY', this.diagnostics);
    if (this.allowTools && !toolUses.length) for (const chunk of this.chunks) if (chunk) await this.emitText(chunk);
    return { responseId: randomUUID(), modelId: this.modelId, purpose: this.purpose, blocks,
      text, toolUses, stopReason: this.stopReason, inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }
}
