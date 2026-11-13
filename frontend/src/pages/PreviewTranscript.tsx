import { Answer } from '../components/Answer';
import { LoaderCircle, RefreshCw } from 'lucide-react';

/** Supplies inert typography/layout examples only inside the Vite development branch, never a signed-in identity. */
export function PreviewTranscript() {
  if (!import.meta.env.DEV) return null;
  return <div className="transcript-column"><div className="preview-caption">Presentation sample · not an investigation or an API response</div>
    <div className="messages-toolbar"><button className="secondary-button" disabled>Load older messages</button>
      <button className="history-icon" disabled title="Refresh messages" aria-label="Refresh messages"><RefreshCw size={16} aria-hidden="true" /></button></div>
    <p className="history-status"><LoaderCircle size={14} aria-hidden="true" /> History loading indicator · presentation only</p>
    <div className="messages-error"><p>History error notice · presentation only. A failed read retains the draft and offers Refresh messages.</p></div>
    <div className="saved-retry"><button className="secondary-button" disabled>Retry failed turn</button><p className="fine">Retry control layout only · no turn, identity or preparation request.</p></div>
    <article className="user-message"><span className="message-label">Layout sample</span><p>Show me how an evidence-backed answer will look in this workspace.</p></article>
    <article className="assistant-message"><div className="message-label">SOC_BOT <span>Typography preview</span></div>
      <Answer text={'## Evidence, with room to read\n\nAnswers appear here as the investigation runs. Findings should distinguish what the records show from what still needs corroboration.\n\n| Source | Observation | Interpretation |\n| --- | --- | --- |\n| Example source | A bounded evidence row | Additional context may be needed |\n\n```text\n' + 'long_example_column_'.repeat(18) + '\n```\n\nThis is disconnected presentation content. No user identity, security event or backend result is simulated.'} />
    </article></div>;
}
