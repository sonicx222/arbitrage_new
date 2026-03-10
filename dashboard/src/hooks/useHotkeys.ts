import { useEffect } from 'react';

/**
 * E-07: Keyboard shortcut hook. Calls handler on keydown unless the user
 * is typing in an input, textarea, or contentEditable element.
 */
export function useHotkeys(keyMap: Record<string, () => void>) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;

      const fn = keyMap[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [keyMap]);
}
