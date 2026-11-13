import { setTimeout as delay } from 'node:timers/promises';
import { ChatError, OUTCOME_RESERVE_MS, TurnBudget } from './config';
import { ConversationStore, Lease } from './store';

/** Sequential, read-only attempt monitor; shutdown and failed observation never masquerade as user cancellation. */
export class CancellationMonitor {
  private readonly abort = new AbortController();
  private readonly shutdown = new AbortController();
  public readonly signal: AbortSignal = this.abort.signal;
  private failure?: ChatError;
  private inFlight?: Promise<void>;
  private background?: Promise<void>;
  private reads = 0;
  private checkedAt = 0;
  private revision = 0;
  public constructor(private readonly store: ConversationStore, private readonly lease: Lease, private readonly budget: TurnBudget) {}

  /** Starts with an authoritative check, attaching the background rejection handler immediately. */
  public async start(): Promise<void> {
    await this.checkpoint();
    this.background = this.loop().catch(() => { if (!this.shutdown.signal.aborted && !this.budget.signal.aborted) this.fail(); });
  }

  private fail(cancelled = false): void {
    if (this.failure) return;
    this.failure = cancelled ? new ChatError('TURN_CANCEL_REQUESTED', 'Cancellation was requested.', 409, false)
      : new ChatError('CANCELLATION_STATE_UNAVAILABLE', 'Cancellation state could not be verified.', 503, false);
    this.abort.abort(this.failure);
  }

  public check(): void { if (this.failure) throw this.failure; }

  /** Coalesces concurrent checkpoints and reuses a control read completed within the last 250 ms. */
  public async checkpoint(): Promise<void> {
    this.check();
    if (this.shutdown.signal.aborted) throw new ChatError('CANCELLATION_STATE_UNAVAILABLE', 'Cancellation monitoring has stopped.', 503, false);
    if (!this.inFlight && Date.now() - this.checkedAt >= 250) {
      this.inFlight = this.read().finally(() => { this.inFlight = undefined; });
    }
    await this.inFlight;
    this.check();
  }

  private async read(): Promise<void> {
    const remaining = this.budget.deadline - OUTCOME_RESERVE_MS - Date.now();
    if (remaining <= 0) { this.budget.check(); return; }
    if (this.reads >= 256) { this.fail(); return; }
    this.reads++;
    try {
      const state = await this.store.cancellationControl(this.lease, AbortSignal.any([
        this.shutdown.signal, AbortSignal.timeout(Math.max(1, Math.min(2000, remaining))),
      ]));
      if (state.revision < this.revision) { this.fail(); return; }
      this.revision = state.revision; this.checkedAt = Date.now();
      if (state.cancel_requested_at) this.fail(true);
      else if (!['running', 'complete', 'truncated'].includes(state.status)) this.fail();
    } catch { if (!this.shutdown.signal.aborted && !this.budget.signal.aborted) this.fail(); }
  }

  private async loop(): Promise<void> {
    while (!this.shutdown.signal.aborted && !this.failure && !this.budget.signal.aborted) {
      await delay(3000, undefined, { signal: AbortSignal.any([this.shutdown.signal, this.budget.signal]) });
      await this.checkpoint();
    }
  }

  /** Uses the same total read cap for one final authoritative cleanup observation after monitoring stops. */
  public async cleanupControl() {
    await this.stop();
    if (this.reads >= 256 || this.budget.remaining() <= 1000) throw new ChatError('CANCELLATION_STATE_UNAVAILABLE', 'Cancellation state could not be verified.', 503, false);
    this.reads++;
    return this.store.cancellationControl(this.lease, AbortSignal.timeout(Math.max(1, Math.min(2000, this.budget.remaining() - 1000))));
  }

  public get readCount(): number { return this.reads; }

  /** Joins the timer and bounded in-flight read before any handler exits. */
  public async stop(): Promise<void> {
    this.shutdown.abort();
    await this.background;
    await this.inFlight;
  }
}
