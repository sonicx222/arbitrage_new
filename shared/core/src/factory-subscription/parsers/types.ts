/**
 * Shared Types for Factory Event Parsers
 *
 * Contains type definitions used across all factory event parsers.
 *
 * @module factory-subscription/parsers/types
 */

import { FactoryType } from '../../../../config/src/dex-factories';

/**
 * Parsed PairCreated event data.
 * Extended to support all factory types including Curve and Balancer V2.
 */
export interface PairCreatedEvent {
  /** Token 0 address (first non-zero coin for Curve) */
  token0: string;
  /** Token 1 address (second non-zero coin for Curve) */
  token1: string;
  /** Created pair/pool address */
  pairAddress: string;
  /** Factory address that emitted the event */
  factoryAddress: string;
  /** Factory type for ABI selection */
  factoryType: FactoryType;
  /** DEX name from factory config */
  dexName: string;
  /** Block number where pair was created */
  blockNumber: number;
  /** Transaction hash */
  transactionHash: string;
  /** Optional: Fee tier (V3-style) in basis points */
  fee?: number;
  /** Optional: Stable pair flag (Solidly-style) */
  isStable?: boolean;
  /** Optional: Tick spacing (V3-style) */
  tickSpacing?: number;
  /** Optional: Bin step (Trader Joe) */
  binStep?: number;
  /** Optional: Pool ID for Balancer V2 (bytes32 as hex string) */
  poolId?: string;
  /** Optional: Balancer V2 pool specialization (0=General, 1=MinimalSwap, 2=TwoToken) */
  specialization?: number;
  /** Optional: All coins in the pool (Curve multi-asset pools) */
  coins?: string[];
  /** Optional: Amplification coefficient (Curve) */
  amplificationCoefficient?: number;
  /** Optional: Base pool address (Curve MetaPool) */
  basePool?: string;
  /** Optional: Whether this is a MetaPool (Curve) */
  isMetaPool?: boolean;
  /** Optional: Flag indicating tokens need async lookup (Balancer V2) */
  requiresTokenLookup?: boolean;
}

/**
 * Raw log structure from Ethereum events.
 * This is a minimal interface representing what we expect from log data.
 */
export interface RawEventLog {
  /** Contract address that emitted the event */
  address: string;
  /** Event topics array (topic[0] is the event signature) */
  topics: string[];
  /** ABI-encoded event data */
  data: string;
  /** Block number where event occurred */
  blockNumber: number;
  /** Transaction hash */
  transactionHash: string;
}
