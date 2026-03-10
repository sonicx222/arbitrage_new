export const CHART = {
  grid: '#27272a',
  tick: '#71717a',
  tooltipBg: '#27272a',
  tooltipBorder: '#3f3f46',
  tooltipText: '#fafafa',
  line1: '#d4a574',
  line2: '#22c55e',
  area1: '#d4a574',
};

// L-11 FIX: Pre-allocated tooltip style object — avoids recreating inline objects
// on every render, which causes Recharts to diff new references unnecessarily.
export const TOOLTIP_STYLE: React.CSSProperties = {
  background: CHART.tooltipBg,
  border: `1px solid ${CHART.tooltipBorder}`,
  fontSize: 11,
  color: CHART.tooltipText,
};

// Pre-allocated Recharts axis/grid props — avoids recreating inline objects
// on every render (same rationale as TOOLTIP_STYLE above).
export const AXIS_TICK = { fontSize: 9, fill: CHART.tick } as const;
export const GRID_PROPS = { strokeDasharray: '3 3' as const, stroke: CHART.grid };

// L-12 FIX: Consistent error truncation length across dashboard.
export const MAX_ERROR_DISPLAY = 30;

// Block explorer base URLs per chain (used for transaction links).
export const EXPLORER_URLS: Record<string, string> = {
  ethereum: 'https://etherscan.io/tx/',
  bsc: 'https://bscscan.com/tx/',
  polygon: 'https://polygonscan.com/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
  base: 'https://basescan.org/tx/',
  avalanche: 'https://snowtrace.io/tx/',
  fantom: 'https://ftmscan.com/tx/',
  zksync: 'https://explorer.zksync.io/tx/',
  linea: 'https://lineascan.build/tx/',
  blast: 'https://blastscan.io/tx/',
  scroll: 'https://scrollscan.com/tx/',
  mantle: 'https://mantlescan.xyz/tx/',
  mode: 'https://modescan.io/tx/',
  solana: 'https://solscan.io/tx/',
};

// L-10: Chain accent colors for visual differentiation.
export const CHAIN_COLORS: Record<string, string> = {
  ethereum: '#627EEA',
  bsc: '#F0B90B',
  polygon: '#8247E5',
  arbitrum: '#28A0F0',
  optimism: '#FF0420',
  base: '#0052FF',
  avalanche: '#E84142',
  fantom: '#1969FF',
  zksync: '#4E529A',
  linea: '#61DFFF',
  blast: '#FCFC03',
  scroll: '#FFEEDA',
  mantle: '#2FC0A2',
  mode: '#DFFE00',
  solana: '#9945FF',
};
