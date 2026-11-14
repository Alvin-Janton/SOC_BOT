import { ContentBlock, Message } from '@aws-sdk/client-bedrock-runtime';
import { ChatError, Configuration, MAX_CONTEXT_BYTES, MAX_TOOL_CALLS, TurnBudget } from './config';
import { buildContext, isTerminalToolResult, planCompaction, selectToolResult } from './context';
import { ToolInputError, ToolRequest, isRagRequest, validateTool } from './contracts';
import { ToolValidation } from '../../../lib/shared/tool-validation';
import { ModelResponse, ModelRunner } from './model';
import { ChatEvent, ConversationStore, Lease, StoreError, ToolPreparation, ToolRejectionCode, isToolRejectionCode } from './store';
import { StreamEvent } from './stream';
import { isConfirmedQueryFailure, rejectedToolActivity, rejectedToolOutput, reportRejectedToolInput, ToolExecutor } from './tools';
import { appendExchange, budgetSnapshot, initialContext } from './active-context';
import { MAX_GROUP_BYTES, nativeBlocks, protocolError } from './response';

type ToolCall = Extract<ChatEvent, { entity_type: 'TOOL_CALL' }>;
interface PreparedCall { call: ToolCall; request?: ToolRequest; rejection?: ToolRejectionCode }

/** Owns one attempt's append-only native exchange; retries/finalization use fresh evidence-only contexts. */
export class Orchestrator {
  public phase = 'recovery';
  public toolCalls = 0;
  public inputTokens = 0;
  public outputTokens = 0;
  private finalizationOnly = false;
  private readonly model: ModelRunner;
  public readonly tools: ToolExecutor;
  private active: Message[] = [];
  private readonly toolIds = new Set<string>();

  /** Binds the admitted attempt without model, storage or tool dispatch during construction. */
  public constructor(private readonly config: Configuration, private readonly store: ConversationStore,
    private readonly lease: Lease, private readonly budget: TurnBudget,
    private readonly emit: (event: StreamEvent) => Promise<void>, cleanupStore = store) {
    this.model = new ModelRunner(config, (input, output) => { this.inputTokens += input; this.outputTokens += output; });
    this.tools = new ToolExecutor(config, budget, store, lease, emit, cleanupStore);
  }

  /** Recovers once and compacts only at entry; no later round rebuilds a signed active prefix. */
  public async run(initialEvents: readonly ChatEvent[]): Promise<ModelResponse> {
    this.toolCalls = initialEvents.filter(event => event.turn_id === this.lease.turnId && event.entity_type === 'TOOL_CALL').length;
    for (const event of initialEvents) if (event.entity_type === 'TOOL_CALL') this.toolIds.add(event.tool_use_id);
    await this.budget.checkpoint();
    this.finalizationOnly = await this.tools.recover(initialEvents);
    const entryAllowsTools = !this.finalizationOnly && this.toolCalls < MAX_TOOL_CALLS && this.budget.canDispatch(200_000);
    this.active = initialContext(await this.context(entryAllowsTools, true), this.toolCalls, entryAllowsTools);
    while (true) {
      this.budget.check();
      let allowTools = !this.finalizationOnly && this.toolCalls < MAX_TOOL_CALLS && this.budget.canDispatch(200_000);
      if (allowTools && this.model.bytes(this.active, true) + MAX_GROUP_BYTES > MAX_CONTEXT_BYTES) allowTools = false;
      const messages = allowTools ? this.active : initialContext(await this.context(false, false), this.toolCalls, false);
      this.phase = allowTools ? 'model' : 'finalization';
      await this.emit({ type: 'activity', stage: allowTools ? 'investigating' : 'finalizing' });
      if (this.config.environment === 'dev') {
        const remainingCalls = Math.max(0, MAX_TOOL_CALLS - this.toolCalls);
        console.info(JSON.stringify({ event: 'dev_tool_budget', conversationId: this.lease.conversationId,
          turnId: this.lease.turnId, attemptId: this.lease.attemptId, maxToolCalls: MAX_TOOL_CALLS,
          toolCallsUsed: this.toolCalls, remainingCalls, availableCalls: allowTools ? remainingCalls : 0,
          allowTools, finalizationOnly: this.finalizationOnly, remainingMs: this.budget.remaining() }));
      }
      const response = await this.model.respond(messages, allowTools, this.budget,
        text => this.emit({ type: 'text_delta', text }), () => this.emit({ type: 'activity', stage: 'thinking' }));
      if (!response.toolUses.length) return response;
      if (!allowTools) throw protocolError();
      this.phase = 'tools';
      const prepared = await this.prepare(response);
      const assistant = nativeBlocks(response.blocks);
      const results: ContentBlock[] = [];
      for (let index = 0; index < prepared.length; index++) {
        const item = prepared[index];
        let confirmedFailure = false;
        let haltQueue = false;
        try {
          await this.budget.checkpoint();
          if (item.rejection) {
            if (item.rejection === 'INVALID_TOOL') this.finalizationOnly = true;
            await this.rejected(item.call, item.rejection);
          } else if (!this.budget.canDispatch(200_000) || !this.hasHeadroom(assistant, results, prepared, index)) {
            this.finalizationOnly = true;
            await this.rejected(item.call, 'FINALIZATION_REQUIRED');
            haltQueue = true;
          } else {
            const output = await this.tools.execute(item.call, item.request!);
            confirmedFailure = !isRagRequest(item.request!) && isConfirmedQueryFailure(output);
          }
        } catch (error) {
          for (const remaining of prepared.slice(index + 1)) await this.rejected(remaining.call, 'NOT_EXECUTED');
          throw error;
        }
        if (confirmedFailure || haltQueue) {
          this.finalizationOnly = true;
          for (const remaining of prepared.slice(index + 1)) await this.rejected(remaining.call, 'NOT_EXECUTED');
          break;
        }
        // Use the actual persisted terminal representation, including errors, in the matching native result order.
        const events = await this.store.reload(this.lease);
        const result = selectToolResult(events, item.call);
        if (!result || !isTerminalToolResult(result)) throw new ChatError('STORAGE_ERROR', 'The tool outcome could not be confirmed.', 503, false);
        results.push({ toolResult: { toolUseId: item.call.tool_use_id, status: result.status, content: [{ json: structuredClone(result.output) }] } });
      }
      if (!this.finalizationOnly) {
        if (results.length !== prepared.length) throw protocolError();
        this.active = appendExchange(this.active, assistant, results, this.toolCalls,
          this.toolCalls < MAX_TOOL_CALLS && this.budget.canDispatch(200_000));
      }
    }
  }

  /** Reserves one real tool's worst-case result plus exact queued nonexecution/control envelopes before dispatch. */
  private hasHeadroom(assistant: readonly ContentBlock[], results: readonly ContentBlock[], prepared: readonly PreparedCall[], index: number): boolean {
    const rest: ContentBlock[] = prepared.slice(index).map((item, offset) => ({ toolResult: { toolUseId: item.call.tool_use_id,
      status: offset === 0 ? 'success' : 'error', content: [{ json: offset === 0 ? {} : rejectedToolOutput(item.call, item.rejection ?? 'NOT_EXECUTED') }] } }));
    const projected: Message[] = [...this.active, { role: 'assistant', content: [...assistant] },
      { role: 'user', content: [...results, ...rest, budgetSnapshot(this.toolCalls, true)] }];
    const maximum = isRagRequest(prepared[index].request!) ? 32_768 : 65_536;
    return this.model.bytes(projected, true) + maximum - 2 <= MAX_CONTEXT_BYTES;
  }

  /** Classifies all original calls and commits their complete response group before any execution can begin. */
  private async prepare(response: ModelResponse): Promise<PreparedCall[]> {
    const prepared = new Map<string, { request?: ToolRequest; rejection?: ToolRejectionCode }>();
    const decisions = new Map<string, ToolPreparation>();
    for (const tool of response.toolUses) {
      this.budget.check();
      if (this.toolIds.has(tool.id)) throw protocolError();
      this.toolIds.add(tool.id); this.toolCalls++;
      let request: ToolRequest | undefined;
      let rejection: ToolRejectionCode | undefined;
      let validation: ToolValidation | undefined;
      if (this.toolCalls > MAX_TOOL_CALLS) rejection = 'TOOL_LIMIT_REACHED';
      else if (!this.budget.canDispatch(200_000)) rejection = 'FINALIZATION_REQUIRED';
      else {
        try { request = validateTool(tool.name, structuredClone(tool.input), this.config); }
        catch (error) {
          if (!(error instanceof ChatError) || !isToolRejectionCode(error.code)) throw error;
          rejection = error.code;
          if (error instanceof ToolInputError && rejection === 'INVALID_TOOL_INPUT') validation = error.validation;
        }
      }
      decisions.set(tool.id, rejection === 'INVALID_TOOL_INPUT' ? { status: 'rejected', code: rejection, ...(validation ? { validation } : {}) }
        : rejection ? { status: 'rejected', code: rejection } : { status: 'approved' });
      prepared.set(tool.id, { request, rejection });
    }
    const events = await this.store.appendResponse(this.lease, response, decisions);
    return events.filter((event): event is ToolCall => event.entity_type === 'TOOL_CALL').map(call => ({ call, ...prepared.get(call.tool_use_id)! }));
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
  private async rejected(call: ToolCall, code: ToolRejectionCode | 'NOT_EXECUTED'): Promise<void> {
    await this.store.append(this.lease, { entity_type: 'TOOL_RESULT', tool_use_id: call.tool_use_id,
      tool_name: call.tool_name, status: 'error', output: rejectedToolOutput(call, code) });
    reportRejectedToolInput(call, code, this.config, this.lease);
    await this.emit(rejectedToolActivity(call, code));
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
  private async context(allowTools: boolean, compact: boolean): Promise<Message[]> {
    this.phase = 'context';
    const events = await this.store.reload(this.lease);
    let summary = await this.store.loadSummary(this.lease);
    while (true) {
      this.budget.check();
      let messages: Message[] | undefined;
      try { messages = buildContext(events, this.lease.turnId, this.lease.attemptId, summary); }
      catch (error) { if (!(error instanceof StoreError) || error.code !== 'CONTEXT_LIMIT') throw error; }
      if (messages && (!compact || this.model.bytes(initialContext(messages, this.toolCalls, allowTools), allowTools) <= 98_304)) return messages;
      if (!compact) throw new ChatError('CONTEXT_LIMIT', 'The conversation exceeds its finalization context limit.', 413, false);
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
