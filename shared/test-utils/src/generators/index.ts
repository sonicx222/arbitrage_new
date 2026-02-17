/**
 * Test Data Generators Index
 *
 * Centralized exports for all test data generators.
 *
 * @see ADR-009: Test Architecture — Phase 3 generators
 */

export {
  SimulatedPriceGenerator,
  createSimulatedPriceGenerator,
  generateSimplePriceSequence,
  generateArbitrageTestData,
} from './simulated-price.generator';

export type {
  PriceSequenceConfig,
  MultiDexPriceConfig,
  GeneratedPrice,
  MultiDexSnapshot,
} from './simulated-price.generator';
