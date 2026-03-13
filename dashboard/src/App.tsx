import { useState, useCallback, useEffect, useMemo, Component, type ReactNode, type ErrorInfo } from 'react';
import { SSEProvider, useConnection, useMetrics, useServices, useFeed } from './context/SSEContext';
import { getItem, removeItem } from './lib/storage';
import { setOnUnauthorized } from './hooks/useApi';
import { useHotkeys } from './hooks/useHotkeys';
import { thresholdColor } from './lib/format';
import { LiveAnnouncer } from './components/LiveAnnouncer';
import { LoginScreen } from './components/LoginScreen';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { OverviewTab } from './tabs/OverviewTab';
import { ExecutionTab } from './tabs/ExecutionTab';
import { OpportunitiesTab } from './tabs/OpportunitiesTab';
import { ChainsTab } from './tabs/ChainsTab';
import { RiskTab } from './tabs/RiskTab';
import { StreamsTab } from './tabs/StreamsTab';
import { AdminTab } from './tabs/AdminTab';
import { DiagnosticsTab } from './tabs/DiagnosticsTab';
import type { Tab } from './lib/types';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Dashboard error boundary caught:', error, info.componentStack);
    // M-08 FIX: Report errors externally so operators see production crashes
    // without needing browser console access.
    try {
      navigator.sendBeacon('/api/client-error', JSON.stringify({
        message: error.message,
        stack: error.stack?.slice(0, 1000),
        componentStack: info.componentStack?.slice(0, 500),
        timestamp: Date.now(),
        url: window.location.href,
      }));
    } catch { /* sendBeacon may not be available in all environments */ }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-surface">
          <div className="card w-96 text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-accent-red/10 flex items-center justify-center mx-auto">
              <svg className="w-6 h-6 text-accent-red" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h2 className="font-display font-bold text-lg">Dashboard Error</h2>
            <p className="text-sm text-gray-500">{this.state.error.message}</p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => this.setState({ error: null })}
                className="px-4 py-2 rounded-lg bg-accent-green/15 text-accent-green text-sm font-medium hover:bg-accent-green/25 transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-gray-300 transition-colors bg-[var(--badge-bg)]"
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// M-06 FIX: Per-tab error isolation so one tab crash doesn't take down the dashboard.
class TabErrorBoundary extends Component<{ tab: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.tab}] tab error:`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card text-center space-y-3 max-w-md mx-auto mt-12">
          <h3 className="font-display font-bold text-sm text-accent-red">{this.props.tab} Error</h3>
          <p className="text-xs text-gray-500">{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="px-3 py-1.5 rounded-lg bg-accent-green/15 text-accent-green text-xs font-medium hover:bg-accent-green/25 transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const TABS: { id: Tab; icon: string }[] = [
  { id: 'Overview', icon: 'M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z' },
  { id: 'Execution', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { id: 'Opportunities', icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' },
  { id: 'Chains', icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1' },
  { id: 'Risk', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
  { id: 'Streams', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4' },
  { id: 'Diagnostics', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
  { id: 'Admin', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z' },
];

// E-03: Hash-based routing — read tab from URL hash, sync on change
const VALID_TABS = new Set<string>(TABS.map((t) => t.id.toLowerCase()));

function tabFromHash(): Tab {
  const hash = window.location.hash.slice(1).toLowerCase();
  if (VALID_TABS.has(hash)) {
    // Capitalize first letter to match Tab type
    return TABS.find((t) => t.id.toLowerCase() === hash)!.id;
  }
  return 'Overview';
}

const STALE_THRESHOLD_MS = 15_000;

function ConnectionIndicator({ onReconnect }: { onReconnect?: () => void }) {
  const { status, lastEventTime } = useConnection();
  const [isStale, setIsStale] = useState(false);

  useEffect(() => {
    const check = () => {
      if (lastEventTime && status === 'connected') {
        setIsStale(Date.now() - lastEventTime > STALE_THRESHOLD_MS);
      } else {
        setIsStale(false);
      }
    };
    check();
    const id = setInterval(check, 3000);
    return () => clearInterval(id);
  }, [lastEventTime, status]);

  const color = status !== 'connected'
    ? (status === 'connecting' ? 'bg-accent-yellow' : 'bg-accent-red')
    : isStale ? 'bg-accent-yellow' : 'bg-accent-green';
  const label = status !== 'connected' ? status : isStale ? 'stale' : 'live';

  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1 rounded-full text-xs bg-[var(--badge-bg)]"
      title={lastEventTime ? `Last event: ${new Date(lastEventTime).toLocaleTimeString()}` : 'No events received'}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${color} ${status === 'connected' && !isStale ? 'animate-pulse' : ''}`} />
      <span className="text-gray-500">{label}</span>
      {/* M-03 FIX: Reconnect button for permanent SSE disconnection (CLOSED state). */}
      {status === 'disconnected' && onReconnect && (
        <button
          onClick={onReconnect}
          className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent-red/15 text-accent-red hover:bg-accent-red/25 transition-colors"
        >
          Reconnect
        </button>
      )}
    </div>
  );
}

function Dashboard({ onLogout, onReconnect }: { onLogout: () => void; onReconnect: () => void }) {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const { metrics } = useMetrics();
  const { circuitBreaker } = useServices();
  const { feed } = useFeed();

  // P1-14: Compute tab notification badges for active issues
  const tabBadges = useMemo(() => {
    const badges: Partial<Record<Tab, boolean>> = {};
    if (circuitBreaker?.state === 'OPEN') badges.Execution = true;
    let failStreak = 0;
    for (const item of feed) {
      if (item.kind === 'execution' && !item.data.success) failStreak++;
      else break;
    }
    if (failStreak >= 3) badges.Execution = true;
    const hasCritical = feed.some(f => f.kind === 'alert' && f.data.severity === 'critical');
    if (hasCritical) badges.Risk = true;
    return badges;
  }, [circuitBreaker, feed]);

  // E-03: Sync tab state with URL hash
  const changeTab = useCallback((t: Tab) => {
    setTab(t);
    window.location.hash = t.toLowerCase();
  }, []);

  useEffect(() => {
    const onHashChange = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // E-07: Keyboard shortcuts — 1-7 switch tabs, ? toggles help
  const keyMap = useMemo(() => {
    const map: Record<string, () => void> = {
      '?': () => setShowShortcuts((v) => !v),
    };
    TABS.forEach((t, i) => { map[String(i + 1)] = () => changeTab(t.id); });
    return map;
  }, [changeTab]);
  useHotkeys(keyMap);

  return (
    <div className="min-h-screen flex flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-3 focus:py-1.5 focus:rounded-lg focus:bg-accent-green focus:text-gray-950 focus:text-xs focus:font-medium">
        Skip to content
      </a>
      <LiveAnnouncer />
      <header className="sticky top-0 z-30 px-3 sm:px-5 py-2.5 flex items-center justify-between border-b border-gray-800 bg-[var(--header-bg)] gap-2">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-accent-green/10 flex items-center justify-center">
              <svg className="w-4 h-4 text-accent-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </div>
            <span className="font-display font-bold text-sm tracking-tight">Arbitrage</span>
          </div>
          <ConnectionIndicator onReconnect={onReconnect} />
          {metrics && (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-gray-500">Health</span>
              <span className={`font-mono font-semibold ${thresholdColor(metrics.systemHealth, 80, 50)}`}>
                {metrics.systemHealth.toFixed(0)}%
              </span>
            </div>
          )}
        </div>
        <nav className="flex items-center gap-0.5 p-1 rounded-xl bg-[var(--badge-bg)]" role="tablist" aria-label="Dashboard sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`tabpanel-${t.id}`}
              onClick={() => changeTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                tab === t.id ? 'bg-accent-green/15 text-accent-green' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d={t.icon} />
              </svg>
              <span className="hidden lg:inline">{t.id}</span>
              {tabBadges[t.id] && <span className="w-1.5 h-1.5 rounded-full bg-accent-red shrink-0" />}
            </button>
          ))}
        </nav>
        <button
          onClick={onLogout}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-500 hover:text-gray-300 transition-colors"
          title="Logout"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          <span className="hidden sm:inline">Logout</span>
        </button>
      </header>
      <main id="main" className="flex-1 p-3 sm:p-5 overflow-auto" role="tabpanel" aria-label={tab}>
        {tab === 'Overview' && <TabErrorBoundary tab="Overview"><OverviewTab /></TabErrorBoundary>}
        {tab === 'Execution' && <TabErrorBoundary tab="Execution"><ExecutionTab /></TabErrorBoundary>}
        {tab === 'Opportunities' && <TabErrorBoundary tab="Opportunities"><OpportunitiesTab /></TabErrorBoundary>}
        {tab === 'Chains' && <TabErrorBoundary tab="Chains"><ChainsTab /></TabErrorBoundary>}
        {tab === 'Risk' && <TabErrorBoundary tab="Risk"><RiskTab /></TabErrorBoundary>}
        {tab === 'Streams' && <TabErrorBoundary tab="Streams"><StreamsTab /></TabErrorBoundary>}
        {tab === 'Diagnostics' && <TabErrorBoundary tab="Diagnostics"><DiagnosticsTab /></TabErrorBoundary>}
        {tab === 'Admin' && <TabErrorBoundary tab="Admin"><AdminTab /></TabErrorBoundary>}
      </main>
      <ShortcutsOverlay open={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(() => !!getItem('dashboard_token'));
  const [sseKey, setSSEKey] = useState(0);

  const handleLogin = useCallback(() => {
    setAuthed(true);
    setSSEKey((k) => k + 1);
  }, []);

  const handleLogout = useCallback(() => {
    removeItem('dashboard_token');
    removeItem('cb_api_key');
    setAuthed(false);
  }, []);

  // H-02 FIX: Register auto-logout handler for 401 responses from API calls.
  useEffect(() => {
    setOnUnauthorized(handleLogout);
    return () => setOnUnauthorized(null);
  }, [handleLogout]);

  // M-03 FIX: Reconnect forces SSEProvider remount via key increment.
  const handleReconnect = useCallback(() => {
    setSSEKey((k) => k + 1);
  }, []);

  // L-07 FIX: Cross-tab auth sync. When another tab removes the token from
  // localStorage, this tab detects it via the storage event and logs out.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'dashboard_token' && !e.newValue) {
        setAuthed(false);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // H-03 FIX: ErrorBoundary wraps both LoginScreen and SSEProvider so render
  // errors in either path are caught instead of producing a white screen.
  if (!authed) {
    return (
      <ErrorBoundary>
        <LoginScreen onLogin={handleLogin} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <SSEProvider key={sseKey}>
        <Dashboard onLogout={handleLogout} onReconnect={handleReconnect} />
      </SSEProvider>
    </ErrorBoundary>
  );
}
