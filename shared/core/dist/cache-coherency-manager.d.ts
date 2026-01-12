export interface NodeInfo {
    id: string;
    address: string;
    lastSeen: number;
    status: 'alive' | 'suspected' | 'dead';
    vectorClock: Map<string, number>;
}
export interface GossipMessage {
    type: 'heartbeat' | 'invalidate' | 'update' | 'digest';
    nodeId: string;
    timestamp: number;
    payload: any;
    vectorClock: Map<string, number>;
}
export interface CacheOperation {
    type: 'set' | 'delete' | 'invalidate';
    key: string;
    value?: any;
    ttl?: number;
    timestamp: number;
    nodeId: string;
    version: number;
}
export interface CoherencyConfig {
    gossipInterval: number;
    suspicionTimeout: number;
    failureTimeout: number;
    fanout: number;
    maxGossipMessageSize: number;
    enableConflictResolution: boolean;
}
export declare class CacheCoherencyManager {
    private config;
    private redis;
    private nodeId;
    private nodes;
    private vectorClock;
    private pendingOperations;
    private gossipTimer;
    private conflictResolver;
    private operationKeys;
    private readonly MAX_PENDING_OPERATIONS;
    private readonly PRUNE_TARGET;
    private vectorClockLock;
    private readonly DEAD_NODE_CLEANUP_MS;
    private readonly MAX_NODES;
    private readonly MAX_VECTOR_CLOCK_ENTRIES;
    private readonly VECTOR_CLOCK_ENTRY_MAX_AGE_MS;
    private vectorClockLastUpdated;
    constructor(nodeId: string, config?: Partial<CoherencyConfig>);
    recordOperation(operation: Omit<CacheOperation, 'timestamp' | 'nodeId' | 'version'>): Promise<void>;
    invalidateKey(key: string): Promise<void>;
    handleIncomingMessage(message: GossipMessage): Promise<void>;
    getNodeStatus(): any;
    setConflictResolver(resolver: (op1: CacheOperation, op2: CacheOperation) => CacheOperation): void;
    private startGossipProtocol;
    private performGossipRound;
    private selectGossipTargets;
    private gossipWithNode;
    private createDigest;
    private handleHeartbeat;
    private handleOperation;
    private handleDigest;
    private hasOperation;
    private findConflictingOperations;
    private resolveConflicts;
    private defaultConflictResolver;
    private findMissingOperations;
    private sendHeartbeat;
    private broadcastOperation;
    private sendMessageToNode;
    private requestMissingOperations;
    /**
     * P1-12 FIX: Atomic vector clock increment with lock.
     *
     * Previous implementation had a TOCTOU vulnerability where concurrent calls
     * could read the same value and both increment to the same new value,
     * resulting in skipped or duplicated versions breaking causal ordering.
     *
     * This fix uses a simple spin-lock pattern. While JavaScript is single-threaded,
     * async operations can interleave, so we guard against concurrent access.
     */
    private incrementVectorClock;
    private mergeVectorClock;
    /**
     * P1-14 FIX: Prune stale vector clock entries to prevent unbounded growth.
     *
     * Removes entries for nodes that:
     * 1. Haven't been updated in VECTOR_CLOCK_ENTRY_MAX_AGE_MS
     * 2. Are no longer in the active nodes map
     *
     * Also enforces MAX_VECTOR_CLOCK_ENTRIES limit.
     */
    private pruneVectorClockEntries;
    private applyOperationLocally;
    /**
     * Generate a unique key for an operation for deduplication purposes.
     * P2-FIX: Centralized key generation for consistent deduplication.
     */
    private getOperationKey;
    private initializeNode;
    /**
     * P1-13 FIX: Cleanup dead nodes with actual removal.
     *
     * Previous implementation only marked nodes as 'dead' but never removed them,
     * causing unbounded memory growth in the nodes Map.
     *
     * This fix:
     * 1. Marks nodes as suspected/dead based on timeout thresholds
     * 2. REMOVES nodes that have been dead for longer than DEAD_NODE_CLEANUP_MS
     * 3. Enforces MAX_NODES limit by removing oldest dead nodes first
     */
    private cleanupDeadNodes;
    /**
     * P1-13 FIX: Enforce maximum nodes limit by removing oldest dead/suspected nodes.
     */
    private enforceMaxNodesLimit;
    destroy(): void;
}
export declare function createCacheCoherencyManager(nodeId: string, config?: Partial<CoherencyConfig>): CacheCoherencyManager;
export declare function getCacheCoherencyManager(): CacheCoherencyManager;
/**
 * P0-9 FIX: Reset the singleton instance to allow proper cleanup.
 *
 * Previous issue: The singleton was never destroyed, causing:
 * - Memory leaks from timers and subscriptions persisting after service restart
 * - Potential conflicts when creating new instances
 *
 * This function should be called during application shutdown.
 */
export declare function resetCacheCoherencyManager(): Promise<void>;
//# sourceMappingURL=cache-coherency-manager.d.ts.map