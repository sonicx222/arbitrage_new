// Cache Coherency Manager with Gossip Protocol
// Maintains cache consistency across distributed nodes

import { createLogger } from './logger';
import { getRedisClient } from './redis';

const logger = createLogger('cache-coherency');

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
  gossipInterval: number; // milliseconds
  suspicionTimeout: number; // milliseconds
  failureTimeout: number; // milliseconds
  fanout: number; // number of nodes to gossip to
  maxGossipMessageSize: number;
  enableConflictResolution: boolean;
}

export class CacheCoherencyManager {
  private config: CoherencyConfig;
  private redis: any;
  private nodeId: string;
  private nodes: Map<string, NodeInfo> = new Map();
  private vectorClock: Map<string, number> = new Map();
  private pendingOperations: CacheOperation[] = [];
  private gossipTimer: NodeJS.Timeout | null = null;
  private conflictResolver: (op1: CacheOperation, op2: CacheOperation) => CacheOperation;

  constructor(nodeId: string, config: Partial<CoherencyConfig> = {}) {
    this.nodeId = nodeId;
    this.config = {
      gossipInterval: config.gossipInterval || 1000, // 1 second
      suspicionTimeout: config.suspicionTimeout || 5000, // 5 seconds
      failureTimeout: config.failureTimeout || 15000, // 15 seconds
      fanout: config.fanout || 3,
      maxGossipMessageSize: config.maxGossipMessageSize || 1024 * 1024, // 1MB
      enableConflictResolution: config.enableConflictResolution !== false
    };

    this.redis = getRedisClient();
    this.conflictResolver = this.defaultConflictResolver.bind(this);

    this.initializeNode();
    this.startGossipProtocol();

    logger.info('Cache coherency manager initialized', {
      nodeId,
      gossipInterval: this.config.gossipInterval,
      fanout: this.config.fanout
    });
  }

  // Public API
  async recordOperation(operation: Omit<CacheOperation, 'timestamp' | 'nodeId' | 'version'>): Promise<void> {
    try {
      // Validate operation
      if (!operation.key || !operation.type) {
        throw new Error('Invalid operation: missing key or type');
      }

      const fullOperation: CacheOperation = {
        ...operation,
        timestamp: Date.now(),
        nodeId: this.nodeId,
        version: this.incrementVectorClock(this.nodeId)
      };

      // Add to pending operations
      this.pendingOperations.push(fullOperation);

      // Broadcast to other nodes
      try {
        await this.broadcastOperation(fullOperation);
      } catch (broadcastError) {
        logger.error('Failed to broadcast operation', { error: broadcastError, operation: fullOperation });
        // Continue with local application even if broadcast fails
      }

      // Apply locally
      await this.applyOperationLocally(fullOperation);

    } catch (error) {
      logger.error('Failed to record operation', { error, operation });
      throw error;
    }
  }

  async invalidateKey(key: string): Promise<void> {
    await this.recordOperation({
      type: 'invalidate',
      key
    });
  }

  async handleIncomingMessage(message: GossipMessage): Promise<void> {
    switch (message.type) {
      case 'heartbeat':
        await this.handleHeartbeat(message);
        break;
      case 'invalidate':
      case 'update':
        await this.handleOperation(message);
        break;
      case 'digest':
        await this.handleDigest(message);
        break;
    }
  }

  getNodeStatus(): any {
    return {
      nodeId: this.nodeId,
      knownNodes: Array.from(this.nodes.keys()),
      vectorClock: Object.fromEntries(this.vectorClock),
      pendingOperations: this.pendingOperations.length,
      lastGossip: Date.now()
    };
  }

  setConflictResolver(resolver: (op1: CacheOperation, op2: CacheOperation) => CacheOperation): void {
    this.conflictResolver = resolver;
  }

  // Gossip protocol implementation
  private async startGossipProtocol(): Promise<void> {
    this.gossipTimer = setInterval(async () => {
      try {
        await this.performGossipRound();
      } catch (error) {
        logger.error('Gossip round failed', { error });
      }
    }, this.config.gossipInterval);
  }

  private async performGossipRound(): Promise<void> {
    // Send heartbeat
    await this.sendHeartbeat();

    // Select random nodes to gossip with
    const targetNodes = this.selectGossipTargets();

    for (const nodeId of targetNodes) {
      await this.gossipWithNode(nodeId);
    }

    // Clean up dead nodes
    this.cleanupDeadNodes();
  }

  private selectGossipTargets(): string[] {
    const aliveNodes = Array.from(this.nodes.values())
      .filter(node => node.status === 'alive' && node.id !== this.nodeId)
      .map(node => node.id);

    // Random selection with fanout
    const targets: string[] = [];
    for (let i = 0; i < Math.min(this.config.fanout, aliveNodes.length); i++) {
      const randomIndex = Math.floor(Math.random() * aliveNodes.length);
      targets.push(aliveNodes.splice(randomIndex, 1)[0]);
    }

    return targets;
  }

  private async gossipWithNode(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    // Send digest of our operations
    const digest = this.createDigest();
    const message: GossipMessage = {
      type: 'digest',
      nodeId: this.nodeId,
      timestamp: Date.now(),
      payload: digest,
      vectorClock: new Map(this.vectorClock)
    };

    await this.sendMessageToNode(node, message);
  }

  private createDigest(): any {
    // Create a summary of our recent operations
    const recentOperations = this.pendingOperations
      .filter(op => Date.now() - op.timestamp < 60000) // Last minute
      .map(op => ({
        key: op.key,
        type: op.type,
        version: op.version,
        timestamp: op.timestamp
      }));

    return {
      operations: recentOperations,
      vectorClock: Object.fromEntries(this.vectorClock)
    };
  }

  // Message handling
  private async handleHeartbeat(message: GossipMessage): Promise<void> {
    const nodeId = message.nodeId;

    if (!this.nodes.has(nodeId)) {
      // New node discovered
      this.nodes.set(nodeId, {
        id: nodeId,
        address: message.payload.address || 'unknown',
        lastSeen: Date.now(),
        status: 'alive',
        vectorClock: new Map(message.vectorClock)
      });
      logger.info('New node discovered', { nodeId });
    } else {
      // Update existing node
      const node = this.nodes.get(nodeId)!;
      node.lastSeen = Date.now();
      node.status = 'alive';
      node.vectorClock = new Map(message.vectorClock);
    }

    // Merge vector clocks
    this.mergeVectorClock(message.vectorClock);
  }

  private async handleOperation(message: GossipMessage): Promise<void> {
    const operation: CacheOperation = {
      ...message.payload,
      nodeId: message.nodeId,
      timestamp: message.timestamp
    };

    // Check if we already have this operation
    if (this.hasOperation(operation)) {
      return;
    }

    // Check for conflicts
    const conflictingOps = this.findConflictingOperations(operation);
    if (conflictingOps.length > 0) {
      if (this.config.enableConflictResolution) {
        const resolvedOp = this.resolveConflicts(operation, conflictingOps);
        await this.applyOperationLocally(resolvedOp);
      } else {
        logger.warn('Operation conflict detected, ignoring', {
          operation: operation.key,
          conflicts: conflictingOps.length
        });
      }
    } else {
      await this.applyOperationLocally(operation);
    }

    // Update vector clock
    this.mergeVectorClock(message.vectorClock);
  }

  private async handleDigest(message: GossipMessage): Promise<void> {
    const remoteDigest = message.payload;

    // Compare digests and request missing operations
    const missingOps = this.findMissingOperations(remoteDigest.operations);

    if (missingOps.length > 0) {
      // Request missing operations from the node
      await this.requestMissingOperations(message.nodeId, missingOps);
    }

    // Merge vector clocks
    this.mergeVectorClock(message.vectorClock);
  }

  // Operation management
  private hasOperation(operation: CacheOperation): boolean {
    return this.pendingOperations.some(op =>
      op.key === operation.key &&
      op.nodeId === operation.nodeId &&
      op.version === operation.version
    );
  }

  private findConflictingOperations(operation: CacheOperation): CacheOperation[] {
    return this.pendingOperations.filter(op =>
      op.key === operation.key &&
      op.nodeId !== operation.nodeId &&
      Math.abs(op.timestamp - operation.timestamp) < 1000 // Within 1 second
    );
  }

  private resolveConflicts(newOp: CacheOperation, conflictingOps: CacheOperation[]): CacheOperation {
    // Use the conflict resolver
    let resolvedOp = newOp;

    for (const conflictingOp of conflictingOps) {
      resolvedOp = this.conflictResolver(resolvedOp, conflictingOp);
    }

    return resolvedOp;
  }

  private defaultConflictResolver(op1: CacheOperation, op2: CacheOperation): CacheOperation {
    // Last-write-wins strategy
    return op1.timestamp > op2.timestamp ? op1 : op2;
  }

  private findMissingOperations(remoteOps: any[]): string[] {
    const localOpKeys = new Set(
      this.pendingOperations.map(op => `${op.nodeId}:${op.version}:${op.key}`)
    );

    return remoteOps
      .filter(op => !localOpKeys.has(`${op.nodeId}:${op.version}:${op.key}`))
      .map(op => op.key);
  }

  // Communication methods
  private async sendHeartbeat(): Promise<void> {
    const message: GossipMessage = {
      type: 'heartbeat',
      nodeId: this.nodeId,
      timestamp: Date.now(),
      payload: { address: 'self' }, // Would be actual address
      vectorClock: new Map(this.vectorClock)
    };

    // Broadcast to all known nodes
    for (const node of this.nodes.values()) {
      if (node.id !== this.nodeId) {
        await this.sendMessageToNode(node, message);
      }
    }
  }

  private async broadcastOperation(operation: CacheOperation): Promise<void> {
    const message: GossipMessage = {
      type: operation.type as 'invalidate' | 'update',
      nodeId: this.nodeId,
      timestamp: operation.timestamp,
      payload: operation,
      vectorClock: new Map(this.vectorClock)
    };

    for (const node of this.nodes.values()) {
      if (node.id !== this.nodeId) {
        await this.sendMessageToNode(node, message);
      }
    }
  }

  private async sendMessageToNode(node: NodeInfo, message: GossipMessage): Promise<void> {
    try {
      // In a real implementation, this would send via network
      // For now, simulate with Redis pub/sub
      const channel = `gossip:${node.id}`;
      await this.redis.publish(channel, JSON.stringify(message));
    } catch (error) {
      logger.error('Failed to send message to node', { error, nodeId: node.id });
    }
  }

  private async requestMissingOperations(nodeId: string, operationKeys: string[]): Promise<void> {
    // Request missing operations from another node
    const message: GossipMessage = {
      type: 'digest',
      nodeId: this.nodeId,
      timestamp: Date.now(),
      payload: {
        type: 'request',
        operationKeys
      },
      vectorClock: new Map(this.vectorClock)
    };

    const node = this.nodes.get(nodeId);
    if (node) {
      await this.sendMessageToNode(node, message);
    }
  }

  // Vector clock management
  private incrementVectorClock(nodeId: string): number {
    const current = this.vectorClock.get(nodeId) || 0;
    const newValue = current + 1;
    this.vectorClock.set(nodeId, newValue);
    return newValue;
  }

  private mergeVectorClock(remoteClock: Map<string, number>): void {
    for (const [nodeId, version] of remoteClock.entries()) {
      const localVersion = this.vectorClock.get(nodeId) || 0;
      if (version > localVersion) {
        this.vectorClock.set(nodeId, version);
      }
    }
  }

  // Local operation application
  private async applyOperationLocally(operation: CacheOperation): Promise<void> {
    // This would integrate with the actual cache system
    // For now, just log the operation
    logger.debug('Applying operation locally', {
      type: operation.type,
      key: operation.key,
      nodeId: operation.nodeId
    });

    // Add to pending operations to track
    this.pendingOperations.push(operation);

    // Clean up old operations (keep last 1000)
    if (this.pendingOperations.length > 1000) {
      this.pendingOperations = this.pendingOperations.slice(-500);
    }
  }

  // Node management
  private initializeNode(): void {
    this.nodes.set(this.nodeId, {
      id: this.nodeId,
      address: 'self',
      lastSeen: Date.now(),
      status: 'alive',
      vectorClock: new Map(this.vectorClock)
    });

    this.vectorClock.set(this.nodeId, 0);
  }

  private cleanupDeadNodes(): void {
    const now = Date.now();

    for (const [nodeId, node] of this.nodes.entries()) {
      if (nodeId === this.nodeId) continue;

      const timeSinceLastSeen = now - node.lastSeen;

      if (timeSinceLastSeen > this.config.failureTimeout) {
        node.status = 'dead';
        logger.warn('Node marked as dead', { nodeId, lastSeen: node.lastSeen });
      } else if (timeSinceLastSeen > this.config.suspicionTimeout) {
        node.status = 'suspected';
      }
    }
  }

  // Cleanup
  destroy(): void {
    if (this.gossipTimer) {
      clearInterval(this.gossipTimer);
      this.gossipTimer = null;
    }

    this.nodes.clear();
    this.pendingOperations.length = 0;

    logger.info('Cache coherency manager destroyed');
  }
}

// Factory function
export function createCacheCoherencyManager(
  nodeId: string,
  config?: Partial<CoherencyConfig>
): CacheCoherencyManager {
  return new CacheCoherencyManager(nodeId, config);
}

// Default instance
let defaultCoherencyManager: CacheCoherencyManager | null = null;

export function getCacheCoherencyManager(): CacheCoherencyManager {
  if (!defaultCoherencyManager) {
    defaultCoherencyManager = createCacheCoherencyManager(
      `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      {
        gossipInterval: 2000, // 2 seconds
        suspicionTimeout: 10000, // 10 seconds
        failureTimeout: 30000, // 30 seconds
        fanout: 5,
        enableConflictResolution: true
      }
    );
  }
  return defaultCoherencyManager;
}