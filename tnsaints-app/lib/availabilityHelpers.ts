/**
 * Pure helper functions for availability / RSVP summaries.
 * Deliberately has no Firebase dependency so it's testable without mocks.
 */

export type RsvpStatus = 'in' | 'out' | 'maybe';

export interface AvailabilityLike {
  status: RsvpStatus;
  [key: string]: any;
}

export interface RsvpSummary {
  inCount: number;
  outCount: number;
  maybeCount: number;
  total: number;
}

export function summariseRsvps(entries: AvailabilityLike[]): RsvpSummary {
  let inCount = 0;
  let outCount = 0;
  let maybeCount = 0;
  for (const e of entries) {
    if (e.status === 'in') inCount++;
    else if (e.status === 'out') outCount++;
    else maybeCount++;
  }
  return { inCount, outCount, maybeCount, total: entries.length };
}
