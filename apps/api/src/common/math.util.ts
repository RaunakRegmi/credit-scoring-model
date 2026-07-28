/**
 * Numeric helpers for the scoring pipeline.
 *
 * Every financial ratio in this system goes through `safeRatio`. That is not
 * defensiveness for its own sake: a debt service ratio computed against zero verified
 * income is the single most likely way for `Infinity` to reach a credit decision, and an
 * `Infinity` that survives to the model is scored as "worst possible applicant" by
 * accident rather than by judgement. We would rather return `null`, flag the application
 * as lacking income data, and put it in front of a human.
 */

/**
 * Division that cannot produce `Infinity` or `NaN`.
 *
 * Returns `null` when the ratio is undefined rather than substituting a number, so the
 * caller is forced to decide what an unknown ratio means for its sub-score.
 */
export function safeRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return null;
  }
  if (denominator === 0) {
    return null;
  }
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

/** Constrains a value to `[min, max]`. Non-finite input collapses to `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * Linear interpolation of points earned between a floor and a ceiling, as used by every
 * "linear scale from 0 to max; capped at top threshold" row in §4.2–4.5.
 *
 * `value <= floor` earns nothing; `value >= ceiling` earns `maxPoints`.
 */
export function linearScore(
  value: number,
  floor: number,
  ceiling: number,
  maxPoints: number,
): number {
  if (!Number.isFinite(value) || ceiling <= floor) {
    return 0;
  }
  const fraction = (value - floor) / (ceiling - floor);
  return clamp(fraction, 0, 1) * maxPoints;
}

/**
 * Inverse of `linearScore`: full points at or below `bestValue`, nothing at or above
 * `worstValue`. Used for ratios where lower is better (DSR, discretionary spend).
 */
export function inverseLinearScore(
  value: number,
  bestValue: number,
  worstValue: number,
  maxPoints: number,
): number {
  if (!Number.isFinite(value) || worstValue <= bestValue) {
    return 0;
  }
  const fraction = (worstValue - value) / (worstValue - bestValue);
  return clamp(fraction, 0, 1) * maxPoints;
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

/** Arithmetic mean. Returns `null` for an empty series rather than `NaN`. */
export function mean(values: readonly number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return null;
  }
  return sum(finite) / finite.length;
}

/** Population standard deviation. `null` for fewer than two observations. */
export function stdDev(values: readonly number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2) {
    return null;
  }
  const average = sum(finite) / finite.length;
  const variance = sum(finite.map((value) => (value - average) ** 2)) / finite.length;
  return Math.sqrt(variance);
}

/**
 * Coefficient of variation — the volatility measure behind `income_stability_cv`.
 *
 * Scale-free, so an applicant earning NPR 30,000 and one earning NPR 300,000 with
 * proportionally identical swings score the same, which is the intended behaviour.
 */
export function coefficientOfVariation(values: readonly number[]): number | null {
  const average = mean(values);
  const deviation = stdDev(values);
  if (average === null || deviation === null || average === 0) {
    return null;
  }
  return Math.abs(deviation / average);
}

/**
 * Ordinary least squares slope of `y` on `x` — the §4.3 "regression on role seniority
 * over time" used for the career progression index.
 *
 * Returns `null` when the slope is not identifiable: fewer than two points, or every
 * observation at the same `x` (zero variance, vertical fit).
 */
export function olsSlope(points: readonly { x: number; y: number }[]): number | null {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (usable.length < 2) {
    return null;
  }

  const meanX = sum(usable.map((p) => p.x)) / usable.length;
  const meanY = sum(usable.map((p) => p.y)) / usable.length;

  const covariance = sum(usable.map((p) => (p.x - meanX) * (p.y - meanY)));
  const varianceX = sum(usable.map((p) => (p.x - meanX) ** 2));

  if (varianceX === 0) {
    return null;
  }
  return covariance / varianceX;
}

/**
 * Compound annual growth rate between the earliest and latest value in a series.
 *
 * Returns `null` when it is undefined — a non-positive starting value, no elapsed time,
 * or fewer than two points. A salary going from 0 to something is infinite growth, which
 * is not a number we want anywhere near a score.
 */
export function compoundGrowthRate(
  startValue: number,
  endValue: number,
  years: number,
): number | null {
  if (!Number.isFinite(startValue) || !Number.isFinite(endValue) || !Number.isFinite(years)) {
    return null;
  }
  if (startValue <= 0 || years <= 0) {
    return null;
  }
  const ratio = endValue / startValue;
  if (ratio <= 0) {
    return null;
  }
  const rate = ratio ** (1 / years) - 1;
  return Number.isFinite(rate) ? rate : null;
}

/**
 * Rounds to `decimals` places.
 *
 * Uses exponential-notation shifting rather than `Math.round(value * 10 ** decimals)`. The
 * multiply-and-divide form is subtly wrong on exact decimal halves: `1.005 * 100` evaluates to
 * `100.49999999999999`, which rounds *down* to `1.00`. Every monetary amount and score in this
 * system passes through here, so a systematic downward bias on half-values is not acceptable.
 * Shifting the decimal exponent in the numeric literal avoids the intermediate product entirely.
 */
export function roundTo(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const shifted = Number(`${value}e${decimals}`);
  if (!Number.isFinite(shifted)) {
    // Overflowed the exponent (values near Number.MAX_VALUE). Fall back to the naive form,
    // where precision at this magnitude is already meaningless.
    const factor = 10 ** decimals;
    const naive = Math.round(value * factor) / factor;
    return Number.isFinite(naive) ? naive : value;
  }
  const result = Number(`${Math.round(shifted)}e-${decimals}`);
  return Number.isFinite(result) ? result : value;
}

/** Distinct calendar months (`YYYY-MM`) present in a set of dates. */
export function distinctMonths(dates: readonly Date[]): number {
  const months = new Set<string>();
  for (const date of dates) {
    if (!Number.isNaN(date.getTime())) {
      months.add(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`);
    }
  }
  return months.size;
}

/** First instant of the UTC month containing `date`. */
export function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Whole months between two dates, floored at zero. */
export function monthsBetween(from: Date, to: Date): number {
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  return Math.max(0, months);
}

/** Fractional years between two dates, using the 365.25-day convention. */
export function yearsBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  if (!Number.isFinite(ms) || ms <= 0) {
    return 0;
  }
  return ms / (1000 * 60 * 60 * 24 * 365.25);
}
