// Safe localStorage wrapper — prevents crashes in restrictive browser modes
// (private browsing, storage quota exceeded, SecurityError in sandboxed iframes).

export function getItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage full or blocked — silently ignore
  }
}

export function removeItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Blocked — silently ignore
  }
}
