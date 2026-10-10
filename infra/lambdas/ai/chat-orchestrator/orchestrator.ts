import { Message } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';
import { ChatError, Configuration, MAX_TOOL_CALLS, TurnBudget } from './config';
import { buildContext, planCompaction } from './context';
import { LogicalQuery, validateTool } from './contracts';
import { ModelResponse, ModelRunner } from './model';
import { ChatEvent, ConversationStore, JsonObject, Lease, StoreError } from './store';
import { StreamEvent } from './stream';
import { ToolExecutor } from './tools';

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

  public constructor(private readonly config: Configuration, private readonly store: ConversationStore,
    private readonly lease: Lease, private readonly budget: TurnBudget,
    private readonly emit: (event: StreamEvent) => Promise<void>) {
    this.model = new ModelRunner(config);
    this.tools = new ToolExecutor(config, budget, store, lease, emit);
  }

  /** Reuses durable evidence, runs calls sequentially, and reserves a no-tools final answer request. */
  public async run(initialEvents: readonly ChatEvent[]): Promise<ModelResponse> {
    this.toolCalls = initialEvents.filter(event => event.turn_id === this.lease.turnId && event.entity_type === 'TOOL_CALL').length;
    await this.tools.recover(initialEvents);
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
        try {
          if (item.rejection) {
            if (item.rejection === 'INVALID_TOOL') this.finalizationOnly = true;
            await this.rejected(item.call, item.rejection);
          } else if (!this.budget.canDispatch(200_000)) {
            this.finalizationOnly = true;
            await this.rejected(item.call, 'FINALIZATION_REQUIRED');
          } else await this.tools.execute(item.call, item.request!);
        } catch (error) {
          // These remaining calls are known not to have been dispatched. Keep their original grouping.
          for (const remaining of prepared.slice(index + 1)) await this.rejected(remaining.call, 'NOT_EXECUTED');
          throw error;
        }
      }
    }
  }

  /** Persists every block before dispatch, including invalid or excess calls, so retries cannot reset the cap. */
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

  /** Stores bounded tool errors without provider diagnostics, payloads, SQL, or fabricated evidence. */
  private async rejected(call: ToolCall, code: string): Promise<void> {
    await this.store.append(this.lease, { entity_type: 'TOOL_RESULT', tool_use_id: call.tool_use_id,
      tool_name: call.tool_name, status: 'error', output: { ok: false, error: { code,
        message: 'This tool block was not executed. Use existing evidence or correct the approved input.' } } });
  }

  /** Summarizes bounded older completed prefixes while retaining audit records and retry barriers. */
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
