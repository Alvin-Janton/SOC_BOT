import type { ContentBlock, ConverseStreamCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { ChatError, MAX_CONTEXT_BYTES } from './config';
import { jsonBytes, jsonValue, protocolError } from './private-json';
import { encodeModelInput, MAX_TOOL_INPUT_BYTES } from './model-input';
export { jsonBytes, jsonValue, protocolError } from './private-json';
export { MAX_TOOL_INPUT_BYTES } from './model-input';
import type { JsonValue } from './store';

export const MAX_GROUP_BYTES = 65_536;
export const MAX_CONTENT_BLOCKS = 64;
export type ResponsePurpose = 'investigation' | 'finalization' | 'summary';
export type Thinking = { type: 'text'; text: string; signature: string } | { type: 'redacted'; data: string };
export type AssistantBlock = { index: number; type: 'text'; text: string }
  | { index: number; type: 'thinking'; thinking: Thinking }
  | { index: number; type: 'tool_use'; id: string; name: string; input: JsonValue };
export interface ModelToolUse { readonly id: string; readonly name: string; readonly index: number; readonly input: JsonValue }
export interface ModelResponse {
  readonly responseId: string; readonly modelId: string; readonly purpose: ResponsePurpose;
  readonly blocks: readonly AssistantBlock[]; readonly text: string; readonly toolUses: readonly ModelToolUse[];
  readonly stopReason: string; readonly inputTokens: number; readonly outputTokens: number;
}

/** Rejects noncanonical encodings while preserving opaque bytes, including empty binary content. */
export function redactedBytes(data: unknown): Uint8Array {
  if (typeof data !== 'string' || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    || Buffer.from(data, 'base64').toString('base64') !== data) throw protocolError();
  return new Uint8Array(Buffer.from(data, 'base64'));
}

/** Validates the complete ordered group once; indexes remain the provider's original ordinals. */
export function validateBlocks(blocks: readonly AssistantBlock[], stopReason: string, purpose: ResponsePurpose): void {
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > MAX_CONTENT_BLOCKS || groupBytes(blocks) > MAX_GROUP_BYTES) {
    throw new ChatError('MODEL_GROUP_LIMIT', 'The complete model response exceeds its supported group limit.', 502);
  }
  const ids = new Set<string>();
  for (const [index, block] of blocks.entries()) {
    if (block.index !== index) throw protocolError();
    jsonValue(block as unknown);
    if (block.type === 'text') {
      if (Object.keys(block).length !== 3 || typeof block.text !== 'string') throw protocolError();
    } else if (block.type === 'thinking') {
      if (purpose === 'summary' || Object.keys(block).length !== 3 || !block.thinking || typeof block.thinking !== 'object') throw protocolError();
      const thinking = block.thinking;
      if (thinking.type === 'text') {
        if (Object.keys(thinking).length !== 3 || typeof thinking.text !== 'string'
          || typeof thinking.signature !== 'string' || !thinking.signature) throw protocolError();
      } else if (thinking.type === 'redacted') {
        if (Object.keys(thinking).length !== 2) throw protocolError();
        redactedBytes(thinking.data);
      } else throw protocolError();
    } else if (block.type === 'tool_use') {
      if (purpose !== 'investigation' || Object.keys(block).length !== 5
        || typeof block.id !== 'string' || typeof block.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(block.id) || !/^[A-Za-z0-9_-]{1,64}$/.test(block.name)
        || ids.has(block.id) || jsonBytes(encodeModelInput(block.input)) > MAX_TOOL_INPUT_BYTES) throw protocolError();
      ids.add(block.id);
    } else throw protocolError();
  }
  if ((ids.size > 0) !== (stopReason === 'tool_use') || !['tool_use', 'end_turn', 'stop_sequence', 'max_tokens'].includes(stopReason)) throw protocolError();
}

/** Restores exact native blocks; every JSON input and byte array is copied before SDK ownership. */
export function nativeBlocks(blocks: readonly AssistantBlock[]): ContentBlock[] {
  return blocks.map(block => block.type === 'text' ? { text: block.text } : block.type === 'tool_use'
    ? { toolUse: { toolUseId: block.id, name: block.name, input: JSON.parse(JSON.stringify(block.input)) } }
    : { reasoningContent: block.thinking.type === 'text'
      ? { reasoningText: { text: block.thinking.text, signature: block.thinking.signature } }
      : { redactedContent: redactedBytes(block.thinking.data) } });
}

/** Checks the whole dispatch payload, including instructions/tools, escaping and binary expansion. */
export function requestBytes(input: ConverseStreamCommandInput): number { return jsonBytes(input); }

/** Fails closed before SDK dispatch rather than pruning signed blocks or evidence to fit. */
export function boundRequest(input: ConverseStreamCommandInput): void {
  if (requestBytes(input) > MAX_CONTEXT_BYTES) throw new ChatError('CONTEXT_LIMIT', 'The bounded model request requires safe compaction.', 413, false);
}

/** Returns the existing persisted output ceiling for the known read-only tool family. */
export function toolOutputBytes(name: string): number {
  return ['describe_documents', 'describe_document', 'retrieve_sections'].includes(name) ? 32_768 : 65_536;
}

/** Measures the actual encoded content payloads; per-record group/envelope metadata has its separate item bound. */
export function groupBytes(blocks: readonly AssistantBlock[]): number {
  return jsonBytes(blocks.map(block => block.type === 'text'
    ? { content_block_index: block.index, entity_type: 'ASSISTANT_TEXT', text: block.text }
    : block.type === 'thinking' ? { content_block_index: block.index, entity_type: 'THINKING', thinking: block.thinking }
      : { content_block_index: block.index, entity_type: 'TOOL_CALL', tool_use_id: block.id, tool_name: block.name, model_input: encodeModelInput(block.input) }));
}
