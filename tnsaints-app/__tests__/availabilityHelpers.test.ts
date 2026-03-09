import { summariseRsvps, RsvpStatus, AvailabilityLike } from '../lib/availabilityHelpers';

function makeRsvp(status: RsvpStatus, uid: string = 'u1'): AvailabilityLike {
  return {
    id: `evt_${uid}`,
    eventId: 'evt',
    uid,
    playerName: `Player ${uid}`,
    status,
  };
}

describe('summariseRsvps', () => {
  it('counts all statuses correctly', () => {
    const entries: AvailabilityLike[] = [
      makeRsvp('in', 'u1'),
      makeRsvp('in', 'u2'),
      makeRsvp('out', 'u3'),
      makeRsvp('maybe', 'u4'),
      makeRsvp('in', 'u5'),
    ];
    const result = summariseRsvps(entries);
    expect(result.inCount).toBe(3);
    expect(result.outCount).toBe(1);
    expect(result.maybeCount).toBe(1);
    expect(result.total).toBe(5);
  });

  it('returns zeros for empty array', () => {
    const result = summariseRsvps([]);
    expect(result.inCount).toBe(0);
    expect(result.outCount).toBe(0);
    expect(result.maybeCount).toBe(0);
    expect(result.total).toBe(0);
  });

  it('handles all in', () => {
    const entries = [makeRsvp('in', 'u1'), makeRsvp('in', 'u2')];
    const result = summariseRsvps(entries);
    expect(result.inCount).toBe(2);
    expect(result.outCount).toBe(0);
    expect(result.maybeCount).toBe(0);
    expect(result.total).toBe(2);
  });

  it('handles all out', () => {
    const entries = [makeRsvp('out', 'u1'), makeRsvp('out', 'u2'), makeRsvp('out', 'u3')];
    const result = summariseRsvps(entries);
    expect(result.outCount).toBe(3);
    expect(result.inCount).toBe(0);
    expect(result.total).toBe(3);
  });

  it('handles all maybe', () => {
    const entries = [makeRsvp('maybe', 'u1')];
    const result = summariseRsvps(entries);
    expect(result.maybeCount).toBe(1);
    expect(result.inCount).toBe(0);
    expect(result.outCount).toBe(0);
    expect(result.total).toBe(1);
  });

  it('handles single entry', () => {
    const result = summariseRsvps([makeRsvp('in', 'u1')]);
    expect(result.inCount).toBe(1);
    expect(result.total).toBe(1);
  });
});
