import { useEffect, useRef, useState } from 'react';
import { Activity, ChatEvent, ChatRequest, streamChat } from '../api/chat';
import { Conversation } from '../api/conversations';
import { ApiError, failure } from '../api/http';
import { ConversationSelection } from '../routing';
import { conversationTitle } from './title';
import { TurnStatus } from '../api/messages';
import { cancelTurn } from '../api/cancel';
import { prepareRetry, retryExplanation } from '../api/retry';

export interface Turn {
  readonly request: ChatRequest;
  readonly accountId: string;
  readonly answer: string;
  readonly activity: readonly Activity[];
  readonly state: 'running' | 'complete' | 'truncated' | 'incomplete' | 'error' | 'cancelled';
  readonly attemptId?: string;
  readonly stopping?: boolean;
  readonly replayed: boolean;
  readonly error?: ApiError;
}
interface StopState { turnId: string; attemptId: string; phase: 'sending' | 'stopping' | 'unknown'; revision?: number }
interface Workspace { key: string; conversationId?: string; title: string; draft: string; inputError: string; retryNotice: string; turns: readonly Turn[]; stop?: StopState; controlRefresh?: boolean }
interface Navigation {
  selection: ConversationSelection; rows: readonly Conversation[];
  assigned(id: string, expected?: string): boolean; select(id?: string): boolean;
  completed(): void; busy?(busy: boolean): void;
  canSend(id?: string): boolean; canRetry(id?: string): boolean; resolved(id: string | undefined, turnId: string): boolean;
  started(): void; settled(id: string | undefined, complete: boolean, recheck?: boolean): void;
  cancellation(): TurnStatus | undefined; observation(turnId: string): TurnStatus | undefined; unavailable(id: string): void;
}

/** Owns isolated in-memory workspaces and immutable exact-retry snapshots for one mounted account. */
export function useChat(accountId: string | undefined, expired: (message: string) => void, preview: boolean, navigation: Navigation) {
  const [, render] = useState(0);
  const [busy, setBusy] = useState(false);
  const [preparingTurnId, setPreparingTurnId] = useState<string>();
  const requestGeneration = useRef(0);
  const stopGeneration = useRef(0);
  const stopController = useRef<AbortController | undefined>(undefined);
  const view = useRef(navigation.selection.id);
  if (view.current !== navigation.selection.id) { view.current = navigation.selection.id; stopGeneration.current++; stopController.current?.abort(); }
  const identity = useRef(accountId); identity.current = accountId;
  const sequence = useRef(0);
  const fresh = (): Workspace => ({ key: `new-${sequence.current++}`, title: 'New investigation', draft: '', inputError: '', retryNotice: '', turns: [] });
  const blank = useRef<Workspace | undefined>(undefined);
  if (!blank.current) blank.current = fresh();
  const byId = useRef(new Map<string, Workspace>());
  const active = useRef(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | undefined>(undefined);
  const callbacks = useRef(navigation); callbacks.current = navigation;
  const selectedId = navigation.selection.id;
  if (selectedId && !byId.current.has(selectedId)) byId.current.set(selectedId, {
    key: `existing-${selectedId}`, conversationId: selectedId, title: 'Selected conversation', draft: '', inputError: '', retryNotice: '', turns: [],
  });
  const workspace = selectedId ? byId.current.get(selectedId)! : blank.current;
  const metadata = navigation.rows.find(row => row.conversationId === workspace.conversationId);
  if (metadata) workspace.title = metadata.title;
  const title = workspace.title;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; requestGeneration.current++; controller.current?.abort(); stopGeneration.current++; stopController.current?.abort(); callbacks.current.busy?.(false); };
  }, []);

  /** Updates only the captured workspace and turn; selection never redirects an arriving event. */
  function update(target: Workspace, id: string, transform: (turn: Turn) => Turn) {
    if (!alive.current) return;
    target.turns = target.turns.map(turn => turn.request.turnId === id ? transform(turn) : turn);
    render(value => value + 1);
  }

  /** Holds the global send/navigation lock across one stream or exact replay without changing its request. */
  async function run(target: Workspace, original: Turn, retrying = false, preparedLock = false) {
    if (preview || !accountId || original.accountId !== identity.current || (preparedLock ? !active.current : active.current
      || !(retrying ? callbacks.current.canRetry(target.conversationId) : callbacks.current.canSend(target.conversationId)))) return;
    if (!preparedLock) {
      active.current = true; setBusy(true); callbacks.current.busy?.(true); callbacks.current.started();
    }
    const generation = ++requestGeneration.current;
    target.retryNotice = ''; target.stop = undefined;
    let complete = false;
    let recheck = false;
    controller.current = new AbortController();
    update(target, original.request.turnId, turn => ({ ...turn, answer: '', activity: [], state: 'running', attemptId: undefined, stopping: false, error: undefined, replayed: false }));
    try {
      await streamChat(original.request, controller.current.signal, (event: ChatEvent) => {
        if (!alive.current || requestGeneration.current !== generation || identity.current !== original.accountId) return;
        if (event.type === 'conversation' || event.type === 'complete') {
          if (target.conversationId && target.conversationId !== event.conversationId) throw new ApiError('The stream returned a contradictory conversation identifier.', 'INVALID_STREAM');
          target.conversationId = event.conversationId;
          byId.current.set(event.conversationId, target);
          if (blank.current === target) blank.current = fresh();
          callbacks.current.assigned(event.conversationId, original.request.conversationId);
          render(value => value + 1);
        }
        if (event.type === 'conversation') update(target, original.request.turnId, turn => ({ ...turn, attemptId: event.attemptId }));
        if (event.type === 'text') update(target, original.request.turnId, turn => turn.stopping || turn.state === 'cancelled' ? turn : ({ ...turn, answer: turn.answer + event.text }));
        if (event.type === 'activity') update(target, original.request.turnId, turn => ({ ...turn, activity: [...turn.activity.slice(-199), event.activity] }));
        if (event.type === 'complete') {
          complete = true; target.stop = undefined;
          update(target, original.request.turnId, turn => ({ ...turn, state: event.truncated ? 'truncated' : 'complete', stopping: false, replayed: event.replayed }));
          callbacks.current.completed();
        }
      });
    } catch (error) {
      if (!alive.current || requestGeneration.current !== generation || identity.current !== original.accountId) return;
      const safe = failure(error);
      if (safe.authenticationRequired) { expired(safe.message); return; }
      const cancelled = safe.code === 'TURN_CANCELLED' && !safe.retryable;
      update(target, original.request.turnId, turn => ({ ...turn, state: cancelled ? 'cancelled' : safe.status === 0 ? 'incomplete' : 'error', error: safe, stopping: false }));
      if (cancelled) { target.stop = undefined; recheck = true; callbacks.current.completed(); }
      if (retrying && safe.status === 409) recheck = true;
      if (target.conversationId && safe.status === 404) callbacks.current.unavailable(target.conversationId);
    } finally {
      if (requestGeneration.current === generation) {
        active.current = false;
        if (alive.current) {
          setBusy(false); callbacks.current.busy?.(false);
          callbacks.current.settled(target.conversationId, complete, recheck || target.controlRefresh); target.controlRefresh = false;
        }
      }
    }
  }
  const last = workspace.turns.at(-1);
  const resolved = Boolean(last && callbacks.current.resolved(workspace.conversationId, last.request.turnId));
  const historicalControl = navigation.cancellation();
  const stopObservation = workspace.stop && navigation.observation(workspace.stop.turnId);
  const stopTerminal = stopObservation && !['running', 'incomplete'].includes(stopObservation.status)
    && stopObservation.revision >= (workspace.stop?.revision ?? 0);
  const stopBlocks = Boolean((workspace.stop && !stopTerminal) || historicalControl?.cancel.requested);
  const cancelledObservation = last && navigation.observation(last.request.turnId);
  const cancelled = cancelledObservation?.status === 'cancelled'; // A confirmed terminal logical turn also resolves an interrupted older local attempt.
  useEffect(() => {
    const pendingStop = workspace.stop;
    if (pendingStop && stopObservation?.status === 'cancelled' && stopObservation.cancel.attemptId === pendingStop.attemptId
      && stopObservation.revision >= (pendingStop.revision ?? 0)) {
      workspace.stop = undefined;
      workspace.retryNotice = 'Cancellation is confirmed. Partial text is not a saved assistant answer.';
      callbacks.current.completed(); render(value => value + 1);
    }
  }, [workspace, stopObservation]);
  const unresolved = (last?.state === 'incomplete' || last?.state === 'error') && !resolved && !cancelled;

  /** Reads immediate control state too, closing the interval before React commits the Stop indicator. */
  function controlBlocked(target: Workspace): boolean {
    const state = target.stop && callbacks.current.observation(target.stop.turnId);
    const terminal = state && !['running', 'incomplete'].includes(state.status) && state.revision >= (target.stop?.revision ?? 0);
    return Boolean((target.stop && !terminal) || callbacks.current.cancellation()?.cancel.requested);
  }

  /** Snapshots one explicit send; an existing selection always supplies its ID, even without local messages. */
  function send() {
    if (active.current || controlBlocked(workspace) || unresolved || preview || !accountId || navigation.selection.error || !callbacks.current.canSend(workspace.conversationId)) return;
    if (!workspace.draft.trim() || workspace.draft.length > 8192) { workspace.inputError = 'Enter a message of 1–8,192 characters.'; render(value => value + 1); return; }
    const request: ChatRequest = Object.freeze({ turnId: crypto.randomUUID(), message: workspace.draft,
      ...(workspace.conversationId ? { conversationId: workspace.conversationId } : {}) });
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 32_768) {
      workspace.inputError = 'This message exceeds the request byte limit. Shorten it before sending.'; render(value => value + 1); return;
    }
    const turn: Turn = { request, accountId, answer: '', activity: [], state: 'running', replayed: false };
    if (!workspace.conversationId && !workspace.turns.length) workspace.title = conversationTitle(workspace.draft);
    workspace.inputError = ''; workspace.turns = [...workspace.turns, turn]; workspace.draft = '';
    render(value => value + 1); void run(workspace, turn);
  }

  /** Replays only this workspace's last allowed request, preserving initial omission of conversationId. */
  function retry() {
    if (controlBlocked(workspace) || cancelled || !last || !last.error?.retryable || resolved || active.current || preview || last.accountId !== accountId || navigation.selection.error
      || !callbacks.current.canRetry(workspace.conversationId)) return;
    void run(workspace, last, true);
  }

  /** One explicit click holds the same lock across bounded read-only preparation and the existing stream POST. */
  async function retrySaved(observed: TurnStatus) {
    const target = workspace;
    const id = target.conversationId;
    if (!id || !accountId || preview || active.current || controlBlocked(workspace) || unresolved || navigation.selection.error
      || !observed.retry.available || callbacks.current.observation(observed.turnId) !== observed
      || !callbacks.current.canRetry(id) || target.turns.some(turn => turn.request.turnId === observed.turnId)) return;
    const owner = accountId;
    const generation = ++requestGeneration.current;
    active.current = true; setBusy(true); setPreparingTurnId(observed.turnId); callbacks.current.busy?.(true);
    callbacks.current.started();
    const preparation = new AbortController(); controller.current = preparation;
    target.retryNotice = ''; render(value => value + 1);
    let transferred = false;
    let recheck = false;
    /** Checks the captured account, exact selection, observation and request token before any side effect or POST. */
    const current = () => alive.current && identity.current === owner && !preparation.signal.aborted
      && requestGeneration.current === generation && active.current && callbacks.current.selection.id === id
      && window.location.pathname === '/' && new URLSearchParams(window.location.search).getAll('conversationId').length === 1
      && [...new URLSearchParams(window.location.search).keys()].every(key => key === 'conversationId')
      && new URLSearchParams(window.location.search).get('conversationId') === id && callbacks.current.observation(observed.turnId) === observed;
    try {
      const result = await prepareRetry(id, observed.turnId, preparation.signal);
      if (!current()) return;
      if (result.revision < observed.revision) throw new ApiError('Retry state changed unexpectedly. No chat request was submitted.', 'INVALID_RESPONSE', 200, false);
      if (!result.retry.available || !result.request) {
        target.retryNotice = retryExplanation(result.retry); recheck = true; return;
      }
      const request: ChatRequest = Object.freeze({ ...result.request });
      const turn: Turn = { request, accountId: owner, answer: '', activity: [], state: 'running', replayed: false };
      target.turns = [...target.turns, turn]; // A real retained request; history/live projection keeps its original user row once.
      transferred = true; setPreparingTurnId(undefined); render(value => value + 1);
      await run(target, turn, true, true); // No intervening release, second confirmation or automatic second attempt.
    } catch (reason) {
      if (!current()) return;
      const safe = failure(reason);
      if (safe.authenticationRequired) { expired(safe.message); return; }
      target.retryNotice = safe.status === 0 ? 'Retry availability could not be checked. No chat request was submitted.' : safe.message;
      if (safe.status === 404 && safe.code === 'CONVERSATION_UNAVAILABLE') callbacks.current.unavailable(id);
      else recheck = true;
    } finally {
      if (!transferred && requestGeneration.current === generation) {
        active.current = false;
        if (alive.current) {
          setBusy(false); setPreparingTurnId(undefined); callbacks.current.busy?.(false);
          callbacks.current.settled(id, false, recheck); render(value => value + 1);
        }
      }
    }
  }

  const live = active.current && !preparingTurnId ? workspace.turns.findLast(turn => turn.state === 'running') : undefined;
  const stopTarget = live?.attemptId ? { turnId: live.request.turnId, attemptId: live.attemptId }
    : !active.current && historicalControl?.cancel.attemptId ? { turnId: historicalControl.turnId, attemptId: historicalControl.cancel.attemptId } : undefined;
  const stopPhase = workspace.stop && !stopTerminal ? workspace.stop.phase : historicalControl?.cancel.requested ? 'stopping' : undefined;

  /** Sends one deliberate Stop for the captured attempt; it never aborts the chat transport or retargets another attempt. */
  async function stop() {
    const target = workspace;
    const id = target.conversationId;
    const chosen = stopTarget;
    if (!id || !accountId || preview || !chosen || preparingTurnId || stopPhase === 'sending' || stopPhase === 'stopping' || target.stop?.phase === 'sending' || target.stop?.phase === 'stopping') return;
    const owner = accountId;
    const streamGeneration = requestGeneration.current;
    const generation = ++stopGeneration.current;
    const captured = callbacks.current.observation(chosen.turnId);
    const abort = new AbortController(); stopController.current = abort;
    target.stop = { ...chosen, phase: 'sending', revision: captured?.revision };
    target.retryNotice = ''; render(value => value + 1);
    const current = () => alive.current && identity.current === owner && !abort.signal.aborted && stopGeneration.current === generation
      && requestGeneration.current === streamGeneration && callbacks.current.selection.id === id
      && window.location.pathname === '/' && new URLSearchParams(window.location.search).getAll('conversationId').length === 1
      && [...new URLSearchParams(window.location.search).keys()].every(key => key === 'conversationId')
      && new URLSearchParams(window.location.search).get('conversationId') === id
      && (live ? target.turns.find(turn => turn.request.turnId === chosen.turnId)?.attemptId === chosen.attemptId
        : callbacks.current.observation(chosen.turnId) === captured);
    try {
      const receipt = await cancelTurn(id, chosen.turnId, chosen.attemptId, abort.signal);
      if (!current()) return;
      const local = target.turns.find(turn => turn.request.turnId === chosen.turnId);
      const saved = callbacks.current.observation(chosen.turnId);
      if ((local && ['complete', 'truncated', 'cancelled'].includes(local.state))
        || (saved && saved.revision > receipt.revision) || (saved && !['running', 'incomplete'].includes(saved.status))) {
        target.stop = undefined; return; // A late receipt cannot regress a confirmed terminal result.
      }
      target.stop = receipt.state === 'stopping' ? { ...chosen, phase: 'stopping', revision: receipt.revision } : undefined;
      target.retryNotice = receipt.state === 'stopping'
        ? 'Stopping was requested. Work may still be running; cancellation is not yet confirmed. Refresh messages if no stream is connected.'
        : 'Cancellation is confirmed. Partial text is not a saved assistant answer.';
      if (local) update(target, chosen.turnId, turn => ({ ...turn, stopping: receipt.state === 'stopping',
        ...(receipt.state === 'cancelled' ? { state: 'cancelled' as const, error: undefined } : {}) }));
      if (receipt.state === 'cancelled') {
        callbacks.current.completed();
        if (active.current) target.controlRefresh = true; else callbacks.current.settled(id, false, true);
      }
    } catch (reason) {
      if (!current()) return;
      const safe = failure(reason);
      if (safe.authenticationRequired) { expired(safe.message); return; }
      const local = target.turns.find(turn => turn.request.turnId === chosen.turnId);
      if (local && ['complete', 'truncated', 'cancelled'].includes(local.state)) { target.stop = undefined; return; }
      target.stop = safe.status === 409 || safe.status === 404 ? undefined : { ...chosen, phase: 'unknown', revision: captured?.revision };
      target.retryNotice = safe.status === 0 ? 'Stop acceptance is unconfirmed. Refresh messages or deliberately retry Stop for this same attempt.' : safe.message;
      if (safe.status === 404 && safe.code === 'CONVERSATION_UNAVAILABLE') callbacks.current.unavailable(id);
      else if (safe.status === 409) {
        if (active.current) target.controlRefresh = true; else callbacks.current.settled(id, false, true);
      }
    } finally {
      if (target.stop?.attemptId === chosen.attemptId && target.stop.phase === 'sending') target.stop = { ...target.stop, phase: 'unknown' };
      if (current()) render(value => value + 1);
    }
  }

  /** Selects a deliberate fresh context while retaining other conversations and an idle new-chat draft. */
  function reset() {
    if (active.current || !navigation.select()) return;
    if (!selectedId) blank.current = fresh();
    render(value => value + 1);
  }
  function setDraft(value: string) { workspace.draft = value; render(previous => previous + 1); }
  /** Exposes the immediate lock to logout before React has committed its busy indicator. */
  function isBusy() { return active.current; }
  return { turns: workspace.turns, draft: workspace.draft, setDraft, title, conversationId: workspace.conversationId,
    workspaceKey: workspace.key, busy, stop, stopTarget, stopPhase, stopBlocks, isBusy, preparingTurnId, unresolved, inputError: workspace.inputError,
    retryNotice: workspace.retryNotice, send, retry, retrySaved, reset };
}
