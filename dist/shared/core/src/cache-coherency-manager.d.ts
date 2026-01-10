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
    private incrementVectorClock;
    private mergeVectorClock;
    private applyOperationLocally;
    private initializeNode;
    private cleanupDeadNodes;
    destroy(): void;
}
export declare function createCacheCoherencyManager(nodeId: string, config?: Partial<CoherencyConfig>): CacheCoherencyManager;
export declare function getCacheCoherencyManager(): CacheCoherencyManager;
//# sourceMappingURL=cache-coherency-manager.d.ts.map