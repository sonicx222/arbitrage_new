import { useState, useCallback } from 'react';
import { SSEProvider, useSSEData } from './context/SSEContext';
import { LoginScreen } from './components/LoginScreen';
import { OverviewTab } from './tabs/OverviewTab';
import { ExecutionTab } from './tabs/ExecutionTab';
import { ChainsTab } from './tabs/ChainsTab';
import { RiskTab } from './tabs/RiskTab';
import { StreamsTab } from './tabs/StreamsTab';
import { AdminTab } from './tabs/AdminTab';
import type { Tab } from './lib/types';

const TABS: Tab[] = ['Overview', 'Execution', 'Chains', 'Risk', 'Streams', 'Admin'];

function ConnectionDot() {
  const { status } = useSSEData();
  const color = status === 'connected' ? 'bg-accent-green' : status === 'connecting' ? 'bg-accent-yellow' : 'bg-accent-red';
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} title={status} />;
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
  const [authed, setAuthed] = useState(() => !!localStorage.getItem('dashboard_token'));
  const [sseKey, setSSEKey] = useState(0);

  const handleLogin = useCallback(() => {
    setAuthed(true);
    setSSEKey((k) => k + 1); // Force SSE reconnect with new token
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('dashboard_token');
    localStorage.removeItem('cb_api_key');
    setAuthed(false);
  }, []);

  if (!authed) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <SSEProvider key={sseKey}>
      <Dashboard onLogout={handleLogout} />
    </SSEProvider>
  );
}
