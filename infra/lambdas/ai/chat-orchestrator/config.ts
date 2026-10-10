export const TURN_DEADLINE_MS = 600_000;
export const FINALIZATION_RESERVE_MS = 90_000;
export const OUTCOME_RESERVE_MS = 45_000;
export const HEARTBEAT_MS = 15_000;
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

/** Fails closed before any service access unless trusted configuration selects the dev-only identity. */
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
  public constructor(public readonly code: string, message: string, public readonly status = 500, public readonly retryable = true) {
    super(message);
    this.name = 'ChatError';
  }
}

/** Uses one acceptance-time deadline, reserving bounded time for cancellation and durable outcomes. */
export class TurnBudget {
  public readonly deadline: number;
  public readonly signal: AbortSignal;
  public constructor(acceptedAt: number) {
    this.deadline = acceptedAt + TURN_DEADLINE_MS;
    this.signal = AbortSignal.timeout(Math.max(1, this.deadline - OUTCOME_RESERVE_MS - Date.now()));
  }
  public remaining(): number { return this.deadline - Date.now(); }
  public check(): void {
    if (this.signal.aborted || this.remaining() <= OUTCOME_RESERVE_MS) {
      throw new ChatError('TURN_TIMED_OUT', 'The investigation reached its time limit.', 504);
    }
  }
  public canDispatch(duration: number): boolean { return this.remaining() > duration + FINALIZATION_RESERVE_MS; }
}
