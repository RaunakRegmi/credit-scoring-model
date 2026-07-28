import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Conditional class names with Tailwind conflict resolution (the shadcn convention). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Formats an NPR amount in the South Asian lakh/crore grouping.
 *
 * `en-IN` rather than `en-US` deliberately: a Nepali underwriter reads 25,00,000 as twenty-five
 * lakh at a glance, where 2,500,000 requires counting digits.
 */
export function formatNpr(amount: number, options: { compact?: boolean } = {}): string {
  if (!Number.isFinite(amount)) {
    return '—';
  }
  if (options.compact === true && amount >= 100_000) {
    if (amount >= 10_000_000) {
      return `NPR ${(amount / 10_000_000).toFixed(2)} Cr`;
    }
    return `NPR ${(amount / 100_000).toFixed(2)} L`;
  }
  return `NPR ${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(amount)}`;
}

export function formatPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return `${(value * 100).toFixed(decimals)}%`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** Turns a SCREAMING_SNAKE code into readable title case for display. */
export function humanise(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .map((word) => (word.length === 0 ? word : word[0]?.toUpperCase() + word.slice(1)))
    .join(' ');
}
