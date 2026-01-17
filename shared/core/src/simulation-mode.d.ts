/**
 * Simulation Mode Module
 *
 * Generates simulated price feeds and arbitrage opportunities for local testing
 * without requiring real blockchain connections.
 *
 * Usage:
 *   Set SIMULATION_MODE=true in environment variables
 *
 * Features:
 *   - Simulated price feeds with realistic volatility
 *   - Artificial arbitrage opportunities for testing
 *   - No external dependencies required
 */
import { EventEmitter } from 'events';
export interface SimulatedPriceUpdate {
    chain: string;
    dex: string;
    pairKey: string;
    token0: string;
    token1: string;
    price: number;
    price0: number;
    price1: number;
    liquidity: number;
    volume24h: number;
    timestamp: number;
    blockNumber: number;
    isSimulated: true;
}
export interface SimulationConfig {
    /** Base volatility (percentage per update) */
    volatility: number;
    /** Update interval in milliseconds */
    updateIntervalMs: number;
    /** Probability of creating an arbitrage opportunity (0-1) */
    arbitrageChance: number;
    /** Size of arbitrage spread when created */
    arbitrageSpread: number;
    /** Chains to simulate */
    chains: string[];
    /** Token pairs to simulate */
    pairs: string[][];
    /** DEXes per chain */
    dexesPerChain: number;
}
declare const DEFAULT_CONFIG: SimulationConfig;
export declare class PriceSimulator extends EventEmitter {
    private config;
    private prices;
    private intervals;
    private running;
    private blockNumbers;
    constructor(config?: Partial<SimulationConfig>);
    private initializePrices;
    start(): void;
    stop(): void;
    private updateChainPrices;
    private emitAllPrices;
    private createPriceUpdate;
    getPrice(chain: string, dex: string, token0: string, token1: string): number | undefined;
    getAllPrices(): Map<string, number>;
    isRunning(): boolean;
}
export declare function getSimulator(config?: Partial<SimulationConfig>): PriceSimulator;
export declare function isSimulationMode(): boolean;
export { DEFAULT_CONFIG as SIMULATION_CONFIG };
//# sourceMappingURL=simulation-mode.d.ts.map