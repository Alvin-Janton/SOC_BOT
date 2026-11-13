import { historyIdentifier } from './messages';
import { ApiError, record, request, responseError } from './http';

export interface ChatRequest { readonly turnId: string; readonly message: string; readonly conversationId?: string }
export interface Activity { readonly stage: string; readonly message: string; readonly details: readonly string[]; readonly error: boolean }
export type ChatEvent = { type: 'conversation'; conversationId: string; attemptId?: string } | { type: 'text'; text: string }
  | { type: 'activity'; activity: Activity } | { type: 'heartbeat' }
  | { type: 'complete'; conversationId: string; replayed: boolean; truncated: boolean };

const MAX_LINE_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const STAGES: Record<string, string> = {
  cancelling: 'Stopping the investigation', investigating: 'Investigating the available evidence', finalizing: 'Preparing the answer', summarizing: 'Summarizing earlier context',
  query_started: 'Query started', query_completed: 'Query completed', rag_started: 'Reading playbook metadata',
  rag_completed: 'Playbook request completed', tool_request_rejected: 'Tool request rejected', tool_error: 'Tool returned an error',
  tool_invocation_failed: 'Tool invocation could not be confirmed', tool_response_invalid: 'Tool response could not be verified',
  tool_not_executed: 'Queued tool was not executed',
};

/** Rejects malformed bounded strings without echoing their untrusted contents. */
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit) throw new ApiError('A stream field could not be verified.', 'INVALID_STREAM');
  return value;
}

/** Selects only public operation/identifier/count fields; SQL, reasoning and arbitrary objects are excluded. */
function activity(event: Record<string, unknown>): Activity {
  const stage = text(event.stage, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(stage)) throw new ApiError('A stream activity could not be verified.', 'INVALID_STREAM');
  const details: string[] = [];
  for (const key of ['operation', 'table', 'toolName', 'code', 'documentId', 'sectionId'] as const) {
    if (event[key] !== undefined) details.push(`${key}: ${text(event[key], 256)}`);
  }
  for (const key of ['rowsReturned', 'documentsReturned', 'sectionsReturned', 'requestedSections'] as const) {
    if (event[key] === undefined) continue;
    if (!Number.isSafeInteger(event[key]) || (event[key] as number) < 0) throw new ApiError('An activity count could not be verified.', 'INVALID_STREAM');
    details.push(`${key}: ${event[key]}`);
  }
  return { stage, message: event.message === undefined ? Object.hasOwn(STAGES, stage) ? STAGES[stage] : 'Processing' : text(event.message, 512), details,
    error: ['tool_request_rejected', 'tool_error', 'tool_invocation_failed', 'tool_response_invalid', 'tool_not_executed'].includes(stage) };
}

/** Reads one bounded NDJSON turn; EOF and transport/protocol failures never masquerade as completion. */
export async function streamChat(payload: ChatRequest, signal: AbortSignal, emit: (event: ChatEvent) => void): Promise<void> {
  const response = await request('/api/chat', { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(960_000)]),
    headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (response.status !== 200) throw await responseError(response, 'chat');
  if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-ndjson' || !response.body) {
    throw new ApiError('The server did not return a verifiable chat stream.', 'INVALID_STREAM');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffered = '';
  let conversationId = payload.conversationId;
  let answerBytes = 0;
  let attemptId: string | undefined;
  let conversationSeen = false;

  /** Validates one line, reconciling all identifiers against the immutable original request. */
  function line(value: string): boolean {
    if (!value.trim()) return false;
    if (encoder.encode(value).byteLength > MAX_LINE_BYTES) throw new ApiError('A chat line exceeded its size limit.', 'INVALID_STREAM');
    const event: unknown = JSON.parse(value);
    if (!record(event) || Object.keys(event).length > 32 || !Object.values(event).every(item => ['string', 'number', 'boolean'].includes(typeof item))) {
      throw new ApiError('A chat event could not be verified.', 'INVALID_STREAM');
    }
    const kind = text(event.type, 64);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(kind)) throw new ApiError('A chat event type could not be verified.', 'INVALID_STREAM');
    if (event.turnId !== undefined && event.turnId !== payload.turnId) throw new ApiError('The stream returned a different turn identifier.', 'INVALID_STREAM');
    if (event.conversationId !== undefined) {
      const id = text(event.conversationId, 128);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || (conversationId !== undefined && id !== conversationId)) {
        throw new ApiError('The stream returned a contradictory conversation identifier.', 'INVALID_STREAM');
      }
      conversationId = id;
    }
    if (['conversation', 'complete', 'error'].includes(kind) && event.turnId !== payload.turnId) throw new ApiError('The stream omitted its turn identifier.', 'INVALID_STREAM');
    if (kind === 'conversation') {
      if (event.conversationId === undefined || !conversationId) throw new ApiError('The stream omitted its conversation identifier.', 'INVALID_STREAM');
      if (event.attemptId !== undefined && !historyIdentifier(event.attemptId)) throw new ApiError('Invalid stream attempt identifier.', 'INVALID_STREAM');
      if (conversationSeen && event.attemptId !== attemptId) throw new ApiError('The stream changed its attempt identifier.', 'INVALID_STREAM');
      attemptId = event.attemptId as string | undefined; conversationSeen = true;
      emit({ type: 'conversation', conversationId, attemptId });
    } else if (kind === 'text_delta') {
      const delta = text(event.text, MAX_LINE_BYTES);
      answerBytes += encoder.encode(delta).byteLength;
      if (answerBytes > 32_768) throw new ApiError('The answer exceeded its supported size.', 'INVALID_STREAM');
      emit({ type: 'text', text: delta });
    } else if (kind === 'activity') emit({ type: 'activity', activity: activity(event) });
    else if (kind === 'heartbeat') emit({ type: 'heartbeat' });
    else if (kind === 'complete') {
      if (event.conversationId === undefined || !conversationId || typeof event.replayed !== 'boolean' || typeof event.truncated !== 'boolean') {
        throw new ApiError('The completion event could not be verified.', 'INVALID_STREAM');
      }
      emit({ type: 'complete', conversationId, replayed: event.replayed, truncated: event.truncated });
      return true;
    } else if (kind === 'error') {
      const code = text(event.code, 128);
      text(event.message, 1024);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(code) || typeof event.retryable !== 'boolean') throw new ApiError('The terminal error could not be verified.', 'INVALID_STREAM');
      const correlation = event.correlationId === undefined ? undefined : text(event.correlationId, 128);
      if (correlation !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(correlation)) throw new ApiError('The error identifier could not be verified.', 'INVALID_STREAM');
      if (code === 'TURN_CANCELLED' && event.retryable !== false) throw new ApiError('Contradictory cancellation result.', 'INVALID_STREAM');
      throw new ApiError(code === 'TURN_CANCELLED' ? 'The investigation was cancelled. Partial text is not a saved answer.' : 'The investigation ended with an application error. Review the turn status before continuing.', code, 200, event.retryable, false, correlation);
    }
    return false; // Unknown informational events cannot complete a turn.
  }

  try {
    while (true) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
        idle = setTimeout(() => reject(new ApiError('The stream stopped responding. Backend work may still finish.')), 60_000);
      })]).finally(() => clearTimeout(idle));
      buffered += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const current = buffered.slice(0, newline).replace(/\r$/, '');
        buffered = buffered.slice(newline + 1);
        if (line(current)) return;
      }
      if (encoder.encode(buffered).byteLength > MAX_LINE_BYTES) throw new ApiError('A chat line exceeded its size limit.', 'INVALID_STREAM');
      if (chunk.done) {
        if (buffered.trim() && line(buffered.replace(/\r$/, ''))) return;
        throw new ApiError('The stream ended without a complete or error event. This answer is incomplete.');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
