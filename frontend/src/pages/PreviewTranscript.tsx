import { Answer } from '../components/Answer';

/** Supplies inert typography/layout examples only inside the Vite development branch, never a signed-in identity. */
export function PreviewTranscript() {
  if (!import.meta.env.DEV) return null;
  return <div className="transcript-column"><div className="preview-caption">Presentation sample · not an investigation or an API response</div>
    <article className="user-message"><span className="message-label">Layout sample</span><p>Show me how an evidence-backed answer will look in this workspace.</p></article>
    <article className="assistant-message"><div className="message-label">SOC_BOT <span>Typography preview</span></div>
      <Answer text={'## Evidence, with room to read\n\nAnswers appear here as the investigation runs. Findings should distinguish what the records show from what still needs corroboration.\n\n| Source | Observation | Interpretation |\n| --- | --- | --- |\n| Example source | A bounded evidence row | Additional context may be needed |\n\n```text\n' + 'long_example_column_'.repeat(18) + '\n```\n\nThis is disconnected presentation content. No user identity, security event or backend result is simulated.'} />
    </article></div>;
}
