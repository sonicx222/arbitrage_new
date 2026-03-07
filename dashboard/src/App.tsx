import { useState, useCallback, useEffect, Component, type ReactNode, type ErrorInfo } from 'react';
import { SSEProvider, useSSEData } from './context/SSEContext';
import { getItem, removeItem } from './lib/storage';
import { LoginScreen } from './components/LoginScreen';
import { OverviewTab } from './tabs/OverviewTab';
import { ExecutionTab } from './tabs/ExecutionTab';
import { ChainsTab } from './tabs/ChainsTab';
import { RiskTab } from './tabs/RiskTab';
import { StreamsTab } from './tabs/StreamsTab';
import { AdminTab } from './tabs/AdminTab';
import type { Tab } from './lib/types';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Dashboard error boundary caught:', error, info.componentStack);
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
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-gray-300 transition-colors"
                style={{ background: 'var(--badge-bg)' }}
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

const TABS: { id: Tab; icon: string }[] = [
  { id: 'Overview', icon: 'M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z' },
  { id: 'Execution', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { id: 'Chains', icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1' },
  { id: 'Risk', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
  { id: 'Streams', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4' },
  { id: 'Admin', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z' },
];

const STALE_THRESHOLD_MS = 10_000;

function ConnectionIndicator() {
  const { status, lastEventTime } = useSSEData();
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
    <div className="flex items-center gap-2 px-2.5 py-1 rounded-full text-xs" style={{ background: 'var(--badge-bg)' }}>
      <span className={`w-1.5 h-1.5 rounded-full ${color} ${status === 'connected' && !isStale ? 'animate-pulse' : ''}`} />
      <span className="text-gray-500">{label}</span>
    </div>
  );
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('Overview');
  const { metrics } = useSSEData();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 px-5 py-2.5 flex items-center justify-between border-b border-gray-800" style={{ background: 'var(--header-bg)' }}>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-accent-green/10 flex items-center justify-center">
              <svg className="w-4 h-4 text-accent-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </div>
            <span className="font-display font-bold text-sm tracking-tight">Arbitrage</span>
          </div>
          <ConnectionIndicator />
          {metrics && (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-gray-500">Health</span>
              <span className={`font-mono font-semibold ${metrics.systemHealth >= 80 ? 'text-accent-green' : metrics.systemHealth >= 50 ? 'text-accent-yellow' : 'text-accent-red'}`}>
                {metrics.systemHealth.toFixed(0)}%
              </span>
            </div>
          )}
        </div>
        <nav className="flex items-center gap-0.5 p-1 rounded-xl" style={{ background: 'var(--badge-bg)' }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                tab === t.id ? 'bg-accent-green/15 text-accent-green' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d={t.icon} />
              </svg>
              <span className="hidden lg:inline">{t.id}</span>
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
      <main className="flex-1 p-5 overflow-auto">
        {tab === 'Overview' && <OverviewTab />}
        {tab === 'Execution' && <ExecutionTab />}
        {tab === 'Chains' && <ChainsTab />}
        {tab === 'Risk' && <RiskTab />}
        {tab === 'Streams' && <StreamsTab />}
        {tab === 'Admin' && <AdminTab />}
      </main>
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

  if (!authed) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <SSEProvider key={sseKey}>
      <ErrorBoundary>
        <Dashboard onLogout={handleLogout} />
      </ErrorBoundary>
    </SSEProvider>
  );
}
