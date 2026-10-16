import { RagError } from './contracts';

export const MAX_INDEX_BYTES = 512 * 1_024;
export const MAX_MARKDOWN_BYTES = 1_024 * 1_024;
export const OBJECT_READ_TIMEOUT_MS = 30_000;
const LAMBDA_TIMEOUT_MS = 180_000;
const COMPLETION_RESERVE_MS = 10_000;

export interface Configuration {
  readonly environment: 'dev' | 'demo';
  readonly bucket: string;
  readonly indexKey: 'playbooks/index.json';
}

export interface InvocationContext {
  readonly awsRequestId: string;
  getRemainingTimeInMillis(): number;
}

/** Checks trusted configuration against the same environment-qualified bucket naming contract as CDK. */
export function configuration(): Configuration {
  const environment = process.env.DEPLOYMENT_ENVIRONMENT;
  const bucket = process.env.PLAYBOOKS_BUCKET_NAME ?? '';
  if ((environment !== 'dev' && environment !== 'demo')
    || bucket.length > 63
    || !new RegExp(`^soc-bot-${environment}-data-[0-9]{12}-[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$`).test(bucket)
    || process.env.PLAYBOOK_INDEX_KEY !== 'playbooks/index.json') throw new RagError('CONFIGURATION_ERROR');
  return { environment, bucket, indexKey: 'playbooks/index.json' };
}

/** Leaves at least ten seconds for the structured outcome, bounded by the real Lambda remaining time. */
export function invocationDeadline(context: InvocationContext): number {
  const remaining = context.getRemainingTimeInMillis();
  if (!Number.isFinite(remaining) || remaining <= COMPLETION_RESERVE_MS) throw new RagError('READ_TIMEOUT');
  return Date.now() + Math.min(LAMBDA_TIMEOUT_MS, remaining) - COMPLETION_RESERVE_MS;
}

/** Refuses further work once the reserved completion window has begun. */
export function checkDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new RagError('READ_TIMEOUT');
}
