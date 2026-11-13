import { LoaderCircle, ShieldCheck } from 'lucide-react';
import { HistoryMessage, TurnStatus } from '../api/messages';
import { Turn } from '../chat/useChat';
import { Confirmation } from '../conversations/useMessages';
import { ActivityList } from './ActivityList';
import { Answer } from './Answer';

interface DisplayMessage {
  readonly key: string; readonly turnId: string; readonly role: 'user' | 'assistant'; readonly content: string;
  readonly saved: boolean; readonly local?: Turn;
}

/** Projects individual saved messages and real local requests without manufacturing pairs or retry inputs. */
function projection(messages: readonly HistoryMessage[], turns: readonly Turn[], statuses: readonly TurnStatus[], confirmations?: ReadonlyMap<string, Confirmation>): readonly DisplayMessage[] {
  const byTurn = new Map(turns.map(turn => [turn.request.turnId, turn]));
  const result: DisplayMessage[] = messages.map(message => {
    const local = byTurn.get(message.turnId);
    const state = statuses.find(status => status.turnId === message.turnId);
    const successful = state?.status === 'complete' || state?.status === 'truncated';
    const overlay = local && message.role === 'assistant' && (local.state === 'running' || (!successful && local.state !== 'complete' && local.state !== 'truncated'));
    return { key: message.messageId, turnId: message.turnId, role: message.role, content: overlay ? local.answer : message.content,
      saved: !overlay, local };
  });
  for (const [index, turn] of turns.entries()) {
    for (const role of ['user', 'assistant'] as const) {
      if (result.some(message => message.turnId === turn.request.turnId && message.role === role)) continue;
      // A role confirmed earlier but outside a fresh page set is not recreated as unsaved local history.
      if (turn.state !== 'running' && confirmations?.get(turn.request.turnId)?.[role]) continue;
      const item: DisplayMessage = { key: `local-${turn.request.turnId}-${role}`, turnId: turn.request.turnId, role,
        content: role === 'user' ? turn.request.message : turn.answer, saved: false, local: turn };
      const first = result.findIndex(message => message.turnId === turn.request.turnId);
      if (role === 'user' && first >= 0) result.splice(first, 0, item);
      else {
        const last = result.findLastIndex(message => message.turnId === turn.request.turnId);
        const later = new Set(turns.slice(index + 1).map(candidate => candidate.request.turnId));
        const next = result.findIndex(message => later.has(message.turnId));
        result.splice(last >= 0 ? last + 1 : next >= 0 ? next : result.length, 0, item);
      }
    }
  }
  return result;
}

/** Explains durable outcomes without claiming a restored running stream is connected or unknown means timeout. */
function SavedStatus({ status }: { status: TurnStatus }) {
  const text = {
    complete: 'Complete', truncated: 'Truncated answer · replay will not continue it.',
    running: 'Recorded as running · the previous stream is not connected. Refresh messages to check again.',
    incomplete: 'Incomplete · outcome unknown. This does not confirm a timeout. Refresh messages to check again.',
    failed: 'Failed', timed_out: 'Timed out', cancelled: 'Cancelled', abandoned: 'Abandoned',
  }[status.status];
  return <div className={`saved-status saved-status-${status.status}`}><span>{status.cancel.requested && ['running', 'incomplete'].includes(status.status) ? 'Stopping requested · terminal cancellation is not confirmed. Refresh messages to check.' : text}</span>
    {status.error && <p>{status.error.message} <span className="fine">{status.error.code}</span></p>}</div>;
}

interface Props {
  messages: readonly HistoryMessage[]; statuses: readonly TurnStatus[]; turns: readonly Turn[];
  confirmations?: ReadonlyMap<string, Confirmation>; retry(): void; retryDisabled: boolean;
  retrySaved(status: TurnStatus): void; durableDisabled: boolean; preparingTurnId?: string;
}

/** Renders saved text safely and keeps activity/retry affordances confined to retained local turns. */
export function Transcript({ messages, statuses, turns, confirmations, retry, retryDisabled, retrySaved, durableDisabled, preparingTurnId }: Props) {
  const display = projection(messages, turns, statuses, confirmations);
  const lastLocal = turns.at(-1);
  return <>{display.map((message, index) => {
    const local = message.local;
    const state = statuses.find(status => status.turnId === message.turnId);
    const confirmed = Boolean(confirmations?.get(message.turnId)?.resolved);
    const localRunning = local?.state === 'running';
    const settledLocally = local?.state === 'complete' || local?.state === 'truncated';
    const cancelled = local?.state === 'cancelled' || state?.status === 'cancelled';
    const uncertain = local && !cancelled && !localRunning && !settledLocally && !(message.saved && confirmed);
    const savedAnswer = messages.some(candidate => candidate.turnId === message.turnId && candidate.role === 'assistant');
    const noticeHere = !display.slice(index + 1).some(candidate => candidate.turnId === message.turnId);
    const label = message.saved ? local?.replayed ? 'Saved replay' : 'Saved message' : localRunning ? 'Investigating' : settledLocally
      ? local.replayed ? 'Saved replay' : local.state === 'truncated' ? 'Truncated answer' : 'Complete · awaiting saved message'
      : 'Local · outcome unconfirmed';
    return <div key={message.key} data-message-id={message.key} className="transcript-message">
      {message.role === 'user' ? <article className="user-message"><span className="message-label">You{!message.saved && <span>Local request</span>}</span><p>{message.content}</p></article>
        : <article className="assistant-message"><div className="message-label"><span className="assistant-mark"><ShieldCheck size={16} aria-hidden="true" /> SOC_BOT</span><span>{label}</span></div>
          {local && <ActivityList entries={local.activity} />}
          {message.content ? <Answer text={message.content} /> : localRunning
            ? <p className="thinking" role="status"><LoaderCircle className="spin" size={15} aria-hidden="true" /> Gathering the available evidence…</p>
            : <p className="muted">No verified answer was received.</p>}
          {cancelled && <div className="turn-notice">The investigation was cancelled. Any retained partial text is not a saved assistant answer. No retry is offered.</div>}
          {local?.stopping && localRunning && <div className="turn-notice" role="status">Stopping was requested; cancellation is not yet confirmed.</div>}
          {uncertain && message.content && <p className="fine">This retained local partial answer is unconfirmed; it is not a saved final response.</p>}
          {!message.saved && local?.state === 'truncated' && <div className="turn-notice">This answer is truncated. Replaying the saved turn will not continue it.</div>}
          {uncertain && local.error && <div className="turn-notice" role="status"><p>{local.error.message}</p>
            <p className="muted">{local.error.code}{local.error.correlationId ? ` · Reference: ${local.error.correlationId}` : ''}</p>
            {lastLocal === local && local.error.retryable && !confirmed
              ? <button className="secondary-button" onClick={retry} disabled={retryDisabled}>Retry this exact turn</button>
              : <p className="muted">No retry is offered for this response.</p>}
            <p className="fine">This retry uses the retained exact original message, turn ID and conversation context. No retry was sent; the server also requires the latest admitted turn.</p></div>}
        </article>}
      {noticeHere && state && !localRunning && !(settledLocally && !confirmed) && <SavedStatus status={state} />}
      {noticeHere && state?.retry.available && !local && <div className="saved-retry">
        <button className="secondary-button" disabled={durableDisabled} onClick={() => retrySaved(state)}
          title="Checks current eligibility, then submits the same original question if still allowed.">
          {preparingTurnId === state.turnId && <LoaderCircle className="spin" size={14} aria-hidden="true" />}
          {preparingTurnId === state.turnId ? 'Checking retry…' : 'Retry failed turn'}</button>
        <p className="fine">Checks the latest saved state before starting another attempt of this same turn. Availability can change.</p>
      </div>}
      {noticeHere && state && ['complete', 'truncated'].includes(state.status) && !savedAnswer && !settledLocally
        && <p className="history-status">Completion is recorded, but its saved answer is outside the loaded view. Refresh messages to retrieve it.{local && !confirmed ? ' The local partial answer is not final.' : ''}</p>}
    </div>;
  })}</>;
}
