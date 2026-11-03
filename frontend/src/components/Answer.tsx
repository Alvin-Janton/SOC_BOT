import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Accepts only explicit HTTP(S) references; model-supplied relative URLs, credentials and other schemes stay inert. */
function reference(value: string): string {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

/** Renders bounded answer Markdown with raw HTML/images disabled and contained code/tables. */
export function Answer({ text }: { text: string }) {
  return <div className="answer-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={reference} components={{
    img: () => null,
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>,
    table: ({ children }) => <div className="table-scroll" role="region" aria-label="Answer table" tabIndex={0}><table>{children}</table></div>,
  }}>{text}</Markdown></div>;
}
