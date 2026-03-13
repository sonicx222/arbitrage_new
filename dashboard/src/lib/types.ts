// dashboard/src/lib/types.ts
// Mirrors backend types for dashboard consumption.
// Keep in sync with: services/coordinator/src/api/types.ts
//                    shared/types/src/index.ts
//                    shared/types/src/execution.ts

export type Tab = 'Overview' | 'Execution' | 'Opportunities' | 'Chains' | 'Risk' | 'Streams' | 'Diagnostics' | 'Admin';

export interface SystemMetrics {
  totalOpportunities: number;
  totalExecutions: number;
  successfulExecutions: number;
  totalProfit: number;
  averageLatency: number;
  averageMemory: number;
  systemHealth: number;
  activeServices: number;
  lastUpdate: number;
  whaleAlerts: number;
  pendingOpportunities: number;
  totalSwapEvents: number;
  totalVolumeUsd: number;
  volumeAggregatesProcessed: number;
  activePairsTracked: number;
  priceUpdatesReceived: number;
  opportunitiesDropped: number;
  dlqMetrics?: {
    total: number;
    expired: number;
    validation: number;
    transient: number;
    unknown: number;
  };
  forwardingMetrics?: {
    expired: number;
    duplicate: number;
    profitRejected: number;
    chainRejected: number;
    gracePeriodDeferred: number;
    notLeader: number;
    circuitOpen: number;
  };
  backpressure?: {
    executionStreamDepthRatio: number;
    active: boolean;
  };
  admissionMetrics?: {
    admitted: number;
    shed: number;
    avgScoreAdmitted: number;
    avgScoreShed: number;
  };
}

export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'starting' | 'stopping';
  uptime: number;
  memoryUsage: number;
  cpuUsage: number;
  lastHeartbeat: number;
  latency?: number;
  error?: string;
  consecutiveFailures?: number;
  restartCount?: number;
}

export interface ExecutionResult {
  opportunityId: string;
  success: boolean;
  transactionHash?: string;
  actualProfit?: number;
  gasUsed?: number;
  gasCost?: number;
  error?: string;
  timestamp: number;
  chain: string;
  dex: string;
  latencyMs?: number;
  usedMevProtection?: boolean;
}

export type AlertSeverity = 'low' | 'warning' | 'high' | 'critical';

export interface Alert {
  type: string;
  service?: string;
  message?: string;
  severity?: AlertSeverity;
  data?: Record<string, unknown>;
  timestamp: number;
}

export interface CircuitBreakerStatus {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  consecutiveFailures: number;
  lastFailureTime: number | null;
  cooldownRemainingMs: number;
  timestamp: number;
}

export interface StreamHealth {
  [streamName: string]: {
    length: number;
    pending: number;
    consumerGroups: number;
    status: 'healthy' | 'warning' | 'critical' | 'unknown';
  };
}

// Unified feed item for LiveFeed component
export type FeedItem =
  | { kind: 'execution'; data: ExecutionResult; id: string }
  | { kind: 'alert'; data: Alert; id: string };

// Chart data points for SSE-driven time series
export interface ChartPoint {
  [key: string]: string | number | undefined;
  time: string;
  latency?: number;
  successRate?: number;
  profit?: number;
}

export interface LagPoint {
  [key: string]: string | number | undefined;
  time: string;
  pending: number;
}

// Diagnostics snapshot (mirrors shared/core/src/monitoring/diagnostics-collector.ts)
export interface CompactPercentiles {
  p50: number;
  p95: number;
  p99: number;
  count: number;
}

export interface DiagnosticsSnapshot {
  pipeline: {
    e2e: CompactPercentiles;
    wsToDetector: CompactPercentiles;
    detectorToPublish: CompactPercentiles;
    stages: Record<string, CompactPercentiles>;
  };
  runtime: {
    eventLoop: { min: number; max: number; mean: number; p99: number };
    memory: { heapUsedMB: number; heapTotalMB: number; rssMB: number; externalMB: number };
    gc: { totalPauseMs: number; count: number; majorCount: number };
    uptimeSeconds: number;
  };
  providers: {
    rpcByChain: Record<string, { p50: number; p95: number; errors: number; totalCalls: number }>;
    rpcByMethod: Record<string, { p50: number; p95: number; totalCalls: number }>;
    reconnections: Record<string, { count: number; p50: number }>;
    wsMessages: Record<string, number>;
    totalRpcErrors: number;
  };
  streams: {
    overall: string;
    streams: Record<string, { length: number; pending: number; consumerGroups: number; status: string }>;
  } | null;
  timestamp: number;
}

/** CEX-DEX spread data from CexPriceFeedService (ADR-036) */
export interface CexSpreadData {
  stats: {
    cexPriceUpdatesTotal: number;
    dexPriceUpdatesTotal: number;
    spreadAlertsTotal: number;
    wsReconnectionsTotal: number;
    wsConnected: boolean;
    running: boolean;
    simulationMode: boolean;
    activeAlertCount: number;
  };
  alerts: Array<{
    tokenId: string;
    chain: string;
    cexPrice: number;
    dexPrice: number;
    spreadPct: number;
    timestamp: number;
  }>;
  healthSnapshot?: {
    status: string;
    disconnectedSince: number | null;
    isDegraded: boolean;
  };
}

// Mirrors shared/types ArbitrageOpportunity (subset for dashboard display)
export interface Opportunity {
  id: string;
  type?: string;
  chain?: string;
  buyDex?: string;
  sellDex?: string;
  buyChain?: string;
  sellChain?: string;
  tokenIn?: string;
  tokenOut?: string;
  expectedProfit?: number;
  estimatedProfit?: number;
  profitPercentage?: number;
  confidence: number;
  timestamp: number;
  expiresAt?: number;
  status?: 'pending' | 'executing' | 'completed' | 'failed' | 'expired';
  gasCost?: number;
  netProfit?: number;
  bridgeRequired?: boolean;
}
