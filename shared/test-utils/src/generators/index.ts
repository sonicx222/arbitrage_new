/**
 * Test Data Generators Index
 *
 * Centralized exports for all test data generators.
 *
 * @see docs/research/INTEGRATION_TEST_COVERAGE_REPORT.md Phase 3
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
