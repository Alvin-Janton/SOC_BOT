import { Writable } from 'node:stream';
import { ChatError, configuration, MAX_OUTPUT_BYTES, OUTCOME_RESERVE_MS, TurnBudget } from './config';
import { parseRequest } from './contracts';
import { Orchestrator } from './orchestrator';
import { ConversationStore, Lease, StoreError } from './store';
import { httpError, LambdaContext, NdjsonStream } from './stream';

/**
 * Maps failures to safe public contracts, never exposing SDK errors, prompts, or record contents.
 *
 * Example Input:
 * { error: StoreError { code: 'NOT_FOUND' }, budget: { remaining: 500_000, signal: { aborted: false } } }
 * Example Output (selected Error properties):
 * { name: 'ChatError', code: 'NOT_FOUND', message: 'Conversation is unavailable.', status: 404, retryable: false }
 * The budget shown is illustrative instance state, not the TurnBudget argument's literal shape.
 */
function publicError(error: unknown, budget: TurnBudget): ChatError {

  if (error instanceof ChatError && !error.retryable) return error;
  if (budget.signal.aborted || budget.remaining() <= OUTCOME_RESERVE_MS) return new ChatError('TURN_TIMED_OUT', 'The investigation reached its time limit.', 504);
  if (error instanceof ChatError) return error;

  if (error instanceof StoreError) {
    if (error.code === 'NOT_FOUND') return new ChatError(error.code, 'Conversation is unavailable.', 404, false);

    if (['TURN_IN_PROGRESS', 'CONVERSATION_BUSY', 'TURN_CONFLICT', 'TURN_TERMINAL', 'LEASE_LOST'].includes(error.code)) {
      return new ChatError(error.code, 'Conversation turn cannot be accepted in its current state.', 409, false);
    }

    if (['INVALID_INPUT', 'HISTORY_LIMIT', 'CONTEXT_LIMIT'].includes(error.code)) {
      return new ChatError(error.code, 'Conversation exceeds the supported request or history limits.', 400, false);
    }
    return new ChatError('STORAGE_ERROR', 'Conversation state could not be processed safely.', 503, false);
  }
  return new ChatError('SERVICE_ERROR', 'The investigation could not complete. Retry using the same turn identifier.', 503);
}

/**
 * Accepts the trusted dev identity, persists outcomes before completion, and leaves auth/API integration inactive.
 *
 * Example Input (Lambda supplies the Writable and context; trusted dev configuration is required):
 * {
 *   event: { body: '{"turnId":"296a0470-b7b7-4a21-a9d7-72fb7be90ac9","message":"Describe waf_events."}' },
 *   raw: Writable <Lambda response stream>,
 *   context: { awsRequestId: '<invocation-id>', getRemainingTimeInMillis: () => 890_000 },
 * }
 * Example Output: resolves to undefined; selected illustrative NDJSON writes are:
 * {"type":"conversation","conversationId":"<generated-conversation-id>","turnId":"296a0470-b7b7-4a21-a9d7-72fb7be90ac9"}
 * {"type":"text_delta","text":"The WAF table contains request and rule evidence."}
 * {"type":"complete","conversationId":"<generated-conversation-id>","replayed":false,"truncated":false,"turnId":"296a0470-b7b7-4a21-a9d7-72fb7be90ac9"}
 * Actual model text/activity varies. Completion follows durable assistant persistence; errors use the safe error path.
 */
async function respond(event: unknown, raw: Writable, context: LambdaContext): Promise<void> {
  const acceptedAt = Date.now();
  const budget = new TurnBudget(acceptedAt);
  let stream: NdjsonStream | undefined;
  let store: ConversationStore | undefined;
  let cleanupStore: ConversationStore | undefined;
  let lease: Lease | undefined;
  let orchestrator: Orchestrator | undefined;
  let turnId: string | undefined;
  let conversationId: string | undefined;
  let outcome = 'rejected';
  let outcomePersisted = false;
  let leaseReleased = false;
  let cancellationConfirmed = false;
  let completionWriteAttempted = false;
  let errorCode: string | undefined;

  try {
    const config = configuration();
    const request = parseRequest(event);
    turnId = request.turnId;
    const remainingRuntime = context.getRemainingTimeInMillis();

    if (!Number.isFinite(remainingRuntime) || remainingRuntime < 600_000) {
      throw new ChatError('CONFIGURATION_ERROR', 'The investigation runtime is not available.', 503, false);
    }

    store = new ConversationStore(config.tableName, config.ownerId, budget.deadline - OUTCOME_RESERVE_MS);
    cleanupStore = new ConversationStore(config.tableName, config.ownerId, budget.deadline);

    const begun = await store.begin(request.conversationId, request.turnId, request.message,
      Math.ceil((Date.now() + remainingRuntime + 30_000) / 1_000));

    conversationId = begun.state === 'completed' ? begun.conversationId : begun.lease.conversationId;
    lease = begun.state === 'acquired' ? begun.lease : undefined;
    stream = new NdjsonStream(raw, turnId);
    await stream.emit({ type: 'conversation', conversationId, turnId });

    if (begun.state === 'completed') {
      if (begun.assistant.entity_type !== 'ASSISTANT_MESSAGE' || Buffer.byteLength(begun.assistant.content, 'utf8') > MAX_OUTPUT_BYTES) {
        throw new ChatError('STORAGE_ERROR', 'Conversation state could not be processed safely.', 503, false);
      }

      await stream.emit({ type: 'text_delta', text: begun.assistant.content });
      outcome = 'completed_replay';
      outcomePersisted = true;
      await stream.finish({ type: 'complete', conversationId, replayed: true, truncated: begun.assistant.stop_reason === 'max_tokens' });
      return;
    }

    orchestrator = new Orchestrator(config, store, begun.lease, budget, activity => stream!.emit(activity));
    const response = await orchestrator.run(begun.events);
    budget.check();
    orchestrator.phase = 'persistence';
    completionWriteAttempted = true;

    await store.append(begun.lease, { entity_type: 'ASSISTANT_MESSAGE', role: 'assistant', model_id: config.modelId,
      stop_reason: response.stopReason, content: response.text });

    outcome = 'completed';
    outcomePersisted = true;
    
    try { await cleanupStore.release(begun.lease); leaseReleased = true; } catch { /* Durable completion is replayable even if release needs expiry recovery. */ }
    await stream.finish({ type: 'complete', conversationId, replayed: false, truncated: response.stopReason === 'max_tokens' });
  } catch (error) {

    let safe = publicError(error, budget);

    if (orchestrator) {
      try { cancellationConfirmed = await orchestrator.tools.cancelActive(); } catch { /* Do not claim an unknown query was stopped. */ }
    }

    if (completionWriteAttempted && !outcomePersisted) {
      // A timed-out write may already have committed. Never append a contradictory failed outcome.
      outcome = 'completion_unknown';
      safe = new ChatError('OUTCOME_NOT_CONFIRMED', 'The final outcome could not be confirmed. Retry the same turn after its active lease expires.', 503);
    } 

    else if (cleanupStore && lease && !outcomePersisted) {
      outcome = safe.code === 'TURN_TIMED_OUT' || safe.code === 'QUERY_TIMED_OUT' || safe.code === 'MODEL_TIMED_OUT' ? 'timed_out' : 'failed';
      try {
        await cleanupStore.append(lease, { entity_type: 'TURN_OUTCOME', outcome: outcome === 'timed_out' ? 'timed_out' : 'failed',
          retryable: safe.retryable, failure_phase: orchestrator?.phase ?? 'acceptance', error_code: safe.code });
        outcomePersisted = true;
      } 

      catch {
        safe = new ChatError('OUTCOME_NOT_CONFIRMED', 'The outcome could not be confirmed. Retry the same turn after its active lease expires.', 503);
      }

      try { await cleanupStore.release(lease); leaseReleased = true; } catch { /* A stale writer cannot clear a newer lease. */ }
    }

    errorCode = safe.code;

    if (stream) await stream.finish({ type: 'error', code: safe.code, message: safe.message,
      retryable: safe.retryable, correlationId: context.awsRequestId });

    else await httpError(raw, safe.status, safe.code, safe.message, context.awsRequestId);
  } 
  
  finally {
    // Intentionally exclude user text, tool arguments/results, summaries, SDK diagnostics and reasoning.
    console.info(JSON.stringify({ event: 'chat_turn', requestId: context.awsRequestId, conversationId, turnId,
      attemptId: lease?.attemptId, outcome, errorCode, outcomePersisted, leaseReleased, cancellationConfirmed,
      durationMs: Date.now() - acceptedAt, toolCalls: orchestrator?.toolCalls ?? 0,
      inputTokens: orchestrator?.inputTokens ?? 0, outputTokens: orchestrator?.outputTokens ?? 0 }));
  }
}

export const handler = awslambda.streamifyResponse(respond);
