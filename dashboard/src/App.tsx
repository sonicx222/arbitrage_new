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
            <h2 className="text-accent-red font-bold">Dashboard Error</h2>
            <p className="text-xs text-gray-400">{this.state.error.message}</p>
            <button
              onClick={() => this.setState({ error: null })}
              className="px-4 py-2 rounded bg-accent-green/20 text-accent-green text-sm hover:bg-accent-green/30"
            >
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded bg-gray-700 text-gray-300 text-sm hover:bg-gray-600 ml-2"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const TABS: Tab[] = ['Overview', 'Execution', 'Chains', 'Risk', 'Streams', 'Admin'];

const STALE_THRESHOLD_MS = 10_000;

function ConnectionDot() {
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
  const label = status !== 'connected' ? status : isStale ? 'stale data' : 'connected';

  return (
    <>
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} title={label} />
      {isStale && <span className="text-[10px] text-accent-yellow">Data stale</span>}
    </>
  );
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('Overview');
  const { metrics } = useSSEData();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-surface-light border-b border-gray-800 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-accent-green font-bold text-sm">ARBITRAGE SYSTEM</span>
          <ConnectionDot />
          {metrics && (
            <span className="text-xs text-gray-500">
              Health: {metrics.systemHealth.toFixed(0)}%
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  tab === t ? 'bg-accent-green/20 text-accent-green' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {t}
              </button>
            ))}
          </nav>
          <button
            onClick={onLogout}
            className="px-2 py-1 text-[10px] text-gray-500 hover:text-gray-300 ml-2"
            title="Logout"
          >
            Logout
          </button>
        </div>
      </header>
      <main className="flex-1 p-4 overflow-auto">
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
    setSSEKey((k) => k + 1); // Force SSE reconnect with new token
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
