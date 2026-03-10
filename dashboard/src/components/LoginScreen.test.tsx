import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoginScreen } from './LoginScreen';

// ---------------------------------------------------------------------------
// Mock storage
// ---------------------------------------------------------------------------
const stored: Record<string, string> = {};
vi.mock('../lib/storage', () => ({
  setItem: vi.fn((k: string, v: string) => { stored[k] = v; }),
  getItem: vi.fn((k: string) => stored[k] ?? null),
  removeItem: vi.fn((k: string) => { delete stored[k]; }),
}));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
beforeEach(() => {
  globalThis.fetch = mockFetch;
  mockFetch.mockReset();
  for (const k of Object.keys(stored)) delete stored[k];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LoginScreen', () => {
  const onLogin = vi.fn();

  beforeEach(() => {
    onLogin.mockClear();
  });

  it('renders form with token input and submit button', () => {
    render(<LoginScreen onLogin={onLogin} />);
    expect(screen.getByPlaceholderText('Enter authentication token')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('renders optional circuit breaker key input', () => {
    render(<LoginScreen onLogin={onLogin} />);
    expect(screen.getByPlaceholderText('Optional API key')).toBeInTheDocument();
  });

  it('does not submit when token is empty (HTML required)', () => {
    render(<LoginScreen onLogin={onLogin} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('validates token via HEAD request and calls onLogin on success', async () => {
    mockFetch.mockResolvedValueOnce({ status: 200 });
    render(<LoginScreen onLogin={onLogin} />);

    fireEvent.change(screen.getByPlaceholderText('Enter authentication token'), {
      target: { value: 'my-secret-token' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(onLogin).toHaveBeenCalled());

    expect(mockFetch).toHaveBeenCalledWith('/api/events', {
      method: 'HEAD',
      headers: { Authorization: 'Bearer my-secret-token' },
    });
    expect(stored['dashboard_token']).toBe('my-secret-token');
  });

  it('stores cb_api_key when provided', async () => {
    mockFetch.mockResolvedValueOnce({ status: 200 });
    render(<LoginScreen onLogin={onLogin} />);

    fireEvent.change(screen.getByPlaceholderText('Enter authentication token'), {
      target: { value: 'tok' },
    });
    fireEvent.change(screen.getByPlaceholderText('Optional API key'), {
      target: { value: 'cb-key-123' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(onLogin).toHaveBeenCalled());
    expect(stored['cb_api_key']).toBe('cb-key-123');
  });

  it('does not store cb_api_key when empty', async () => {
    mockFetch.mockResolvedValueOnce({ status: 200 });
    render(<LoginScreen onLogin={onLogin} />);

    fireEvent.change(screen.getByPlaceholderText('Enter authentication token'), {
      target: { value: 'tok' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(onLogin).toHaveBeenCalled());
    expect(stored['cb_api_key']).toBeUndefined();
  });

  it('shows "Invalid token" on 401 response', async () => {
    mockFetch.mockResolvedValueOnce({ status: 401 });
    render(<LoginScreen onLogin={onLogin} />);

    fireEvent.change(screen.getByPlaceholderText('Enter authentication token'), {
      target: { value: 'bad-token' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByText('Invalid token')).toBeInTheDocument());
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('shows "Invalid token" on 403 response', async () => {
    mockFetch.mockResolvedValueOnce({ status: 403 });
    render(<LoginScreen onLogin={onLogin} />);

    fireEvent.change(screen.getByPlaceholderText('Enter authentication token'), {
      target: { value: 'forbidden-token' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByText('Invalid token')).toBeInTheDocument());
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('shows "Cannot reach server" on network error', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<LoginScreen onLogin={onLogin} />);

    fireEvent.change(screen.getByPlaceholderText('Enter authentication token'), {
      target: { value: 'any-token' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByText('Cannot reach server')).toBeInTheDocument());
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('shows loading state during validation', async () => {
    let resolvePromise: (v: { status: number }) => void;
    mockFetch.mockReturnValueOnce(new Promise<{ status: number }>((r) => { resolvePromise = r; }));
    render(<LoginScreen onLogin={onLogin} />);

    fireEvent.change(screen.getByPlaceholderText('Enter authentication token'), {
      target: { value: 'tok' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByText('Validating...')).toBeInTheDocument());
    expect(screen.getByRole('button')).toBeDisabled();

    await act(async () => { resolvePromise!({ status: 200 }); });
    await waitFor(() => expect(onLogin).toHaveBeenCalled());
  });
});

// Need act for the loading state test
async function act(fn: () => Promise<void>) {
  const { act: rtlAct } = await import('@testing-library/react');
  await rtlAct(fn);
}
