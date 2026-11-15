import { randomUUID } from 'node:crypto';
import type { ChatError, Configuration } from './config';
import type { ResponsePurpose } from './response';

export type FailureStage = 'request_validation' | 'stream_accept' | 'response_validation';
export type FailureCode =
  | 'UNCLASSIFIED_PROTOCOL_ERROR' | 'REQUEST_NATIVE_BLOCKS_NOT_ALLOWED' | 'REQUEST_SIZE_LIMIT' | 'MISSING_RESPONSE_STREAM'
  | 'EVENT_UNION_INVALID' | 'EVENT_MEMBER_UNSUPPORTED' | 'START_UNION_INVALID' | 'START_MEMBER_UNSUPPORTED'
  | 'DELTA_UNION_INVALID' | 'DELTA_MEMBER_UNSUPPORTED' | 'TOOL_DELTA_UNION_INVALID' | 'TOOL_DELTA_INPUT_INVALID'
  | 'REASONING_UNION_INVALID' | 'REASONING_MEMBER_UNSUPPORTED'
  | 'MESSAGE_START_DUPLICATE' | 'MESSAGE_START_ROLE_INVALID' | 'EVENT_BEFORE_MESSAGE_START' | 'EVENT_AFTER_MESSAGE_STOP' | 'METADATA_BEFORE_STOP' | 'METADATA_DUPLICATE' | 'USAGE_INVALID'
  | 'BLOCK_INDEX_INVALID' | 'BLOCK_ALREADY_CLOSED' | 'BLOCK_KIND_MISMATCH' | 'STOP_UNKNOWN_BLOCK' | 'BLOCK_INDEX_NONCONSECUTIVE' | 'BLOCK_START_WHILE_OPEN'
  | 'TOOL_START_DUPLICATE' | 'TOOL_DELTA_BEFORE_START' | 'TOOL_FIELDS_UNEXPECTED' | 'TOOL_IDENTITY_INVALID'
  | 'TOOL_IDENTITY_DUPLICATE' | 'TOOL_TYPE_UNSUPPORTED' | 'TOOLS_DISABLED_START'
  | 'REASONING_IN_SUMMARY' | 'REASONING_MODE_MIXED' | 'REDACTED_BYTES_INVALID' | 'REASONING_TEXT_TYPE_INVALID'
  | 'SIGNATURE_TYPE_INVALID' | 'SIGNATURE_MISSING_AT_STOP' | 'TEXT_DELTA_TYPE_INVALID'
  | 'MESSAGE_STOP_WITH_OPEN_BLOCKS' | 'MESSAGE_STOP_REASON_TYPE_INVALID' | 'STREAM_END_WITHOUT_START' | 'STREAM_END_WITHOUT_STOP' | 'STREAM_END_WITHOUT_METADATA' | 'STREAM_END_WITH_OPEN_BLOCKS' | 'PUBLIC_ANSWER_EMPTY'
  | 'OUTPUT_TOKEN_LIMIT' | 'OUTPUT_TEXT_LIMIT' | 'RAW_INPUT_LIMIT' | 'TOOL_INPUT_PARSE_REJECTED' | 'ENCODED_INPUT_REJECTED'
  | 'GROUP_SIZE_OR_COUNT_LIMIT' | 'BLOCK_ORDER_INVALID' | 'TEXT_BLOCK_INVALID' | 'THINKING_BLOCK_INVALID'
  | 'SIGNED_THINKING_INVALID' | 'REDACTED_BLOCK_INVALID' | 'THINKING_VARIANT_INVALID' | 'TOOL_BLOCK_INVALID'
  | 'BLOCK_VARIANT_INVALID' | 'STOP_TOOL_RELATIONSHIP_INVALID' | 'BASE64_INVALID'
  | 'JSON_DEPTH_INVALID' | 'JSON_STRING_INVALID' | 'JSON_ARRAY_SHAPE_INVALID' | 'JSON_ARRAY_DESCRIPTOR_INVALID'
  | 'JSON_OBJECT_SYMBOLS_INVALID' | 'JSON_OBJECT_DESCRIPTOR_INVALID' | 'JSON_TYPE_INVALID';

const EVENTS = ['messageStart', 'contentBlockStart', 'contentBlockDelta', 'contentBlockStop', 'messageStop', 'metadata',
  'internalServerException', 'modelStreamErrorException', 'serviceUnavailableException', 'throttlingException', 'validationException'] as const;
const STARTS = ['toolUse', 'serverToolUse', 'image'] as const;
const DELTAS = ['text', 'toolUse', 'reasoningContent', 'toolResult', 'citation', 'image', 'video', 'audio', 'document', 'guardContent'] as const;
const REASONING = ['text', 'signature', 'redactedContent'] as const;
const STOP_REASONS = ['tool_use', 'end_turn', 'stop_sequence', 'max_tokens', 'guardrail_intervened', 'content_filtered',
  'malformed_model_output', 'model_context_window_exceeded'] as const;
const PUBLIC_CODES = ['MODEL_PROTOCOL_ERROR', 'MODEL_GROUP_LIMIT', 'MODEL_TOOL_INPUT_LIMIT', 'MODEL_TOOL_INPUT_INVALID',
  'MODEL_OUTPUT_LIMIT', 'MODEL_EMPTY_RESPONSE', 'CONTEXT_LIMIT', 'TOOLS_DISABLED'] as const;
type Index = number | 'missing' | 'invalid';
type Kind = 'text' | 'thinking' | 'tool_use' | 'missing' | 'unknown';
type InputKind = 'object' | 'array' | 'null' | 'string' | 'number' | 'boolean' | 'unknown';
type ToolTypeCategory = 'missing' | 'null' | 'tool_use' | 'client_tool_use' | 'server_tool_use' | 'other_string' | 'non_string';
export interface ParserState {
  expectedNextIndex: number; blockCount: number; toolBlockCount: number; openBlockCount: number;
  messageStarted: boolean; messageStopped: boolean; metadataSeen: boolean; thinkingActivityEmitted: boolean;
  blockKind: Kind; blockOpen: boolean; blockStopped: boolean; signaturePresent: boolean;
  textBytes: number; inputBytes: number; signatureBytes: number; redactedBytes: number; inputKind: InputKind; stopReason: string;
}
interface UnionSummary { member: string; knownMembers: string[]; unknownMemberCount: number }
interface EventSummary {
  ordinal: number; event: UnionSummary; start: UnionSummary; delta: UnionSummary; reasoning: UnionSummary; toolDelta: UnionSummary;
  blockIndex: Index; toolType: ToolTypeCategory; messageStarted: boolean; messageStopped: boolean; metadataSeen: boolean; blockOpen: boolean; blockStopped: boolean;
  blockCount: number; openBlockCount: number;
}

/** Reads structural own data only; diagnostic collection never invokes provider accessors. */
function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

/** Classifies only the SDK start's type metadata; recognized labels do not grant parser acceptance. */
function toolTypeCategory(value: unknown): ToolTypeCategory {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value !== 'string') return 'non_string';
  switch (value) {
    case 'tool_use': return 'tool_use';
    case 'client_tool_use': return 'client_tool_use';
    case 'server_tool_use': return 'server_tool_use';
    default: return 'other_string';
  }
}

/** Returns fixed member labels/counts, never an unexpected property name or payload value. */
function union(value: unknown, allowed: readonly string[]): UnionSummary {
  if (value === undefined) return { member: 'missing', knownMembers: [], unknownMemberCount: 0 };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { member: 'invalid', knownMembers: [], unknownMemberCount: 0 };
  const knownMembers = allowed.filter(key => field(value, key) !== undefined);
  let unknownMemberCount = 0;
  for (const key of Object.keys(value)) if (!allowed.includes(key) && field(value, key) !== undefined) unknownMemberCount = Math.min(64, unknownMemberCount + 1);
  const count = knownMembers.length + unknownMemberCount;
  return { member: count === 0 ? 'missing' : count > 1 ? 'mixed' : knownMembers[0] ?? 'unknown', knownMembers: [...knownMembers], unknownMemberCount };
}

/** Restricts counters to bounded finite integers without serializing their source. */
function count(value: number): number { return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0; }

/** Owns temporary dev-only metadata for one invocation; no raw event/error/provider object is archived. */
export class ParserDiagnostics {
  private readonly id = randomUUID();
  private readonly failures = new WeakMap<object, FailureCode>();
  private recent: EventSummary[] = [];
  private ordinal = 0;
  private omitted = 0;
  private emitted = false;
  private toolType: ToolTypeCategory = 'missing';
  public blockIndex: Index = 'missing';
  public constructor(private readonly environment: 'dev', private readonly purpose: ResponsePurpose, private readonly allowTools: boolean) {}

  /** Associates only a fixed label with the original error identity; the error itself remains untouched. */
  public mark<T>(error: T, code: FailureCode): T {
    try { if (this.environment === 'dev' && error && typeof error === 'object' && !this.failures.has(error)) this.failures.set(error, code); } catch { /* Best effort only. */ }
    return error;
  }

  /** Records at most sixteen safe summaries before the original parser guard sees the current event. */
  public observe(event: unknown, snapshot: () => ParserState): void {
    if (this.environment !== 'dev') return;
    try {
      this.ordinal = count(this.ordinal + 1);
      const start = field(event, 'contentBlockStart'); const delta = field(event, 'contentBlockDelta'); const stop = field(event, 'contentBlockStop');
      this.toolType = toolTypeCategory(field(field(field(start, 'start'), 'toolUse'), 'type'));
      const index = field(start ?? delta ?? stop, 'contentBlockIndex');
      this.blockIndex = index === undefined ? 'missing' : typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 64 ? index : 'invalid';
      const state = snapshot();
      this.recent.push({ ordinal: this.ordinal, event: union(event, EVENTS), start: union(field(start, 'start'), STARTS),
        delta: union(field(delta, 'delta'), DELTAS), reasoning: union(field(field(delta, 'delta'), 'reasoningContent'), REASONING),
        toolDelta: union(field(field(delta, 'delta'), 'toolUse'), ['input']), blockIndex: this.blockIndex, toolType: this.toolType,
        messageStarted: state.messageStarted === true, messageStopped: state.messageStopped === true, metadataSeen: state.metadataSeen === true,
        blockOpen: state.blockOpen === true, blockStopped: state.blockStopped === true,
        blockCount: count(state.blockCount), openBlockCount: count(state.openBlockCount) });
      if (this.recent.length > 16) { this.recent.shift(); this.omitted = count(this.omitted + 1); }
    } catch { /* A collector failure cannot change parser acceptance. */ }
  }

  /** Emits once for a classified parser/limit failure; service, timeout, cancellation and callback errors are excluded. */
  public emit(error: ChatError, stage: FailureStage, current?: ParserState): void {
    if (this.environment !== 'dev' || this.emitted) return;
    try {
      const reason = this.failures.get(error);
      if (!PUBLIC_CODES.some(code => code === error.code) || (!reason && error.code !== 'MODEL_PROTOCOL_ERROR')) return;
      this.emitted = true;
      const state = current ? {
        expectedNextIndex: count(current.expectedNextIndex), blockCount: count(current.blockCount), toolBlockCount: count(current.toolBlockCount), openBlockCount: count(current.openBlockCount),
        messageStarted: current.messageStarted === true, messageStopped: current.messageStopped === true, metadataSeen: current.metadataSeen === true,
        thinkingActivityEmitted: current.thinkingActivityEmitted === true,
        blockKind: ['text', 'thinking', 'tool_use', 'missing'].includes(current.blockKind) ? current.blockKind : 'unknown',
        blockOpen: current.blockOpen === true, blockStopped: current.blockStopped === true, signaturePresent: current.signaturePresent === true,
        textBytes: count(current.textBytes), inputBytes: count(current.inputBytes), signatureBytes: count(current.signatureBytes), redactedBytes: count(current.redactedBytes),
        inputKind: ['object', 'array', 'null', 'string', 'number', 'boolean'].includes(current.inputKind) ? current.inputKind : 'unknown',
        stopReason: !current.stopReason ? 'missing' : STOP_REASONS.some(value => value === current.stopReason) ? current.stopReason : 'unknown',
      } : null;
      const record = { event: 'dev_model_parser_diagnostic', diagnosticId: this.id, purpose: this.purpose, allowTools: this.allowTools,
        failureCode: reason ?? 'UNCLASSIFIED_PROTOCOL_ERROR', failureStage: stage, originalCode: error.code,
        eventOrdinal: this.ordinal, blockIndex: this.blockIndex, toolType: this.toolType, current: state, omittedSummaries: this.omitted, recentEvents: [...this.recent] };
      let encoded = JSON.stringify(record);
      while (Buffer.byteLength(encoded, 'utf8') > 8_192 && record.recentEvents.length) {
        record.recentEvents.shift(); record.omittedSummaries = count(record.omittedSummaries + 1); encoded = JSON.stringify(record);
      }
      if (Buffer.byteLength(encoded, 'utf8') <= 8_192) console.info(encoded);
    } catch { /* Never mask, replace or retry the original failure if formatting/output fails. */ }
  }
}

/** Allocates no diagnostic UUID/buffer in demo; initialization failure also leaves ordinary work unchanged. */
export function createParserDiagnostics(environment: Configuration['environment'], purpose: ResponsePurpose, allowTools: boolean): ParserDiagnostics | undefined {
  if (environment !== 'dev') return undefined;
  try { return new ParserDiagnostics(environment, purpose, allowTools); } catch { return undefined; }
}

/** Preserves the thrown value while optionally retaining one fixed, private invocation-local classification. */
export function diagnosticFailure<T>(error: T, code: FailureCode, diagnostics?: ParserDiagnostics): T {
  return diagnostics ? diagnostics.mark(error, code) : error;
}
