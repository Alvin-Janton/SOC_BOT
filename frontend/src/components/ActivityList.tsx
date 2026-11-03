import { CircleCheck, CircleAlert, Waypoints } from 'lucide-react';
import { Activity } from '../api/chat';

/** Shows only fields published by the stream, without presenting tool activity as private reasoning. */
export function ActivityList({ entries }: { entries: readonly Activity[] }) {
  if (!entries.length) return null;
  return <details className="activity-list"><summary><Waypoints size={14} aria-hidden="true" /><span>Investigation activity</span><span className="activity-count">{entries.length}</span></summary>
    <ol>{entries.map((entry, index) => <li key={index}>
      {entry.error ? <CircleAlert size={14} aria-hidden="true" /> : entry.stage.endsWith('_completed') ? <CircleCheck size={14} aria-hidden="true" /> : <Waypoints size={14} aria-hidden="true" />}
      <div><p>{entry.message}</p>{entry.details.length > 0 && <p className="activity-detail">{entry.details.join(' · ')}</p>}</div>
    </li>)}</ol></details>;
}
