/**
 * Pure helper functions for event display and filtering.
 * Deliberately has no Firebase dependency so it's testable without mocks.
 */

export type EventType = 'practice' | 'game' | 'tournament' | 'meeting' | 'other';

export interface TeamEventLike {
  id: string;
  startDate: string;
  [key: string]: any;
}

const EVENT_TYPE_META: Record<EventType, { icon: string; color: string; label: string }> = {
  practice: { icon: 'running', color: '#2e7d32', label: 'Practice' },
  game: { icon: 'basketball-ball', color: '#0b3a8d', label: 'Game' },
  tournament: { icon: 'trophy', color: '#f5a623', label: 'Tournament' },
  meeting: { icon: 'users', color: '#6b7a94', label: 'Meeting' },
  other: { icon: 'calendar', color: '#536277', label: 'Other' },
};

export function getEventMeta(type: EventType) {
  return EVENT_TYPE_META[type] ?? EVENT_TYPE_META.other;
}

/** Format date like "Sat, Mar 15" */
export function formatEventDate(isoStr: string): string {
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Format time like "6:00 PM" */
export function formatEventTime(isoStr: string): string {
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** Group events by date key "YYYY-MM-DD" */
export function groupEventsByDate<T extends TeamEventLike>(events: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const e of events) {
    const key = e.startDate.slice(0, 10);
    const arr = map.get(key) ?? [];
    arr.push(e);
    map.set(key, arr);
  }
  return map;
}

/** Get upcoming events (today or later) */
export function filterUpcoming<T extends TeamEventLike>(events: T[]): T[] {
  const todayStr = new Date().toISOString().slice(0, 10);
  return events.filter((e) => e.startDate.slice(0, 10) >= todayStr);
}

/** Get past events */
export function filterPast<T extends TeamEventLike>(events: T[]): T[] {
  const todayStr = new Date().toISOString().slice(0, 10);
  return events.filter((e) => e.startDate.slice(0, 10) < todayStr);
}

/* ── Recurring-event helpers ─────────────────────────────── */

export interface RecurrencePattern {
  /** Days of week the event recurs on (0 = Sunday … 6 = Saturday) */
  daysOfWeek: number[];
  /** Maximum number of occurrences (optional) */
  repeatCount?: number;
  /** Stop generating after this date YYYY-MM-DD (optional, inclusive) */
  repeatUntil?: string;
}

/** Hard cap to prevent accidental unbounded generation */
const MAX_OCCURRENCES = 200;

/**
 * Generate an array of Date objects for each occurrence of a recurring event.
 *
 * Starting the day AFTER `startDate`, walks forward day-by-day and collects
 * dates whose day-of-week is in `pattern.daysOfWeek`.  Stops when either
 * `repeatCount` occurrences have been collected, or the date exceeds
 * `repeatUntil`, whichever comes first.  If neither is provided the hard cap
 * of 200 occurrences is used.
 *
 * The original `startDate` is NOT included in the output – it is treated as
 * the first occurrence by the caller.
 */
export function generateRecurringDates(
  startDate: Date,
  pattern: RecurrencePattern,
): Date[] {
  const { daysOfWeek, repeatCount, repeatUntil } = pattern;
  if (!daysOfWeek.length) return [];

  const limit = Math.min(repeatCount ?? MAX_OCCURRENCES, MAX_OCCURRENCES);
  // We need (limit - 1) additional dates because the original event counts as #1
  const needed = limit - 1;
  if (needed <= 0) return [];

  const endDate = repeatUntil ? new Date(repeatUntil + 'T23:59:59') : null;
  const daySet = new Set(daysOfWeek);
  const results: Date[] = [];

  const cursor = new Date(startDate);
  cursor.setDate(cursor.getDate() + 1); // start from the day after

  // Walk forward up to ~2 years as safety
  const maxDays = 731;
  for (let i = 0; i < maxDays && results.length < needed; i++) {
    if (endDate && cursor > endDate) break;
    if (daySet.has(cursor.getDay())) {
      results.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return results;
}
