import { ReactNode, useEffect, useRef } from 'react';
import { LockKeyhole } from 'lucide-react';
import { Brand } from './Brand';

export interface Notice { readonly message: string; readonly warning?: boolean }

/** Reuses the compact login presentation and provides a keyboard-focus target after route transitions. */
export function AuthLayout({ title, description, notice, children, footer }: {
  title: ReactNode; description: string; notice?: Notice; children: ReactNode; footer?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <div className="login-page"><a className="skip-link" href="#account-form">Skip to form</a>
    <header className="login-header"><Brand /><span className="workspace-label">Security investigation workspace</span></header>
    <main className="login-main"><div className="login-intro"><span className="eyebrow"><span className="status-dot" /> Your SOC_BOT account</span>
      <h1 ref={heading} tabIndex={-1}>{title}</h1><p>{description}</p></div>
      {import.meta.env.DEV && <div className="notice">Local visual preview. Authentication and application requests are disconnected.</div>}
      {notice && <div className={`notice ${notice.warning ? 'notice-warning' : ''}`} role={notice.warning ? 'alert' : 'status'}>{notice.message}</div>}
      {children}{footer && <nav className="auth-links" aria-label="Account navigation">{footer}</nav>}
      <p className="login-security"><LockKeyhole size={14} aria-hidden="true" /> Private access. Read-only investigation.</p>
    </main><footer className="login-footer"><span>SOC_BOT</span><span>Grounded in evidence. Guided by you.</span></footer>
  </div>;
}
