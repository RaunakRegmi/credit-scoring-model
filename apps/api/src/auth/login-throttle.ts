/**
 * Per-source login throttle.
 *
 * Complements the per-account lockout in `staff_user`, which it does not replace: lockout stops
 * an attacker grinding one account, this stops them spreading a small number of attempts across
 * many accounts from one source — where no single counter ever reaches its threshold.
 *
 * **In-process, and therefore per-replica.** Two API instances behind a load balancer each allow
 * the full budget, so the effective limit is the configured one times the replica count. That is
 * an acceptable ceiling for a single-instance or pilot deployment and is *not* adequate once the
 * API is horizontally scaled — at that point this moves to Redis or to the ingress layer. Stated
 * here rather than discovered later, because the code looks correct either way.
 */
import { Injectable, Logger } from '@nestjs/common';

interface Attempt {
  count: number;
  /** Epoch ms when the window began. */
  windowStart: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 20;

/** Bounded so a spray of unique source addresses cannot grow this map without limit. */
const MAX_TRACKED_KEYS = 10_000;

@Injectable()
export class LoginThrottle {
  private readonly logger = new Logger(LoginThrottle.name);
  private readonly attempts = new Map<string, Attempt>();

  /**
   * Records an attempt and reports whether the source is over budget.
   *
   * Counts every attempt, not only failures. A source making hundreds of *successful* logins per
   * minute is also not a person, and only counting failures leaves credential-stuffing with a
   * valid dump unthrottled.
   */
  check(key: string): { readonly allowed: boolean; readonly retryAfterSeconds: number } {
    const now = Date.now();
    this.evictExpired(now);

    const existing = this.attempts.get(key);

    if (existing === undefined || now - existing.windowStart >= WINDOW_MS) {
      this.attempts.set(key, { count: 1, windowStart: now });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    existing.count += 1;

    if (existing.count > MAX_ATTEMPTS_PER_WINDOW) {
      const retryAfterSeconds = Math.ceil((existing.windowStart + WINDOW_MS - now) / 1000);
      this.logger.warn(`Login throttle engaged for ${key} (${existing.count} attempts in window)`);
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Clears a source's counter after a successful authentication. */
  reset(key: string): void {
    this.attempts.delete(key);
  }

  private evictExpired(now: number): void {
    if (this.attempts.size < MAX_TRACKED_KEYS) {
      // Cheap path: only sweep when the map is actually large. Iterating ten thousand entries on
      // every login attempt would make the throttle its own denial of service.
      return;
    }
    for (const [key, attempt] of this.attempts) {
      if (now - attempt.windowStart >= WINDOW_MS) {
        this.attempts.delete(key);
      }
    }
    // Still full of live windows — an attack in progress. Drop the oldest rather than grow.
    if (this.attempts.size >= MAX_TRACKED_KEYS) {
      const oldest = [...this.attempts.entries()]
        .sort((a, b) => a[1].windowStart - b[1].windowStart)
        .slice(0, Math.floor(MAX_TRACKED_KEYS / 4));
      for (const [key] of oldest) {
        this.attempts.delete(key);
      }
    }
  }
}
