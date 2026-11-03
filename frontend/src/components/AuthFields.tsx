import { useState } from 'react';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';

/** Renders a labelled transient password with an accessible visibility toggle; text is never transformed. */
export function PasswordField({ id, label, value, change, busy, current = false, errorId }: {
  id: string; label: string; value: string; change(value: string): void; busy: boolean; current?: boolean; errorId?: string;
}) {
  const [visible, setVisible] = useState(false);
  return <div className="field"><label htmlFor={id}>{label}</label><div className="password-field">
    <input id={id} name={id} type={visible ? 'text' : 'password'} autoComplete={current ? 'current-password' : 'new-password'}
      required minLength={current ? 1 : 15} maxLength={256} value={value} onChange={event => change(event.target.value)} disabled={busy} aria-describedby={errorId} />
    <button type="button" className="password-toggle" disabled={busy} onClick={() => setVisible(previous => !previous)}
      aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`} aria-pressed={visible} title={`${visible ? 'Hide' : 'Show'} password`}>
      {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}</button>
  </div></div>;
}

/** Keeps email editable on direct navigation and lets callers clear stale proof whenever it changes. */
export function EmailField({ value, change, busy, errorId }: { value: string; change(value: string): void; busy: boolean; errorId?: string }) {
  return <div className="field"><label htmlFor="account-email">Email address</label>
    <input id="account-email" name="email" type="email" autoComplete="username" required maxLength={128} value={value}
      onChange={event => change(event.target.value)} disabled={busy} aria-describedby={errorId} placeholder="you@example.com" />
  </div>;
}

/** Preserves codes as strings, without imposing an undocumented numeric or fixed-length format. */
export function CodeField({ value, change, busy, label }: { value: string; change(value: string): void; busy: boolean; label: string }) {
  return <div className="field"><label htmlFor="account-code">{label}</label>
    <input id="account-code" name="code" type="text" autoComplete="one-time-code" required maxLength={2048} value={value}
      onChange={event => change(event.target.value)} disabled={busy} aria-describedby="account-error" />
  </div>;
}

/** Displays loading for one explicit form submission without queuing another action. */
export function AuthSubmit({ busy, children, disabled = false }: { busy: boolean; children: string; disabled?: boolean }) {
  return <button type="submit" className="primary-button" disabled={busy || disabled}>
    {busy ? <><LoaderCircle className="spin" size={17} aria-hidden="true" /> Working…</> : children}
  </button>;
}

/** Reuses the actual new-password policy while leaving current-password login bounds unchanged. */
export function passwordProblem(password: string, confirmation: string): string | undefined {
  if (password.length < 15 || password.length > 256 || /\s/u.test(password)) return 'Use a password of 15 to 256 characters without whitespace.';
  if (password !== confirmation) return 'The new passwords must match.';
  return undefined;
}
