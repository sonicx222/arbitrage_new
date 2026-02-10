/**
 * Jest Setup - Runs BEFORE module resolution
 *
 * This file runs before test files are loaded, allowing us to
 * set up polyfills and global configurations.
 */

// Polyfill for BigInt serialization in Jest workers
// This allows Jest to serialize BigInt values during inter-worker communication
// MUST be set before any modules with BigInt constants are imported
if (typeof BigInt.prototype.toJSON === 'undefined') {
  BigInt.prototype.toJSON = function () {
    return this.toString();
  };
}
