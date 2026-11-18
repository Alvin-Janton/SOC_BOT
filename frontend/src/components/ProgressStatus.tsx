import { CircleAlert, LoaderCircle } from 'lucide-react';
import { Activity } from '../api/chat';

const LABELS: Readonly<Record<string, string>> = {
  query_started: 'Querying logs…', query_completed: 'Reviewing query results…',
  rag_started: 'Reviewing playbooks…', rag_completed: 'Reviewing playbooks…',
  summarizing: 'Preparing conversation context…', finalizing: 'Preparing response…',
  cancelling: 'Stopping requested; cancellation is not yet confirmed.',
  tool_request_rejected: 'A tool request was rejected.', tool_error: 'A tool request failed.',
  tool_invocation_failed: 'A tool request outcome could not be confirmed.',
  tool_response_invalid: 'A tool response could not be verified.', tool_not_executed: 'A tool request was not executed.',
};

/** Presents only coarse, fixed public stages; tool completion never implies a completed investigation. */
export function ProgressStatus({ entries, stopping = false }: { entries: readonly Activity[]; stopping?: boolean }) {
  const latest = entries.at(-1);
  const warning = !stopping && Boolean(latest?.error);
  const label = stopping ? LABELS.cancelling : latest && Object.hasOwn(LABELS, latest.stage) ? LABELS[latest.stage]
    : warning ? 'A tool request reported a problem.' : 'Investigating…';
  return <p className={`progress-status${warning ? ' progress-warning' : ''}`} role="status" aria-live="polite" aria-atomic="true">
    {warning ? <CircleAlert size={15} aria-hidden="true" /> : <LoaderCircle className="spin" size={15} aria-hidden="true" />}<span>{label}</span>
  </p>;
}

/** Keeps one nonfatal tool-problem observation after local activity settles, without exposing a trace. */
export function ToolIssueWarning() {
  return <p className="progress-status progress-warning"><CircleAlert size={15} aria-hidden="true" />
    <span>Some tool requests were rejected, failed or not executed.</span></p>;
}
