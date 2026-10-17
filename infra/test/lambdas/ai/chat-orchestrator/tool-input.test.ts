import { BedrockRuntimeClient, ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { ChatError, Configuration, TurnBudget } from '../../../../lambdas/ai/chat-orchestrator/config';
import { validateTool } from '../../../../lambdas/ai/chat-orchestrator/contracts';
import { ModelRunner } from '../../../../lambdas/ai/chat-orchestrator/model';

/**
 * Feeds a synthetic Bedrock response through the real ModelRunner stream parser.
 * Each inputs entry represents one streamed argument fragment: [''] means one empty
 * delta, [] means no deltas, and ['{}'] means one delta containing valid JSON.
 * Only the SDK send method is mocked; parsing and later validateTool calls are real.
 * Returns the parsed tool block and its synthetic environment configuration, not backend results.
 */
async function streamedTool(environment: Configuration['environment'], name: string, inputs: readonly string[]) {
  const upper = environment.toUpperCase();
  const config: Configuration = {
    environment, ownerId: `soc-bot-${environment}-analyst`, tableName: `SOC-BOT-${upper}-CHAT-HISTORY`,
    queryFunction: `SOC-BOT-${upper}-QUERY-TOOL`, ragFunction: `SOC-BOT-${upper}-RAG-TOOL`,
    modelId: 'us.anthropic.claude-sonnet-4-6', region: 'us-east-1', database: `soc_bot_${environment}_security`, maxQueryDays: 30,
  };
  // Reproduce a complete tool-use response: start message/block, optional input fragments,
  // close block/message, then usage metadata. No tool backend is invoked by this helper.
  const events: ConverseStreamOutput[] = [
    { messageStart: { role: 'assistant' } },
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'synthetic-tool-1', name } } } },
    ...inputs.map(input => ({ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input } } } })),
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'tool_use' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 1 } } },
  ];
  // Install the mock before constructing/using ModelRunner so no real Bedrock request occurs.
  // The async generator yields the events as the real SDK stream would.
  const send = jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async () => ({
    $metadata: {},
    stream: (async function* () { yield* events; })(),
  }));
  const emitText = jest.fn();
  const response = await new ModelRunner(config).respond(
    [{ role: 'user', content: [{ text: 'Synthetic tool-input check.' }] }], true, new TurnBudget(Date.now()), emitText,
  );
  // Every case must consume one model response containing one tool call. This tool-only
  // fixture must not emit any final-answer text.
  expect(send).toHaveBeenCalledTimes(1);
  expect(emitText).not.toHaveBeenCalled();
  expect(response.toolUses).toHaveLength(1);
  return { tool: response.toolUses[0], config };
}

// Remove each case's SDK spy so its synthetic response cannot leak into another test.
afterEach(() => { jest.restoreAllMocks(); });

/** Checks the narrow empty-discovery compatibility rule without weakening strict input validation. */
describe('streamed tool input compatibility', () => {
  // Reproduce the AWS-observed one-empty-delta case in BOTH environments. Acceptance
  // must be identical, and the parser must preserve the original ID/name/index.
  test.each(['dev', 'demo'] as const)('%s accepts the observed empty describe_documents delta', async environment => {
    const { tool, config } = await streamedTool(environment, 'describe_documents', ['']);
    expect(tool).toMatchObject({ id: 'synthetic-tool-1', name: 'describe_documents', index: 0 });
    // The parser supplies {}, then the unchanged validator approves only the discovery operation.
    expect(tool.input).toEqual({});
    expect(validateTool(tool.name, tool.input, config)).toEqual({ operation: 'describe_documents' });
  });

  // Two other valid cases: no deltas uses the same exact-empty rule; literal '{}'
  // is already valid JSON. Both must reach strict validation as empty discovery arguments.
  test.each([
    { label: 'no input deltas', inputs: [] },
    { label: 'ordinary empty JSON object', inputs: ['{}'] },
  ])('accepts $label as empty discovery arguments', async ({ inputs }) => {
    const { tool, config } = await streamedTool('dev', 'describe_documents', inputs);
    expect(tool.input).toEqual({});
    expect(validateTool(tool.name, tool.input, config)).toEqual({ operation: 'describe_documents' });
  });

  // Invalid JSON/null/whitespace must not gain the {} fallback. Valid JSON with extra
  // fields, an array, or a scalar is also invalid for this strict zero-argument object schema.
  // Each row below is a separate test using the real validator, not a mocked rejection.
  test.each([
    { label: 'explicit JSON null', raw: 'null' },
    { label: 'malformed nonempty JSON', raw: '{' },
    { label: 'whitespace-only input', raw: ' \t\n' },
    { label: 'unexpected fields', raw: '{"unexpected":true}' },
    { label: 'JSON array', raw: '[]' },
    { label: 'JSON string scalar', raw: '""' },
    { label: 'JSON number scalar', raw: '0' },
    { label: 'JSON boolean scalar', raw: 'false' },
  ])('rejects $label through the real validator', async ({ raw }) => {
    const { tool, config } = await streamedTool('dev', 'describe_documents', [raw]);
    expect(() => validateTool(tool.name, tool.input, config)).toThrow(expect.objectContaining<Partial<ChatError>>({ code: 'INVALID_TOOL_INPUT' }));
  });

  // Every other supported tool requires arguments. Empty input must still parse to
  // null and fail validation; the discovery fallback must not apply.
  test.each(['describe_document', 'retrieve_sections', 'describe_table', 'query_events', 'aggregate_events'])(
    '%s still rejects empty required input', async name => {
      const { tool, config } = await streamedTool('dev', name, ['']);
      expect(tool.input).toBeNull();
      expect(() => validateTool(tool.name, tool.input, config)).toThrow(expect.objectContaining<Partial<ChatError>>({ code: 'INVALID_TOOL_INPUT' }));
    },
  );
});
