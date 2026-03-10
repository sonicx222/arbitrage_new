import { useState } from 'react';
import { setItem } from '../lib/storage';

interface Props {
  onLogin: () => void;
}

export function LoginScreen({ onLogin }: Props) {
  const [token, setToken] = useState('');
  const [cbKey, setCbKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/events', {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403 ? 'Invalid token' : `Server error (${res.status})`);
        setLoading(false);
        return;
      }
    } catch {
      setError('Cannot reach server');
      setLoading(false);
      return;
    }
    setItem('dashboard_token', token);
    if (cbKey) setItem('cb_api_key', cbKey);
    setLoading(false);
    onLogin();
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-surface">
      <div className="absolute inset-0 pointer-events-none" style={{
        background: 'radial-gradient(ellipse at 50% 0%, rgba(34, 197, 94, 0.04) 0%, transparent 50%),' +
          'radial-gradient(ellipse at 80% 80%, rgba(96, 165, 250, 0.04) 0%, transparent 50%)',
      }} />
      <form onSubmit={handleSubmit} className="card w-[380px] relative z-10" style={{ animation: 'slideUp 0.3s ease-out' }}>
        <div className="flex items-center justify-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-accent-green/10 flex items-center justify-center">
            <svg className="w-7 h-7 text-accent-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
        </div>
        <h2 className="font-display font-bold text-xl text-center mb-1">Arbitrage System</h2>
        <p className="text-center text-xs text-gray-500 mb-6">Multi-chain trading dashboard</p>
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1.5">Dashboard Token</label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-full bg-surface border border-gray-700 rounded-lg px-3 py-2.5 text-sm font-mono focus:border-accent-green focus:ring-1 focus:ring-accent-green/20 outline-none transition-all"
              required
              autoFocus
              placeholder="Enter authentication token"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1.5">
              Circuit Breaker API Key <span className="text-gray-600">(optional)</span>
            </label>
            <input
              type="password"
              value={cbKey}
              onChange={(e) => setCbKey(e.target.value)}
              className="w-full bg-surface border border-gray-700 rounded-lg px-3 py-2.5 text-sm font-mono focus:border-accent-green focus:ring-1 focus:ring-accent-green/20 outline-none transition-all"
              placeholder="Optional API key"
            />
          </div>
          {error && (
            <div className="text-xs text-accent-red text-center px-3 py-2 rounded-lg bg-accent-red/10">{error}</div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-accent-green/15 text-accent-green font-display font-semibold text-sm hover:bg-accent-green/25 transition-all disabled:opacity-50 active:scale-[0.98]"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Validating...
              </span>
            ) : 'Connect'}
          </button>
        </div>
        <p className="text-[10px] text-gray-600 text-center mt-4">Token is stored in localStorage for SSE auth</p>
      </form>
    </div>
  );
}
