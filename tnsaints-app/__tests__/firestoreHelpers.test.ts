import { cleanData } from '../lib/firestoreHelpers';

describe('cleanData', () => {
  it('removes keys with undefined values', () => {
    const input = { a: 1, b: undefined, c: 'hello' };
    expect(cleanData(input)).toEqual({ a: 1, c: 'hello' });
  });

  it('keeps null values (Firestore accepts null)', () => {
    const input = { a: null, b: 'test' };
    expect(cleanData(input)).toEqual({ a: null, b: 'test' });
  });

  it('keeps falsy values like 0, false, empty string', () => {
    const input = { a: 0, b: false, c: '', d: undefined };
    expect(cleanData(input)).toEqual({ a: 0, b: false, c: '' });
  });

  it('returns an empty object when all values are undefined', () => {
    const input = { a: undefined, b: undefined };
    expect(cleanData(input)).toEqual({});
  });

  it('returns identical object when no undefined values exist', () => {
    const input = { name: 'Saints', season: 'Spring' };
    expect(cleanData(input)).toEqual({ name: 'Saints', season: 'Spring' });
  });
});
