import { Message } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';
import { ChatError, Configuration, MAX_TOOL_CALLS, TurnBudget } from './config';
import { buildContext, planCompaction } from './context';
import { LogicalQuery, validateTool } from './contracts';
import { ModelResponse, ModelRunner } from './model';
import { ChatEvent, ConversationStore, JsonObject, Lease, StoreError } from './store';
import { StreamEvent } from './stream';
import { isConfirmedQueryFailure, ToolExecutor } from './tools';

type ToolCall = Extract<ChatEvent, { entity_type: 'TOOL_CALL' }>;
interface PreparedCall { call: ToolCall; request?: LogicalQuery; rejection?: string }

/** Implements the bounded model loop without giving the model an AWS identity or direct query access. */
export class Orchestrator {
  public phase = 'recovery';
  public toolCalls = 0;
  public inputTokens = 0;
  public outputTokens = 0;
  private finalizationOnly = false;
  private readonly model: ModelRunner;
  public readonly tools: ToolExecutor;

  /**
   * Connects the accepted attempt's store, model runner, tool executor, time budget, and safe event emitter.
   *
   * Example Input (dependencies and lease abbreviated):
   * new Orchestrator(config, ConversationStore <authorized store>,
   *   { conversationId: 'conversation-A', turnId: '<turn-uuid>', attemptId: '<attempt-uuid>', version: 1, expiresAt: <future-epoch-seconds> },
   *   TurnBudget <time remaining>, async (event) => { ... })
   * Example Output (selected initial instance state):
   * { phase: 'recovery', toolCalls: 0, inputTokens: 0, outputTokens: 0, tools: ToolExecutor <instance> }
   * Constructing the object does not start a query or a model request.
   */
  public constructor(private readonly config: Configuration, private readonly store: ConversationStore,
    private readonly lease: Lease, private readonly budget: TurnBudget,
    private readonly emit: (event: StreamEvent) => Promise<void>) {
    this.model = new ModelRunner(config);
    this.tools = new ToolExecutor(config, budget, store, lease, emit);
  }

  /**
   * Reuses durable evidence, runs calls sequentially, and reserves a no-tools final answer request.
   *
   * Example Input (initialEvents reduced; matches this instance's current lease turn):
   * [{ entity_type: 'USER_MESSAGE', turn_id: '<turn-uuid>', event_sequence: 1, content: 'Describe waf_events.', ... }]
   * Example Output (illustrative final model response):
   * { text: 'The WAF table contains request and rule evidence.', toolUses: [], stopReason: 'end_turn', inputTokens: 1200, outputTokens: 40 }
   * Side effects may include TOOL_CALL/TOOL_RESULT persistence and activity/text_delta events.
   * This method does not append ASSISTANT_MESSAGE or emit complete; the handler does that after return.
   */
  public async run(initialEvents: readonly ChatEvent[]): Promise<ModelResponse> {
    this.toolCalls = initialEvents.filter(event => event.turn_id === this.lease.turnId && event.entity_type === 'TOOL_CALL').length;
    this.finalizationOnly = await this.tools.recover(initialEvents);
    while (true) {
      this.budget.check();
      const messages = await this.context();
      const allowTools = !this.finalizationOnly && this.toolCalls < MAX_TOOL_CALLS && this.budget.canDispatch(200_000);
      this.phase = allowTools ? 'model' : 'finalization';
      await this.emit({ type: 'activity', stage: allowTools ? 'investigating' : 'finalizing' });
      const response = await this.model.respond(messages, allowTools, this.budget,
        text => this.emit({ type: 'text_delta', text }));
      this.inputTokens += response.inputTokens;
      this.outputTokens += response.outputTokens;
      if (response.toolUses.length === 0) {
        if (!['end_turn', 'stop_sequence', 'max_tokens'].includes(response.stopReason)) {
          throw new ChatError('MODEL_INCOMPLETE_RESPONSE', 'The model did not complete an answer.');
        }
        return response;
      }
      this.phase = 'tools';
      const prepared = await this.prepare(response);
      for (let index = 0; index < prepared.length; index++) {
        const item = prepared[index];
        let confirmedFailure = false;
        try {
          if (item.rejection) {
            if (item.rejection === 'INVALID_TOOL') this.finalizationOnly = true;
            await this.rejected(item.call, item.rejection);
          } else if (!this.budget.canDispatch(200_000)) {
            this.finalizationOnly = true;
            await this.rejected(item.call, 'FINALIZATION_REQUIRED');
          } else {
            const output = await this.tools.execute(item.call, item.request!);
            confirmedFailure = isConfirmedQueryFailure(output);
          }
        } catch (error) {
          // These remaining calls are known not to have been dispatched. Keep their original grouping.
          for (const remaining of prepared.slice(index + 1)) await this.rejected(remaining.call, 'NOT_EXECUTED');
          throw error;
        }
        if (confirmedFailure) {
          this.finalizationOnly = true;
          // Keep this outside the catch: an uncertain rejection write must not be attempted twice.
          for (const remaining of prepared.slice(index + 1)) await this.rejected(remaining.call, 'NOT_EXECUTED');
          break;
        }
      }
    }
  }

  /**
   * Persists every block before dispatch, including invalid or excess calls, so retries cannot reset the cap.
   *
   * Example Input:
   * { text: '', toolUses: [{ id: 'tool-1', name: 'describe_table', index: 0, input: { table: 'waf_events' } }],
   *   stopReason: 'tool_use', inputTokens: 900, outputTokens: 30 }
   * Example Output (stored ChatEvent abbreviated):
   * [{ call: { entity_type: 'TOOL_CALL', tool_use_id: 'tool-1', tool_name: 'describe_table',
   *            arguments: { table: 'waf_events' }, assistant_message_id: '<generated-group-uuid>', content_block_index: 0, ... },
   *    request: { operation: 'describe_table', table: 'waf_events' }, rejection: undefined }]
   * An invalid/excess block instead has request: undefined and a rejection code; preparation never dispatches it.
   */
  private async prepare(response: ModelResponse): Promise<PreparedCall[]> {
    const assistantMessageId = randomUUID();
    const prepared: PreparedCall[] = [];
    for (const tool of response.toolUses) {
      this.toolCalls++;
      let request: LogicalQuery | undefined;
      let rejection: string | undefined;
      if (this.toolCalls > MAX_TOOL_CALLS) rejection = 'TOOL_LIMIT_REACHED';
      else if (!this.budget.canDispatch(200_000)) rejection = 'FINALIZATION_REQUIRED';
      else {
        try { request = validateTool(tool.name, tool.input, this.config); }
        catch (error) {
          if (!(error instanceof ChatError)) throw error;
          rejection = error.code;
        }
      }
      // Invalid inputs are not copied into audit history; the bounded rejection still counts as a call.
      const args = request ? Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'operation')) as JsonObject : {};
      const event = await this.store.append(this.lease, { entity_type: 'TOOL_CALL', assistant_message_id: assistantMessageId,
        content_block_index: tool.index, tool_use_id: tool.id, tool_name: tool.name, arguments: args });
      if (event.entity_type !== 'TOOL_CALL') throw new ChatError('STORAGE_ERROR', 'Conversation state could not be saved.');
      prepared.push({ call: event, request, rejection });
    }
    return prepared;
  }

  /**
   * Stores bounded tool errors without provider diagnostics, payloads, SQL, or fabricated evidence.
   *
   * Example Input (selected call fields):
   * { call: { tool_use_id: 'tool-2', tool_name: 'query_events', ... }, code: 'NOT_EXECUTED' }
   * Example Output: resolves to undefined; appended payload:
   * { entity_type: 'TOOL_RESULT', tool_use_id: 'tool-2', tool_name: 'query_events', status: 'error',
   *   output: { ok: false, error: { code: 'NOT_EXECUTED', message: 'This tool block was not executed. Use existing evidence or correct the approved input.' } } }
   * Storage failures propagate; an unsuccessful write is not treated as a saved rejection.
   */
  private async rejected(call: ToolCall, code: string): Promise<void> {
    await this.store.append(this.lease, { entity_type: 'TOOL_RESULT', tool_use_id: call.tool_use_id,
      tool_name: call.tool_name, status: 'error', output: { ok: false, error: { code,
        message: 'This tool block was not executed. Use existing evidence or correct the approved input.' } } });
  }

  /**
   * Summarizes bounded older completed prefixes while retaining audit records and retry barriers.
   *
   * Example Input: context() // no arguments; reads this instance's lease, store, and budget
   * With the current turn's stored user message 'Describe waf_events.' and no earlier history:
   * Example Output:
   * [{ role: 'user', content: [{ text: 'Describe waf_events.' }] }]
   * Larger eligible histories may produce a persisted summary and a summarizing activity before returning bounded messages.
   * No audit events are deleted, and an unsafe compaction boundary is not crossed.
   */
  private async context(): Promise<Message[]> {
    this.phase = 'context';
    const events = await this.store.reload(this.lease);
    let summary = await this.store.loadSummary(this.lease);
    while (true) {
      this.budget.check();
      let messages: Message[] | undefined;
      try { messages = buildContext(events, this.lease.turnId, this.lease.attemptId, summary); }
      catch (error) { if (!(error instanceof StoreError) || error.code !== 'CONTEXT_LIMIT') throw error; }
      if (messages && Buffer.byteLength(JSON.stringify(messages), 'utf8') <= 98_304) return messages;
      const plan = planCompaction(events, this.lease.turnId, summary);
      if (!plan.coversThrough || plan.eligibleEvents.length === 0) {
        if (messages) return messages;
        throw new ChatError('CONTEXT_LIMIT', 'The conversation cannot be compacted safely within the context limit.', 413, false);
      }
      if (!this.budget.canDispatch(90_000)) {
        if (messages) return messages;
        throw new ChatError('TURN_TIMED_OUT', 'The investigation reached its time limit.', 504);
      }
      await this.emit({ type: 'activity', stage: 'summarizing' });
      const text = await this.model.summarize(buildContext(plan.eligibleEvents, this.lease.turnId, '', summary), this.budget);
      summary = await this.store.saveSummary(this.lease, text, plan.coversThrough);
    }
  }
}
