/**
 * Shared Firestore write helpers.
 *
 * Firestore rejects `undefined` values in documents. Use `cleanData()`
 * on every object before passing it to addDoc / setDoc / updateDoc so
 * optional fields never cause silent write failures.
 */

/**
 * Recursively strip keys whose value is `undefined`.
 * Returns a shallow-cleaned copy — nested objects are NOT deep-cloned,
 * but nested `undefined` values one level deep are also removed.
 */
export function cleanData<T extends Record<string, unknown>>(obj: T): T {
  const result = {} as T;
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}
