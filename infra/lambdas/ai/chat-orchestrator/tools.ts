import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_RESPONSE_BYTES, QUERY_DEADLINE_SECONDS } from '../../../lib/stacks/ai/query-contract';
import { ChatError, Configuration, TurnBudget } from './config';
import { isTerminalToolResult, selectToolResult } from './context';
import { LogicalQuery, validateTool } from './contracts';
import { ChatEvent, ConversationStore, JsonObject, Lease } from './store';
import { StreamEvent } from './stream';

const PENDING = ['SUBMITTED', 'QUEUED', 'RUNNING', 'UNKNOWN'];
const EXECUTION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
type ToolCall = Extract<ChatEvent, { entity_type: 'TOOL_CALL' }>;

/**
 * Recognizes bounded, confirmed query failures; unavailable executions are not terminal evidence.
 *
 * Example Input:
 * { ok: false, query_execution_id: '11111111-1111-4111-8111-111111111111', state: 'FAILED', error: { code: 'QUERY_FAILED' } }
 * Example Output: true
 * { ok: false, state: 'UNKNOWN', error: { code: 'NOT_FOUND' } } returns false.
 * This shape check does not fetch Athena state; callers must independently verify and persist that state.
 */
export function isConfirmedQueryFailure(output: JsonObject): boolean {
  const error = output.error;
  return output.ok === false && typeof output.query_execution_id === 'string' && EXECUTION_ID.test(output.query_execution_id)
    && error !== null && typeof error === 'object' && !Array.isArray(error)
    && ((output.state === 'FAILED' && error.code === 'QUERY_FAILED')
      || (output.state === 'CANCELLED' && error.code === 'QUERY_CANCELLED'));
}

/**
 * Accepts bounded JSON objects from the private tool, without exposing provider error text.
 *
 * Example Input: { ok: true, state: 'RUNNING' }
 * Example Output: { ok: true, state: 'RUNNING' } // same object
 * Input [] or a JSON string instead of a parsed object throws ChatError { code: 'TOOL_PROTOCOL_ERROR' }.
 * The enclosing invoke() handles payload size and required response fields separately.
 */
function responseObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChatError('TOOL_PROTOCOL_ERROR', 'The query tool returned an invalid response.');
  return value as JsonObject;
}

/**
 * Compares stored request maps without depending on DynamoDB attribute iteration order.
 *
 * Example Input: { z: 2, a: { y: 1, b: 0 }, rows: [2, 1] }
 * Example Output: '{"a":{"b":0,"y":1},"rows":[2,1],"z":2}'
 * Object keys are sorted recursively; array order is preserved and the input is not mutated.
 */
function canonicalJson(value: JsonObject): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry);
}

/**
 * Accepts only a canonical service timestamp proving completion inside the original execution budget.
 *
 * Example Input:
 * { output: { completed_at: '2026-10-10T12:02:00.000Z' }, submittedAt: Date.parse('2026-10-10T12:00:00.000Z') }
 * Example Output: true // completion is within the original 180-second budget
 * Completion at 12:04:00.000Z, before submission, or without canonical UTC milliseconds returns false.
 */
function completedInTime(output: JsonObject, submittedAt: number): boolean {
  const value = output.completed_at;

  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const completedAt = Date.parse(value);
  return Number.isFinite(completedAt) && new Date(completedAt).toISOString() === value
    && completedAt >= submittedAt && completedAt <= submittedAt + QUERY_DEADLINE_SECONDS * 1_000;
}

/** Coordinates private query operations and durably checkpoints submission before polling. */
export class ToolExecutor {
  private readonly client = new LambdaClient({ maxAttempts: 1 });

  private active?: { id: string; submittedAt: number; request: LogicalQuery; call: ToolCall;
    cancellationRequested?: boolean; cancellationConfirmed?: boolean; failure?: JsonObject };

  /**
   * Binds the private query function to the accepted attempt's budget, store, lease, and event emitter.
   *
   * Example Input (dependencies abbreviated):
   * new ToolExecutor({ queryFunction: 'SOC-BOT-DEV-QUERY-TOOL', ... }, TurnBudget <time remaining>,
   *   ConversationStore <authorized store>, Lease <current live lease>, async (event) => { ... })
   * Example Output (selected instance state, not a JSON response):
   * ToolExecutor { config: { queryFunction: 'SOC-BOT-DEV-QUERY-TOOL', ... },
   *   active: undefined, client: LambdaClient <maxAttempts: 1>, ... }
   * No query Lambda invocation is sent during construction.
   */
  public constructor(private readonly config: Configuration, private readonly budget: TurnBudget,
    private readonly store: ConversationStore, private readonly lease: Lease,
    private readonly emit: (event: StreamEvent) => Promise<void>) {}

  /**
   * Invokes only the configured function; submission is never retried blindly after an ambiguous timeout.
   *
   * Example Input:
   * { request: { operation: 'describe_table', table: 'waf_events' }, cleanup: false, timeoutMs: 20_000 }
   * Example Output (illustrative decoded response; full schema metadata omitted):
   * { ok: true, operation: 'describe_table', table: 'waf_events',
   *   columns: [{ name: 'event_uid', type: 'string', description: '<catalog comment>', partition: false }, ...],
   *   result_count: 0, truncated: false, ... }
   * Malformed, oversized, or function-error responses throw ChatError rather than returning SDK diagnostics.
   */
  private async invoke(request: object, cleanup = false, timeoutMs = 20_000): Promise<JsonObject> {

    const result = await this.client.send(new InvokeCommand({
      FunctionName: this.config.queryFunction, InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(request)),
    }), { abortSignal: cleanup ? AbortSignal.timeout(5_000)
      : AbortSignal.any([this.budget.signal, AbortSignal.timeout(Math.max(1, timeoutMs))]) });

    if (result.FunctionError || !result.Payload || result.Payload.byteLength > MAX_RESPONSE_BYTES) {
      throw new ChatError('TOOL_PROTOCOL_ERROR', 'The query tool could not complete the operation.');
    }

    let response: JsonObject;

    try { response = responseObject(JSON.parse(Buffer.from(result.Payload).toString('utf8'))); }

    catch { throw new ChatError('TOOL_PROTOCOL_ERROR', 'The query tool returned an invalid response.'); }
    if (typeof response.ok !== 'boolean') throw new ChatError('TOOL_PROTOCOL_ERROR', 'The query tool returned an invalid response.');

    return response;
  }

  /**
   * Appends one terminal result using the existing tool-result variant and bounded output contract.
   *
   * Example Input (call abbreviated):
   * { call: { tool_use_id: 'tool-1', tool_name: 'query_events', ... },
   *   output: { ok: true, state: 'SUCCEEDED', result_count: 0, rows: [] }, status: 'success' }
   * Example Output: { ok: true, state: 'SUCCEEDED', result_count: 0, rows: [] } // original output
   * Side effect: appends a TOOL_RESULT with matching IDs/status/output and clears matching active tracking.
   * Return occurs only after persistence succeeds; a failed write still clears verified terminal tracking and throws.
   */
  private async terminal(call: ToolCall, output: JsonObject, status: 'success' | 'error' = 'success'): Promise<JsonObject> {
    try {
      await this.store.append(this.lease, { entity_type: 'TOOL_RESULT', tool_use_id: call.tool_use_id,
        tool_name: call.tool_name, status, output });
    } finally {
      // Its final state is already verified. A failed write stays fatal, without a second cleanup result write.
      if (this.active?.call.tool_use_id === call.tool_use_id) this.active = undefined;
    }
    return output;
  }

  /**
   * Saves a verified final failure and durable group-halt evidence before allowing final synthesis.
   *
   * Example Input:
   * { call: ToolCall <original query call>, id: '11111111-1111-4111-8111-111111111111', state: 'FAILED' }
   * Example Output (also persisted as error-status TOOL_RESULT.output):
   * { ok: false, query_execution_id: '11111111-1111-4111-8111-111111111111', state: 'FAILED', halted_tool_group: true,
   *   error: { code: 'QUERY_FAILED', message: 'The approved query did not complete successfully.' } }
   * State CANCELLED uses QUERY_CANCELLED. The caller must have verified the final service state first.
   */
  private async failed(call: ToolCall, id: string, state: 'FAILED' | 'CANCELLED'): Promise<JsonObject> {
    const code = state === 'CANCELLED' ? 'QUERY_CANCELLED' : 'QUERY_FAILED';

    return this.terminal(call, { ok: false, query_execution_id: id, state, halted_tool_group: true,
      error: { code, message: 'The approved query did not complete successfully.' } }, 'error');
  }

  /**
   * Validates a status response while retaining recognized failures for durable terminalization.
   *
   * Example Input:
   * { request: { operation: 'query_events', table: 'waf_events', start_time: '2026-09-11T00:00:00Z', end_time: '2026-09-12T00:00:00Z', limit: 2 },
   *   id: '11111111-1111-4111-8111-111111111111', timeoutMs: 20_000 }
   * Example Output (selected fields from a verified tool response):
   * { ok: true, operation: 'query_events', table: 'waf_events', query_execution_id: '11111111-1111-4111-8111-111111111111', state: 'RUNNING', ... }
   * Sends query_status with the complete original request; unexpected IDs, states, or contracts throw QUERY_STATUS_UNAVAILABLE.
   */
  private async status(request: LogicalQuery, id: string, timeoutMs: number): Promise<JsonObject> {

    const output = await this.invoke({ operation: 'query_status', query_execution_id: id, query: request }, false, timeoutMs);

    if (output.query_execution_id !== id) throw new ChatError('QUERY_STATUS_UNAVAILABLE', 'The query status could not be confirmed.');
    const error = output.error;

    if (typeof output.state !== 'string' || !['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(output.state)
      || output.operation !== request.operation || output.table !== request.table
      || (output.state === 'FAILED'
        ? output.ok !== false || !error || typeof error !== 'object' || Array.isArray(error) || error.code !== 'QUERY_FAILED'
        : output.ok !== true)) {
      throw new ChatError('QUERY_STATUS_UNAVAILABLE', 'The query status could not be confirmed.');
    }

    return output;
  }

  /**
   * Reuses a durably confirmed cleanup failure; an unconfirmed stop or storage error remains fatal.
   *
   * Example Input: timedOut() // this.active tracks a known query whose deadline expired
   * If cancelActive() observes CANCELLED and successfully saves the failure:
   * Example Output:
   * { ok: false, query_execution_id: '11111111-1111-4111-8111-111111111111', state: 'CANCELLED', halted_tool_group: true,
   *   error: { code: 'QUERY_CANCELLED', message: 'The approved query did not complete successfully.' } }
   * Reuses the saved failure, not another result write; absent confirmed failure throws QUERY_TIMED_OUT.
   */
  private async timedOut(): Promise<JsonObject> {
    const active = this.active;
    await this.cancelActive();
    if (active?.failure) return active.failure;
    // A requested stop, unavailable state, or late success is not a saved terminal query failure.
    throw new ChatError('QUERY_TIMED_OUT', 'The query reached its time limit.');
  }

  /**
   * Persists complete evidence before reporting success, retaining exact IDs and bounded result rows.
   *
   * Example Input (call/request and verified output abbreviated):
   * { call: ToolCall <original query call>, request: { operation: 'query_events', table: 'waf_events', ... },
   *   output: { ok: true, state: 'SUCCEEDED', query_execution_id: '11111111-1111-4111-8111-111111111111', result_count: 0, rows: [], ... } }
   * Example Output (same complete object after persistence, reduced here):
   * { ok: true, state: 'SUCCEEDED', query_execution_id: '11111111-1111-4111-8111-111111111111', result_count: 0, rows: [], ... }
   * Also emits { type: 'activity', stage: 'query_completed', operation: 'query_events', table: 'waf_events', rowsReturned: 0 }.
   * Clears active tracking without inventing or copying evidence rows.
   */
  private async succeeded(call: ToolCall, request: LogicalQuery, output: JsonObject): Promise<JsonObject> {
    await this.terminal(call, output);
    this.active = undefined;
    await this.emit({ type: 'activity', stage: 'query_completed', operation: request.operation,
      table: request.table, rowsReturned: typeof output.result_count === 'number' ? output.result_count : 0 });
    return output;
  }

  /**
   * Starts a new validated logical query, or resolves its internal asynchronous lifecycle.
   *
   * Example Input (call abbreviated; request already validated):
   * { call: { tool_use_id: 'tool-1', tool_name: 'query_events', ... }, request: {
   *   operation: 'query_events', table: 'waf_events', start_time: '2026-09-11T00:00:00Z',
   *   end_time: '2026-09-12T00:00:00Z', fields: ['action'], limit: 2,
   * } }
   * Example Output (illustrative final verified evidence, reduced):
   * { ok: true, state: 'SUCCEEDED', query_execution_id: '11111111-1111-4111-8111-111111111111', result_count: 0, rows: [], ... }
   * Persists the returned submission ID/original request before polling, then saves a terminal result.
   * Unlike the query Lambda's start operation, execute() does not return its SUBMITTED checkpoint as final evidence.
   */
  public async execute(call: ToolCall, request: LogicalQuery): Promise<JsonObject> {
    this.budget.check();
    if (this.active) throw new ChatError('QUERY_TIMED_OUT', 'A previous query has not reached a confirmed terminal state.');
    await this.emit({ type: 'activity', stage: 'query_started', operation: request.operation, table: request.table });
    const submittedAt = Date.now();
    let output: JsonObject;
    try { output = await this.invoke(request); }
    catch (error) {
      if (request.operation === 'describe_table') throw error;
      throw new ChatError('UNKNOWN_TOOL_DISPATCH', 'The query submission could not be safely confirmed.', 409, false);
    }
    if (request.operation === 'describe_table') {
      if (output.ok !== true) throw new ChatError('QUERY_FAILED', 'The approved table description could not complete.');
      await this.terminal(call, output);
      await this.emit({ type: 'activity', stage: 'query_completed', operation: request.operation, table: request.table, rowsReturned: 0 });
      return output;
    }
    const id = output.query_execution_id;
    if (output.ok !== true || typeof id !== 'string' || !EXECUTION_ID.test(id) || output.state !== 'SUBMITTED') {
      throw new ChatError('UNKNOWN_TOOL_DISPATCH', 'The query submission could not be safely confirmed.', 409, false);
    }
    this.active = { id, request, submittedAt, call };
    await this.store.append(this.lease, { entity_type: 'TOOL_RESULT', tool_use_id: call.tool_use_id,
      tool_name: call.tool_name, status: 'success', output: { state: 'SUBMITTED', query_execution_id: id,
        query: request as unknown as JsonObject, submitted_at_ms: submittedAt } });
    return this.poll(call, request, id, submittedAt);
  }

  /**
   * Polls within the saved execution deadline and durably records every known terminal failure.
   *
   * Example Input (original request abbreviated):
   * { call: ToolCall <original query call>, request: { operation: 'query_events', table: 'waf_events', ... },
   *   id: '11111111-1111-4111-8111-111111111111', submittedAt: Date.now() - 1_000 }
   * If status() observes RUNNING followed by a verified FAILED state:
   * Example Output:
   * { ok: false, query_execution_id: '11111111-1111-4111-8111-111111111111', state: 'FAILED', halted_tool_group: true,
   *   error: { code: 'QUERY_FAILED', message: 'The approved query did not complete successfully.' } }
   * Verified success returns persisted bounded rows instead; an unavailable state is not converted into a failure result.
   */
  private async poll(call: ToolCall, request: LogicalQuery, id: string, submittedAt: number): Promise<JsonObject> {
    this.active = { id, request, submittedAt, call };
    while (true) {
      this.budget.check();
      if (Date.now() - submittedAt >= QUERY_DEADLINE_SECONDS * 1_000) {
        return this.timedOut();
      }
      let output: JsonObject;
      try {
        output = await this.status(request, id, Math.min(20_000, QUERY_DEADLINE_SECONDS * 1_000 - (Date.now() - submittedAt)));
      } catch (error) {
        if (Date.now() - submittedAt >= QUERY_DEADLINE_SECONDS * 1_000) {
          // An unavailable status must not be converted into confirmed terminal evidence.
          if (error instanceof ChatError) throw error;
          return this.timedOut();
        }
        throw error;
      }
      if (output.state === 'FAILED' || output.state === 'CANCELLED') {
        const failure = await this.failed(call, id, output.state);
        this.active = undefined;
        return failure;
      }
      if (output.state === 'SUCCEEDED'
        && (Date.now() - submittedAt < QUERY_DEADLINE_SECONDS * 1_000 || completedInTime(output, submittedAt))) {
        return this.succeeded(call, request, output);
      }
      if (Date.now() - submittedAt >= QUERY_DEADLINE_SECONDS * 1_000) {
        return this.timedOut();
      }
      const wait = Math.min(1_000, QUERY_DEADLINE_SECONDS * 1_000 - (Date.now() - submittedAt));
      await delay(Math.max(1, wait), undefined, { signal: this.budget.signal });
    }
  }

  /**
   * Fetches one authenticated status after expiry, reusing success only with timely service completion evidence.
   *
   * Example Input (clock is now after 2026-10-10T12:03:00.000Z):
   * { call: ToolCall <original query call>, request: LogicalQuery <original approved request>,
   *   id: '11111111-1111-4111-8111-111111111111', submittedAt: Date.parse('2026-10-10T12:00:00.000Z') }
   * Example Output (if authenticated status proves completion at 12:02:00):
   * { ok: true, state: 'SUCCEEDED', completed_at: '2026-10-10T12:02:00.000Z', result_count: 0, rows: [], ... }
   * Saves that original execution's result; late/unproven completion follows bounded cleanup, never a new submission.
   */
  private async recoverExpired(call: ToolCall, request: LogicalQuery, id: string, submittedAt: number): Promise<JsonObject> {
    this.active = { id, request, submittedAt, call };
    this.budget.check();
    const output = await this.status(request, id, 20_000);
    if (output.state === 'SUCCEEDED' && completedInTime(output, submittedAt)) {
      return this.succeeded(call, request, output);
    } else if (output.state === 'FAILED' || output.state === 'CANCELLED') {
      const failure = await this.failed(call, id, output.state);
      this.active = undefined;
      return failure;
    } else {
      return this.timedOut();
    }
  }

  /**
   * Validates a saved submission against its original call before polling or fatal-path cleanup.
   *
   * Example Input (call's full arguments equal query without its operation; submitted_at_ms is in the past):
   * { call: { tool_name: 'query_events', arguments: { table: 'waf_events', start_time: '2026-09-11T00:00:00Z', end_time: '2026-09-12T00:00:00Z' }, ... },
   *   output: { state: 'SUBMITTED', query_execution_id: '11111111-1111-4111-8111-111111111111',
   *     query: { operation: 'query_events', table: 'waf_events', start_time: '2026-09-11T00:00:00Z', end_time: '2026-09-12T00:00:00Z' },
   *     submitted_at_ms: Date.now() - 1_000 } }
   * Example Output (same original call/request references, abbreviated):
   * { id: '11111111-1111-4111-8111-111111111111', submittedAt: <saved-submitted_at_ms>,
   *   request: { operation: 'query_events', table: 'waf_events', ... }, call: <original-TOOL_CALL> }
   * Does not send a query; mismatched or malformed checkpoints throw TOOL_PROTOCOL_ERROR.
   */
  private checkpoint(call: ToolCall, output: JsonObject): NonNullable<ToolExecutor['active']> {
    const id = output.query_execution_id;
    const submittedAt = output.submitted_at_ms;
    if (typeof id !== 'string' || !EXECUTION_ID.test(id) || typeof submittedAt !== 'number'
      || !Number.isSafeInteger(submittedAt) || submittedAt <= 0 || submittedAt > Date.now()) {
      throw new ChatError('TOOL_PROTOCOL_ERROR', 'A previous query checkpoint is invalid.', 409, false);
    }
    const original = responseObject(output.query);
    const request = validateTool(String(call.tool_name), call.arguments, this.config);
    if (request.operation === 'describe_table' || canonicalJson(request as unknown as JsonObject) !== canonicalJson(original)) {
      throw new ChatError('TOOL_PROTOCOL_ERROR', 'A previous query checkpoint is invalid.', 409, false);
    }
    return { id, request, submittedAt, call };
  }

  /**
   * Reuses original results without copying them, and halts queued work after a durable confirmed failure.
   *
   * Example Input (selected matching events for this lease's turn):
   * [
   *   { entity_type: 'TOOL_CALL', turn_id: '<turn-uuid>', event_sequence: 2, tool_use_id: 'tool-1', tool_name: 'query_events', assistant_message_id: 'group-1', content_block_index: 0, attempt_id: '<prior-attempt-uuid>', ... },
   *   { entity_type: 'TOOL_RESULT', turn_id: '<turn-uuid>', event_sequence: 3, tool_use_id: 'tool-1', tool_name: 'query_events', status: 'error',
   *     output: { ok: false, query_execution_id: '11111111-1111-4111-8111-111111111111', state: 'FAILED', halted_tool_group: true, error: { code: 'QUERY_FAILED' } }, ... },
   * ]
   * Example Output: true // orchestrator must finalize with tools disabled
   * Reuses this saved failure without copying it. Empty/already-successful history returns false; known pending IDs are polled.
   * Unknown dispatch or contradictory later work throws; provably queued calls after a durable halt receive NOT_EXECUTED results.
   */
  public async recover(events: readonly ChatEvent[]): Promise<boolean> {
    const calls = events.filter((event): event is ToolCall => event.turn_id === this.lease.turnId && event.entity_type === 'TOOL_CALL')
      .sort((left, right) => left.event_sequence - right.event_sequence);
    const haltedGroups = new Map<string, ToolCall>();
    let finalizationOnly = false;
    for (const call of calls) {
      const latest = selectToolResult(events, call);
      const halt = haltedGroups.get(call.assistant_message_id);
      const queuedAfterHalt = halt && call.attempt_id === halt.attempt_id && call.event_sequence > halt.event_sequence
        && call.content_block_index > halt.content_block_index;
      const results = events.filter((event): event is Extract<ChatEvent, { entity_type: 'TOOL_RESULT' }> =>
        event.turn_id === call.turn_id && event.entity_type === 'TOOL_RESULT' && event.tool_use_id === call.tool_use_id);
      if (queuedAfterHalt && results.some(result => {
        const error = result.output.error;
        return result.status !== 'error' || result.output.query_execution_id !== undefined || !error
          || typeof error !== 'object' || Array.isArray(error) || error.code !== 'NOT_EXECUTED';
      })) {
        // Even a hidden pending checkpoint contradicts nonexecution; retain its ID for fatal-path cleanup.
        const pending = [...results].sort((left, right) => right.event_sequence - left.event_sequence)
          .find((result): boolean => !isTerminalToolResult(result));
        if (pending) this.active = this.checkpoint(call, pending.output);
        throw new ChatError('UNKNOWN_TOOL_DISPATCH', 'A halted tool group contains inconsistent dispatch evidence.', 409, false);
      }
      if (!latest && queuedAfterHalt) {
        await this.terminal(call, { ok: false, error: { code: 'NOT_EXECUTED',
          message: 'This tool block was not executed. Use existing evidence or correct the approved input.' } }, 'error');
        continue;
      }
      if (!latest?.output || typeof latest.output !== 'object' || Array.isArray(latest.output)) {
        throw new ChatError('UNKNOWN_TOOL_DISPATCH', 'A previous query dispatch could not be safely recovered.', 409, false);
      }
      let output = latest.output as JsonObject;
      if (isTerminalToolResult(latest) && output.query_execution_id !== undefined && !isConfirmedQueryFailure(output)
        && !(latest.status === 'success' && output.ok === true && output.state === 'SUCCEEDED')) {
        const pending = [...results].sort((left, right) => right.event_sequence - left.event_sequence)
          .find((result): boolean => !isTerminalToolResult(result));
        if (pending) this.active = this.checkpoint(call, pending.output);
        throw new ChatError('QUERY_STATUS_UNAVAILABLE', 'A previous query final state could not be confirmed.');
      }
      const error = output.error;
      if (queuedAfterHalt && (latest.status !== 'error' || !error || typeof error !== 'object'
        || Array.isArray(error) || error.code !== 'NOT_EXECUTED')) {
        throw new ChatError('UNKNOWN_TOOL_DISPATCH', 'A halted tool group contains inconsistent dispatch evidence.', 409, false);
      }
      if (!isTerminalToolResult(latest)) {
        this.active = this.checkpoint(call, output);
        const { id, request, submittedAt } = this.active;
        if (finalizationOnly) throw new ChatError('QUERY_STATUS_UNAVAILABLE', 'Later query work cannot continue after a confirmed failure.');
        output = Date.now() - submittedAt >= QUERY_DEADLINE_SECONDS * 1_000
          ? await this.recoverExpired(call, request, id, submittedAt) : await this.poll(call, request, id, submittedAt);
      }
      if (isConfirmedQueryFailure(output)) {
        if (isTerminalToolResult(latest) && latest.status !== 'error') {
          throw new ChatError('TOOL_PROTOCOL_ERROR', 'A previous query failure record is invalid.', 409, false);
        }
        finalizationOnly = true;
        if (output.halted_tool_group === true) haltedGroups.set(call.assistant_message_id, call);
      }
    }
    return finalizationOnly;
  }

  /**
   * Records observed cancellation state; only an observed CANCELLED execution confirms a stopped query.
   *
   * Example Input: cancelActive() // no arguments; active contains the original call/request and a known execution ID
   * With the cancellation response:
   * { ok: true, query_execution_id: '11111111-1111-4111-8111-111111111111', state: 'CANCELLED', cancellation_requested: true }
   * Example Output: true, after saving the bounded QUERY_CANCELLED failure and clearing active tracking.
   * No active query returns false. A requested stop with state RUNNING also returns false and saves a pending checkpoint;
   * false does not itself prove cancellation failed or that a query is still running.
   */
  public async cancelActive(): Promise<boolean> {
    const active = this.active;
    if (!active) return false;
    const output = await this.invoke({ operation: 'cancel_query', query_execution_id: active.id }, true);
    if (output.ok !== true || output.query_execution_id !== active.id || typeof output.state !== 'string'
      || !['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(output.state)
      || typeof output.cancellation_requested !== 'boolean') {
      throw new ChatError('QUERY_CANCELLATION_UNAVAILABLE', 'Query cancellation could not be confirmed.');
    }
    active.cancellationRequested = output.cancellation_requested;
    active.cancellationConfirmed = output.state === 'CANCELLED';
    if (output.state === 'FAILED' || output.state === 'CANCELLED') {
      active.failure = await this.failed(active.call, active.id, output.state);
      this.active = undefined;
    } else {
      // Even a succeeded execution needs an authenticated status fetch before its rows become evidence.
      await this.store.append(this.lease, { entity_type: 'TOOL_RESULT', tool_use_id: active.call.tool_use_id,
        tool_name: active.call.tool_name, status: 'success', output: {
          state: PENDING.includes(output.state) ? output.state : 'SUBMITTED', observed_state: output.state,
          query_execution_id: active.id, query: active.request as unknown as JsonObject, submitted_at_ms: active.submittedAt,
          cancellation_requested: active.cancellationRequested, cancellation_confirmed: false,
        } });
      if (output.state === 'SUCCEEDED') this.active = undefined;
    }
    return active.cancellationConfirmed;
  }
}
