/**
 * Type Guard Utilities for Stream Message Handling
 *
 * Provides type-safe extraction of fields from untyped stream message data.
 * Reduces code duplication and improves readability in stream handlers.
 *
 * @see coordinator.ts (stream handlers)
 */

/**
 * Safely extract a string value from an object.
 * Returns the default value if the field is missing or not a string.
 */
export function getString(data: Record<string, unknown>, key: string, defaultValue: string = ''): string {
  const value = data[key];
  return typeof value === 'string' ? value : defaultValue;
}

/**
 * Safely extract a number value from an object.
 * Returns the default value if the field is missing or not a number.
 */
export function getNumber(data: Record<string, unknown>, key: string, defaultValue: number = 0): number {
  const value = data[key];
  return typeof value === 'number' && !isNaN(value) ? value : defaultValue;
}

/**
 * Safely extract a non-negative number value from an object.
 * Guards against malformed negative values.
 */
export function getNonNegativeNumber(data: Record<string, unknown>, key: string, defaultValue: number = 0): number {
  const value = getNumber(data, key, defaultValue);
  return value >= 0 ? value : defaultValue;
}

/**
 * Safely extract a boolean value from an object.
 * Returns the default value if the field is missing or not a boolean.
 */
export function getBoolean(data: Record<string, unknown>, key: string, defaultValue: boolean = false): boolean {
  const value = data[key];
  return typeof value === 'boolean' ? value : defaultValue;
}

/**
 * Safely extract an optional string value from an object.
 * Returns undefined if the field is missing or not a string.
 */
export function getOptionalString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Safely extract an optional number value from an object.
 * Returns undefined if the field is missing or not a number.
 */
export function getOptionalNumber(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' && !isNaN(value) ? value : undefined;
}

/**
 * Unwrap a potentially wrapped message event.
 * Stream messages can be either direct data or wrapped in { type, data } envelope.
 */
export function unwrapMessageData(data: Record<string, unknown>): Record<string, unknown> {
  // Check if this is a wrapped MessageEvent (has 'type' and 'data' fields)
  if (typeof data.type === 'string' && data.data && typeof data.data === 'object') {
    return data.data as Record<string, unknown>;
  }
  return data;
}

/**
 * Validate that a required field exists and is a non-empty string.
 * Useful for ID fields that must be present.
 */
export function hasRequiredString(data: Record<string, unknown>, key: string): boolean {
  const value = data[key];
  return typeof value === 'string' && value.length > 0;
}
