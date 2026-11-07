import { ApiError, jsonResponse, record, request, responseError } from './http';

export interface Conversation { readonly conversationId: string; readonly title: string; readonly createdAt: string; readonly updatedAt: string }
export interface ConversationPage { readonly conversations: readonly Conversation[]; readonly nextCursor: string | null }
/** Matches the bounded ASCII chat ID grammar without accepting trailing line terminators. */
export const validConversationId = (value: string): boolean => value.length >= 1 && value.length <= 128 && !/[^A-Za-z0-9_-]/.test(value);

/** Accepts the writer's canonical UTC timestamp representation rather than merely parseable date text. */
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Loads one bounded metadata page from a fixed same-origin route; cursors stay opaque and transient. */
export async function listConversations(cursor: string | undefined, signal: AbortSignal): Promise<ConversationPage> {
  const response = await request('/api/conversations', { method: 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    headers: { Accept: 'application/json' } }, cursor);
  if (response.status !== 200) throw await responseError(response, 'history');
  const value = await jsonResponse(response, 32_768);
  const invalid = () => new ApiError('The conversation list could not be verified. Refresh the list to try again.', 'INVALID_RESPONSE', response.status, false);
  if (!record(value) || Object.keys(value).length !== 2 || !Array.isArray(value.conversations) || value.conversations.length > 20
    || !(value.nextCursor === null || (typeof value.nextCursor === 'string' && value.nextCursor.length >= 1
      && value.nextCursor.length <= 2048 && !/[^A-Za-z0-9_-]/.test(value.nextCursor)))) throw invalid();
  const conversations = value.conversations.map((item: unknown): Conversation => {
    if (!record(item) || Object.keys(item).length !== 4 || typeof item.conversationId !== 'string' || !validConversationId(item.conversationId)
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 240 || Array.from(item.title).length > 60
      || /[\p{Cc}\p{Cf}]/u.test(item.title) || !timestamp(item.createdAt) || !timestamp(item.updatedAt) || item.createdAt > item.updatedAt) throw invalid();
    return { conversationId: item.conversationId, title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt };
  });
  return { conversations, nextCursor: value.nextCursor as string | null };
}
