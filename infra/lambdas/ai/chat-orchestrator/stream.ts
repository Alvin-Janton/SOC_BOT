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

  /** Emits at most one terminal event and closes the response after all queued writes. */
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

/** Returns a normal HTTP error before the NDJSON response has started. */
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
