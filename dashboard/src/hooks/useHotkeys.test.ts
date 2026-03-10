import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useHotkeys } from './useHotkeys';

function fireKey(key: string, target?: Partial<HTMLElement>) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true });
  if (target) {
    Object.defineProperty(event, 'target', { value: target });
  }
  window.dispatchEvent(event);
}

describe('useHotkeys', () => {
  it('calls handler for matching key', () => {
    const handler = vi.fn();
    renderHook(() => useHotkeys({ '1': handler }));

    fireKey('1');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not call handler for non-matching key', () => {
    const handler = vi.fn();
    renderHook(() => useHotkeys({ '1': handler }));

    fireKey('2');
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores keys when target is an INPUT', () => {
    const handler = vi.fn();
    renderHook(() => useHotkeys({ '1': handler }));

    fireKey('1', { tagName: 'INPUT' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores keys when target is a TEXTAREA', () => {
    const handler = vi.fn();
    renderHook(() => useHotkeys({ '1': handler }));

    fireKey('1', { tagName: 'TEXTAREA' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores keys when target is contentEditable', () => {
    const handler = vi.fn();
    renderHook(() => useHotkeys({ '1': handler }));

    fireKey('1', { tagName: 'DIV', isContentEditable: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('supports ? key for help toggle', () => {
    const handler = vi.fn();
    renderHook(() => useHotkeys({ '?': handler }));

    fireKey('?');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('cleans up listener on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useHotkeys({ '1': handler }));

    unmount();
    fireKey('1');
    expect(handler).not.toHaveBeenCalled();
  });
});
