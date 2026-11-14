import { ChatError } from './config';
import { jsonBytes, jsonValue } from './private-json';
import type { JsonValue } from './store';

export const MAX_TOOL_INPUT_BYTES = 16_384;
export interface EncodedModelInput { encoding: 'json_text_v1'; json: string }

/** Never includes raw JSON tokens or provider text in a failure. */
function invalid(): ChatError { return new ChatError('MODEL_TOOL_INPUT_INVALID', 'The model tool input cannot be represented safely.', 502); }

/** Normalizes decimal spelling only, without first rounding it through a JavaScript Number. */
function decimal(value: string): string {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(value);
  if (!match) throw invalid();
  let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = BigInt(match[4] ?? '0') - BigInt((match[3] ?? '').length);
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  if (trailing) { digits = digits.slice(0, -trailing); exponent += BigInt(trailing); }
  return `${match[1]}${digits}e${exponent}`;
}

/** Parses only values whose numeric tokens survive ECMAScript JSON serialization without decimal-value loss.
 * Node.js 22 supplies each primitive's source token to the reviver. This is not arbitrary-precision numeric storage:
 * unsupported precision, negative zero, overflow and underflow fail before a group can be persisted or replayed.
 */
export function parseModelInput(raw: string): JsonValue {
  if (Buffer.byteLength(raw, 'utf8') > MAX_TOOL_INPUT_BYTES) throw invalid();
  try {
    const parse = JSON.parse as (text: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown;
    const parsed = parse(raw, (_key, value, context) => {
      if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)
        || typeof context?.source !== 'string' || decimal(context.source) !== decimal(String(value)))) throw invalid();
      return value;
    });
    jsonValue(parsed);
    return parsed;
  } catch { throw invalid(); }
}

/** Encodes accepted parsed JSON as text so DynamoDB never coerces or range-limits its numeric members. */
export function encodeModelInput(value: JsonValue): EncodedModelInput {
  jsonValue(value);
  const encoded: EncodedModelInput = { encoding: 'json_text_v1', json: JSON.stringify(value) };
  if (jsonBytes(encoded) > MAX_TOOL_INPUT_BYTES) throw new ChatError('MODEL_TOOL_INPUT_LIMIT', 'The encoded model tool request exceeds its input limit.', 502);
  return encoded;
}

/** Uses one explicit encoding version; malformed/unknown encodings never fall back to legacy arguments. */
export function decodeModelInput(value: unknown): JsonValue {
  jsonValue(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'encoding') || !Object.hasOwn(value, 'json')) throw invalid();
  const stored = value as Record<string, unknown>;
  if (stored.encoding !== 'json_text_v1' || typeof stored.json !== 'string' || jsonBytes(stored) > MAX_TOOL_INPUT_BYTES) throw invalid();
  const parsed = parseModelInput(stored.json);
  if (JSON.stringify(parsed) !== stored.json) throw invalid();
  return parsed;
}
