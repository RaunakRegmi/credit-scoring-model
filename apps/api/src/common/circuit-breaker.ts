/**
 * A minimal timeout-and-trip circuit breaker.
 *
 * Written rather than pulled in as a dependency: the whole behaviour is sixty lines, and
 * the failure semantics here matter enough to credit decisions that they should be
 * readable in one screen rather than configured through someone else's options object.
 *
 * The scoring engine depends on it for one specific guarantee — when the ML service is
 * down or slow, we find out in bounded time and fall back to the deterministic scorecard,
 * rather than holding an applicant's request open until an upstream timeout fires.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Circuit is open; retry in ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
  }
}

export class OperationTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Operation exceeded ${timeoutMs}ms`);
    this.name = 'OperationTimeoutError';
  }
}

export interface CircuitBreakerOptions {
  /** Per-attempt ceiling. */
  readonly timeoutMs: number;
  /** Consecutive failures that trip the circuit. */
  readonly failureThreshold: number;
  /** How long the circuit stays open before allowing one trial call. */
  readonly resetMs: number;
  /** Identifier used in log messages. */
  readonly name: string;
}

export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly lastFailureAt: number | null;
  readonly lastError: string | null;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: CircuitBreakerOptions) {}

  snapshot(): CircuitSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
    };
  }

  /**
   * Runs `operation` under the breaker.
   *
   * Throws `CircuitOpenError` without invoking the operation when the circuit is open,
   * and `OperationTimeoutError` when it overruns. Both are the caller's cue to degrade;
   * neither should be treated as an application error.
   */
  async execute<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.refreshState();

    if (this.state === 'OPEN') {
      throw new CircuitOpenError(this.retryAfterMs());
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // The deadline is enforced by racing, not only by aborting the signal.
    //
    // Aborting alone is not enough: it relies on the operation observing the signal. `fetch`
    // does, but a hung DNS resolution, a third-party client that ignores signals, or a
    // CPU-bound step does not — and then `await operation(...)` blocks past the deadline and
    // the timeout silently never fires. §6.2 budgets applicant-facing latency, so the caller
    // must be released on time regardless of whether the operation cooperates.
    //
    // The abort is still issued, so well-behaved operations stop work and release sockets
    // rather than completing into a result nobody is waiting for.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new OperationTimeoutError(this.options.timeoutMs));
      }, this.options.timeoutMs);
    });

    const attempt = operation(controller.signal);
    // If the race is lost, `attempt` may still reject later with nobody awaiting it. Without
    // this the process takes an unhandled rejection for an error we already accounted for.
    attempt.catch(() => undefined);

    try {
      const result = await Promise.race([attempt, deadline]);
      this.onSuccess();
      return result;
    } catch (error) {
      // Normalise: an abort we triggered is our deadline, not a peer error.
      const failure =
        error instanceof OperationTimeoutError
          ? error
          : controller.signal.aborted
            ? new OperationTimeoutError(this.options.timeoutMs)
            : error;
      this.onFailure(failure);
      throw failure;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /** Transitions OPEN -> HALF_OPEN once the cooldown has elapsed. */
  private refreshState(): void {
    if (this.state === 'OPEN' && this.openedAt !== null) {
      if (Date.now() - this.openedAt >= this.options.resetMs) {
        this.state = 'HALF_OPEN';
      }
    }
  }

  private retryAfterMs(): number {
    if (this.openedAt === null) {
      return this.options.resetMs;
    }
    return Math.max(0, this.options.resetMs - (Date.now() - this.openedAt));
  }

  private onSuccess(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.lastError = null;
  }

  private onFailure(error: unknown): void {
    this.consecutiveFailures += 1;
    this.lastFailureAt = Date.now();
    this.lastError = error instanceof Error ? error.message : String(error);

    // A failed trial call in HALF_OPEN re-opens immediately; there is no point letting
    // further traffic through to confirm what we just learned.
    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }

  /** Test seam: returns the breaker to its initial state. */
  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.lastFailureAt = null;
    this.lastError = null;
  }
}
