// dashboard/src/lib/types.ts
// Mirrors backend types for dashboard consumption.
// Keep in sync with: services/coordinator/src/api/types.ts
//                    shared/types/src/index.ts
//                    shared/types/src/execution.ts

export type Tab = 'Overview' | 'Execution' | 'Chains' | 'Risk' | 'Streams' | 'Admin';

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
  time: string;
  latency?: number;
  successRate?: number;
}

export interface LagPoint {
  time: string;
  pending: number;
}
