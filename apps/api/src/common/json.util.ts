/**
 * Normalises a domain object into a value Prisma will accept for a `Json` column.
 *
 * Two problems solved at once:
 *
 *   · Typing. Prisma's `InputJsonValue` requires a string index signature, which our
 *     `readonly` domain interfaces deliberately do not have. Casting at each call site would
 *     work and would also silently accept a value containing a `Date`, a `Decimal` or a
 *     `undefined` that does not survive the round trip.
 *
 *   · Semantics. Passing through `JSON.stringify` is exactly the normalisation an audit
 *     snapshot wants: `Date` becomes an ISO 8601 string, Prisma `Decimal` uses its own
 *     `toJSON`, and `undefined` properties disappear rather than being stored as SQL nulls.
 *     §10.4 requires these records to be readable years later by something that is not this
 *     codebase, so plain JSON scalars are the correct storage form.
 *
 * Throws if the value is not serialisable (a circular reference, a `BigInt`). That is a
 * programming error, and failing at the write is far better than persisting a corrupt audit
 * record.
 */
import { Prisma } from '../../prisma/generated/prisma/client';

export function toJson(value: unknown): Prisma.InputJsonValue {
  const serialised = JSON.stringify(value);
  if (serialised === undefined) {
    throw new TypeError(
      'Value is not JSON-serialisable and cannot be persisted to a Json column',
    );
  }
  return JSON.parse(serialised) as Prisma.InputJsonValue;
}
