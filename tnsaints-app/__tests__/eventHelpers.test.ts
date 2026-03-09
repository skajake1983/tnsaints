import {
  getEventMeta,
  formatEventDate,
  formatEventTime,
  groupEventsByDate,
  filterUpcoming,
  filterPast,
  generateRecurringDates,
  EventType,
  TeamEventLike,
} from '../lib/eventHelpers';

// Helper to make a minimal event-like object
function makeEvent(overrides: Partial<TeamEventLike> & { startDate: string }): TeamEventLike {
  const { id, ...rest } = overrides;
  return {
    id: id ?? 'e1',
    ...rest,
  };
}

// ── getEventMeta ───────────────────────────────────────────────────

describe('getEventMeta', () => {
  it('returns correct meta for practice', () => {
    const meta = getEventMeta('practice');
    expect(meta.label).toBe('Practice');
    expect(meta.icon).toBe('running');
    expect(meta.color).toBe('#2e7d32');
  });

  it('returns correct meta for game', () => {
    const meta = getEventMeta('game');
    expect(meta.label).toBe('Game');
    expect(meta.icon).toBe('basketball-ball');
  });

  it('returns correct meta for tournament', () => {
    const meta = getEventMeta('tournament');
    expect(meta.label).toBe('Tournament');
    expect(meta.icon).toBe('trophy');
  });

  it('returns correct meta for meeting', () => {
    const meta = getEventMeta('meeting');
    expect(meta.label).toBe('Meeting');
    expect(meta.icon).toBe('users');
  });

  it('returns correct meta for other', () => {
    const meta = getEventMeta('other');
    expect(meta.label).toBe('Other');
    expect(meta.icon).toBe('calendar');
  });

  it('falls back to other for unknown type', () => {
    const meta = getEventMeta('unknown' as EventType);
    expect(meta.label).toBe('Other');
  });
});

// ── formatEventDate ────────────────────────────────────────────────

describe('formatEventDate', () => {
  it('formats a date in short weekday/month/day', () => {
    const result = formatEventDate('2026-03-15T18:00:00');
    // Should contain month and day, exact format depends on locale
    expect(result).toMatch(/Mar/);
    expect(result).toMatch(/15/);
  });

  it('works for January 1', () => {
    const result = formatEventDate('2026-01-01T00:00:00');
    expect(result).toMatch(/Jan/);
    expect(result).toMatch(/1/);
  });
});

// ── formatEventTime ────────────────────────────────────────────────

describe('formatEventTime', () => {
  it('formats time in 12-hour format', () => {
    const result = formatEventTime('2026-03-15T18:00:00');
    expect(result).toMatch(/6:00/);
    expect(result).toMatch(/PM/i);
  });

  it('formats morning time', () => {
    const result = formatEventTime('2026-03-15T09:30:00');
    expect(result).toMatch(/9:30/);
    expect(result).toMatch(/AM/i);
  });
});

// ── groupEventsByDate ──────────────────────────────────────────────

describe('groupEventsByDate', () => {
  it('groups events by their date key (YYYY-MM-DD)', () => {
    const events = [
      makeEvent({ id: 'e1', startDate: '2026-03-15T09:00:00' }),
      makeEvent({ id: 'e2', startDate: '2026-03-15T14:00:00' }),
      makeEvent({ id: 'e3', startDate: '2026-03-16T10:00:00' }),
    ];
    const map = groupEventsByDate(events);
    expect(map.size).toBe(2);
    expect(map.get('2026-03-15')?.length).toBe(2);
    expect(map.get('2026-03-16')?.length).toBe(1);
  });

  it('returns empty map for empty array', () => {
    const map = groupEventsByDate([]);
    expect(map.size).toBe(0);
  });

  it('places single event in one group', () => {
    const events = [makeEvent({ startDate: '2026-06-01T12:00:00' })];
    const map = groupEventsByDate(events);
    expect(map.size).toBe(1);
    expect(map.get('2026-06-01')?.length).toBe(1);
  });
});

// ── filterUpcoming / filterPast ────────────────────────────────────

describe('filterUpcoming', () => {
  it('includes events on or after today', () => {
    // Use a far-future date that will always be upcoming
    const events = [
      makeEvent({ id: 'future', startDate: '2099-12-31T10:00:00' }),
      makeEvent({ id: 'past', startDate: '2000-01-01T10:00:00' }),
    ];
    const result = filterUpcoming(events);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('future');
  });

  it('returns empty when all events are past', () => {
    const events = [
      makeEvent({ startDate: '2000-01-01T10:00:00' }),
    ];
    expect(filterUpcoming(events).length).toBe(0);
  });
});

describe('filterPast', () => {
  it('includes events before today', () => {
    const events = [
      makeEvent({ id: 'future', startDate: '2099-12-31T10:00:00' }),
      makeEvent({ id: 'past', startDate: '2000-01-01T10:00:00' }),
    ];
    const result = filterPast(events);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('past');
  });

  it('returns empty when all events are future', () => {
    const events = [
      makeEvent({ startDate: '2099-12-31T10:00:00' }),
    ];
    expect(filterPast(events).length).toBe(0);
  });
});

// ── generateRecurringDates ─────────────────────────────────────────

describe('generateRecurringDates', () => {
  // 2026-03-02 is a Monday
  const monday = new Date('2026-03-02T18:00:00');

  it('returns empty when daysOfWeek is empty', () => {
    const result = generateRecurringDates(monday, { daysOfWeek: [] });
    expect(result).toEqual([]);
  });

  it('returns empty when repeatCount is 1 (original event is the only occurrence)', () => {
    const result = generateRecurringDates(monday, { daysOfWeek: [1], repeatCount: 1 });
    expect(result).toEqual([]);
  });

  it('generates correct number of occurrences with repeatCount', () => {
    // Every Monday for 4 weeks total (original + 3 more)
    const result = generateRecurringDates(monday, { daysOfWeek: [1], repeatCount: 4 });
    expect(result.length).toBe(3);
    expect(result[0].getDay()).toBe(1); // Monday
    expect(result[1].getDay()).toBe(1);
    expect(result[2].getDay()).toBe(1);
    // should be consecutive Mondays
    expect(result[0].getDate()).toBe(9);
    expect(result[1].getDate()).toBe(16);
    expect(result[2].getDate()).toBe(23);
  });

  it('generates events on multiple days of the week', () => {
    // Mon + Wed, repeatCount=5
    const result = generateRecurringDates(monday, { daysOfWeek: [1, 3], repeatCount: 5 });
    expect(result.length).toBe(4); // 5 total - 1 original
    const days = result.map((d) => d.getDay());
    // First hit after Monday should be Wednesday, then Monday, Wednesday, etc.
    expect(days[0]).toBe(3); // Wed Mar 4
    expect(days[1]).toBe(1); // Mon Mar 9
    expect(days[2]).toBe(3); // Wed Mar 11
    expect(days[3]).toBe(1); // Mon Mar 16
  });

  it('respects repeatUntil date', () => {
    // Every Monday, no count, stop after Mar 20
    const result = generateRecurringDates(monday, {
      daysOfWeek: [1],
      repeatUntil: '2026-03-20',
    });
    // Mar 9, 16 (Mar 23 would be after cutoff)
    expect(result.length).toBe(2);
    expect(result[0].getDate()).toBe(9);
    expect(result[1].getDate()).toBe(16);
  });

  it('stops at whichever comes first: repeatCount or repeatUntil', () => {
    // Every Monday, max 10, but until Mar 15 → Mar 9 only
    const result = generateRecurringDates(monday, {
      daysOfWeek: [1],
      repeatCount: 10,
      repeatUntil: '2026-03-15',
    });
    expect(result.length).toBe(1);
    expect(result[0].getDate()).toBe(9);
  });

  it('does not include the original startDate in results', () => {
    const result = generateRecurringDates(monday, { daysOfWeek: [1], repeatCount: 3 });
    // Monday the 2nd should not be in results
    expect(result.every((d) => d.getDate() !== 2)).toBe(true);
  });

  it('caps at 200 occurrences even with large repeatCount', () => {
    const result = generateRecurringDates(monday, { daysOfWeek: [1, 3, 5], repeatCount: 500 });
    // Should get at most 199 additional (200 total - 1 original)
    expect(result.length).toBeLessThanOrEqual(199);
  });

  it('handles all 7 days selected', () => {
    const result = generateRecurringDates(monday, {
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      repeatCount: 8,
    });
    expect(result.length).toBe(7); // 8 total minus original
    // Should be the next 7 consecutive days
    for (let i = 0; i < 7; i++) {
      expect(result[i].getDate()).toBe(3 + i);
    }
  });

  it('handles weekend-only pattern', () => {
    // Start on Monday, Sat+Sun selected, 3 total
    const result = generateRecurringDates(monday, {
      daysOfWeek: [0, 6], // Sun, Sat
      repeatCount: 3,
    });
    expect(result.length).toBe(2);
    expect(result[0].getDay()).toBe(6); // Sat Mar 7
    expect(result[1].getDay()).toBe(0); // Sun Mar 8
  });
});
