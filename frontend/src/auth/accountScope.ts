/** A captured memory-only account lifetime; verification gates dispatch without aborting same-account streams. */
export interface AccountScope { readonly userId: string; readonly generation: number; readonly signal: AbortSignal }
type Listener = (boundary: boolean) => void;
let generation = 0;
let active: { scope: AccountScope; controller: AbortController; verified: boolean } | undefined;
const listeners = new Set<Listener>();
const readyListeners = new Set<() => void>();

/** Identifies stale work without presenting it as an uncertain backend mutation. */
export class AccountScopeError extends Error {
  constructor() { super('Account context is not confirmed. Check your session before continuing.'); this.name = 'AccountScopeError'; }
}

export function accountGeneration(): number { return generation; }
export function currentScope(scope: AccountScope | undefined): boolean {
  return Boolean(scope && active?.scope === scope && !scope.signal.aborted);
}
export function canDispatch(scope: AccountScope | undefined): scope is AccountScope {
  return currentScope(scope) && Boolean(active?.verified);
}
export function assertScope(scope: AccountScope, dispatch = false): void {
  if (!currentScope(scope) || (dispatch && !active?.verified)) throw new AccountScopeError();
}
export function captureScope(userId: string | undefined): AccountScope {
  if (!active || active.scope.userId !== userId) throw new AccountScopeError();
  assertScope(active.scope, true);
  return active.scope;
}
export function subscribeAccount(listener: Listener): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
/** Resumes only explicitly deferred reads after verification, without refreshing on every focus. */
export function subscribeAccountReady(listener: () => void): () => void {
  readyListeners.add(listener); return () => { readyListeners.delete(listener); };
}
/** Invalidates synchronously so stale closures cannot dispatch before React commits a privacy reset. */
export function invalidateAccount(expected?: AccountScope): void {
  if (expected && !currentScope(expected)) return;
  const previous = active; active = undefined; generation++;
  previous?.controller.abort();
  listeners.forEach(listener => listener(true));
}
/** Gates a newer view for fresh cookie discovery without attributing an old auth response to it. */
export function requestAccountCheck(): void { pauseAccount(); listeners.forEach(listener => listener(false)); }
export function pauseAccount(): void { if (active) active.verified = false; }
/** Reuses a verified lifetime on ordinary focus checks; account changes receive a fresh generation. */
export function confirmAccount(userId: string): AccountScope {
  if (active?.scope.userId !== userId) {
    if (active) invalidateAccount();
    const controller = new AbortController();
    active = { scope: Object.freeze({ userId, generation, signal: controller.signal }), controller, verified: true };
  }
  active!.verified = true;
  readyListeners.forEach(listener => listener());
  return active!.scope;
}

const CHANNEL = 'soc-bot-account-context-v1';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
let channel: BroadcastChannel | undefined;
let sender: string | undefined;
/** Opens one versioned, identity-free notification channel; messages never establish authentication. */
export function listenForAccountChanges(received: () => void): () => void {
  if (import.meta.env.DEV || typeof BroadcastChannel === 'undefined') return () => undefined;
  try { channel = new BroadcastChannel(CHANNEL); sender = crypto.randomUUID(); }
  catch { channel?.close(); channel = undefined; sender = undefined; return () => undefined; }
  const ownChannel = channel;
  const seen = new Set<string>();
  ownChannel.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const message = data as Record<string, unknown>;
    if (Object.keys(message).length !== 4 || message.version !== 1 || message.type !== 'invalidate'
      || typeof message.sender !== 'string' || message.sender.length !== 36 || !uuid.test(message.sender) || typeof message.event !== 'string'
      || message.event.length !== 36 || !uuid.test(message.event) || message.sender === sender || seen.has(message.event)) return;
    seen.add(message.event); if (seen.size > 128) seen.delete(seen.values().next().value!);
    received();
  };
  return () => { ownChannel.close(); if (channel === ownChannel) { channel = undefined; sender = undefined; } };
}
/** Publishes only a fixed invalidation hint after a confirmed browser-session transition. */
export function publishAccountChange(): void {
  try { channel?.postMessage({ version: 1, type: 'invalidate', sender, event: crypto.randomUUID() }); }
  catch { /* Focus/pageshow reconciliation and server binding remain available without channel delivery. */ }
}
