import { encodeModelInput } from '../../../../lambdas/ai/chat-orchestrator/model-input';
import * as contextModule from '../../../../lambdas/ai/chat-orchestrator/context';
import { BedrockRuntimeClient, ConverseStreamCommand, ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { Orchestrator } from '../../../../lambdas/ai/chat-orchestrator/orchestrator';
import { Configuration, TurnBudget } from '../../../../lambdas/ai/chat-orchestrator/config';
import { ChatEvent, ConversationStore, Lease } from '../../../../lambdas/ai/chat-orchestrator/store';
import { historyRecord } from '../../../../lambdas/ai/chat-orchestrator/history-records';

const turnId = '11111111-1111-4111-8111-111111111111';
const attemptId = '22222222-2222-4222-8222-222222222222';
const oldAttempt = '33333333-3333-4333-8333-333333333333';
const created = '2026-11-14T12:00:00.000Z';
const config: Configuration = { environment: 'demo', tableName: 'SOC-BOT-DEMO-CHAT-HISTORY', queryFunction: 'SOC-BOT-DEMO-QUERY-TOOL',
  ragFunction: 'SOC-BOT-DEMO-RAG-TOOL', region: 'us-east-1', modelId: 'us.anthropic.claude-sonnet-4-6', database: 'soc_bot_demo_security', maxQueryDays: 30 };

/** Supplies tiny complete SDK streams; private values are obviously synthetic and never taken from records. */
function stream(toolInput?: string, toolId = 'tool-one'): ConverseStreamOutput[] {
  const middle: ConverseStreamOutput[] = toolInput === undefined ? [
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Public answer.' } } }, { contentBlockStop: { contentBlockIndex: 0 } },
  ] : [
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'synthetic-private' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'synthetic-signature' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: toolId, name: 'describe_table' } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: toolInput } } } }, { contentBlockStop: { contentBlockIndex: 1 } },
  ];
  return [{ messageStart: { role: 'assistant' } }, ...middle, { messageStop: { stopReason: toolInput === undefined ? 'end_turn' : 'tool_use' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 1 } } }];
}

/** Creates complete synthetic audit envelopes used solely by mocked SDK replies. */
function event(sequence: number, payload: object, turn = turnId, attempt = attemptId): ChatEvent {
  const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  return { PK: 'CONV#conversation-one', SK: `EVT#${created}#${String(sequence).padStart(10, '0')}#${id}`, schema_version: 1,
    conversation_id: 'conversation-one', event_id: id, event_sequence: sequence, turn_id: turn, ...((payload as { entity_type?: string }).entity_type === 'USER_MESSAGE' ? {} : { attempt_id: attempt }), created_at: created, ...payload } as ChatEvent;
}

/** SDK JSON replies use plain same-realm objects; opaque bytes are tested separately at the parser boundary. */
function copy<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }

/** Mocks only the DynamoDB boundary, returning writes as subsequent reads without simulating IAM/conditions. */
function storage(earlier: ChatEvent[] = [], version = 1, unknownGroup = false) {
  const existingUser = earlier.find(row => row.turn_id === turnId && row.entity_type === 'USER_MESSAGE');
  const user = existingUser ?? event(earlier.length + 1, { entity_type: 'USER_MESSAGE', role: 'user', content: 'Synthetic request.' });
  const records = existingUser ? [...earlier] : [...earlier, user];
  const lease: Lease = { conversationId: 'conversation-one', turnId, attemptId, version, expiresAt: Math.ceil(Date.now() / 1000) + 900 };
  const metadata: Record<string, unknown> = { PK: user.PK, SK: 'META', entity_type: 'CONVERSATION', schema_version: 1, conversation_id: lease.conversationId,
    owner_id: 'owner-one', created_at: created, updated_at: created, last_event_sequence: records.length, lease_version: version,
    history_projection_version: 1, history_through_sequence: records.length, retry_projection_version: 1, latest_turn_id: turnId,
    active_turn_id: turnId, active_attempt_id: attemptId, lease_expires_at: lease.expiresAt, title: 'Synthetic', GSI1PK: 'USER#owner-one', GSI1SK: 'CONV#synthetic' };
  const items = new Map<string, Record<string, unknown>>([[user.PK + '|META', metadata], [user.PK + `|TURN#${turnId}`, {
    PK: user.PK, SK: `TURN#${turnId}`, schema_version: 1, entity_type: 'TURN_STATE', conversation_id: lease.conversationId, turn_id: turnId,
    attempt_id: attemptId, lease_version: version, revision: version, status: 'running', original_message: 'Synthetic request.', retryable: null,
    cancel_requested_at: null, user_event_id: user.event_id, assistant_event_id: null, outcome_event_id: null, error_code: null,
    created_at: created, updated_at: created,
  }]]);
  for (const row of records) { items.set(row.PK + '|' + row.SK, { ...row }); const copy = historyRecord(row); if (copy) items.set(copy.PK + '|' + copy.SK, copy); }
  const send = jest.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async command => {
    if (command instanceof GetCommand) return { Item: copy(items.get(command.input.Key?.PK + '|' + command.input.Key?.SK)) };
    if (command instanceof QueryCommand) return { Items: [...items.values()].filter(item => String(item.SK).startsWith('EVT#')).sort((a, b) => Number(a.event_sequence) - Number(b.event_sequence)).map(item => copy(item)) };
    if (command instanceof TransactWriteCommand) {
      if (unknownGroup && command.input.TransactItems?.some(item => item.Put?.Item?.response_format === 1)) throw new Error('Synthetic unknown group write');
      for (const action of command.input.TransactItems ?? []) {
        if (action.Put) items.set(action.Put.Item!.PK + '|' + action.Put.Item!.SK, copy(action.Put.Item!));
        if (action.Update) {
          const values = action.Update.ExpressionAttributeValues!;
          Object.assign(metadata, { last_event_sequence: values[':sequence'], history_through_sequence: values[':sequence'] });
          if (values[':summary']) Object.assign(metadata, { latest_summary_sk: values[':summary'], summary_covers_through_sk: values[':checkpoint'] });
        }
      }
      return {};
    }
    throw new Error('Unexpected synthetic SDK command');
  });
  return { send, items, records, lease, store: new ConversationStore(config.tableName, 'owner-one') };
}

afterEach(() => jest.restoreAllMocks());

/** Runs the real model/store/orchestrator loop with only service SDKs mocked. */
describe('thinking tool-loop boundaries', () => {
  test('commits before execution and keeps the exact earlier system/tools/snapshots/signature prefix', async () => {
    const state = storage(); const requests: ConverseStreamCommand['input'][] = [];
    jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async command => {
      requests.push(copy((command as ConverseStreamCommand).input));
      return { stream: (async function* () { yield* stream(requests.length === 1 ? '{"table":"waf_events"}' : undefined); })() };
    });
    const invoke = jest.spyOn(LambdaClient.prototype, 'send').mockImplementation(async () => {
      expect([...state.items.values()].filter(item => item.response_format === 1)).toHaveLength(2);
      return { StatusCode: 200, Payload: Buffer.from(JSON.stringify({ ok: true, table: 'waf_events', columns: [] })) };
    });
    const activity = jest.fn(); const orchestrator = new Orchestrator(config, state.store, state.lease, new TurnBudget(Date.now()), activity);
    const result = await orchestrator.run(state.records);
    expect(result.text).toBe('Public answer.'); expect(invoke).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2); expect(requests[1].system).toEqual(requests[0].system); expect(requests[1].toolConfig).toEqual(requests[0].toolConfig);
    expect(requests[1].messages!.slice(0, requests[0].messages!.length)).toEqual(requests[0].messages);
    const native = requests[1].messages![requests[0].messages!.length].content!;
    expect(native[0].reasoningContent).toEqual({ reasoningText: { text: 'synthetic-private', signature: 'synthetic-signature' } });
    expect(requests[1].messages!.at(-1)?.content?.[0].toolResult).toBeDefined();
    expect(requests[1].messages!.at(-1)?.content?.at(-1)?.text).toContain('"used":1');
    expect(activity.mock.calls.filter(([entry]) => entry.stage === 'thinking')).toHaveLength(1);
    expect(orchestrator.inputTokens).toBe(20); expect(orchestrator.outputTokens).toBe(10);
  });

  test('persists raw null rejection without executing it and replays that exact input in the active chain', async () => {
    const state = storage(); const requests: ConverseStreamCommand['input'][] = [];
    jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async command => {
      requests.push(copy((command as ConverseStreamCommand).input));
      return { stream: (async function* () { yield* stream(requests.length === 1 ? 'null' : undefined); })() };
    });
    const invoke = jest.spyOn(LambdaClient.prototype, 'send');
    await new Orchestrator(config, state.store, state.lease, new TurnBudget(Date.now()), async () => {}).run(state.records);
    expect(invoke).not.toHaveBeenCalled();
    const call = [...state.items.values()].find(item => item.entity_type === 'TOOL_CALL')!;
    expect(call.model_input).toEqual({ encoding: 'json_text_v1', json: 'null' }); expect(call).not.toHaveProperty('arguments');
    expect(requests[1].messages![requests[0].messages!.length].content?.[1].toolUse?.input).toBeNull();
  });

  test('unknown group persistence prevents all execution and model redispatch', async () => {
    const state = storage([], 1, true);
    const model = jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async () => ({ stream: (async function* () { yield* stream('{"table":"waf_events"}'); })() }));
    const invoke = jest.spyOn(LambdaClient.prototype, 'send');
    await expect(new Orchestrator(config, state.store, state.lease, new TurnBudget(Date.now()), async () => {}).run(state.records)).rejects.toThrow('Synthetic unknown group write');
    expect(model).toHaveBeenCalledTimes(1); expect(invoke).not.toHaveBeenCalled();
  });

  test('a retry with eight previously rejected calls finalizes fresh without old reasoning or new allowance', async () => {
    const prior: ChatEvent[] = [event(1, { entity_type: 'USER_MESSAGE', role: 'user', content: 'Synthetic request.' })];
    for (let index = 0; index < 8; index++) {
      prior.push(event(prior.length + 1, { entity_type: 'TOOL_CALL', assistant_message_id: 'legacy-group', content_block_index: index,
        tool_use_id: `prior-${index}`, tool_name: 'describe_documents', arguments: {}, preparation: { status: 'rejected', code: 'INVALID_TOOL_INPUT' } }, turnId, oldAttempt));
      prior.push(event(prior.length + 1, { entity_type: 'TOOL_RESULT', tool_use_id: `prior-${index}`, tool_name: 'describe_documents', status: 'error',
        output: { ok: false, error: { code: 'INVALID_TOOL_INPUT', message: 'Synthetic rejection.' } } }, turnId, oldAttempt));
    }
    const state = storage(prior, 2); const requests: ConverseStreamCommand['input'][] = [];
    jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async command => {
      requests.push(copy((command as ConverseStreamCommand).input)); return { stream: (async function* () { yield* stream(); })() };
    });
    const invoke = jest.spyOn(LambdaClient.prototype, 'send');
    const orchestrator = new Orchestrator(config, state.store, state.lease, new TurnBudget(Date.now()), async () => {});
    await orchestrator.run(state.records);
    expect(orchestrator.toolCalls).toBe(8); expect(invoke).not.toHaveBeenCalled(); expect(requests).toHaveLength(1);
    expect(requests[0].toolConfig).toBeUndefined(); expect(requests[0].additionalModelRequestFields).toMatchObject({ thinking: { type: 'adaptive' } });
    expect(requests[0].messages!.flatMap(message => message.content ?? []).map(block => block.text ?? '').join('')).toContain('"used":8');
    expect(requests[0].messages!.every(message => message.content!.every(block => !block.reasoningContent && !block.toolUse && !block.toolResult))).toBe(true);
  });
  test('fresh retry reuses confirmed evidence but never prior-attempt thinking or intermediate prose', async () => {
    const group = '44444444-4444-4444-8444-444444444444';
    const common = { response_format: 1, response_block_count: 3, assistant_message_id: group, model_id: config.modelId, stop_reason: 'tool_use', purpose: 'investigation' };
    const prior = [event(1, { entity_type: 'USER_MESSAGE', role: 'user', content: 'Synthetic request.' }),
      event(2, { ...common, entity_type: 'THINKING', content_block_index: 0, thinking: { type: 'text', text: 'old-private', signature: 'old-signature' } }, turnId, oldAttempt),
      event(3, { ...common, entity_type: 'ASSISTANT_TEXT', content_block_index: 1, text: 'old-intermediate' }, turnId, oldAttempt),
      event(4, { ...common, entity_type: 'TOOL_CALL', content_block_index: 2, tool_use_id: 'prior-one', tool_name: 'describe_table',
        model_input: encodeModelInput({ table: 'waf_events' }), preparation: { status: 'approved' } }, turnId, oldAttempt),
      event(5, { entity_type: 'TOOL_RESULT', tool_use_id: 'prior-one', tool_name: 'describe_table', status: 'success', output: { ok: true, table: 'waf_events', description: 'confirmed-evidence' } }, turnId, oldAttempt),
      event(6, { entity_type: 'TURN_OUTCOME', outcome: 'failed', retryable: true, failure_phase: 'model', error_code: 'MODEL_SERVICE_ERROR' }, turnId, oldAttempt)];
    const state = storage(prior, 2); const inputs: ConverseStreamCommand['input'][] = [];
    jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async command => {
      inputs.push(copy((command as ConverseStreamCommand).input)); return { stream: (async function* () { yield* stream(); })() };
    });
    const invoke = jest.spyOn(LambdaClient.prototype, 'send');
    const orchestrator = new Orchestrator(config, state.store, state.lease, new TurnBudget(Date.now()), async () => {});
    await orchestrator.run(state.records);
    const serialized = JSON.stringify(inputs[0].messages);
    expect(serialized).toContain('confirmed-evidence'); expect(orchestrator.toolCalls).toBe(1); expect(invoke).not.toHaveBeenCalled();
    for (const privateValue of ['old-private', 'old-signature', 'old-intermediate']) expect(serialized).not.toContain(privateValue);
    expect(inputs[0].messages!.every(message => message.content!.every(block => !block.reasoningContent && !block.toolUse && !block.toolResult))).toBe(true);
  });

  test('interrupted new-format rejection recovers once without revalidation or tool invocation', async () => {
    const group = '44444444-4444-4444-8444-444444444444';
    const prior = [event(1, { entity_type: 'USER_MESSAGE', role: 'user', content: 'Synthetic request.' }),
      event(2, { entity_type: 'TOOL_CALL', response_format: 1, response_block_count: 1, assistant_message_id: group,
        content_block_index: 0, model_id: config.modelId, stop_reason: 'tool_use', purpose: 'investigation',
        tool_use_id: 'prior-rejected', tool_name: 'describe_documents', model_input: encodeModelInput(null),
        preparation: { status: 'rejected', code: 'INVALID_TOOL_INPUT' } }, turnId, oldAttempt)];
    const state = storage(prior, 2); const requests: ConverseStreamCommand['input'][] = [];
    jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async command => {
      requests.push(copy((command as ConverseStreamCommand).input)); return { stream: (async function* () { yield* stream(); })() };
    });
    const invoke = jest.spyOn(LambdaClient.prototype, 'send');
    const orchestrator = new Orchestrator(config, state.store, state.lease, new TurnBudget(Date.now()), async () => {});
    await orchestrator.run(state.records);
    const results = [...state.items.values()].filter(item => item.entity_type === 'TOOL_RESULT');
    expect(results).toHaveLength(1); expect(results[0].output).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_INPUT' } });
    expect(orchestrator.toolCalls).toBe(1); expect(invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(requests[0].messages)).toContain('INVALID_TOOL_INPUT');
    await orchestrator.tools.recover(await state.store.reload(state.lease));
    expect([...state.items.values()].filter(item => item.entity_type === 'TOOL_RESULT')).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('post-response result headroom stops the current and queued calls before dispatch', async () => {
    const prior: ChatEvent[] = [];
    for (let index = 0; index < 6; index++) {
      const id = `aaaa0000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      prior.push(event(prior.length + 1, { entity_type: 'USER_MESSAGE', role: 'user', content: 'u'.repeat(6000) }, id, oldAttempt));
      prior.push(event(prior.length + 1, { entity_type: 'ASSISTANT_MESSAGE', role: 'assistant', content: 'a'.repeat(14000), model_id: config.modelId, stop_reason: 'end_turn' }, id, oldAttempt));
    }
    const state = storage(prior); const requests: ConverseStreamCommand['input'][] = [];
    jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async command => {
      requests.push(copy((command as ConverseStreamCommand).input));
      const response = stream(requests.length === 1 ? '{"table":"waf_events"}' : undefined);
      if (requests.length === 1) {
        response[1] = { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'r'.repeat(60000) } } } };
        response.splice(-2, 0,
          { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'tool-two', name: 'describe_table' } } } },
          { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '{"table":"waf_events"}' } } } },
          { contentBlockStop: { contentBlockIndex: 2 } });
      }
      return { stream: (async function* () { yield* response; })() };
    });
    const invoke = jest.spyOn(LambdaClient.prototype, 'send');
    await new Orchestrator(config, state.store, state.lease, new TurnBudget(Date.now()), async () => {}).run(state.records);
    expect(requests).toHaveLength(2); expect(requests[0].toolConfig).toBeDefined(); expect(requests[1].toolConfig).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    const results = [...state.items.values()].filter(item => item.entity_type === 'TOOL_RESULT');
    expect(results).toHaveLength(2);
    expect(results[0].output).toMatchObject({ error: { code: 'FINALIZATION_REQUIRED' } });
    expect(results[1].output).toMatchObject({ error: { code: 'NOT_EXECUTED' } });
    expect(requests[1].messages!.every(message => message.content!.every(block => !block.reasoningContent && !block.toolUse))).toBe(true);
  });

  test('time-limited attempts finalize with fresh adaptive thinking and no tools', async () => {
    const state = storage(); const requests: ConverseStreamCommand['input'][] = [];
    jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async command => {
      requests.push(copy((command as ConverseStreamCommand).input)); return { stream: (async function* () { yield* stream(); })() };
    });
    await new Orchestrator(config, state.store, state.lease, new TurnBudget(Date.now() - 360_000), async () => {}).run(state.records);
    expect(requests).toHaveLength(1); expect(requests[0].toolConfig).toBeUndefined();
    expect(requests[0].additionalModelRequestFields).toMatchObject({ thinking: { type: 'adaptive' } });
  });

  test.each([false, true])('compacts only at entry; private-free summary and context-headroom finalization=%s', async headroom => {
    const prior: ChatEvent[] = [];
    for (let index = 0; index < 8; index++) {
      const id = `aaaa0000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      const common = { response_format: 1, response_block_count: 2, assistant_message_id: id, model_id: config.modelId, stop_reason: 'end_turn', purpose: 'investigation' };
      const answer = 'a'.repeat(headroom ? 23000 : 6000);
      prior.push(event(prior.length + 1, { entity_type: 'USER_MESSAGE', role: 'user', content: 'u'.repeat(headroom ? 8000 : 6000) }, id, oldAttempt));
      prior.push(event(prior.length + 1, { ...common, entity_type: 'THINKING', content_block_index: 0, thinking: { type: 'text', text: 'older-private', signature: 'older-signature' } }, id, oldAttempt));
      prior.push(event(prior.length + 1, { ...common, entity_type: 'ASSISTANT_TEXT', content_block_index: 1, text: answer }, id, oldAttempt));
      prior.push(event(prior.length + 1, { entity_type: 'ASSISTANT_MESSAGE', role: 'assistant', content: answer,
        model_id: config.modelId, stop_reason: 'end_turn', assistant_message_id: id }, id, oldAttempt));
    }
    const state = storage(prior); const compact = jest.spyOn(contextModule, 'planCompaction');
    const requests: ConverseStreamCommand['input'][] = []; let normal = 0; let entryCalls = 0;
    jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async command => {
      const input = copy((command as ConverseStreamCommand).input); requests.push(input);
      const summary = input.inferenceConfig?.maxTokens === 1024;
      if (!summary) { normal++; if (normal === 1) entryCalls = compact.mock.calls.length; }
      return { stream: (async function* () { yield* stream(!summary && !headroom && normal === 1 ? '{"table":"waf_events"}' : undefined); })() };
    });
    const invoke = jest.spyOn(LambdaClient.prototype, 'send').mockImplementation(async () => ({ StatusCode: 200,
      Payload: Buffer.from(JSON.stringify({ ok: true, table: 'waf_events', description: 'e'.repeat(30000) })) }));
    await new Orchestrator(config, state.store, state.lease, new TurnBudget(Date.now()), async () => {}).run(state.records);
    const summaries = requests.filter(input => input.inferenceConfig?.maxTokens === 1024);
    expect(summaries).toHaveLength(1); expect(compact.mock.calls.length).toBe(entryCalls);
    expect(JSON.stringify(summaries[0].messages)).not.toContain('older-private'); expect(JSON.stringify(summaries[0].messages)).not.toContain('older-signature');
    expect(summaries[0].additionalModelRequestFields).toEqual({ thinking: { type: 'disabled' } });
    const normalRequests = requests.filter(input => input.inferenceConfig?.maxTokens === 8192);
    if (headroom) { expect(normalRequests).toHaveLength(1); expect(normalRequests[0].toolConfig).toBeUndefined(); expect(invoke).not.toHaveBeenCalled(); }
    else { expect(normalRequests).toHaveLength(2); expect(normalRequests[1].messages!.slice(0, normalRequests[0].messages!.length)).toEqual(normalRequests[0].messages); }
    expect([...state.items.values()].filter(item => String(item.SK).startsWith('EVT#')).length).toBeGreaterThanOrEqual(prior.length);
  });

});
