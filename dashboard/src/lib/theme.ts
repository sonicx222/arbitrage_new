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

// L-12 FIX: Consistent error truncation length across dashboard.
export const MAX_ERROR_DISPLAY = 30;

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
  mantle: '#000000',
  mode: '#DFFE00',
  solana: '#9945FF',
};
