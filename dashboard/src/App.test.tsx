import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from './App';

// ---------------------------------------------------------------------------
// Mock storage
// ---------------------------------------------------------------------------
const stored: Record<string, string> = {};
vi.mock('./lib/storage', () => ({
  getItem: vi.fn((k: string) => stored[k] ?? null),
  setItem: vi.fn((k: string, v: string) => { stored[k] = v; }),
  removeItem: vi.fn((k: string) => { delete stored[k]; }),
}));

// ---------------------------------------------------------------------------
// Mock SSEProvider — renders children without actual SSE connection
// ---------------------------------------------------------------------------
vi.mock('./context/SSEContext', () => ({
  SSEProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="sse-provider">{children}</div>,
  useSSEData: () => ({
    metrics: null,
    services: {},
    circuitBreaker: null,
    streams: null,
    feed: [],
    chartData: [],
    lagData: [],
    status: 'connecting' as const,
    lastEventTime: null,
    nextFeedId: 0,
  }),
}));

// ---------------------------------------------------------------------------
// Mock child tabs to keep tests focused on auth gating
// ---------------------------------------------------------------------------
vi.mock('./tabs/OverviewTab', () => ({ OverviewTab: () => <div data-testid="overview-tab">Overview</div> }));
vi.mock('./tabs/ExecutionTab', () => ({ ExecutionTab: () => <div data-testid="execution-tab">Execution</div> }));
vi.mock('./tabs/ChainsTab', () => ({ ChainsTab: () => <div data-testid="chains-tab">Chains</div> }));
vi.mock('./tabs/RiskTab', () => ({ RiskTab: () => <div data-testid="risk-tab">Risk</div> }));
vi.mock('./tabs/StreamsTab', () => ({ StreamsTab: () => <div data-testid="streams-tab">Streams</div> }));
vi.mock('./tabs/AdminTab', () => ({ AdminTab: () => <div data-testid="admin-tab">Admin</div> }));

// ---------------------------------------------------------------------------
// Mock fetch (LoginScreen uses it for HEAD validation)
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

describe('App', () => {
  it('renders LoginScreen when no token in storage', () => {
    render(<App />);
    expect(screen.getByPlaceholderText('Enter authentication token')).toBeInTheDocument();
  });

  it('renders Dashboard when token exists in storage', () => {
    stored['dashboard_token'] = 'valid-token';
    render(<App />);
    expect(screen.getByText('Arbitrage')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Enter authentication token')).not.toBeInTheDocument();
  });

  it('transitions from LoginScreen to Dashboard on login', async () => {
    mockFetch.mockResolvedValueOnce({ status: 200, ok: true });
    render(<App />);

    // Initially showing login
    expect(screen.getByPlaceholderText('Enter authentication token')).toBeInTheDocument();

    // Fill in token and submit
    fireEvent.change(screen.getByPlaceholderText('Enter authentication token'), {
      target: { value: 'my-token' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Connect' }));

    // Should transition to dashboard
    await waitFor(() => expect(screen.getByText('Arbitrage')).toBeInTheDocument());
    expect(screen.queryByPlaceholderText('Enter authentication token')).not.toBeInTheDocument();
  });

  it('transitions from Dashboard to LoginScreen on logout', () => {
    stored['dashboard_token'] = 'valid-token';
    stored['cb_api_key'] = 'some-key';

    const { getByTitle } = render(<App />);

    // Dashboard is showing
    expect(screen.getByText('Arbitrage')).toBeInTheDocument();

    // Click logout
    fireEvent.click(getByTitle('Logout'));

    // Should show login screen and clear storage
    expect(screen.getByPlaceholderText('Enter authentication token')).toBeInTheDocument();
    expect(stored['dashboard_token']).toBeUndefined();
    expect(stored['cb_api_key']).toBeUndefined();
  });

  it('shows Overview tab by default in Dashboard', () => {
    stored['dashboard_token'] = 'valid-token';
    render(<App />);
    expect(screen.getByTestId('overview-tab')).toBeInTheDocument();
  });

  it('wraps Dashboard in SSEProvider', () => {
    stored['dashboard_token'] = 'valid-token';
    render(<App />);
    expect(screen.getByTestId('sse-provider')).toBeInTheDocument();
  });
});
