import { z } from 'zod';
import { authSubSchema } from '../auth/user-state';
import { record } from '../shared/origin-guard';

const ERRORS = {
  INVALID_INPUT: { status: 400, message: 'Invalid conversation-list request.' },
  AUTHENTICATION_REQUIRED: { status: 401, message: 'Authentication required.' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'Conversation history is temporarily unavailable.' },
} as const;

/** Carries only authored public errors; storage/provider details never enter responses or logs. */
export class HistoryError extends Error {
  public constructor(public readonly code: keyof typeof ERRORS) { super(ERRORS[code].message); }
  public get status(): number { return ERRORS[this.code].status; }
}

export interface HistoryConfiguration { readonly environment: 'dev' | 'demo'; readonly account: string; readonly apiId: string; readonly table: string }

/** Validates server-owned identifiers without accepting caller-selected tables, accounts or environments. */
export function configuration(): HistoryConfiguration {
  const environment = process.env.DEPLOYMENT_ENVIRONMENT;
  const account = process.env.EXPECTED_ACCOUNT_ID ?? '';
  const apiId = process.env.FRONTEND_API_ID ?? '';
  const table = process.env.CHAT_HISTORY_TABLE_NAME ?? '';
  if ((environment !== 'dev' && environment !== 'demo') || process.env.AWS_REGION !== 'us-east-1'
    || !/^\d{12}$/.test(account) || !/^[a-z0-9]{1,128}$/.test(apiId)
    || table !== `SOC-BOT-${environment.toUpperCase()}-CHAT-HISTORY`) throw new HistoryError('SERVICE_UNAVAILABLE');
  return { environment, account, apiId, table };
}

/** Validates the REST envelope and trusted BFF context before parsing an optional navigation cursor. */
export function request(raw: unknown, config: HistoryConfiguration): { owner: string; cursor?: string } {
  const event = record(raw);
  const context = record(event?.requestContext);

  if (!event || event.version !== undefined || event.httpMethod !== 'GET' || event.resource !== '/api/conversations'
    || event.path !== event.resource || context?.httpMethod !== 'GET' || context.resourcePath !== event.resource
    || (event.isBase64Encoded !== undefined && event.isBase64Encoded !== false)
    || (event.body !== undefined && event.body !== null && event.body !== '')) throw new HistoryError('INVALID_INPUT');

  const authorization = record(context.authorizer);
  const subject = authSubSchema.safeParse(authorization?.userId);

  if (context.accountId !== config.account || context.apiId !== config.apiId || context.stage !== config.environment
    || authorization?.authenticationType !== 'bff-session' || !subject.success || authorization.principalId !== subject.data
    || authorization.apiId !== config.apiId || authorization.stage !== config.environment) throw new HistoryError('AUTHENTICATION_REQUIRED');

  if (event.pathParameters !== undefined && event.pathParameters !== null
    && (!record(event.pathParameters) || Object.keys(event.pathParameters).length)) throw new HistoryError('INVALID_INPUT');

  let cursor: string | undefined;

  for (const name of ['queryStringParameters', 'multiValueQueryStringParameters'] as const) {
    if (event[name] === undefined || event[name] === null) continue;
    const map = record(event[name]);
    if (!map || Object.keys(map).some(key => key !== 'cursor')) throw new HistoryError('INVALID_INPUT');
    if (!Object.hasOwn(map, 'cursor')) continue;
    const supplied = map.cursor;

    const value = name === 'multiValueQueryStringParameters'
      ? Array.isArray(supplied) && supplied.length === 1 ? supplied[0] : undefined : supplied;

    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(value)
      || (cursor !== undefined && cursor !== value)) throw new HistoryError('INVALID_INPUT');

    cursor = value;
  }
  return { owner: subject.data, cursor };
}

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const keySchema = z.strictObject({ PK: z.string().max(133), SK: z.literal('META'),
  GSI1PK: z.string().max(133), GSI1SK: z.string().max(158) });
export type IndexKey = z.infer<typeof keySchema>;
export interface Conversation { readonly conversationId: string; readonly title: string; readonly createdAt: string; readonly updatedAt: string }

/** Accepts only mutually consistent metadata keys in the authenticated owner's index partition. */
export function indexKey(raw: unknown, owner: string): IndexKey | undefined {
  const parsed = keySchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const key = parsed.data;
  const id = key.PK.slice(5);
  const time = key.GSI1SK.slice(5, 29);
  if (!idSchema.safeParse(id).success || key.PK !== `CONV#${id}` || key.GSI1PK !== `USER#${owner}`
    || !timestamp.safeParse(time).success || key.GSI1SK !== `CONV#${time}#${id}`) return undefined;
  return key;
}

const metadataSchema = z.object({ PK: z.string(), SK: z.string(), GSI1PK: z.string(), GSI1SK: z.string(),
  conversation_id: idSchema, title: z.string().min(1).max(240).refine(value => Array.from(value).length <= 60
    && value.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value)), created_at: timestamp, updated_at: timestamp });

/** Maps projected metadata to four public fields, rejecting corrupt or cross-owner results as storage failure. */
export function conversation(raw: unknown, owner: string): Conversation {
  const parsed = metadataSchema.safeParse(raw);
  if (!parsed.success) throw new HistoryError('SERVICE_UNAVAILABLE');
  const item = parsed.data;
  const key = indexKey({ PK: item.PK, SK: item.SK, GSI1PK: item.GSI1PK, GSI1SK: item.GSI1SK }, owner);
  if (!key || item.PK !== `CONV#${item.conversation_id}` || item.GSI1SK !== `CONV#${item.updated_at}#${item.conversation_id}`
    || item.created_at > item.updated_at) throw new HistoryError('SERVICE_UNAVAILABLE');
  return { conversationId: item.conversation_id, title: item.title, createdAt: item.created_at, updatedAt: item.updated_at };
}
