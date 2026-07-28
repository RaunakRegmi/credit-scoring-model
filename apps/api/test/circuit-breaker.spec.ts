/**
 * Circuit breaker behaviour — the mechanism behind the §4 "model timeout" requirement.
 *
 * What matters is not that it trips, but that it fails in bounded time and reports *why*, so
 * the decision engine can distinguish a slow model from an absent one and degrade accordingly.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CircuitBreaker,
  CircuitOpenError,
  OperationTimeoutError,
} from '../src/common/circuit-breaker';

function breaker(overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
  return new CircuitBreaker({
    name: 'test',
    timeoutMs: 50,
    failureThreshold: 3,
    resetMs: 100,
    ...overrides,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('closed circuit', () => {
  it('passes through a successful result', async () => {
    const circuit = breaker();
    await expect(circuit.execute(async () => 'ok')).resolves.toBe('ok');
    expect(circuit.snapshot().state).toBe('CLOSED');
  });

  it('propagates the operation error and counts the failure', async () => {
    const circuit = breaker();
    await expect(circuit.execute(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(circuit.snapshot().consecutiveFailures).toBe(1);
    expect(circuit.snapshot().state).toBe('CLOSED');
  });

  it('resets the failure count after a success', async () => {
    const circuit = breaker();
    await expect(circuit.execute(async () => Promise.reject(new Error('boom')))).rejects.toThrow();
    await circuit.execute(async () => 'ok');
    expect(circuit.snapshot().consecutiveFailures).toBe(0);
  });
});

describe('timeouts', () => {
  it('aborts an operation that overruns and reports it as a timeout', async () => {
    const circuit = breaker({ timeoutMs: 30 });
    await expect(
      circuit.execute(async (signal) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
        return 'never';
      }),
    ).rejects.toBeInstanceOf(OperationTimeoutError);
  });

  it('signals the abort to the operation so it can stop work', async () => {
    const circuit = breaker({ timeoutMs: 20 });
    const observed = { aborted: false };

    await expect(
      circuit.execute(async (signal) => {
        signal.addEventListener('abort', () => {
          observed.aborted = true;
        });
        await sleep(200);
        return 'done';
      }),
    ).rejects.toBeInstanceOf(OperationTimeoutError);

    expect(observed.aborted).toBe(true);
  });

  it('counts a timeout as a failure towards the threshold', async () => {
    const circuit = breaker({ timeoutMs: 10, failureThreshold: 2 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(circuit.execute(async () => sleep(100))).rejects.toBeInstanceOf(
        OperationTimeoutError,
      );
    }
    expect(circuit.snapshot().state).toBe('OPEN');
  });
});

describe('open circuit', () => {
  it('trips after the configured number of consecutive failures', async () => {
    const circuit = breaker({ failureThreshold: 3 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(circuit.execute(async () => Promise.reject(new Error('down')))).rejects.toThrow();
    }
    expect(circuit.snapshot().state).toBe('OPEN');
  });

  it('rejects immediately without invoking the operation', async () => {
    const circuit = breaker({ failureThreshold: 1 });
    await expect(circuit.execute(async () => Promise.reject(new Error('down')))).rejects.toThrow();

    const operation = vi.fn(async () => 'should not run');
    await expect(circuit.execute(operation)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(operation).not.toHaveBeenCalled();
  });

  it('reports how long until the next attempt', async () => {
    const circuit = breaker({ failureThreshold: 1, resetMs: 500 });
    await expect(circuit.execute(async () => Promise.reject(new Error('down')))).rejects.toThrow();

    try {
      await circuit.execute(async () => 'x');
      expect.unreachable('expected CircuitOpenError');
    } catch (error) {
      expect(error).toBeInstanceOf(CircuitOpenError);
      expect((error as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
      expect((error as CircuitOpenError).retryAfterMs).toBeLessThanOrEqual(500);
    }
  });
});

describe('half-open recovery', () => {
  it('allows one trial call after the cooldown and closes on success', async () => {
    const circuit = breaker({ failureThreshold: 1, resetMs: 40 });
    await expect(circuit.execute(async () => Promise.reject(new Error('down')))).rejects.toThrow();
    expect(circuit.snapshot().state).toBe('OPEN');

    await sleep(60);
    await expect(circuit.execute(async () => 'recovered')).resolves.toBe('recovered');
    expect(circuit.snapshot().state).toBe('CLOSED');
    expect(circuit.snapshot().consecutiveFailures).toBe(0);
  });

  it('re-opens immediately when the trial call also fails', async () => {
    const circuit = breaker({ failureThreshold: 3, resetMs: 40 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(circuit.execute(async () => Promise.reject(new Error('down')))).rejects.toThrow();
    }
    await sleep(60);

    // One trial failure re-opens without waiting for the threshold again — there is no point
    // letting more traffic through to confirm what we just learned.
    await expect(circuit.execute(async () => Promise.reject(new Error('still down')))).rejects.toThrow(
      'still down',
    );
    expect(circuit.snapshot().state).toBe('OPEN');
  });
});

describe('snapshot', () => {
  it('records the last error message for diagnostics', async () => {
    const circuit = breaker();
    await expect(circuit.execute(async () => Promise.reject(new Error('upstream 502')))).rejects.toThrow();
    expect(circuit.snapshot().lastError).toBe('upstream 502');
    expect(circuit.snapshot().lastFailureAt).not.toBeNull();
  });

  it('clears state on reset', async () => {
    const circuit = breaker({ failureThreshold: 1 });
    await expect(circuit.execute(async () => Promise.reject(new Error('down')))).rejects.toThrow();
    circuit.reset();
    expect(circuit.snapshot()).toEqual({
      state: 'CLOSED',
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastError: null,
    });
  });
});
