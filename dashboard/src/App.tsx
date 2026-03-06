import { useState } from 'react';

const TABS = ['Overview', 'Execution', 'Chains', 'Risk', 'Streams', 'Admin'] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>('Overview');

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-surface-light border-b border-gray-800 px-4 py-2 flex items-center justify-between">
        <span className="text-accent-green font-bold">ARBITRAGE SYSTEM</span>
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
      <main className="flex-1 p-4">
        <div className="text-gray-400">
          {tab} tab — content coming soon
        </div>
      </main>
    </div>
  );
}
