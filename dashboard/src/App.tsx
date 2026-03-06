import { useState } from 'react';
import { SSEProvider, useSSEData } from './context/SSEContext';
import { OverviewTab } from './tabs/OverviewTab';
import { ExecutionTab } from './tabs/ExecutionTab';
import type { Tab } from './lib/types';

const TABS: Tab[] = ['Overview', 'Execution', 'Chains', 'Risk', 'Streams', 'Admin'];

function ConnectionDot() {
  const { status } = useSSEData();
  const color = status === 'connected' ? 'bg-accent-green' : status === 'connecting' ? 'bg-accent-yellow' : 'bg-accent-red';
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} title={status} />;
}

function Dashboard() {
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
      </header>
      <main className="flex-1 p-4 overflow-auto">
        {tab === 'Overview' && <OverviewTab />}
        {tab === 'Execution' && <ExecutionTab />}
        {tab !== 'Overview' && tab !== 'Execution' && (
          <div className="text-gray-500 text-xs">{tab} — coming soon</div>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <SSEProvider>
      <Dashboard />
    </SSEProvider>
  );
}
