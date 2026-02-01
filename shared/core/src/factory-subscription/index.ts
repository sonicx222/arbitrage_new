/**
 * Factory Subscription Module
 *
 * This module provides factory-level event subscriptions for dynamic pair discovery.
 * It enables 40-50x RPC reduction compared to individual pair subscriptions.
 *
 * @module factory-subscription
 *
 * ## Directory Structure
 *
 * ```
 * factory-subscription/
 * ├── index.ts                  - Module entry point
 * └── parsers/
 *     ├── index.ts              - Parser exports
 *     ├── types.ts              - Shared types (PairCreatedEvent)
 *     ├── utils.ts              - Hex parsing utilities
 *     ├── v2-pair-parser.ts     - Uniswap V2 parser
 *     ├── v3-pool-parser.ts     - Uniswap V3 parser
 *     ├── solidly-parser.ts     - Solidly/Velodrome parser
 *     ├── algebra-parser.ts     - Algebra parser
 *     ├── trader-joe-parser.ts  - Trader Joe LB parser
 *     ├── curve-parser.ts       - Curve parser
 *     └── balancer-v2-parser.ts - Balancer V2 parser
 * ```
 */

// =============================================================================
// Re-export all parsers
// =============================================================================

export * from './parsers';
