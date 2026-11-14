import type { ContentBlock, Message } from '@aws-sdk/client-bedrock-runtime';
import { ChatError, MAX_TOOL_CALLS } from './config';

/** Creates one immutable-in-practice control snapshot; prior snapshots are never regenerated or edited. */
export function budgetSnapshot(used: number, enabled: boolean): ContentBlock {
  if (!Number.isSafeInteger(used) || used < 0) throw new ChatError('CONFIGURATION_ERROR', 'The investigation tool budget is invalid.', 500, false);
  const remaining = Math.max(0, MAX_TOOL_CALLS - used);
  return { text: `TOOL_BUDGET_V1: ${JSON.stringify({ maximum: MAX_TOOL_CALLS, used, nominal_remaining: remaining,
    available: enabled ? remaining : 0, availability: enabled ? 'subject_to_current_time_and_context_gates' : 'finalization_required',
    note: 'Backend control metadata, not evidence. Each request counts, including rejected/skipped calls. No future-time guarantee.' })}` };
}

/** Adds an entry snapshot only to a fresh unsent context, copying all selected history before ownership. */
export function initialContext(messages: readonly Message[], used: number, enabled: boolean): Message[] {
  const copy = structuredClone([...messages]);
  const last = copy[copy.length - 1];
  const snapshot = budgetSnapshot(used, enabled);
  if (last?.role === 'user') last.content = [...(last.content ?? []), snapshot];
  else copy.push({ role: 'user', content: [snapshot] });
  return copy;
}

/** Appends one complete native assistant exchange and one ordered result/control message without rewriting the prefix. */
export function appendExchange(messages: readonly Message[], assistant: readonly ContentBlock[], results: readonly ContentBlock[],
  used: number, enabled: boolean): Message[] {
  return [...messages, { role: 'assistant', content: structuredClone([...assistant]) },
    { role: 'user', content: [...structuredClone([...results]), budgetSnapshot(used, enabled)] }];
}
