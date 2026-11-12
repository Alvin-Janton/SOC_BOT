import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, failure } from '../api/http';
import { HistoryMessage, listMessages, MessagePage, TurnStatus } from '../api/messages';

export interface Confirmation { readonly user?: string; readonly assistant?: string; readonly resolved?: TurnStatus }
interface Entry {
  messages: readonly HistoryMessage[]; statuses: readonly TurnStatus[]; observations: readonly TurnStatus[]; confirmations: Map<string, Confirmation>;
  snapshot?: number; nextCursor: string | null; consumed: Set<string>; chain: number;
  loaded: boolean; verified: boolean; validVisit: number; unavailable: boolean;
  phase: 'idle' | 'initial' | 'refresh' | 'page'; error?: ApiError; pageError?: ApiError;
  change: { readonly version: number; readonly kind: 'newest' | 'older' };
}
interface Scope { readonly account?: string; readonly id?: string; readonly visible: boolean; readonly visit: number }
interface Pending { readonly entry: Entry; readonly controller: AbortController; readonly generation: number }

/** Also fences the interval between synchronous URL navigation and React committing the next selection. */
function selectedView(id: string | undefined): boolean {
  const parameters = new URLSearchParams(window.location.search);
  const ids = parameters.getAll('conversationId');
  return window.location.pathname === '/' && [...parameters.keys()].every(key => key === 'conversationId')
    && (id === undefined ? ids.length === 0 : ids.length === 1 && ids[0] === id);
}

/** Creates a memory-only page chain; confirmation IDs do not retain discarded server message bodies. */
function empty(): Entry {
  return { messages: [], statuses: [], observations: [], confirmations: new Map(), nextCursor: null, consumed: new Set(), chain: 0,
    loaded: false, verified: false, validVisit: -1, unavailable: false, phase: 'idle', change: { version: 0, kind: 'newest' } };
}

/** Uses revision precedence, with the later accepted observation winning legitimate equal-revision changes. */
function statuses(previous: readonly TurnStatus[], incoming: readonly TurnStatus[]): readonly TurnStatus[] {
  const result = new Map(previous.map(item => [item.turnId, item]));
  for (const item of incoming) if (item.revision >= (result.get(item.turnId)?.revision ?? 0)) result.set(item.turnId, item);
  return [...result.values()];
}

/** Compares immutable persisted fields only; identical overlapping IDs may appear once across pages. */
function identical(left: HistoryMessage, right: HistoryMessage): boolean {
  return left.messageId === right.messageId && left.turnId === right.turnId && left.sequence === right.sequence
    && left.role === right.role && left.content === right.content && left.createdAt === right.createdAt;
}

/** A fresh snapshot may discard old pages, but cannot rewrite an immutable ID or reuse its sequence. */
function refreshMessages(entry: Entry, page: MessagePage): readonly HistoryMessage[] {
  const byId = new Map(entry.messages.map(message => [message.messageId, message]));
  const bySequence = new Map(entry.messages.map(message => [message.sequence, message]));
  for (const message of page.messages) {
    const previous = byId.get(message.messageId);
    if ((previous && !identical(previous, message)) || (bySequence.has(message.sequence) && bySequence.get(message.sequence)!.messageId !== message.messageId)) {
      throw new ApiError('Saved messages changed unexpectedly. The previous view was retained; contact the administrator.', 'INVALID_RESPONSE', 200, false);
    }
  }
  return page.messages;
}

/** Rejects changed snapshots, collisions and nonpreceding pages before changing the usable chain. */
function older(entry: Entry, page: MessagePage): readonly HistoryMessage[] {
  const invalid = () => new ApiError('Older messages did not match this snapshot. Refresh messages to restart the page chain.', 'INVALID_RESPONSE', 200, false);
  if (page.snapshotSequence !== entry.snapshot) throw invalid();
  const byId = new Map(entry.messages.map(message => [message.messageId, message]));
  const bySequence = new Map(entry.messages.map(message => [message.sequence, message]));
  const boundary = entry.messages[0]?.sequence ?? Infinity;
  const added: HistoryMessage[] = [];
  for (const message of page.messages) {
    const existing = byId.get(message.messageId);
    if (existing) { if (!identical(existing, message)) throw invalid(); }
    else {
      if (bySequence.has(message.sequence) || message.sequence >= boundary) throw invalid();
      added.push(message);
    }
  }
  return [...added, ...entry.messages];
}

/** Retains only role identity/confirmed completion observations to reconcile actual local requests later. */
function confirm(entry: Entry): void {
  for (const message of entry.messages) {
    const previous = entry.confirmations.get(message.turnId) ?? {};
    const status = entry.statuses.find(item => item.turnId === message.turnId);
    entry.confirmations.set(message.turnId, { ...previous, [message.role]: message.messageId,
      ...(message.role === 'assistant' && status && ['complete', 'truncated'].includes(status.status) ? { resolved: status } : {}) });
  }
}

/** Owns one mounted account's transcripts, explicit page reads and per-visit send readiness, never polling. */
export function useMessages(accountId: string | undefined, conversationId: string | undefined, visible: boolean,
  expired: (message: string) => void, beforeRead: (kind: 'newest' | 'older') => void) {
  const [, render] = useState(0);
  const [completion, setCompletion] = useState(0);
  const cache = useRef(new Map<string, Entry>());
  const owner = useRef(accountId);
  const scope = useRef<Scope>({ account: accountId, id: conversationId, visible, visit: 0 });
  const callbacks = useRef({ expired, beforeRead }); callbacks.current = { expired, beforeRead };
  const generation = useRef(0);
  const pending = useRef<Pending | undefined>(undefined);
  const suspended = useRef(false);
  const alive = useRef(false);
  if (scope.current.account !== accountId || scope.current.id !== conversationId || scope.current.visible !== visible) {
    scope.current = { account: accountId, id: conversationId, visible, visit: scope.current.visit + 1 };
  }
  if (owner.current !== accountId) { cache.current.clear(); owner.current = accountId; }
  const entry = conversationId && accountId ? cache.current.get(conversationId) : undefined;

  /** Invalidates before aborting so even a completed obsolete read cannot expire the current account. */
  const cancel = useCallback(() => {
    generation.current++;
    const previous = pending.current; pending.current = undefined;
    if (previous) { previous.controller.abort(); previous.entry.phase = 'idle'; }
  }, []);

  /** Captures account, visit, request generation and cursor-chain identity for every response side effect. */
  const read = useCallback(async (newest: boolean) => {
    const captured = scope.current;
    if (!alive.current || !captured.account || !captured.id || !captured.visible || suspended.current || import.meta.env.DEV || !selectedView(captured.id)) return;
    let target = cache.current.get(captured.id);
    if (!target) { target = empty(); cache.current.set(captured.id, target); }
    if (pending.current) {
      if (!newest || pending.current.entry.phase !== 'page') return;
      cancel();
    }
    if (!newest && (!target.loaded || target.unavailable || !target.nextCursor || !target.verified || target.validVisit !== captured.visit)) return;
    const cursor = newest ? undefined : target.nextCursor!;
    if (cursor && target.consumed.has(cursor)) return;
    const chain = target.chain;
    const boundary = target.snapshot;
    const controller = new AbortController();
    const id = ++generation.current;
    pending.current = { entry: target, controller, generation: id };
    target.phase = newest ? target.loaded ? 'refresh' : 'initial' : 'page';
    if (newest) { target.verified = false; target.error = undefined; } else target.pageError = undefined;
    callbacks.current.beforeRead(newest ? 'newest' : 'older');
    render(value => value + 1);

    /** Requires the same live view and chain before accepting either data or an authentication error. */
    const current = () => alive.current && !controller.signal.aborted && !suspended.current && generation.current === id
      && scope.current.account === captured.account && scope.current.id === captured.id && scope.current.visible
      && scope.current.visit === captured.visit && selectedView(captured.id) && target.chain === chain && target.snapshot === boundary
      && (newest || target.nextCursor === cursor);
    try {
      const page = await listMessages(captured.id, cursor, controller.signal);
      if (!current()) return;
      const used = newest ? new Set<string>() : new Set(target.consumed);
      if (cursor) used.add(cursor);
      if (page.nextCursor && used.has(page.nextCursor)) throw new ApiError('Messages pagination could not advance. Refresh messages to restart.', 'INVALID_RESPONSE', 200, false);
      const messages = newest ? refreshMessages(target, page) : older(target, page);
      const observations = statuses(target.observations, page.turnStatuses);
      const represented = new Set(messages.map(message => message.turnId));
      target.messages = messages; target.observations = observations; target.statuses = observations.filter(status => represented.has(status.turnId));
      target.snapshot = page.snapshotSequence; target.nextCursor = page.nextCursor; target.consumed = used;
      target.loaded = true; target.unavailable = false; target.pageError = undefined;
      if (newest) { target.chain++; target.verified = true; target.validVisit = captured.visit; target.error = undefined; }
      confirm(target);
      target.change = { version: target.change.version + 1, kind: newest ? 'newest' : 'older' };
    } catch (reason) {
      if (!current()) return;
      const safe = failure(reason);
      if (safe.authenticationRequired) { callbacks.current.expired(safe.message); return; }
      const error = safe.status === 0 ? new ApiError('Conversation messages could not be reached. Your draft and local chat were retained.', 'HISTORY_UNAVAILABLE', 0, false) : safe;
      if (safe.status === 404 && safe.code === 'CONVERSATION_UNAVAILABLE') {
        target.messages = []; target.statuses = []; target.observations = []; target.confirmations.clear(); target.snapshot = undefined;
        target.nextCursor = null; target.consumed.clear(); target.loaded = false; target.verified = false; target.unavailable = true;
        target.error = error; target.pageError = undefined; target.chain++;
      } else if (newest) target.error = error;
      else target.pageError = error;
    } finally {
      // Success intentionally changes the chain, so cleanup uses the request token rather than current().
      if (alive.current && pending.current?.generation === id) {
        pending.current = undefined; target.phase = 'idle'; render(value => value + 1);
      }
    }
  }, [cancel]);

  const refresh = useCallback(() => { void read(true); }, [read]);
  const more = useCallback(() => { void read(false); }, [read]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; cancel(); cache.current.clear(); };
  }, [cancel]);
  useEffect(() => {
    // This is one selection/reentry/completion read, not an effect on cache/list/render changes.
    if (accountId && conversationId && visible && !suspended.current) {
      void read(true);
    }
    return cancel;
  }, [accountId, conversationId, visible, completion, read, cancel]);

  /** Immediately prevents pre-send responses from changing status or authentication during the stream. */
  const suspend = useCallback(() => {
    suspended.current = true; cancel();
    const selected = scope.current.id && cache.current.get(scope.current.id);
    if (selected) selected.verified = false;
  }, [cancel]);

  /** Refreshes once after completion or an explicit retry-state recheck, once the immediate chat lock is released. */
  const settled = useCallback((id: string | undefined, complete: boolean, recheck = false) => {
    suspended.current = false;
    if ((complete || recheck) && id && alive.current) setCompletion(value => value + 1);
  }, []);

  /** Requires a valid newest observation for this visit, never list membership or stale cached data. */
  const canRetry = useCallback((id: string | undefined) => {
    if (!alive.current || !scope.current.visible || !scope.current.account || suspended.current || import.meta.env.DEV || !selectedView(id)) return false;
    if (!id) return scope.current.id === undefined;
    const saved = cache.current.get(id);
    return scope.current.id === id && Boolean(saved?.verified && saved.validVisit === scope.current.visit && !saved.unavailable
      && saved.phase !== 'initial' && saved.phase !== 'refresh' && (saved.messages.length || saved.nextCursor === null));
  }, []);

  /** Blocks only the latest observed running/unknown turn in addition to newest-page readiness. */
  const canSend = useCallback((id: string | undefined) => {
    if (!canRetry(id)) return false;
    if (!id) return true;
    const saved = cache.current.get(id)!;
    const latest = saved.messages.at(-1);
    const state = latest && saved.statuses.find(status => status.turnId === latest.turnId)?.status;
    return state !== 'running' && state !== 'incomplete';
  }, [canRetry]);

  /** A saved assistant plus its successful terminal status resolves only that exact retained local turn. */
  const resolved = useCallback((id: string | undefined, turnId: string) => Boolean(id && cache.current.get(id)?.confirmations.get(turnId)?.resolved), []);
  /** Returns the current validated visible observation, never an inferred latest turn or an old discarded row. */
  const observation = useCallback((turnId: string): TurnStatus | undefined => {
    const id = scope.current.id;
    return id ? cache.current.get(id)?.statuses.find(status => status.turnId === turnId) : undefined;
  }, []);
  /** Applies a current preparation/chat 404 to this selection without dropping any other conversation's state. */
  const unavailable = useCallback((id: string) => {
    if (!alive.current || scope.current.id !== id || !selectedView(id)) return;
    cancel();
    const saved = cache.current.get(id);
    if (saved) {
      saved.messages = []; saved.statuses = []; saved.observations = []; saved.confirmations.clear(); saved.snapshot = undefined;
      saved.nextCursor = null; saved.consumed.clear(); saved.loaded = false; saved.verified = false; saved.unavailable = true;
      saved.error = new ApiError('Conversation unavailable.', 'CONVERSATION_UNAVAILABLE', 404, false); saved.pageError = undefined; saved.chain++;
    }
    render(value => value + 1);
  }, [cancel]);
  const ready = !conversationId || Boolean(entry?.verified && entry.validVisit === scope.current.visit && !entry.unavailable);
  // Unverified does not mean a GET is active: a settled uncertain local turn needs an explicit refresh.
  const phase = entry?.phase ?? 'idle';
  return { messages: entry?.messages ?? [], statuses: entry?.statuses ?? [], confirmations: entry?.confirmations,
    loaded: entry?.loaded ?? false, ready, phase, error: entry?.error, pageError: entry?.pageError,
    unavailable: entry?.unavailable ?? false, nextCursor: entry?.nextCursor ?? null, change: entry?.change,
    refresh, more, suspend, settled, canSend, canRetry, resolved, observation, markUnavailable: unavailable };
}
