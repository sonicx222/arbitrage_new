/**
 * Contract Testing Exports
 *
 * Phase 4 Testing Excellence: P3-4 Contract Testing
 *
 * @see docs/reports/TEST_OPTIMIZATION_RESEARCH_REPORT.md
 */

export {
  // Contracts
  opportunityContract,
  healthCheckContract,
  errorContract,

  // Pact helpers
  createDetectorPact,
  detectorInteractions,
  verifyDetectorProvider,
} from './detector-contract';
