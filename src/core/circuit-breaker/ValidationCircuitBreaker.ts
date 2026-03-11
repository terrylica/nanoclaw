/**
 * Circuit breaker for validation subsystem health monitoring.
 *
 * States:
 *   CLOSED    — normal operation; failures are tracked
 *   OPEN      — subsystem tripped; calls fail-fast until timeout expires
 *   HALF_OPEN — recovery probe; one call allowed through to test the subsystem
 *
 * Emits events:
 *   'stateChange' (prev: State, next: State) — on any state transition
 *   'failure'     (error: Error)             — on each recorded failure
 *   'success'     ()                          — on a successful call
 *   'open'        ()                          — when tripping to OPEN
 *   'close'       ()                          — when recovering to CLOSED
 */
import { EventEmitter } from 'events';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before tripping to OPEN. Default: 5 */
  failureThreshold?: number;
  /** Milliseconds to wait in OPEN before probing (HALF_OPEN). Default: 30_000 */
  recoveryTimeoutMs?: number;
  /** Number of consecutive successes in HALF_OPEN to close again. Default: 1 */
  successThreshold?: number;
}

export class ValidationCircuitBreaker extends EventEmitter {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private openedAt: number | null = null;

  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly successThreshold: number;

  constructor(options: CircuitBreakerOptions = {}) {
    super();
    this.failureThreshold = options.failureThreshold ?? 5;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 30_000;
    this.successThreshold = options.successThreshold ?? 1;
  }

  /** Current circuit state. */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Execute `fn` through the circuit breaker.
   * Throws immediately (without calling `fn`) if OPEN and timeout has not elapsed.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeTransitionFromOpen();

    if (this.state === 'OPEN') {
      throw new Error('Circuit breaker is OPEN — call rejected');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** Manually record a failure (useful when the caller handles errors itself). */
  recordFailure(err?: Error): void {
    this.onFailure(err ?? new Error('Manual failure recorded'));
  }

  /** Manually record a success (useful when the caller handles results itself). */
  recordSuccess(): void {
    this.onSuccess();
  }

  // --- Private helpers ---

  private maybeTransitionFromOpen(): void {
    if (this.state === 'OPEN' && this.openedAt !== null) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.recoveryTimeoutMs) {
        this.transition('HALF_OPEN');
      }
    }
  }

  private onSuccess(): void {
    this.emit('success');
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.failureCount = 0;
        this.successCount = 0;
        this.openedAt = null;
        this.transition('CLOSED');
        this.emit('close');
      }
    } else {
      // CLOSED: reset failure counter on success
      this.failureCount = 0;
    }
  }

  private onFailure(err: Error): void {
    this.emit('failure', err);
    this.successCount = 0;
    this.failureCount++;

    if (this.state === 'CLOSED' && this.failureCount >= this.failureThreshold) {
      this.openedAt = Date.now();
      this.transition('OPEN');
      this.emit('open');
    } else if (this.state === 'HALF_OPEN') {
      // Probe failed — reopen
      this.openedAt = Date.now();
      this.transition('OPEN');
      this.emit('open');
    }
  }

  private transition(next: CircuitState): void {
    const prev = this.state;
    this.state = next;
    this.emit('stateChange', prev, next);
  }
}
