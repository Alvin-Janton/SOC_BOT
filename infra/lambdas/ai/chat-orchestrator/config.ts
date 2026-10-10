export const TURN_DEADLINE_MS = 600_000; // 10 minutes
export const FINALIZATION_RESERVE_MS = 90_000; // 90 seconds
export const OUTCOME_RESERVE_MS = 45_000; // 45 seconds
export const HEARTBEAT_MS = 15_000; // 15 seconds
export const MAX_TOOL_CALLS = 4;
export const MAX_CONTEXT_BYTES = 262_144;
export const MAX_OUTPUT_BYTES = 32_768;
export const MAX_OUTPUT_TOKENS = 2_048;

export interface Configuration {
  readonly environment: 'dev';
  readonly ownerId: string;
  readonly tableName: string;
  readonly queryFunction: string;
  readonly modelId: string;
  readonly region: string;
  readonly database: string;
  readonly maxQueryDays: number;
}

/**
 * Fails closed before any service access unless trusted configuration selects the dev-only identity.
 *
 * Example Input (no arguments; trusted environment variables):
 * {
 *   DEPLOYMENT_ENVIRONMENT: 'dev', DEV_USER_ID: 'soc-bot-dev-analyst',
 *   CHAT_HISTORY_TABLE_NAME: 'SOC-BOT-DEV-CHAT-HISTORY',
 *   QUERY_TOOL_FUNCTION_NAME: 'SOC-BOT-DEV-QUERY-TOOL',
 *   DATABASE_NAME: 'soc_bot_dev_security', MAX_QUERY_WINDOW_DAYS: '30',
 *   BEDROCK_MODEL_ID: 'us.anthropic.claude-sonnet-4-6', BEDROCK_REGION: 'us-east-1',
 * }
 * Example Output:
 * {
 *   environment: 'dev', ownerId: 'soc-bot-dev-analyst',
 *   tableName: 'SOC-BOT-DEV-CHAT-HISTORY', queryFunction: 'SOC-BOT-DEV-QUERY-TOOL',
 *   database: 'soc_bot_dev_security', maxQueryDays: 30,
 *   modelId: 'us.anthropic.claude-sonnet-4-6', region: 'us-east-1',
 * }
 * Invalid configuration throws ChatError rather than returning partial configuration.
 */
export function configuration(): Configuration {
  const ownerId = process.env.DEV_USER_ID ?? '';
  const tableName = process.env.CHAT_HISTORY_TABLE_NAME ?? '';
  const queryFunction = process.env.QUERY_TOOL_FUNCTION_NAME ?? '';
  const database = process.env.DATABASE_NAME ?? '';
  const maxQueryDays = Number(process.env.MAX_QUERY_WINDOW_DAYS);
  if (process.env.DEPLOYMENT_ENVIRONMENT !== 'dev' || !/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)
    || tableName !== 'SOC-BOT-DEV-CHAT-HISTORY' || queryFunction !== 'SOC-BOT-DEV-QUERY-TOOL'
    || database !== 'soc_bot_dev_security' || process.env.BEDROCK_MODEL_ID !== 'us.anthropic.claude-sonnet-4-6'
    || process.env.BEDROCK_REGION !== 'us-east-1' || !Number.isInteger(maxQueryDays) || maxQueryDays < 1 || maxQueryDays > 366) {
    throw new ChatError('CONFIGURATION_ERROR', 'Chat is not available in this environment.', 503, false);
  }
  return { environment: 'dev', ownerId, tableName, queryFunction, database, maxQueryDays,
    modelId: process.env.BEDROCK_MODEL_ID, region: process.env.BEDROCK_REGION };
}

/** Carries a safe public error without including provider messages, stack traces, or request content. */
export class ChatError extends Error {
  /**
   * Creates an error with a safe message, HTTP status, and explicit retry policy.
   *
   * Example Input:
   * new ChatError('INVALID_INPUT', 'Expected a chat request.', 400, false)
   * Example Output (selected properties of the new Error instance):
   * { name: 'ChatError', code: 'INVALID_INPUT', message: 'Expected a chat request.', status: 400, retryable: false }
   */
  public constructor(public readonly code: string, message: string, public readonly status = 500, public readonly retryable = true) {
    super(message);
    this.name = 'ChatError';
  }
}

/** Uses one acceptance-time deadline, reserving bounded time for cancellation and durable outcomes. */
export class TurnBudget {
  public readonly deadline: number;
  public readonly signal: AbortSignal;
  /**
   * Starts the acceptance-time deadline and a cancellation signal that leaves cleanup time.
   *
   * Example Input (illustrative clock: Date.now() is 1_000):
   * new TurnBudget(1_000)
   * Example Output (selected instance state):
   * { deadline: 601_000, signal: AbortSignal { aborted: false } }
   * The signal is scheduled to abort after 555_000 ms, not after the hard Lambda timeout.
   */
  public constructor(acceptedAt: number) {
    this.deadline = acceptedAt + TURN_DEADLINE_MS;
    this.signal = AbortSignal.timeout(Math.max(1, this.deadline - OUTCOME_RESERVE_MS - Date.now()));
  }
  /**
   * Returns milliseconds left before the application deadline.
   *
   * Example Input: remaining(), with { deadline: 601_000 } and Date.now() === 101_000
   * Example Output: 500_000
   */
  public remaining(): number { return this.deadline - Date.now(); }
  /**
   * Rejects normal work once cancellation or the cleanup reserve has been reached.
   *
   * Example Input: check(), with { remaining: 500_000, signal: { aborted: false } }
   * Example Output: undefined; execution continues without changing the budget.
   * With only 45_000 ms remaining, it throws ChatError { code: 'TURN_TIMED_OUT', status: 504 }.
   */
  public check(): void {
    if (this.signal.aborted || this.remaining() <= OUTCOME_RESERVE_MS) {
      throw new ChatError('TURN_TIMED_OUT', 'The investigation reached its time limit.', 504);
    }
  }
  /**
   * Checks whether an operation and the finalization reserve fit in the remaining budget.
   *
   * Example Input: canDispatch(200_000), with remaining() === 400_000
   * Example Output: true, because 400_000 > 200_000 + 90_000.
   * With remaining() === 250_000, the same input returns false.
   */
  public canDispatch(duration: number): boolean { return this.remaining() > duration + FINALIZATION_RESERVE_MS; }
}
