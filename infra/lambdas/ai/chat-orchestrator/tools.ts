import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_RESPONSE_BYTES, QUERY_DEADLINE_SECONDS } from '../../../lib/stacks/ai/query-contract';
import { ChatError, Configuration, TurnBudget } from './config';
import { LogicalQuery, validateTool } from './contracts';
import { ChatEvent, ConversationStore, JsonObject, Lease } from './store';
import { StreamEvent } from './stream';

const PENDING = ['SUBMITTED', 'QUEUED', 'RUNNING', 'UNKNOWN'];
const EXECUTION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
type ToolCall = Extract<ChatEvent, { entity_type: 'TOOL_CALL' }>;
type ToolResult = Extract<ChatEvent, { entity_type: 'TOOL_RESULT' }>;

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
    cancellationRequested?: boolean; cancellationConfirmed?: boolean };

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
    await this.store.append(this.lease, { entity_type: 'TOOL_RESULT', tool_use_id: call.tool_use_id,
      tool_name: call.tool_name, status, output });
    return output;
  }

  /** Reuses compact failure evidence without exposing the query provider's diagnostics. */
  private async failed(call: ToolCall, id: string, state: string): Promise<JsonObject> {
    const code = state === 'NOT_FOUND' ? 'QUERY_NOT_FOUND' : state === 'CANCELLED' ? 'QUERY_CANCELLED' : 'QUERY_FAILED';

    return this.terminal(call, { ok: false, query_execution_id: id, state,
      error: { code, message: 'The approved query did not complete successfully.' } }, 'error');
  }

  /** Validates a status response while retaining recognized failures for durable terminalization. */
  private async status(request: LogicalQuery, id: string, timeoutMs: number): Promise<JsonObject> {

    const output = await this.invoke({ operation: 'query_status', query_execution_id: id, query: request }, false, timeoutMs);

    if (output.query_execution_id !== id) throw new ChatError('QUERY_STATUS_UNAVAILABLE', 'The query status could not be confirmed.');
    const error = output.error;

    if (output.ok === false && error && typeof error === 'object' && !Array.isArray(error)
      && error.code === 'QUERY_NOT_FOUND') return { ok: false, query_execution_id: id, state: 'NOT_FOUND' };

    if (typeof output.state !== 'string' || ![...PENDING, 'SUCCEEDED', 'FAILED', 'CANCELLED', 'NOT_FOUND'].includes(output.state)
      || (output.ok !== true && output.state !== 'FAILED')) {
      throw new ChatError('QUERY_STATUS_UNAVAILABLE', 'The query status could not be confirmed.');
    }

    return output;
  }

  /** Records expiry and attempts cleanup without allowing cleanup failures to replace the timeout. */
  private async timedOut(call: ToolCall, id: string, recovering: boolean): Promise<JsonObject> {

    const active = this.active;

    try { await this.cancelActive(); } catch { /* Final outcome reporting still identifies the original timeout. */ }
    if (this.active) {
      // Keep the latest pending checkpoint; another call must not replace an execution whose stop is unconfirmed.
      throw new ChatError('QUERY_TIMED_OUT', 'The query reached its time limit.');
    }

    const output: JsonObject = { ok: false, query_execution_id: id, state: 'TIMED_OUT',
      cancellation_requested: active?.cancellationRequested ?? false,
      cancellation_confirmed: active?.cancellationConfirmed ?? false,
      error: { code: 'QUERY_TIMED_OUT', message: 'The query reached its time limit.' } };
      
    try { await this.terminal(call, output, 'error'); }
    catch { throw new ChatError('QUERY_TIMED_OUT', 'The query reached its time limit.'); }
    if (recovering) return output;
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
  private async poll(call: ToolCall, request: LogicalQuery, id: string, submittedAt: number, recovering = false): Promise<JsonObject> {
    this.active = { id, request, submittedAt, call };
    while (true) {
      this.budget.check();
      if (Date.now() - submittedAt >= QUERY_DEADLINE_SECONDS * 1_000) {
        return this.timedOut(call, id, recovering);
      }
      let output: JsonObject;
      try {
        output = await this.status(request, id, Math.min(20_000, QUERY_DEADLINE_SECONDS * 1_000 - (Date.now() - submittedAt)));
      } catch (error) {
        if (Date.now() - submittedAt >= QUERY_DEADLINE_SECONDS * 1_000) {
          return this.timedOut(call, id, recovering);
        }
        throw error;
      }
      if (Date.now() - submittedAt >= QUERY_DEADLINE_SECONDS * 1_000) {
        return this.timedOut(call, id, recovering);
      }
      if (output.state === 'SUCCEEDED') {
        return this.succeeded(call, request, output);
      }
      if (['FAILED', 'CANCELLED', 'NOT_FOUND'].includes(String(output.state))) {
        const failure = await this.failed(call, id, String(output.state));
        this.active = undefined;
        if (recovering) return failure;
        throw new ChatError(output.state === 'NOT_FOUND' ? 'QUERY_NOT_FOUND' : output.state === 'CANCELLED' ? 'QUERY_CANCELLED' : 'QUERY_FAILED',
          'The approved query did not complete successfully.');
      }
      const wait = Math.min(1_000, QUERY_DEADLINE_SECONDS * 1_000 - (Date.now() - submittedAt));
      await delay(Math.max(1, wait), undefined, { signal: this.budget.signal });
    }
  }

  /** Fetches one authenticated status after expiry, reusing success only with timely service completion evidence. */
  private async recoverExpired(call: ToolCall, request: LogicalQuery, id: string, submittedAt: number): Promise<void> {
    this.active = { id, request, submittedAt, call };
    this.budget.check();
    const output = await this.status(request, id, 20_000);
    if (output.state === 'SUCCEEDED' && completedInTime(output, submittedAt)) {
      await this.succeeded(call, request, output);
    } else if (['FAILED', 'CANCELLED', 'NOT_FOUND'].includes(String(output.state))) {
      await this.failed(call, id, String(output.state));
      this.active = undefined;
    } else {
      await this.timedOut(call, id, true);
    }
  }

  /** Reuses terminal evidence or a known submission ID; an unknown prior dispatch never gets resubmitted. */
  public async recover(events: readonly ChatEvent[]): Promise<void> {
    const calls = events.filter((event): event is ToolCall => event.turn_id === this.lease.turnId && event.entity_type === 'TOOL_CALL');
    for (const call of calls) {
      const results = events.filter((event): event is ToolResult => event.turn_id === this.lease.turnId && event.entity_type === 'TOOL_RESULT'
        && event.tool_use_id === call.tool_use_id).sort((a, b) => a.event_sequence - b.event_sequence);
      const latest = results.at(-1);
      if (!latest?.output || typeof latest.output !== 'object' || Array.isArray(latest.output)) {
        throw new ChatError('UNKNOWN_TOOL_DISPATCH', 'A previous query dispatch could not be safely recovered.', 409, false);
      }
      const output = latest.output as JsonObject;
      if (latest.status !== 'error' && typeof output.state === 'string' && PENDING.includes(output.state)) {
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
        if (Date.now() - submittedAt >= QUERY_DEADLINE_SECONDS * 1_000) await this.recoverExpired(call, request, id, submittedAt);
        else await this.poll(call, request, id, submittedAt, true);
      } else {
        await this.store.append(this.lease, { entity_type: 'TOOL_RESULT', tool_use_id: call.tool_use_id,
          tool_name: call.tool_name, status: latest.status ?? 'success', output });
      }
    }
  }

  /** Records observed cancellation state; only an observed CANCELLED execution confirms a stopped query. */
  public async cancelActive(): Promise<boolean> {
    const active = this.active;
    if (!active) return false;
    const output = await this.invoke({ operation: 'cancel_query', query_execution_id: active.id }, true);
    if (output.ok !== true || output.query_execution_id !== active.id || typeof output.state !== 'string'
      || ![...PENDING, 'SUCCEEDED', 'FAILED', 'CANCELLED', 'NOT_FOUND'].includes(output.state)
      || typeof output.cancellation_requested !== 'boolean') {
      throw new ChatError('QUERY_CANCELLATION_UNAVAILABLE', 'Query cancellation could not be confirmed.');
    }
    active.cancellationRequested = output.cancellation_requested;
    active.cancellationConfirmed = output.state === 'CANCELLED';
    if (['FAILED', 'CANCELLED', 'NOT_FOUND'].includes(output.state)) {
      await this.failed(active.call, active.id, output.state);
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
