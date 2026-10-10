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

/** Recognizes bounded, confirmed query failures; unavailable executions are not terminal evidence. */
export function isConfirmedQueryFailure(output: JsonObject): boolean {
  const error = output.error;
  return output.ok === false && typeof output.query_execution_id === 'string' && EXECUTION_ID.test(output.query_execution_id)
    && error !== null && typeof error === 'object' && !Array.isArray(error)
    && ((output.state === 'FAILED' && error.code === 'QUERY_FAILED')
      || (output.state === 'CANCELLED' && error.code === 'QUERY_CANCELLED'));
}

/** Accepts bounded JSON objects from the private tool, without exposing provider error text. */
function responseObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChatError('TOOL_PROTOCOL_ERROR', 'The query tool returned an invalid response.');
  return value as JsonObject;
}

/** Compares stored request maps without depending on DynamoDB attribute iteration order. */
function canonicalJson(value: JsonObject): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry);
}

/** Accepts only a canonical service timestamp proving completion inside the original execution budget. */
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

  public constructor(private readonly config: Configuration, private readonly budget: TurnBudget,
    private readonly store: ConversationStore, private readonly lease: Lease,
    private readonly emit: (event: StreamEvent) => Promise<void>) {}

  /** Invokes only the configured function; submission is never retried blindly after an ambiguous timeout. */
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

  /** Appends one terminal result using the existing tool-result variant and bounded output contract. */
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

  /** Saves a verified final failure and durable group-halt evidence before allowing final synthesis. */
  private async failed(call: ToolCall, id: string, state: 'FAILED' | 'CANCELLED'): Promise<JsonObject> {
    const code = state === 'CANCELLED' ? 'QUERY_CANCELLED' : 'QUERY_FAILED';

    return this.terminal(call, { ok: false, query_execution_id: id, state, halted_tool_group: true,
      error: { code, message: 'The approved query did not complete successfully.' } }, 'error');
  }

  /** Validates a status response while retaining recognized failures for durable terminalization. */
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

  /** Reuses a durably confirmed cleanup failure; an unconfirmed stop or storage error remains fatal. */
  private async timedOut(): Promise<JsonObject> {
    const active = this.active;
    await this.cancelActive();
    if (active?.failure) return active.failure;
    // A requested stop, unavailable state, or late success is not a saved terminal query failure.
    throw new ChatError('QUERY_TIMED_OUT', 'The query reached its time limit.');
  }

  /** Persists complete evidence before reporting success, retaining exact IDs and bounded result rows. */
  private async succeeded(call: ToolCall, request: LogicalQuery, output: JsonObject): Promise<JsonObject> {
    await this.terminal(call, output);
    this.active = undefined;
    await this.emit({ type: 'activity', stage: 'query_completed', operation: request.operation,
      table: request.table, rowsReturned: typeof output.result_count === 'number' ? output.result_count : 0 });
    return output;
  }

  /** Starts a new validated logical query, or resolves its internal asynchronous lifecycle. */
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

  /** Polls within the saved execution deadline and durably records every known terminal failure. */
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

  /** Fetches one authenticated status after expiry, reusing success only with timely service completion evidence. */
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

  /** Validates a saved submission against its original call before polling or fatal-path cleanup. */
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

  /** Reuses original results without copying them, and halts queued work after a durable confirmed failure. */
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

  /** Records observed cancellation state; only an observed CANCELLED execution confirms a stopped query. */
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
