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
