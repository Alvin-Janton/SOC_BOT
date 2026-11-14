import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { decodeModelInput, encodeModelInput, parseModelInput } from '../../../../lambdas/ai/chat-orchestrator/model-input';
import type { JsonValue } from '../../../../lambdas/ai/chat-orchestrator/store';
import { BedrockRuntimeClient, ConverseStreamCommand, ConverseStreamOutput, Message, StopReason } from '@aws-sdk/client-bedrock-runtime';
import { Configuration, TurnBudget } from '../../../../lambdas/ai/chat-orchestrator/config';
import { ModelRunner } from '../../../../lambdas/ai/chat-orchestrator/model';
import { AssistantBlock, boundRequest, groupBytes, jsonBytes, MAX_GROUP_BYTES, nativeBlocks, validateBlocks } from '../../../../lambdas/ai/chat-orchestrator/response';
import { appendExchange, initialContext } from '../../../../lambdas/ai/chat-orchestrator/active-context';
import { boundRecord, boundResponseTransaction } from '../../../../lambdas/ai/chat-orchestrator/response-transaction';

const config: Configuration = { environment: 'dev', tableName: 'SOC-BOT-DEV-CHAT-HISTORY', queryFunction: 'SOC-BOT-DEV-QUERY-TOOL',
  ragFunction: 'SOC-BOT-DEV-RAG-TOOL', region: 'us-east-1', modelId: 'us.anthropic.claude-sonnet-4-6', database: 'soc_bot_dev_security', maxQueryDays: 30 };
const messages: Message[] = [{ role: 'user', content: [{ text: 'Synthetic request.' }] }];

/** Wraps synthetic middle events in the real SDK envelope; no network or provider data is used. */
function events(middle: ConverseStreamOutput[], stopReason: StopReason = 'end_turn'): ConverseStreamOutput[] {
  return [{ messageStart: { role: 'assistant' } }, ...middle, { messageStop: { stopReason } },
    { metadata: { usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 }, metrics: { latencyMs: 1 } } }];
}

/** Runs the production parser against one mocked SDK boundary and captures public callbacks. */
async function run(middle: ConverseStreamOutput[], stopReason: StopReason = 'end_turn', allowTools = false) {
  const send = jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async () => ({ stream: (async function* () { yield* events(middle, stopReason); })() }));
  const text = jest.fn(); const thinking = jest.fn(); const usage = jest.fn();
  const response = await new ModelRunner(config, usage).respond(messages, allowTools, new TurnBudget(Date.now()), text, thinking);
  return { response, send, text, thinking, usage };
}

// Each case owns its SDK spy; restored mocks cannot carry synthetic output into another request.
afterEach(() => jest.restoreAllMocks());

/** Exercises actual Converse reasoning unions, ordered reconstruction and privacy callbacks. */
describe('adaptive response assembly', () => {
  test('preserves fragmented text/signature, empty thinking text and ordered tool blocks', async () => {
    const result = await run([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: '' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'sig-' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'one' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Inter' } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'mediate.' } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'tool-one', name: 'describe_documents' } } } },
      { contentBlockStop: { contentBlockIndex: 2 } },
    ], 'tool_use', true);
    expect(result.response.blocks).toEqual([
      { index: 0, type: 'thinking', thinking: { type: 'text', text: '', signature: 'sig-one' } },
      { index: 1, type: 'text', text: 'Intermediate.' },
      { index: 2, type: 'tool_use', id: 'tool-one', name: 'describe_documents', input: {} },
    ]);
    expect(result.thinking).toHaveBeenCalledTimes(1);
    expect(result.thinking).toHaveBeenCalledWith();
    expect(result.text).not.toHaveBeenCalled();
    expect(result.usage).toHaveBeenCalledWith(12, 7);
  });

  test('round-trips opaque redacted bytes without exposing them or reasoning to public text', async () => {
    const { response, text, thinking } = await run([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: new Uint8Array([0, 255]) } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: new Uint8Array([1]) } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Public answer.' } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
    ]);
    expect(nativeBlocks(response.blocks)[0]).toEqual({ reasoningContent: { redactedContent: new Uint8Array([0, 255, 1]) } });
    expect(text.mock.calls).toEqual([['Public answer.']]);
    expect(thinking).toHaveBeenCalledTimes(1);
  });

  test('accepts adaptive responses without a thinking block and keeps max_tokens truncation', async () => {
    const { response, thinking } = await run([{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Partial.' } } },
      { contentBlockStop: { contentBlockIndex: 0 } }], 'max_tokens');
    expect(response.stopReason).toBe('max_tokens'); expect(response.text).toBe('Partial.'); expect(thinking).not.toHaveBeenCalled();
  });

  test.each([
    [{ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'private' } } } }, { contentBlockStop: { contentBlockIndex: 0 } }],
    [{ contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'out of order' } } }],
    [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'unclosed' } } }],
    [{ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'sig' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: new Uint8Array([1]) } } } }],
    [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'closed' } } }, { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'late' } } }],
  ] as ConverseStreamOutput[][])('rejects malformed lifecycle/union/signature groups without returning partial blocks', async (...middle) => {
    await expect(run(middle)).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_ERROR' });
  });

  test('rejects thinking-only output rather than publishing a completed answer', async () => {
    await expect(run([{ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'sig' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } }], 'max_tokens')).rejects.toMatchObject({ code: 'MODEL_EMPTY_RESPONSE' });
  });

  test('investigation/finalization use adaptive medium 8192 without sampling; summary stays disabled', async () => {
    const send = jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async () => ({ stream: (async function* () {
      yield* events([{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Public.' } } }, { contentBlockStop: { contentBlockIndex: 0 } }]);
    })() }));
    const model = new ModelRunner(config);
    await model.respond(messages, true, new TurnBudget(Date.now()), async () => {});
    await model.respond(messages, false, new TurnBudget(Date.now()), async () => {});
    await model.summarize(messages, new TurnBudget(Date.now()));
    const inputs = send.mock.calls.map(call => (call[0] as ConverseStreamCommand).input);
    for (const input of inputs.slice(0, 2)) {
      expect(input.inferenceConfig).toEqual({ maxTokens: 8192 });
      expect(input.additionalModelRequestFields).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
    }
    expect(inputs[0].toolConfig).toBeDefined(); expect(inputs[1].toolConfig).toBeUndefined();
    expect(inputs[2].inferenceConfig).toEqual({ maxTokens: 1024, temperature: 0 });
    expect(inputs[2].additionalModelRequestFields).toEqual({ thinking: { type: 'disabled' } });
  });

  test('cancellation aborts reasoning through the existing signal before a response can complete', async () => {
    const control = new AbortController(); const budget = new TurnBudget(Date.now());
    budget.attach({ signal: control.signal, check: () => { if (control.signal.aborted) throw new Error('synthetic interruption'); }, checkpoint: async () => {} });
    jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async () => ({ stream: (async function* () {
      yield { messageStart: { role: 'assistant' } }; control.abort();
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'sig' } } } };
    })() }));
    await expect(new ModelRunner(config).respond(messages, true, budget, async () => {})).rejects.toThrow();
  });
});

/** Exercises the real codec and installed marshaller without a DynamoDB request or numeric coercion. */
describe('versioned private model-input storage', () => {
  test.each(['null', '[true,"snow:雪",null]', '{"quantity":0.25}', '1e100', '1e308', '1e-200'])('round-trips %s through DynamoDB as text and restores identical native input', raw => {
    const original = parseModelInput(raw);
    const stored = encodeModelInput(original);
    const restored = unmarshall(marshall({ model_input: stored })).model_input;
    expect(decodeModelInput(restored)).toEqual(original);
    expect(nativeBlocks([{ index: 0, type: 'tool_use', id: 'tool-one', name: 'describe_document', input: decodeModelInput(restored) }])[0].toolUse?.input).toEqual(original);
    expect(stored.encoding).toBe('json_text_v1');
    expect(typeof stored.json).toBe('string');
  });

  test.each(['{', ' ', 'NaN', '1e400', '1e-400', '9007199254740993', '0.123456789012345678901', '-0'])('rejects malformed or unsupported source numeric precision: %s', raw => {
    expect(() => parseModelInput(raw)).toThrow();
  });

  test('never silently converts unsupported values to null or omits them', () => {
    const withSymbol = [1]; Object.defineProperty(withSymbol, Symbol('ignored'), { value: true });
    const accessor: number[] = []; Object.defineProperty(accessor, '0', { get: () => 1, enumerable: true });
    for (const value of [NaN, Infinity, -Infinity, undefined, -0, BigInt(1), [undefined], Array(1), { ignored: undefined }, withSymbol, accessor]) {
      expect(() => encodeModelInput(value as JsonValue)).toThrow();
    }
  });

  test('unknown/mixed versions and malformed/noncanonical stored text never fall back to legacy input', () => {
    for (const value of [null, { encoding: 'unknown', json: 'null' }, { encoding: 'json_text_v1', json: '{' },
      { encoding: 'json_text_v1', json: ' null ' }, { encoding: 'json_text_v1', json: '1e400' },
      { encoding: 'json_text_v1', json: 'null', arguments: {} }]) expect(() => decodeModelInput(value)).toThrow();
  });

  test('measures the 16-KiB encoded envelope including escaping overhead', () => {
    const prefix = '雪\n"';
    const minimum = jsonBytes(encodeModelInput(prefix));
    const value = prefix + 'x'.repeat(16384 - minimum);
    expect(jsonBytes(encodeModelInput(value))).toBe(16384);
    expect(decodeModelInput(encodeModelInput(value))).toBe(value);
    expect(() => encodeModelInput(value + 'x')).toThrow();
    // The raw JSON fits, but nested stored-string escaping and version metadata must also fit.
    expect(Buffer.byteLength(JSON.stringify(value + 'x'))).toBeLessThan(16384);
  });
});

/** Locks down exact JSON/UTF-8/base64 byte controls and append-only native budget history. */
describe('response byte limits and stable active context', () => {
  test('counts escaped UTF-8 and base64 at the aggregate 64-KiB boundary', () => {
    const blocks: AssistantBlock[] = [{ index: 0, type: 'thinking', thinking: { type: 'text', text: '雪\n', signature: '' } }];
    const thinking = blocks[0].type === 'thinking' && blocks[0].thinking.type === 'text' ? blocks[0].thinking : undefined;
    thinking!.signature = 's'.repeat(MAX_GROUP_BYTES - groupBytes(blocks));
    expect(groupBytes(blocks)).toBe(MAX_GROUP_BYTES); expect(() => validateBlocks(blocks, 'end_turn', 'investigation')).not.toThrow();
    thinking!.signature += 's'; expect(() => validateBlocks(blocks, 'end_turn', 'investigation')).toThrow();
    const native = [{ reasoningContent: { redactedContent: new Uint8Array([0, 255, 1]) } }];
    expect(jsonBytes(native)).toBe(Buffer.byteLength(JSON.stringify([{ reasoningContent: { redactedContent: 'AP8B' } }])));
  });

  test('checks whole 256-KiB request and 96-KiB envelope exactly, not per-content character counts', () => {
    const input = { modelId: 'synthetic', messages: [{ role: 'user' as const, content: [{ text: '' }] }] };
    input.messages[0].content[0].text = 'x'.repeat(262144 - jsonBytes(input));
    expect(() => boundRequest(input)).not.toThrow(); input.messages[0].content[0].text += 'x'; expect(() => boundRequest(input)).toThrow();
    const record = { PK: 'synthetic', SK: 'synthetic', text: '' };
    record.text = 'x'.repeat(98304 - jsonBytes(record)); expect(() => boundRecord(record)).not.toThrow();
    record.text += 'x'; expect(() => boundRecord(record)).toThrow();
  });

  test('enforces 100 distinct transaction keys and the serialized four-MiB transaction cap', () => {
    const items = Array.from({ length: 100 }, (_, index) => ({ Put: { TableName: 'synthetic', Item: { PK: 'same', SK: String(index) } } }));
    expect(() => boundResponseTransaction(items)).not.toThrow();
    expect(() => boundResponseTransaction([...items, items[0]])).toThrow();
    expect(() => boundResponseTransaction([items[0], items[0]])).toThrow();
    expect(() => boundResponseTransaction([{ Put: { TableName: 'synthetic', Item: { PK: 'p', SK: 's', text: 'x'.repeat(4194304) } } }])).toThrow();
  });

  test('retains old snapshots/native signatures exactly and appends results before the next budget snapshot', () => {
    const first = initialContext(messages, 1, true); const original = JSON.stringify(first);
    const assistant = nativeBlocks([{ index: 0, type: 'thinking', thinking: { type: 'text', text: '', signature: 'sig' } },
      { index: 1, type: 'tool_use', id: 'tool-one', name: 'describe_documents', input: {} }]);
    const next = appendExchange(first, assistant, [{ toolResult: { toolUseId: 'tool-one', status: 'error', content: [{ json: { ok: false } }] } }], 2, true);
    expect(JSON.stringify(first)).toBe(original); expect(next.slice(0, first.length)).toEqual(first);
    expect(next[first.length].content).toEqual(assistant);
    expect(next.at(-1)?.content?.[0].toolResult).toBeDefined(); expect(next.at(-1)?.content?.at(-1)?.text).toContain('"used":2');
  });
});
