import { once } from 'node:events';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { HEARTBEAT_MS } from './config';

export interface LambdaContext { readonly awsRequestId: string; getRemainingTimeInMillis(): number }
declare global {
  const awslambda: {
    streamifyResponse(handler: (event: unknown, stream: Writable, context: LambdaContext) => Promise<void>): unknown;
    HttpResponseStream: { from(stream: Writable, metadata: { statusCode: number; headers: Record<string, string> }): Writable };
  };
}
export type StreamEvent = Record<string, string | number | boolean> & { type: string };

/** Serializes safe NDJSON events and bounded backpressure without treating disconnects as cancellation. */
export class NdjsonStream {
  private readonly stream: Writable;
  private queue: Promise<void> = Promise.resolve();
  private transportFailed = false;
  private terminal = false;
  private lastActivity = Date.now();
  private readonly timer: ReturnType<typeof setInterval>;

  /**
   * Wraps Lambda's response stream with NDJSON headers, transport tracking, and idle heartbeats.
   *
   * Example Input:
   * new NdjsonStream(Writable <Lambda response stream>, '296a0470-b7b7-4a21-a9d7-72fb7be90ac9')
   * Example Output: an NdjsonStream instance; HTTP metadata includes:
   * { statusCode: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }
   * The constructor does not write a conversation or answer event; callers use emit().
   */
  public constructor(raw: Writable, private readonly turnId: string) {
    this.stream = awslambda.HttpResponseStream.from(raw, { statusCode: 200, headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
    this.stream.on('error', () => { this.transportFailed = true; });
    this.timer = setInterval(() => {
      if (!this.terminal && Date.now() - this.lastActivity >= HEARTBEAT_MS) {
        void this.emit({ type: 'heartbeat', turnId, stage: 'processing' });
      }
    }, HEARTBEAT_MS);
    this.timer.unref();
  }

  /**
   * Queues one JSON line while bounding backpressure and suppressing writes after transport failure.
   *
   * Example Input:
   * { type: 'text_delta', text: 'Two events were found.' }
   * Example Output: resolves to undefined; on a healthy open stream, writes this line plus a newline:
   * {"type":"text_delta","text":"Two events were found."}
   * An already-terminal stream ignores new events rather than emitting a second response.
   */
  public emit(event: StreamEvent): Promise<void> {
    if (this.terminal) return this.queue;
    const line = `${JSON.stringify(event)}\n`;
    this.queue = this.queue.then(async () => {
      if (this.transportFailed || this.stream.destroyed) return;
      this.lastActivity = Date.now();
      try {
        if (!this.stream.write(line)) await once(this.stream, 'drain', { signal: AbortSignal.timeout(1_000) });
      } catch { this.transportFailed = true; }
    });
    return this.queue;
  }

  /**
   * Emits at most one terminal event and closes the response after all queued writes.
   *
   * Example Input (instance turnId is '296a0470-b7b7-4a21-a9d7-72fb7be90ac9'):
   * { type: 'complete', conversationId: 'conversation-A', replayed: false, truncated: false }
   * Example Output: resolves to undefined; selected final line on a healthy stream:
   * {"type":"complete","conversationId":"conversation-A","replayed":false,"truncated":false,"turnId":"296a0470-b7b7-4a21-a9d7-72fb7be90ac9"}
   * Side effects: marks the stream terminal, clears heartbeats, and ends the response.
   */
  public async finish(event: StreamEvent): Promise<void> {
    if (this.terminal) return;
    const sent = this.emit({ ...event, turnId: this.turnId });
    this.terminal = true;
    clearInterval(this.timer);
    await sent;
    try {
      const closed = finished(this.stream, { cleanup: true, signal: AbortSignal.timeout(5_000) });
      this.stream.end();
      await closed;
    } catch { this.transportFailed = true; }
  }
}

/**
 * Returns a normal HTTP error before the NDJSON response has started.
 *
 * Example Input:
 * { raw: Writable <Lambda response stream>, statusCode: 400, code: 'INVALID_INPUT',
 *   message: 'Invalid chat request fields.', correlationId: '<invocation-id>' }
 * Example Output: resolves to undefined; HTTP 400 with application/json body:
 * {"error":{"code":"INVALID_INPUT","message":"Invalid chat request fields."},"correlationId":"<invocation-id>"}
 * Unlike emit(), this sends one ordinary JSON error and closes the response.
 */
export async function httpError(raw: Writable, statusCode: number, code: string, message: string, correlationId: string): Promise<void> {
  const stream = awslambda.HttpResponseStream.from(raw, { statusCode, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  } });
  try {
    const closed = finished(stream, { cleanup: true, signal: AbortSignal.timeout(5_000) });
    stream.end(JSON.stringify({ error: { code, message }, correlationId }));
    await closed;
  } catch { /* A broken transport is not evidence that backend work was cancelled. */ }
}
