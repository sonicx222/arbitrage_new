/**
 * Contract Testing: Detector API Contract
 *
 * Phase 4 Testing Excellence: P3-4 Contract Testing
 *
 * Defines the contract between Coordinator (consumer) and Detector (provider).
 * Uses Pact for consumer-driven contract testing.
 *
 * NOTE: Requires @pact-foundation/pact to be installed.
 * Install with: npm install --save-dev @pact-foundation/pact
 *
 * @see docs/reports/TEST_OPTIMIZATION_RESEARCH_REPORT.md
 */

import path from 'path';

// Dynamic import to handle optional dependency
let Pact: any;
let Matchers: any;

try {
  const pact = require('@pact-foundation/pact');
  Pact = pact.Pact;
  Matchers = pact.Matchers;
} catch {
  // Pact not installed - provide mock matchers for type definition
  Matchers = {
    like: (value: unknown) => value,
    eachLike: (value: unknown) => [value],
    iso8601DateTime: () => new Date().toISOString(),
    decimal: (value: number) => value,
    integer: (value: number) => value,
    string: (value: string) => value,
  };
}

const { like, eachLike, decimal, integer, string } = Matchers;

/**
 * Opportunity notification payload contract.
 */
export const opportunityContract = {
  id: string('opp-123'),
  chain: string('arbitrum'),
  buyDex: string('uniswap'),
  sellDex: string('sushiswap'),
  tokenIn: string('WETH'),
  tokenOut: string('USDC'),
  amountIn: string('1000000000000000000'),
  expectedProfit: decimal(0.015),
  profitPercentage: decimal(1.5),
  confidence: decimal(0.85),
  timestamp: integer(Date.now()),
  expiresAt: integer(Date.now() + 10000),
  route: like({
    buyPath: eachLike(string('0x...')),
    sellPath: eachLike(string('0x...')),
  }),
};

/**
 * Health check response contract.
 */
export const healthCheckContract = {
  status: string('healthy'),
  partition: string('asia-fast'),
  chains: eachLike(string('arbitrum')),
  metrics: like({
    opportunitiesDetected: integer(100),
    lastOpportunityAt: integer(Date.now()),
    uptime: integer(3600),
  }),
};

/**
 * Error response contract.
 */
export const errorContract = {
  error: string('NotFound'),
  message: string('Resource not found'),
  code: integer(404),
};

/**
 * Create Pact provider for Detector tests.
 */
export function createDetectorPact(options: {
  consumer: string;
  pactDir?: string;
}) {
  return new Pact({
    consumer: options.consumer,
    provider: 'Detector',
    port: 0, // Random port
    dir: options.pactDir || path.resolve(__dirname, '../../pacts'),
    log: path.resolve(__dirname, '../../logs/pact.log'),
    logLevel: 'warn',
    spec: 2,
  });
}

/**
 * Standard interactions for Detector API.
 */
export const detectorInteractions = {
  /**
   * Get latest opportunity interaction.
   */
  getLatestOpportunity: {
    state: 'detector has found opportunity',
    uponReceiving: 'a request for latest opportunity',
    withRequest: {
      method: 'GET',
      path: '/api/v1/opportunities/latest',
      headers: {
        Accept: 'application/json',
      },
    },
    willRespondWith: {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: opportunityContract,
    },
  },

  /**
   * Get health check interaction.
   */
  getHealth: {
    state: 'detector is running',
    uponReceiving: 'a health check request',
    withRequest: {
      method: 'GET',
      path: '/api/v1/health',
    },
    willRespondWith: {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: healthCheckContract,
    },
  },

  /**
   * Subscribe to opportunities interaction.
   */
  subscribeOpportunities: {
    state: 'detector is running',
    uponReceiving: 'a subscription request',
    withRequest: {
      method: 'POST',
      path: '/api/v1/opportunities/subscribe',
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        chains: eachLike(string('arbitrum')),
        minProfit: decimal(0.005),
      },
    },
    willRespondWith: {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        subscriptionId: string('sub-123'),
        status: string('active'),
      },
    },
  },

  /**
   * Not found error interaction.
   */
  opportunityNotFound: {
    state: 'no opportunities available',
    uponReceiving: 'a request when no opportunities exist',
    withRequest: {
      method: 'GET',
      path: '/api/v1/opportunities/latest',
    },
    willRespondWith: {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
      },
      body: errorContract,
    },
  },
};

/**
 * Verify provider against contract.
 */
export async function verifyDetectorProvider(options: {
  providerBaseUrl: string;
  pactUrls: string[];
  providerVersion?: string;
  publishVerificationResult?: boolean;
}) {
   
  const { Verifier } = require('@pact-foundation/pact');

  const verifier = new Verifier({
    provider: 'Detector',
    providerBaseUrl: options.providerBaseUrl,
    pactUrls: options.pactUrls,
    providerVersion: options.providerVersion || process.env.GIT_SHA || 'unknown',
    publishVerificationResult: options.publishVerificationResult || false,
    stateHandlers: {
      'detector has found opportunity': async () => {
        // Set up state where detector has found an opportunity
        // This would typically interact with a mock data layer
      },
      'detector is running': async () => {
        // Set up state where detector is healthy and running
      },
      'no opportunities available': async () => {
        // Set up state where no opportunities exist
      },
    },
  });

  return verifier.verifyProvider();
}
