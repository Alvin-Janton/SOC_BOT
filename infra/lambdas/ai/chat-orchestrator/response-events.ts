import { decodeModelInput, encodeModelInput, EncodedModelInput } from './model-input';
import { AssistantBlock, jsonBytes, MAX_TOOL_INPUT_BYTES, ModelResponse, protocolError, Thinking, validateBlocks } from './response';
import type { ChatEvent, JsonObject, JsonValue, ToolPreparation } from './store';

export interface GroupMetadata {
  response_format: 1; response_block_count: number; assistant_message_id: string; model_id: string;
  stop_reason: string; purpose: 'investigation' | 'finalization'; content_block_index: number;
}
export type GroupedPayload = GroupMetadata & (
  { entity_type: 'THINKING'; thinking: Thinking }
  | { entity_type: 'ASSISTANT_TEXT'; text: string }
  | { entity_type: 'TOOL_CALL'; tool_use_id: string; tool_name: string; model_input: EncodedModelInput; preparation: ToolPreparation });
type ToolCall = Extract<ChatEvent, { entity_type: 'TOOL_CALL' }>;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const GROUP_KEYS = ['response_format', 'response_block_count', 'assistant_message_id', 'model_id', 'stop_reason', 'purpose', 'content_block_index'];
const BASE_KEYS = ['PK', 'SK', 'schema_version', 'conversation_id', 'event_id', 'event_sequence', 'turn_id', 'attempt_id', 'created_at'];

/** Selects input by field presence: a rejected original JSON null is not a missing legacy argument. */
export function callInput(call: ToolCall): JsonValue {
  return Object.hasOwn(call, 'model_input') ? decodeModelInput((call as ToolCall & { model_input: EncodedModelInput }).model_input) : (call as { arguments: JsonObject }).arguments;
}

/** Gives evidence/reference consumers only safe object arguments; raw rejected input remains private. */
export function safeArguments(call: ToolCall): JsonObject {
  if (call.preparation?.status === 'rejected') return {};
  const input = callInput(call);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw protocolError();
  return JSON.parse(JSON.stringify(input)) as JsonObject;
}

/** Validates exact new payload fields and metadata before converting its original content block. */
export function groupedBlock(value: GroupedPayload): AssistantBlock {
  if (value.response_format !== 1 || typeof value.assistant_message_id !== 'string' || !UUID.test(value.assistant_message_id)
    || typeof value.model_id !== 'string' || !value.model_id || value.model_id.length > 256
    || !['investigation', 'finalization'].includes(value.purpose)
    || !Number.isInteger(value.response_block_count) || value.response_block_count < 1 || value.response_block_count > 64
    || !Number.isInteger(value.content_block_index) || value.content_block_index < 0 || value.content_block_index >= value.response_block_count
    || !['tool_use', 'end_turn', 'stop_sequence', 'max_tokens'].includes(value.stop_reason)) throw protocolError();
  const payloadKeys = value.entity_type === 'THINKING' ? ['thinking'] : value.entity_type === 'ASSISTANT_TEXT' ? ['text']
    : value.entity_type === 'TOOL_CALL' ? ['tool_use_id', 'tool_name', 'model_input', 'preparation'] : [];
  const allowed = new Set([...GROUP_KEYS, ...BASE_KEYS, 'entity_type', ...payloadKeys]);
  if (!payloadKeys.length || Object.keys(value).some(key => !allowed.has(key))
    || [...GROUP_KEYS, ...payloadKeys].some(key => !Object.hasOwn(value, key))) throw protocolError();
  let block: AssistantBlock;
  if (value.entity_type === 'THINKING') block = { index: value.content_block_index, type: 'thinking', thinking: value.thinking };
  else if (value.entity_type === 'ASSISTANT_TEXT') block = { index: value.content_block_index, type: 'text', text: value.text };
  else {
    const input = decodeModelInput(value.model_input);
    if (jsonBytes(value.model_input) > MAX_TOOL_INPUT_BYTES || !value.preparation
      || !['approved', 'rejected'].includes(value.preparation.status)
      || (value.preparation.status === 'approved' && (!input || typeof input !== 'object' || Array.isArray(input)))) throw protocolError();
    block = { index: value.content_block_index, type: 'tool_use', id: value.tool_use_id, name: value.tool_name, input };
  }
  // Validate this block's fields independently; complete-group ordering is checked after assembly.
  validateBlocks([{ ...block, index: 0 }], block.type === 'tool_use' ? 'tool_use' : 'end_turn', value.purpose);
  return block;
}

/** Produces one payload per original block, with no duplicate arguments object or partial snapshot record. */
export function responsePayloads(response: ModelResponse, decisions: ReadonlyMap<string, ToolPreparation>): GroupedPayload[] {
  if (response.purpose === 'summary' || !UUID.test(response.responseId)) throw protocolError();
  validateBlocks(response.blocks, response.stopReason, response.purpose);
  if (response.text !== response.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    || Buffer.byteLength(response.text, 'utf8') > 32_768
    || JSON.stringify(response.toolUses) !== JSON.stringify(response.blocks.flatMap(block => block.type === 'tool_use'
      ? [{ id: block.id, name: block.name, index: block.index, input: block.input }] : []))) throw protocolError();
  return response.blocks.map(block => {
    const common: GroupMetadata = { response_format: 1, response_block_count: response.blocks.length,
      assistant_message_id: response.responseId, model_id: response.modelId, stop_reason: response.stopReason,
      purpose: response.purpose as 'investigation' | 'finalization', content_block_index: block.index };
    const payload: GroupedPayload = block.type === 'text' ? { ...common, entity_type: 'ASSISTANT_TEXT', text: block.text }
      : block.type === 'thinking' ? { ...common, entity_type: 'THINKING', thinking: JSON.parse(JSON.stringify(block.thinking)) }
        : { ...common, entity_type: 'TOOL_CALL', tool_use_id: block.id, tool_name: block.name,
          model_input: encodeModelInput(block.input), preparation: JSON.parse(JSON.stringify(decisions.get(block.id)!)) };
    groupedBlock(payload);
    return payload;
  });
}

/** Proves complete, consecutive atomic groups and their final public answer linkage on every full audit read. */
export function validateResponseGroups(events: readonly ChatEvent[]): void {
  const groups = new Map<string, (ChatEvent & GroupedPayload)[]>();
  for (const event of events) {
    if (!Object.hasOwn(event, 'response_format')) continue;
    const grouped = event as ChatEvent & GroupedPayload;
    groupedBlock(grouped);
    const group = groups.get(grouped.assistant_message_id) ?? [];
    group.push(grouped); groups.set(grouped.assistant_message_id, group);
  }
  for (const [id, items] of groups) {
    items.sort((left, right) => left.content_block_index - right.content_block_index);
    const first = items[0];
    if (items.length !== first.response_block_count || items.some((event, index) => event.content_block_index !== index
      || event.event_sequence !== first.event_sequence + index || event.conversation_id !== first.conversation_id
      || event.turn_id !== first.turn_id || event.attempt_id !== first.attempt_id
      || GROUP_KEYS.filter(key => key !== 'content_block_index').some(key =>
        (event as unknown as Record<string, unknown>)[key] !== (first as unknown as Record<string, unknown>)[key]))) throw protocolError();
    const blocks = items.map(groupedBlock);
    validateBlocks(blocks, first.stop_reason, first.purpose);
    const answers = events.filter(event => event.entity_type === 'ASSISTANT_MESSAGE' && event.assistant_message_id === id);
    if (first.stop_reason === 'tool_use') { if (answers.length) throw protocolError(); continue; }
    const answer = answers[0];
    const text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    if (!text.trim() || answers.length !== 1 || answer.entity_type !== 'ASSISTANT_MESSAGE'
      || answer.turn_id !== first.turn_id || answer.attempt_id !== first.attempt_id || answer.model_id !== first.model_id
      || answer.stop_reason !== first.stop_reason || answer.content !== text
      || answer.event_sequence !== first.event_sequence + items.length) throw protocolError();
  }
  if (events.some(event => event.entity_type === 'ASSISTANT_MESSAGE' && event.assistant_message_id && !groups.has(event.assistant_message_id))) throw protocolError();
}
