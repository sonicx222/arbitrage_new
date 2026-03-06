import { useState } from 'react';

interface Props {
  onLogin: () => void;
}

export function LoginScreen({ onLogin }: Props) {
  const [token, setToken] = useState('');
  const [cbKey, setCbKey] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (token) localStorage.setItem('dashboard_token', token);
    if (cbKey) localStorage.setItem('cb_api_key', cbKey);
    onLogin();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <form onSubmit={handleSubmit} className="card w-80 space-y-4">
        <h2 className="text-accent-green font-bold">Arbitrage Dashboard</h2>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Dashboard Token</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full bg-surface border border-gray-700 rounded px-2 py-1.5 text-sm focus:border-accent-green outline-none"
            required
            autoFocus
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Circuit Breaker API Key (optional)</label>
          <input
            type="password"
            value={cbKey}
            onChange={(e) => setCbKey(e.target.value)}
            className="w-full bg-surface border border-gray-700 rounded px-2 py-1.5 text-sm focus:border-accent-green outline-none"
          />
        </div>
        <button
          type="submit"
          className="w-full py-2 rounded bg-accent-green/20 text-accent-green font-medium text-sm hover:bg-accent-green/30 transition-colors"
        >
          Connect
        </button>
        <p className="text-[10px] text-gray-600 text-center">
          Token is stored in localStorage for SSE auth
        </p>
      </form>
    </div>
  );
}
