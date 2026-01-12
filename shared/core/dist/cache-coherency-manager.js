"use strict";
// Cache Coherency Manager with Gossip Protocol
// Maintains cache consistency across distributed nodes
Object.defineProperty(exports, "__esModule", { value: true });
exports.CacheCoherencyManager = void 0;
exports.createCacheCoherencyManager = createCacheCoherencyManager;
exports.getCacheCoherencyManager = getCacheCoherencyManager;
exports.resetCacheCoherencyManager = resetCacheCoherencyManager;
const logger_1 = require("./logger");
const redis_1 = require("./redis");
const logger = (0, logger_1.createLogger)('cache-coherency');
class CacheCoherencyManager {
    constructor(nodeId, config = {}) {
        this.nodes = new Map();
        this.vectorClock = new Map();
        this.pendingOperations = [];
        this.gossipTimer = null;
        // P2-FIX: Track operation keys to prevent duplicates (O(1) lookup)
        this.operationKeys = new Set();
        // P2-FIX: Maximum pending operations to prevent unbounded memory growth
        this.MAX_PENDING_OPERATIONS = 1000;
        this.PRUNE_TARGET = 500;
        // P1-12 FIX: Lock for atomic vector clock operations
        this.vectorClockLock = false;
        // P1-13 FIX: Dead node cleanup timeout (remove nodes dead longer than this)
        this.DEAD_NODE_CLEANUP_MS = 300000; // 5 minutes
        // P1-13 FIX: Maximum number of nodes to track
        this.MAX_NODES = 1000;
        // P1-14 FIX: Maximum vector clock entries
        this.MAX_VECTOR_CLOCK_ENTRIES = 1000;
        // P1-14 FIX: Vector clock entry age threshold
        this.VECTOR_CLOCK_ENTRY_MAX_AGE_MS = 3600000; // 1 hour
        // P1-14 FIX: Track last update time for vector clock entries
        this.vectorClockLastUpdated = new Map();
        this.nodeId = nodeId;
        this.config = {
            gossipInterval: config.gossipInterval || 1000, // 1 second
            suspicionTimeout: config.suspicionTimeout || 5000, // 5 seconds
            failureTimeout: config.failureTimeout || 15000, // 15 seconds
            fanout: config.fanout || 3,
            maxGossipMessageSize: config.maxGossipMessageSize || 1024 * 1024, // 1MB
            enableConflictResolution: config.enableConflictResolution !== false
        };
        this.redis = (0, redis_1.getRedisClient)();
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
    async recordOperation(operation) {
        try {
            // Validate operation
            if (!operation.key || !operation.type) {
                throw new Error('Invalid operation: missing key or type');
            }
            const fullOperation = {
                ...operation,
                timestamp: Date.now(),
                nodeId: this.nodeId,
                version: this.incrementVectorClock(this.nodeId)
            };
            // P2-FIX: Check for duplicate before adding (using Set for O(1) lookup)
            const operationKey = this.getOperationKey(fullOperation);
            if (this.operationKeys.has(operationKey)) {
                logger.debug('Duplicate operation detected, skipping', { key: operation.key });
                return;
            }
            // P2-FIX: Only add to pending operations once (removed from here, happens in applyOperationLocally)
            // This prevents duplicate entries when recordOperation and applyOperationLocally both add
            // Broadcast to other nodes
            try {
                await this.broadcastOperation(fullOperation);
            }
            catch (broadcastError) {
                logger.error('Failed to broadcast operation', { error: broadcastError, operation: fullOperation });
                // Continue with local application even if broadcast fails
            }
            // Apply locally (this is where the operation gets added to pendingOperations)
            await this.applyOperationLocally(fullOperation);
        }
        catch (error) {
            logger.error('Failed to record operation', { error, operation });
            throw error;
        }
    }
    async invalidateKey(key) {
        await this.recordOperation({
            type: 'invalidate',
            key
        });
    }
    async handleIncomingMessage(message) {
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
    getNodeStatus() {
        return {
            nodeId: this.nodeId,
            knownNodes: Array.from(this.nodes.keys()),
            vectorClock: Object.fromEntries(this.vectorClock),
            pendingOperations: this.pendingOperations.length,
            lastGossip: Date.now()
        };
    }
    setConflictResolver(resolver) {
        this.conflictResolver = resolver;
    }
    // Gossip protocol implementation
    async startGossipProtocol() {
        this.gossipTimer = setInterval(async () => {
            try {
                await this.performGossipRound();
            }
            catch (error) {
                logger.error('Gossip round failed', { error });
            }
        }, this.config.gossipInterval);
    }
    async performGossipRound() {
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
    selectGossipTargets() {
        const aliveNodes = Array.from(this.nodes.values())
            .filter(node => node.status === 'alive' && node.id !== this.nodeId)
            .map(node => node.id);
        // Random selection with fanout
        const targets = [];
        for (let i = 0; i < Math.min(this.config.fanout, aliveNodes.length); i++) {
            const randomIndex = Math.floor(Math.random() * aliveNodes.length);
            targets.push(aliveNodes.splice(randomIndex, 1)[0]);
        }
        return targets;
    }
    async gossipWithNode(nodeId) {
        const node = this.nodes.get(nodeId);
        if (!node)
            return;
        // Send digest of our operations
        const digest = this.createDigest();
        const message = {
            type: 'digest',
            nodeId: this.nodeId,
            timestamp: Date.now(),
            payload: digest,
            vectorClock: new Map(this.vectorClock)
        };
        await this.sendMessageToNode(node, message);
    }
    createDigest() {
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
    async handleHeartbeat(message) {
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
        }
        else {
            // Update existing node
            const node = this.nodes.get(nodeId);
            node.lastSeen = Date.now();
            node.status = 'alive';
            node.vectorClock = new Map(message.vectorClock);
        }
        // Merge vector clocks
        this.mergeVectorClock(message.vectorClock);
    }
    async handleOperation(message) {
        const operation = {
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
            }
            else {
                logger.warn('Operation conflict detected, ignoring', {
                    operation: operation.key,
                    conflicts: conflictingOps.length
                });
            }
        }
        else {
            await this.applyOperationLocally(operation);
        }
        // Update vector clock
        this.mergeVectorClock(message.vectorClock);
    }
    async handleDigest(message) {
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
    hasOperation(operation) {
        // P2-FIX: Use O(1) Set lookup instead of O(n) array scan
        const operationKey = this.getOperationKey(operation);
        return this.operationKeys.has(operationKey);
    }
    findConflictingOperations(operation) {
        return this.pendingOperations.filter(op => op.key === operation.key &&
            op.nodeId !== operation.nodeId &&
            Math.abs(op.timestamp - operation.timestamp) < 1000 // Within 1 second
        );
    }
    resolveConflicts(newOp, conflictingOps) {
        // Use the conflict resolver
        let resolvedOp = newOp;
        for (const conflictingOp of conflictingOps) {
            resolvedOp = this.conflictResolver(resolvedOp, conflictingOp);
        }
        return resolvedOp;
    }
    defaultConflictResolver(op1, op2) {
        // Last-write-wins strategy
        return op1.timestamp > op2.timestamp ? op1 : op2;
    }
    findMissingOperations(remoteOps) {
        const localOpKeys = new Set(this.pendingOperations.map(op => `${op.nodeId}:${op.version}:${op.key}`));
        return remoteOps
            .filter(op => !localOpKeys.has(`${op.nodeId}:${op.version}:${op.key}`))
            .map(op => op.key);
    }
    // Communication methods
    async sendHeartbeat() {
        const message = {
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
    async broadcastOperation(operation) {
        const message = {
            type: operation.type,
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
    async sendMessageToNode(node, message) {
        try {
            // In a real implementation, this would send via network
            // For now, simulate with Redis pub/sub
            const channel = `gossip:${node.id}`;
            await this.redis.publish(channel, JSON.stringify(message));
        }
        catch (error) {
            logger.error('Failed to send message to node', { error, nodeId: node.id });
        }
    }
    async requestMissingOperations(nodeId, operationKeys) {
        // Request missing operations from another node
        const message = {
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
    incrementVectorClock(nodeId) {
        // P1-12 FIX: Simple spin-lock to prevent concurrent increments
        if (this.vectorClockLock) {
            throw new Error('Vector clock operation in progress - concurrent access detected');
        }
        this.vectorClockLock = true;
        try {
            const current = this.vectorClock.get(nodeId) || 0;
            const newValue = current + 1;
            this.vectorClock.set(nodeId, newValue);
            // P1-14 FIX: Track when this entry was last updated for cleanup
            this.vectorClockLastUpdated.set(nodeId, Date.now());
            return newValue;
        }
        finally {
            this.vectorClockLock = false;
        }
    }
    mergeVectorClock(remoteClock) {
        const now = Date.now();
        for (const [nodeId, version] of remoteClock.entries()) {
            const localVersion = this.vectorClock.get(nodeId) || 0;
            if (version > localVersion) {
                this.vectorClock.set(nodeId, version);
                // P1-14 FIX: Track when this entry was last updated
                this.vectorClockLastUpdated.set(nodeId, now);
            }
        }
        // P1-14 FIX: Cleanup stale vector clock entries
        this.pruneVectorClockEntries();
    }
    /**
     * P1-14 FIX: Prune stale vector clock entries to prevent unbounded growth.
     *
     * Removes entries for nodes that:
     * 1. Haven't been updated in VECTOR_CLOCK_ENTRY_MAX_AGE_MS
     * 2. Are no longer in the active nodes map
     *
     * Also enforces MAX_VECTOR_CLOCK_ENTRIES limit.
     */
    pruneVectorClockEntries() {
        const now = Date.now();
        // First pass: remove stale entries
        for (const [nodeId, lastUpdated] of this.vectorClockLastUpdated.entries()) {
            if (nodeId === this.nodeId)
                continue; // Never remove own entry
            const age = now - lastUpdated;
            const node = this.nodes.get(nodeId);
            // Remove if entry is old AND node is not active
            if (age > this.VECTOR_CLOCK_ENTRY_MAX_AGE_MS && (!node || node.status === 'dead')) {
                this.vectorClock.delete(nodeId);
                this.vectorClockLastUpdated.delete(nodeId);
            }
        }
        // Second pass: enforce max size if still too large
        if (this.vectorClock.size > this.MAX_VECTOR_CLOCK_ENTRIES) {
            // Remove oldest entries first (but never self)
            const entries = Array.from(this.vectorClockLastUpdated.entries())
                .filter(([nodeId]) => nodeId !== this.nodeId)
                .sort((a, b) => a[1] - b[1]); // Sort by last updated, oldest first
            const removeCount = this.vectorClock.size - this.MAX_VECTOR_CLOCK_ENTRIES;
            for (let i = 0; i < removeCount && i < entries.length; i++) {
                const [nodeId] = entries[i];
                this.vectorClock.delete(nodeId);
                this.vectorClockLastUpdated.delete(nodeId);
            }
            logger.debug('Pruned vector clock entries due to size limit', {
                removed: removeCount,
                remaining: this.vectorClock.size
            });
        }
    }
    // Local operation application
    async applyOperationLocally(operation) {
        // This would integrate with the actual cache system
        // For now, just log the operation
        logger.debug('Applying operation locally', {
            type: operation.type,
            key: operation.key,
            nodeId: operation.nodeId
        });
        // P2-FIX: Generate operation key for deduplication
        const operationKey = this.getOperationKey(operation);
        // P2-FIX: Check for duplicate before adding
        if (this.operationKeys.has(operationKey)) {
            logger.debug('Duplicate operation in applyOperationLocally, skipping', { key: operation.key });
            return;
        }
        // Add to tracking structures atomically
        this.operationKeys.add(operationKey);
        this.pendingOperations.push(operation);
        // P2-FIX: Atomic pruning using splice instead of array reassignment
        // This prevents losing concurrent additions during the reassignment
        if (this.pendingOperations.length > this.MAX_PENDING_OPERATIONS) {
            const removeCount = this.pendingOperations.length - this.PRUNE_TARGET;
            const removedOps = this.pendingOperations.splice(0, removeCount);
            // Also remove from the keys set to keep them in sync
            for (const op of removedOps) {
                this.operationKeys.delete(this.getOperationKey(op));
            }
            logger.debug('Pruned pending operations', { removed: removeCount, remaining: this.pendingOperations.length });
        }
    }
    /**
     * Generate a unique key for an operation for deduplication purposes.
     * P2-FIX: Centralized key generation for consistent deduplication.
     */
    getOperationKey(operation) {
        return `${operation.nodeId}:${operation.version}:${operation.key}`;
    }
    // Node management
    initializeNode() {
        this.nodes.set(this.nodeId, {
            id: this.nodeId,
            address: 'self',
            lastSeen: Date.now(),
            status: 'alive',
            vectorClock: new Map(this.vectorClock)
        });
        this.vectorClock.set(this.nodeId, 0);
    }
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
    cleanupDeadNodes() {
        const now = Date.now();
        const nodesToRemove = [];
        for (const [nodeId, node] of this.nodes.entries()) {
            if (nodeId === this.nodeId)
                continue; // Never remove self
            const timeSinceLastSeen = now - node.lastSeen;
            if (timeSinceLastSeen > this.config.failureTimeout) {
                // Check if already dead
                if (node.status !== 'dead') {
                    node.status = 'dead';
                    logger.warn('Node marked as dead', { nodeId, lastSeen: node.lastSeen });
                }
                // P1-13 FIX: Remove nodes that have been dead too long
                if (timeSinceLastSeen > this.config.failureTimeout + this.DEAD_NODE_CLEANUP_MS) {
                    nodesToRemove.push(nodeId);
                }
            }
            else if (timeSinceLastSeen > this.config.suspicionTimeout) {
                node.status = 'suspected';
            }
        }
        // P1-13 FIX: Actually remove dead nodes
        for (const nodeId of nodesToRemove) {
            this.nodes.delete(nodeId);
            logger.info('Removed dead node from tracking', { nodeId });
        }
        // P1-13 FIX: Enforce maximum nodes limit
        if (this.nodes.size > this.MAX_NODES) {
            this.enforceMaxNodesLimit();
        }
    }
    /**
     * P1-13 FIX: Enforce maximum nodes limit by removing oldest dead/suspected nodes.
     */
    enforceMaxNodesLimit() {
        // Collect non-self nodes sorted by priority (dead first, then suspected, then by lastSeen)
        const nodesWithPriority = Array.from(this.nodes.entries())
            .filter(([nodeId]) => nodeId !== this.nodeId)
            .map(([nodeId, node]) => ({
            nodeId,
            node,
            priority: node.status === 'dead' ? 0 : node.status === 'suspected' ? 1 : 2,
            lastSeen: node.lastSeen
        }))
            .sort((a, b) => {
            // Sort by priority first (dead < suspected < alive)
            if (a.priority !== b.priority)
                return a.priority - b.priority;
            // Then by lastSeen (oldest first)
            return a.lastSeen - b.lastSeen;
        });
        const removeCount = this.nodes.size - this.MAX_NODES;
        for (let i = 0; i < removeCount && i < nodesWithPriority.length; i++) {
            const { nodeId } = nodesWithPriority[i];
            this.nodes.delete(nodeId);
            logger.debug('Removed node due to max nodes limit', { nodeId });
        }
    }
    // Cleanup
    destroy() {
        if (this.gossipTimer) {
            clearInterval(this.gossipTimer);
            this.gossipTimer = null;
        }
        this.nodes.clear();
        this.pendingOperations.length = 0;
        // P2-FIX: Also clear the operation keys set
        this.operationKeys.clear();
        // P1-14 FIX: Also clear vector clock tracking
        this.vectorClock.clear();
        this.vectorClockLastUpdated.clear();
        logger.info('Cache coherency manager destroyed');
    }
}
exports.CacheCoherencyManager = CacheCoherencyManager;
// Factory function
function createCacheCoherencyManager(nodeId, config) {
    return new CacheCoherencyManager(nodeId, config);
}
// Default instance
let defaultCoherencyManager = null;
function getCacheCoherencyManager() {
    if (!defaultCoherencyManager) {
        defaultCoherencyManager = createCacheCoherencyManager(`node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, {
            gossipInterval: 2000, // 2 seconds
            suspicionTimeout: 10000, // 10 seconds
            failureTimeout: 30000, // 30 seconds
            fanout: 5,
            enableConflictResolution: true
        });
    }
    return defaultCoherencyManager;
}
/**
 * P0-9 FIX: Reset the singleton instance to allow proper cleanup.
 *
 * Previous issue: The singleton was never destroyed, causing:
 * - Memory leaks from timers and subscriptions persisting after service restart
 * - Potential conflicts when creating new instances
 *
 * This function should be called during application shutdown.
 */
async function resetCacheCoherencyManager() {
    if (defaultCoherencyManager) {
        await defaultCoherencyManager.destroy();
        defaultCoherencyManager = null;
    }
}
//# sourceMappingURL=cache-coherency-manager.js.map