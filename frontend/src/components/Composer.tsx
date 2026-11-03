import { useEffect, useRef } from 'react';
import { ArrowUp } from 'lucide-react';

interface ComposerProps {
  draft: string; change(value: string): void; send(): void; busy: boolean; blocked: boolean; preview: boolean; error: string;
}

/** Keeps drafting independent of the active turn and funnels button/keyboard sends through the same lock. */
export function Composer({ draft, change, send, busy, blocked, preview, error }: ComposerProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(input.current.scrollHeight, 180)}px`;
  }, [draft]);
  const invalid = draft.length > 8192;
  const disabled = busy || blocked || preview || invalid || !draft.trim();
  return <div className="composer-dock">
    <form className={`composer ${invalid ? 'composer-invalid' : ''}`} onSubmit={event => { event.preventDefault(); if (!disabled) send(); }}>
      <label htmlFor="investigation-message" className="sr-only">Investigation message</label>
      <textarea id="investigation-message" ref={input} rows={2} value={draft} onChange={event => change(event.target.value)}
        placeholder={busy ? 'Draft your next question while the investigation runs…' : 'Ask about your security data…'}
        aria-describedby="composer-guidance composer-error" aria-invalid={invalid || Boolean(error)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault(); if (!disabled) send();
          }
        }} />
      <div className="composer-bottom"><span>{busy ? <><span className="processing-dot" /> Investigating · you can keep drafting</> : 'Read-only investigation'}</span>
        <div className="flex items-center gap-3"><span className={invalid ? 'input-count over-limit' : 'input-count'}>{draft.length.toLocaleString()} / 8,192</span>
          <button className="send-button" type="submit" disabled={disabled} aria-label="Send message" title="Send message (Enter)"><ArrowUp size={19} aria-hidden="true" /></button></div>
      </div>
    </form>
    <p id="composer-error" className="composer-error" role={error || invalid ? 'alert' : undefined}>{error || (invalid ? 'Shorten the message to 8,192 characters before sending.' : '')}</p>
    <p id="composer-guidance" className="composer-guidance">Enter to send · Shift + Enter for a new line. Verify important conclusions against the cited evidence.</p>
  </div>;
}
