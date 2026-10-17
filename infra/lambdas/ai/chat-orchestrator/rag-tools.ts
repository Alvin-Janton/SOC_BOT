import { InvokeCommand, InvokeCommandOutput, LambdaClient } from '@aws-sdk/client-lambda';
import { randomUUID } from 'node:crypto';
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, RagRequest, RagResponse, failure, responseSchema } from '../rag-tool/contracts';
import { ChatError, Configuration, FINALIZATION_RESERVE_MS, TurnBudget } from './config';

const client = new LambdaClient({ maxAttempts: 1 });
const RAG_INVOCATION_MS = 180_000;

/** Keeps caller-generated availability results distinct without changing the persisted/wire envelope. */
export interface RagInvocationOutcome {
  readonly response: RagResponse;
  readonly origin: 'backend' | 'adapter';
}

/** Carries a boundary classification only until the executor rethrows the original fatal failure. */
export class RagBoundaryFailure extends Error {
  public constructor(public readonly kind: 'invocation' | 'response', public readonly failure: unknown) {
    super('The playbook invocation boundary failed.');
  }
}

/** Creates a fatal protocol error without retaining response content or SDK diagnostics. */
function protocolError(): ChatError {
  return new ChatError('TOOL_PROTOCOL_ERROR', 'The playbook tool returned an invalid response.', 502, false);
}

/** Validates metadata and binds the complete response to the exact requested operation, document and sections. */
function validatedResponse(value: unknown, request: RagRequest): RagResponse {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw protocolError();
  const response = parsed.data;
  if (response.operation !== request.operation) throw protocolError();
  if (response.ok) {
    if (response.operation === 'describe_documents') {
      if (new Set(response.documents.map(document => document.document_id)).size !== response.documents.length) throw protocolError();
    } else {
      if (request.operation === 'describe_documents' || response.document.document_id !== request.document_id
        || new Set(response.sections.map(section => section.section_id)).size !== response.sections.length) throw protocolError();
      if (response.operation === 'describe_document' && response.sections.length !== response.document.section_count) throw protocolError();
      if (response.operation === 'retrieve_sections' && (request.operation !== 'retrieve_sections'
        || response.sections.length !== request.section_ids.length
        || response.sections.some((section, position) => section.section_id !== request.section_ids[position])
        || response.document.section_count < response.sections.length)) throw protocolError();
    }
  }
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESPONSE_BYTES) throw protocolError();
  return response;
}

/** Recognizes retryable transport/service unavailability only; permissions and unknown failures remain fatal. */
function unavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const metadata = error as Error & { $metadata?: { httpStatusCode?: number }; code?: string };
  const status = metadata.$metadata?.httpStatusCode;
  return (status !== undefined && (status >= 500 || status === 429))
    || ['ServiceException', 'TooManyRequestsException', 'EC2ThrottledException', 'NetworkingError', 'TimeoutError'].includes(error.name)
    || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
      'ENETUNREACH', 'EHOSTUNREACH'].includes(metadata.code ?? '');
}

/** Invokes only the configured private RAG function once, preserving reserves and returning validated full results.
 * Example input: { operation: 'retrieve_sections', document_id: 'credential-compromise', section_ids: ['initial-triage'] }.
 * Output: { response: <complete RAG envelope>, origin: 'backend' | 'adapter' }; only response is persisted.
 * This adapter neither persists results nor cancels the remote Lambda.
 */
export async function invokeRag(request: RagRequest, config: Configuration, budget: TurnBudget): Promise<RagInvocationOutcome> {
  budget.check();
  const available = budget.remaining() - FINALIZATION_RESERVE_MS;
  if (available <= 0) throw new ChatError('TURN_TIMED_OUT', 'The investigation reached its time limit.', 504);
  const payload = Buffer.from(JSON.stringify(request));
  if (payload.byteLength > MAX_REQUEST_BYTES) throw new ChatError('INVALID_TOOL_INPUT', 'The playbook request exceeds its input limit.', 400, false);
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(RAG_INVOCATION_MS, available)));
  const signal = AbortSignal.any([budget.signal, timeout]);
  let result: InvokeCommandOutput;
  try {
    result = await client.send(new InvokeCommand({ FunctionName: config.ragFunction, InvocationType: 'RequestResponse', Payload: payload }),
      { abortSignal: signal });
  } catch (error) {
    try { budget.check(); } catch (failure) { throw new RagBoundaryFailure('invocation', failure); }
    if (timeout.aborted) {
      if (available <= RAG_INVOCATION_MS) throw new RagBoundaryFailure('invocation',
        new ChatError('TURN_TIMED_OUT', 'The investigation reached its time limit.', 504));
      // A local wait timeout does not cancel the remote function or prove it never ran.
      return { origin: 'adapter', response: failure('READ_TIMEOUT', request.operation, randomUUID()) };
    }
    if (unavailable(error)) return { origin: 'adapter', response: failure('READ_FAILED', request.operation, randomUUID()) };
    throw new RagBoundaryFailure('invocation',
      new ChatError('RAG_INVOCATION_FAILED', 'The playbook tool could not be invoked safely.', 502, false));
  }
  budget.check();
  if (timeout.aborted) {
    if (available <= RAG_INVOCATION_MS) throw new RagBoundaryFailure('invocation',
      new ChatError('TURN_TIMED_OUT', 'The investigation reached its time limit.', 504));
    return { origin: 'adapter', response: failure('READ_TIMEOUT', request.operation, randomUUID()) };
  }
  if (result.StatusCode !== 200 || result.FunctionError) throw new RagBoundaryFailure('invocation', protocolError());
  if (!result.Payload || result.Payload.byteLength > MAX_RESPONSE_BYTES) throw new RagBoundaryFailure('response', protocolError());
  try {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.Payload)); }
    catch { throw protocolError(); }
    return { origin: 'backend', response: validatedResponse(value, request) };
  } catch (failure) { throw new RagBoundaryFailure('response', failure); }
}
