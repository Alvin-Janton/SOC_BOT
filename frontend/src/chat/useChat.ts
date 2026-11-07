import { useEffect, useRef, useState } from 'react';
import { Activity, ChatEvent, ChatRequest, streamChat } from '../api/chat';
import { Conversation } from '../api/conversations';
import { ApiError, failure } from '../api/http';
import { ConversationSelection } from '../routing';
import { conversationTitle } from './title';

export interface Turn {
  readonly request: ChatRequest;
  readonly accountId: string;
  readonly answer: string;
  readonly activity: readonly Activity[];
  readonly state: 'running' | 'complete' | 'truncated' | 'incomplete' | 'error';
  readonly replayed: boolean;
  readonly error?: ApiError;
}
interface Workspace { key: string; conversationId?: string; title: string; draft: string; inputError: string; turns: readonly Turn[] }
interface Navigation {
  selection: ConversationSelection; rows: readonly Conversation[];
  assigned(id: string, expected?: string): boolean; select(id?: string): boolean;
  completed(): void; busy?(busy: boolean): void;
}

/** Owns isolated in-memory workspaces and immutable exact-retry snapshots for one mounted account. */
export function useChat(accountId: string | undefined, expired: (message: string) => void, preview: boolean, navigation: Navigation) {
  const [, render] = useState(0);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const fresh = (): Workspace => ({ key: `new-${sequence.current++}`, title: 'New investigation', draft: '', inputError: '', turns: [] });
  const blank = useRef<Workspace | undefined>(undefined);
  if (!blank.current) blank.current = fresh();
  const byId = useRef(new Map<string, Workspace>());
  const active = useRef(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | undefined>(undefined);
  const callbacks = useRef(navigation); callbacks.current = navigation;
  const selectedId = navigation.selection.id;
  if (selectedId && !byId.current.has(selectedId)) byId.current.set(selectedId, {
    key: `existing-${selectedId}`, conversationId: selectedId, title: 'Selected conversation', draft: '', inputError: '', turns: [],
  });
  const workspace = selectedId ? byId.current.get(selectedId)! : blank.current;
  const metadata = navigation.rows.find(row => row.conversationId === workspace.conversationId);
  if (metadata) workspace.title = metadata.title;
  const title = workspace.title;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; controller.current?.abort(); callbacks.current.busy?.(false); };
  }, []);

  /** Updates only the captured workspace and turn; selection never redirects an arriving event. */
  function update(target: Workspace, id: string, transform: (turn: Turn) => Turn) {
    if (!alive.current) return;
    target.turns = target.turns.map(turn => turn.request.turnId === id ? transform(turn) : turn);
    render(value => value + 1);
  }

  /** Holds the global send/navigation lock across one stream or exact replay without changing its request. */
  async function run(target: Workspace, original: Turn) {
    if (active.current || preview || !accountId || original.accountId !== accountId) return;
    active.current = true; setBusy(true); callbacks.current.busy?.(true);
    controller.current = new AbortController();
    update(target, original.request.turnId, turn => ({ ...turn, answer: '', activity: [], state: 'running', error: undefined, replayed: false }));
    try {
      await streamChat(original.request, controller.current.signal, (event: ChatEvent) => {
        if (!alive.current) return;
        if (event.type === 'conversation' || event.type === 'complete') {
          if (target.conversationId && target.conversationId !== event.conversationId) throw new ApiError('The stream returned a contradictory conversation identifier.', 'INVALID_STREAM');
          target.conversationId = event.conversationId;
          byId.current.set(event.conversationId, target);
          if (blank.current === target) blank.current = fresh();
          callbacks.current.assigned(event.conversationId, original.request.conversationId);
          render(value => value + 1);
        }
        if (event.type === 'text') update(target, original.request.turnId, turn => ({ ...turn, answer: turn.answer + event.text }));
        if (event.type === 'activity') update(target, original.request.turnId, turn => ({ ...turn, activity: [...turn.activity.slice(-199), event.activity] }));
        if (event.type === 'complete') {
          update(target, original.request.turnId, turn => ({ ...turn, state: event.truncated ? 'truncated' : 'complete', replayed: event.replayed }));
          callbacks.current.completed();
        }
      });
    } catch (error) {
      if (!alive.current) return;
      const safe = failure(error);
      if (safe.authenticationRequired) { expired(safe.message); return; }
      update(target, original.request.turnId, turn => ({ ...turn, state: safe.status === 0 ? 'incomplete' : 'error', error: safe }));
    } finally {
      active.current = false;
      if (alive.current) { setBusy(false); callbacks.current.busy?.(false); }
    }
  }
  const last = workspace.turns.at(-1);
  const unresolved = last?.state === 'incomplete' || last?.state === 'error';

  /** Snapshots one explicit send; an existing selection always supplies its ID, even without local messages. */
  function send() {
    if (active.current || unresolved || preview || !accountId || navigation.selection.error) return;
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
    if (!last || !last.error?.retryable || active.current || preview || last.accountId !== accountId || navigation.selection.error) return;
    void run(workspace, last);
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
    workspaceKey: workspace.key, busy, isBusy, unresolved, inputError: workspace.inputError, send, retry, reset };
}
