"use strict";
/**
 * T3.12: Enhanced Whale Activity Detection
 *
 * Professional-grade whale tracking with:
 * - Wallet tracking over time (activity history)
 * - Pattern analysis (accumulation/distribution)
 * - Follow-the-whale signals (early warning)
 * - Impact prediction (price movement forecast)
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Finding 4.2
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhaleActivityTracker = void 0;
exports.getWhaleActivityTracker = getWhaleActivityTracker;
exports.resetWhaleActivityTracker = resetWhaleActivityTracker;
const logger_1 = require("./logger");
const logger = (0, logger_1.createLogger)('whale-activity-tracker');
// =============================================================================
// Default Configuration
// =============================================================================
const DEFAULT_CONFIG = {
    whaleThresholdUsd: 50000,
    activityWindowMs: 24 * 60 * 60 * 1000, // 24 hours
    minTradesForPattern: 3,
    maxTrackedWallets: 5000,
    maxTransactionsPerWallet: 100,
    superWhaleMultiplier: 10
};
// =============================================================================
// Whale Activity Tracker
// =============================================================================
/**
 * T3.12: Enhanced Whale Activity Tracker
 *
 * Tracks whale wallets, detects patterns, and generates follow-the-whale signals.
 */
class WhaleActivityTracker {
    constructor(config = {}) {
        this.wallets = new Map();
        this.signalHandlers = [];
        this.stats = {
            totalTransactionsTracked: 0,
            totalSignalsGenerated: 0,
            totalSignalConfidence: 0,
            walletEvictions: 0
        };
        this.config = { ...DEFAULT_CONFIG, ...config };
        logger.info('WhaleActivityTracker initialized', {
            whaleThresholdUsd: this.config.whaleThresholdUsd,
            activityWindowMs: this.config.activityWindowMs,
            maxTrackedWallets: this.config.maxTrackedWallets
        });
    }
    /**
     * Record a whale transaction.
     * This is the main entry point for tracking whale activity.
     */
    recordTransaction(transaction) {
        // Validate transaction qualifies as whale
        if (transaction.usdValue < this.config.whaleThresholdUsd) {
            return;
        }
        this.stats.totalTransactionsTracked++;
        // Get or create wallet profile
        let profile = this.wallets.get(transaction.walletAddress);
        if (!profile) {
            this.evictLRUWalletsIfNeeded();
            profile = this.createWalletProfile(transaction.walletAddress, transaction.timestamp);
            this.wallets.set(transaction.walletAddress, profile);
        }
        // Update profile
        this.updateWalletProfile(profile, transaction);
        // Analyze for signals
        const signal = this.analyzeForSignal(profile, transaction);
        if (signal) {
            this.emitSignal(signal);
        }
        logger.debug('Whale transaction recorded', {
            wallet: transaction.walletAddress.slice(0, 10) + '...',
            usdValue: transaction.usdValue,
            direction: transaction.direction,
            pattern: profile.pattern
        });
    }
    /**
     * Get activity summary for a specific token/pair.
     */
    getActivitySummary(pairKey, chain, windowMs) {
        const window = windowMs ?? this.config.activityWindowMs;
        const cutoff = Date.now() - window;
        let buyVolumeUsd = 0;
        let sellVolumeUsd = 0;
        let whaleCount = 0;
        let superWhaleCount = 0;
        let totalPriceImpact = 0;
        let impactCount = 0;
        const superWhaleThreshold = this.config.whaleThresholdUsd * this.config.superWhaleMultiplier;
        for (const profile of this.wallets.values()) {
            for (const tx of profile.recentTransactions) {
                if (tx.timestamp < cutoff)
                    continue;
                // BUG FIX: Use exact string matching instead of includes() to avoid partial matches
                // e.g., "USDT" should not match "USDT2"
                const matchesPair = tx.pairAddress === pairKey ||
                    tx.tokenIn === pairKey ||
                    tx.tokenOut === pairKey;
                if (!matchesPair)
                    continue;
                if (tx.chain !== chain)
                    continue;
                if (tx.direction === 'buy') {
                    buyVolumeUsd += tx.usdValue;
                }
                else {
                    sellVolumeUsd += tx.usdValue;
                }
                if (tx.usdValue >= superWhaleThreshold) {
                    superWhaleCount++;
                }
                whaleCount++;
                if (tx.priceImpact > 0) {
                    totalPriceImpact += tx.priceImpact;
                    impactCount++;
                }
            }
        }
        const netFlowUsd = buyVolumeUsd - sellVolumeUsd;
        const totalVolume = buyVolumeUsd + sellVolumeUsd;
        let dominantDirection = 'neutral';
        if (totalVolume > 0) {
            const buyRatio = buyVolumeUsd / totalVolume;
            if (buyRatio > 0.6)
                dominantDirection = 'bullish';
            else if (buyRatio < 0.4)
                dominantDirection = 'bearish';
        }
        return {
            pairKey,
            chain,
            windowMs: window,
            buyVolumeUsd,
            sellVolumeUsd,
            netFlowUsd,
            whaleCount,
            superWhaleCount,
            dominantDirection,
            avgPriceImpact: impactCount > 0 ? totalPriceImpact / impactCount : 0
        };
    }
    /**
     * Get wallet profile by address.
     */
    getWalletProfile(address) {
        return this.wallets.get(address);
    }
    /**
     * Get top whales by volume.
     */
    getTopWhales(limit = 10) {
        return Array.from(this.wallets.values())
            .sort((a, b) => b.totalVolumeUsd - a.totalVolumeUsd)
            .slice(0, limit);
    }
    /**
     * Get wallets matching a specific pattern.
     */
    getWalletsByPattern(pattern) {
        return Array.from(this.wallets.values())
            .filter(w => w.pattern === pattern);
    }
    /**
     * Register a handler for whale signals.
     */
    onSignal(handler) {
        this.signalHandlers.push(handler);
        return () => {
            const index = this.signalHandlers.indexOf(handler);
            if (index > -1) {
                this.signalHandlers.splice(index, 1);
            }
        };
    }
    /**
     * Get tracker statistics.
     */
    getStats() {
        const avgConfidence = this.stats.totalSignalsGenerated > 0
            ? this.stats.totalSignalConfidence / this.stats.totalSignalsGenerated
            : 0;
        return {
            totalTransactionsTracked: this.stats.totalTransactionsTracked,
            totalWalletsTracked: this.wallets.size,
            totalSignalsGenerated: this.stats.totalSignalsGenerated,
            avgSignalConfidence: avgConfidence,
            walletEvictions: this.stats.walletEvictions
        };
    }
    /**
     * Reset all tracking data.
     */
    reset() {
        this.wallets.clear();
        this.stats = {
            totalTransactionsTracked: 0,
            totalSignalsGenerated: 0,
            totalSignalConfidence: 0,
            walletEvictions: 0
        };
    }
    // ===========================================================================
    // Private Helpers
    // ===========================================================================
    createWalletProfile(address, timestamp) {
        // BUG FIX: Use provided timestamp for consistency with historical data replay
        const ts = timestamp ?? Date.now();
        return {
            address,
            firstSeen: ts,
            lastSeen: ts,
            totalTransactions: 0,
            totalVolumeUsd: 0,
            recentTransactions: [],
            pattern: 'unknown',
            historicalAccuracy: 0.5, // Start neutral
            activeChains: new Set(),
            frequentTokens: new Map()
        };
    }
    updateWalletProfile(profile, tx) {
        // BUG FIX: Only update lastSeen if transaction is newer (handles out-of-order processing)
        profile.lastSeen = Math.max(profile.lastSeen, tx.timestamp);
        profile.totalTransactions++;
        profile.totalVolumeUsd += tx.usdValue;
        profile.activeChains.add(tx.chain);
        // Track frequent tokens
        const tokenCount = profile.frequentTokens.get(tx.tokenIn) || 0;
        profile.frequentTokens.set(tx.tokenIn, tokenCount + 1);
        const outCount = profile.frequentTokens.get(tx.tokenOut) || 0;
        profile.frequentTokens.set(tx.tokenOut, outCount + 1);
        // Add to recent transactions (maintain limit)
        profile.recentTransactions.push(tx);
        if (profile.recentTransactions.length > this.config.maxTransactionsPerWallet) {
            profile.recentTransactions.shift();
        }
        // Update pattern analysis
        profile.pattern = this.detectPattern(profile);
    }
    detectPattern(profile) {
        const transactions = profile.recentTransactions;
        if (transactions.length < this.config.minTradesForPattern) {
            return 'unknown';
        }
        // Analyze recent transactions within activity window
        const cutoff = Date.now() - this.config.activityWindowMs;
        const recent = transactions.filter(tx => tx.timestamp >= cutoff);
        if (recent.length < this.config.minTradesForPattern) {
            return 'unknown';
        }
        // BUG FIX: Sort by timestamp for accurate time-based analysis
        // Transactions may be recorded out of order (e.g., historical data replay)
        const sortedRecent = [...recent].sort((a, b) => a.timestamp - b.timestamp);
        const buys = sortedRecent.filter(tx => tx.direction === 'buy');
        const sells = sortedRecent.filter(tx => tx.direction === 'sell');
        const buyRatio = buys.length / sortedRecent.length;
        // Check for arbitrageur pattern (quick buy/sell cycles)
        const avgTimeBetweenTrades = sortedRecent.length > 1
            ? (sortedRecent[sortedRecent.length - 1].timestamp - sortedRecent[0].timestamp) / (sortedRecent.length - 1)
            : Infinity;
        if (avgTimeBetweenTrades < 60000 && Math.abs(buyRatio - 0.5) < 0.2) {
            return 'arbitrageur';
        }
        // Check for accumulator/distributor
        if (buyRatio > 0.7)
            return 'accumulator';
        if (buyRatio < 0.3)
            return 'distributor';
        return 'swing_trader';
    }
    analyzeForSignal(profile, tx) {
        // Only generate signals for wallets with established patterns
        if (profile.pattern === 'unknown') {
            return null;
        }
        // Super whale transactions always generate signals
        const isSuperWhale = tx.usdValue >= this.config.whaleThresholdUsd * this.config.superWhaleMultiplier;
        // Calculate confidence based on pattern consistency and volume
        let confidence = 0.5;
        let signalType = 'follow';
        let reasoning = '';
        switch (profile.pattern) {
            case 'accumulator':
                if (tx.direction === 'buy') {
                    confidence = 0.7;
                    signalType = 'follow';
                    reasoning = `Known accumulator buying ${tx.tokenOut}. Pattern confidence high.`;
                }
                else {
                    confidence = 0.6;
                    signalType = 'fade';
                    reasoning = `Accumulator selling - possible distribution start. Watch closely.`;
                }
                break;
            case 'distributor':
                if (tx.direction === 'sell') {
                    confidence = 0.65;
                    signalType = 'follow';
                    reasoning = `Known distributor continuing sell pattern. Price pressure expected.`;
                }
                else {
                    confidence = 0.5;
                    signalType = 'front_run';
                    reasoning = `Distributor buying - possible accumulation phase starting.`;
                }
                break;
            case 'arbitrageur':
                // Arbitrageurs indicate market inefficiency
                confidence = 0.55;
                signalType = 'front_run';
                reasoning = `Arbitrageur active - market inefficiency detected.`;
                break;
            case 'swing_trader':
                confidence = 0.5;
                signalType = 'follow';
                reasoning = `Swing trader ${tx.direction}ing. Mixed signals.`;
                break;
        }
        // Boost confidence for super whales
        if (isSuperWhale) {
            confidence = Math.min(0.95, confidence + 0.15);
            reasoning = `SUPER WHALE: ${reasoning}`;
        }
        // Boost confidence based on historical accuracy
        if (profile.historicalAccuracy > 0.6) {
            confidence = Math.min(0.95, confidence + (profile.historicalAccuracy - 0.5) * 0.2);
        }
        // Only emit if confidence meets minimum threshold
        if (confidence < 0.5) {
            return null;
        }
        return {
            id: `whale_signal_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            type: signalType,
            walletAddress: profile.address,
            chain: tx.chain,
            token: tx.direction === 'buy' ? tx.tokenOut : tx.tokenIn,
            direction: tx.direction,
            confidence,
            usdValue: tx.usdValue,
            timestamp: Date.now(),
            reasoning,
            validForMs: isSuperWhale ? 300000 : 60000 // 5 min for super whales, 1 min otherwise
        };
    }
    emitSignal(signal) {
        this.stats.totalSignalsGenerated++;
        this.stats.totalSignalConfidence += signal.confidence;
        logger.info('Whale signal generated', {
            type: signal.type,
            token: signal.token,
            direction: signal.direction,
            confidence: signal.confidence,
            usdValue: signal.usdValue
        });
        for (const handler of this.signalHandlers) {
            try {
                handler(signal);
            }
            catch (error) {
                logger.error('Signal handler error', { error });
            }
        }
    }
    evictLRUWalletsIfNeeded() {
        if (this.wallets.size < this.config.maxTrackedWallets) {
            return;
        }
        // Find and remove the oldest 10% of wallets by lastSeen
        const toRemove = Math.max(1, Math.floor(this.config.maxTrackedWallets * 0.1));
        const walletsByAge = Array.from(this.wallets.entries())
            .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
        for (let i = 0; i < toRemove && i < walletsByAge.length; i++) {
            this.wallets.delete(walletsByAge[i][0]);
            this.stats.walletEvictions++;
        }
        logger.debug('Evicted LRU wallets', {
            evicted: toRemove,
            remaining: this.wallets.size
        });
    }
}
exports.WhaleActivityTracker = WhaleActivityTracker;
// =============================================================================
// Singleton Factory
// =============================================================================
/**
 * Singleton Pattern Note:
 * This uses a configurable singleton pattern rather than `createSingleton` from async-singleton.ts
 * because it requires configuration parameters on first initialization. The standard createSingleton
 * pattern uses a fixed factory function which doesn't support runtime configuration.
 *
 * Thread safety: JavaScript is single-threaded for synchronous code, so this pattern
 * is safe. The check-and-set is atomic in the JS event loop.
 */
let trackerInstance = null;
/**
 * Get the singleton WhaleActivityTracker instance.
 * Configuration is only applied on first call; subsequent calls return the existing instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton WhaleActivityTracker instance
 */
function getWhaleActivityTracker(config) {
    if (!trackerInstance) {
        trackerInstance = new WhaleActivityTracker(config);
    }
    return trackerInstance;
}
/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
function resetWhaleActivityTracker() {
    if (trackerInstance) {
        trackerInstance.reset();
    }
    trackerInstance = null;
}
//# sourceMappingURL=whale-activity-tracker.js.map