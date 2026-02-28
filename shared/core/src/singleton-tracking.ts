/**
 * Singleton Access Tracking
 *
 * Lightweight dirty-flag mechanism used by test infrastructure to skip
 * unnecessary singleton resets. When no singleton getter has been called
 * during a test, resetAllSingletons() can return immediately.
 *
 * Production overhead: one boolean assignment per getter call (~1 ns).
 *
 * @see shared/test-utils/src/setup/singleton-reset.ts
 */

let _dirty = false;

/** Mark that at least one singleton was accessed (called by getter functions). */
export function notifySingletonAccess(): void {
  _dirty = true;
}

/** Check whether any singleton was accessed since last clear. */
export function isSingletonDirty(): boolean {
  return _dirty;
}

/** Clear the dirty flag (called after resetAllSingletons completes). */
export function clearSingletonDirty(): void {
  _dirty = false;
}
