import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ConversationStore, Lease, ToolPreparation } from '../../../../lambdas/ai/chat-orchestrator/store';
import { AssistantBlock, ModelResponse } from '../../../../lambdas/ai/chat-orchestrator/response';
import { historyRecord } from '../../../../lambdas/ai/chat-orchestrator/history-records';
import { callInput, responsePayloads, safeArguments, validateResponseGroups } from '../../../../lambdas/ai/chat-orchestrator/response-events';

const turnId = '11111111-1111-4111-8111-111111111111';
const attemptId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const responseId = '44444444-4444-4444-8444-444444444444';
const created = '2026-11-14T12:00:00.000Z';
const lease: Lease = { conversationId: 'conversation-one', turnId, attemptId, version: 1, expiresAt: Math.ceil(Date.now() / 1000) + 900 };
const metadata = { PK: 'CONV#conversation-one', SK: 'META', entity_type: 'CONVERSATION', schema_version: 1,
  conversation_id: lease.conversationId, owner_id: 'owner-one', created_at: created, updated_at: created,
  last_event_sequence: 1, lease_version: 1, history_projection_version: 1, history_through_sequence: 1, retry_projection_version: 1,
  latest_turn_id: turnId, active_turn_id: turnId, active_attempt_id: attemptId, lease_expires_at: lease.expiresAt,
  title: 'Synthetic', GSI1PK: 'USER#owner-one', GSI1SK: 'CONV#synthetic' };
const turn = { PK: metadata.PK, SK: `TURN#${turnId}`, schema_version: 1, entity_type: 'TURN_STATE', conversation_id: lease.conversationId,
  turn_id: turnId, attempt_id: attemptId, lease_version: 1, revision: 1, status: 'running', original_message: 'Synthetic request.',
  retryable: null, cancel_requested_at: null, user_event_id: userId, assistant_event_id: null, outcome_event_id: null, error_code: null,
  created_at: created, updated_at: created };

/** Constructs one complete synthetic response through the same public contract as ModelRunner. */
function response(blocks: AssistantBlock[], stopReason = 'end_turn'): ModelResponse {
  return { responseId, modelId: 'us.anthropic.claude-sonnet-4-6', purpose: 'investigation', blocks, stopReason,
    text: blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    toolUses: blocks.flatMap(block => block.type === 'tool_use' ? [{ id: block.id, name: block.name, index: block.index, input: block.input }] : []),
    inputTokens: 1, outputTokens: 1 };
}

/** Mocks only DynamoDB's send boundary; store validation, conditions, allocation and projections remain real. */
function sdk() {
  return jest.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async command => {
    if (command instanceof GetCommand) return { Item: command.input.Key?.SK === 'META' ? structuredClone(metadata) : structuredClone(turn) };
    if (command instanceof TransactWriteCommand) return {};
    throw new Error('Unexpected synthetic SDK operation');
  });
}

afterEach(() => jest.restoreAllMocks());

/** Proves group/public atomicity, exact input storage and existing lease/cancellation fences. */
describe('atomic private response persistence', () => {
  test('stores original rejected null with no duplicate arguments and no private HIST/TURN transition', async () => {
    const send = sdk(); const store = new ConversationStore('SOC-BOT-DEV-CHAT-HISTORY', 'owner-one');
    const model = response([{ index: 0, type: 'thinking', thinking: { type: 'text', text: '', signature: 'sig' } },
      { index: 1, type: 'tool_use', id: 'tool-one', name: 'describe_document', input: null }], 'tool_use');
    const records = await store.appendResponse(lease, model, new Map([['tool-one', { status: 'rejected', code: 'INVALID_TOOL_INPUT' }]]));
    const call = records.find(event => event.entity_type === 'TOOL_CALL')!;
    if (call.entity_type !== 'TOOL_CALL') throw new Error('Missing synthetic call');
    expect(callInput(call)).toBeNull(); expect(safeArguments(call)).toEqual({}); expect(call).not.toHaveProperty('arguments');
    expect(records.map(historyRecord)).toEqual([undefined, undefined]);
    const transaction = send.mock.calls.find(([command]) => command instanceof TransactWriteCommand)![0] as TransactWriteCommand;
    expect(transaction.input.TransactItems).toHaveLength(4);
    expect(transaction.input.TransactItems![1].Put?.Item).toEqual(turn);
    expect(transaction.input.TransactItems![0].Update?.ExpressionAttributeValues?.[':sequence']).toBe(3);
    expect(transaction.input.TransactItems![1].Put?.ConditionExpression).toContain('#cancel = :cancel');
  });

  test('publishes private blocks, public answer, HIST, TURN and watermark in one transaction', async () => {
    const send = sdk(); const store = new ConversationStore('SOC-BOT-DEV-CHAT-HISTORY', 'owner-one');
    const records = await store.appendResponse(lease, response([{ index: 0, type: 'thinking', thinking: { type: 'redacted', data: 'AP8B' } },
      { index: 1, type: 'text', text: 'Public answer.' }]));
    expect(() => validateResponseGroups(records)).not.toThrow();
    const transaction = send.mock.calls.find(([command]) => command instanceof TransactWriteCommand)![0] as TransactWriteCommand;
    const items = transaction.input.TransactItems!;
    expect(items).toHaveLength(6);
    expect(items[1].Put?.Item).toMatchObject({ status: 'complete', revision: 2, retryable: false });
    expect(items.at(-1)?.Put?.Item).toMatchObject({ entity_type: 'ASSISTANT_MESSAGE', content: 'Public answer.', SK: 'HIST#0000000004' });
    expect(items.at(-1)?.Put?.Item).not.toHaveProperty('assistant_message_id');
    expect(items[0].Update?.ExpressionAttributeValues?.[':sequence']).toBe(4);
    expect(send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
  });

  test('fits a maximum 64-block final group in 68 unique atomic actions', async () => {
    const send = sdk(); const store = new ConversationStore('SOC-BOT-DEV-CHAT-HISTORY', 'owner-one');
    await store.appendResponse(lease, response(Array.from({ length: 64 }, (_, index) => ({ index, type: 'text', text: 'x' }))));
    const command = send.mock.calls.find(([value]) => value instanceof TransactWriteCommand)![0] as TransactWriteCommand;
    expect(command.input.TransactItems).toHaveLength(68);
  });

  test('unknown writes are not resubmitted and malformed groups issue no transaction', async () => {
    const send = sdk(); send.mockImplementation(async command => {
      if (command instanceof GetCommand) return { Item: command.input.Key?.SK === 'META' ? metadata : turn };
      throw new Error('Synthetic unknown acknowledgement');
    });
    const store = new ConversationStore('SOC-BOT-DEV-CHAT-HISTORY', 'owner-one');
    await expect(store.appendResponse(lease, response([{ index: 0, type: 'text', text: 'Public.' }]))).rejects.toThrow('Synthetic unknown acknowledgement');
    expect(send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
    send.mockClear();
    await expect(store.appendResponse(lease, response([{ index: 1, type: 'text', text: 'Gap.' }]))).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    expect(send).not.toHaveBeenCalled();
  });

  test('accepted intent prevents final/private writes and a definitive intent race cannot erase its revision', async () => {
    const send = sdk(); let reads = 0;
    send.mockImplementation(async command => {
      if (command instanceof GetCommand) {
        if (command.input.Key?.SK === 'META') return { Item: metadata };
        reads++;
        return { Item: reads > 1 ? { ...turn, revision: 2, cancel_requested_at: created } : turn };
      }
      const error = Object.assign(new Error('Synthetic conditional conflict'), { name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }, { Code: 'None' }] });
      throw error;
    });
    const store = new ConversationStore('SOC-BOT-DEV-CHAT-HISTORY', 'owner-one');
    await expect(store.appendResponse(lease, response([{ index: 0, type: 'text', text: 'Public.' }]))).rejects.toMatchObject({ code: 'TURN_CANCEL_REQUESTED' });
    expect(send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
  });

  test('complete replay remains read-only against a new grouped final answer', async () => {
    const send = sdk(); const store = new ConversationStore('SOC-BOT-DEV-CHAT-HISTORY', 'owner-one');
    const records = await store.appendResponse(lease, response([{ index: 0, type: 'text', text: 'Saved answer.' }]));
    const transaction = send.mock.calls.find(([command]) => command instanceof TransactWriteCommand)![0] as TransactWriteCommand;
    const savedTurn = transaction.input.TransactItems![1].Put!.Item;
    const user = { PK: metadata.PK, SK: `EVT#${created}#0000000001#${userId}`, schema_version: 1,
      conversation_id: lease.conversationId, event_id: userId, event_sequence: 1, turn_id: turnId, created_at: created,
      entity_type: 'USER_MESSAGE', role: 'user', content: turn.original_message };
    send.mockClear(); send.mockImplementation(async command => {
      if (command instanceof GetCommand) return { Item: command.input.Key?.SK === 'META' ? { ...metadata, last_event_sequence: 3, history_through_sequence: 3 } : savedTurn };
      if (command instanceof QueryCommand) return { Items: [user, ...records] };
      throw new Error('Completed replay must not write');
    });
    const begun = await store.begin(lease.conversationId, turnId, turn.original_message, lease.expiresAt);
    expect(begun.state).toBe('completed');
    expect(send.mock.calls.every(([command]) => !(command instanceof TransactWriteCommand))).toBe(true);
  });

  test('rejects missing/mixed group metadata and preserves valid legacy input access', () => {
    const legacy = { entity_type: 'TOOL_CALL', arguments: { table: 'waf_events' }, preparation: { status: 'approved' } } as const;
    expect(callInput(legacy as never)).toEqual({ table: 'waf_events' });
    const payloads = responsePayloads(response([{ index: 0, type: 'tool_use', id: 'tool-one', name: 'describe_documents', input: {} }], 'tool_use'),
      new Map<string, ToolPreparation>([['tool-one', { status: 'approved' }]]));
    expect(() => validateResponseGroups([])).not.toThrow();
    expect(() => responsePayloads(response([{ index: 0, type: 'tool_use', id: 'tool-one', name: 'describe_documents', input: {} }], 'tool_use'), new Map())).toThrow();
    expect(payloads[0]).not.toHaveProperty('arguments');
  });
});
