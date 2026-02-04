/**
 * Helius Simulation Provider for Solana
 *
 * Implements transaction simulation for Solana blockchain using the Helius API.
 * Helius provides 100,000 credits/month on free tier (simulateTransaction costs 1 credit).
 *
 * Key differences from EVM simulation:
 * - Uses Solana's native simulateTransaction RPC method
 * - Tracks compute units instead of gas
 * - Handles program logs instead of EVM event logs
 * - Supports commitment levels (processed, confirmed, finalized)
 *
 * Fallback: When Helius is unavailable or rate-limited, falls back to native
 * Solana RPC simulateTransaction (less detailed but no rate limits).
 *
 * @see Phase 1: Solana Simulation Provider in enhancement plan
 * @see ADR-016: Transaction Simulation Integration (Amendment for Solana)
 */

import {
  SimulationProviderConfig,
  SimulationProviderHealth,
  SimulationRequest,
  SimulationResult,
  SimulationProviderType,
  SIMULATION_DEFAULTS,
  getSimulationErrorMessage,
} from './types';
import { BaseSimulationProvider } from './base-simulation-provider';

// =============================================================================
// Solana-Specific Types
// =============================================================================

/**
 * Solana simulation request extension.
 * Extends standard SimulationRequest with Solana-specific fields.
 */
export interface SolanaSimulationRequest extends Omit<SimulationRequest, 'transaction'> {
  /** Chain must be 'solana' */
  chain: 'solana';
  /** Serialized transaction (base64 or base58 encoded) */
  transaction: string;
  /** Commitment level for simulation */
  commitment?: 'processed' | 'confirmed' | 'finalized';
  /** Whether to replace recent blockhash (useful for simulation) */
  replaceRecentBlockhash?: boolean;
  /** Accounts to return data for after simulation */
  accountsToReturn?: string[];
  /** Minimum context slot for simulation */
  minContextSlot?: number;
}

/**
 * Solana simulation result extension.
 * Extends standard SimulationResult with Solana-specific fields.
 */
export interface SolanaSimulationResult extends SimulationResult {
  /** Solana program logs from simulation */
  programLogs?: string[];
  /** Compute units consumed */
  computeUnitsConsumed?: number;
  /** Account data changes (if requested) */
  accountChanges?: SolanaAccountChange[];
  /** Inner instructions (CPI calls) */
  innerInstructions?: SolanaInnerInstruction[];
}

/**
 * Account change from Solana simulation
 */
export interface SolanaAccountChange {
  /** Account public key */
  pubkey: string;
  /** Account data after simulation (base64 encoded) */
  data: string;
  /** Account owner program */
  owner: string;
  /** Account lamports after simulation */
  lamports: number;
  /** Whether account is executable */
  executable: boolean;
  /** Rent epoch */
  rentEpoch: number;
}

/**
 * Inner instruction from Solana simulation (CPI)
 */
export interface SolanaInnerInstruction {
  /** Index of the instruction that triggered this CPI */
  index: number;
  /** CPI instructions */
  instructions: Array<{
    programIdIndex: number;
    accounts: number[];
    data: string;
  }>;
}

// =============================================================================
// Helius Configuration
// =============================================================================

/**
 * Helius API configuration.
 *
 * Free tier: 100,000 credits/month
 * simulateTransaction: 1 credit per call
 *
 * @see https://docs.helius.dev/
 */
export const HELIUS_CONFIG = {
  /** Base URL for Helius RPC (with API key appended) */
  rpcUrlTemplate: 'https://mainnet.helius-rpc.com/?api-key={apiKey}',
  /** Enhanced transactions API URL */
  enhancedApiUrl: 'https://api.helius.xyz/v0',
  /** Free tier monthly credit limit */
  freeMonthlyCredits: 100_000,
  /** Credits per simulateTransaction call */
  creditsPerSimulation: 1,
  /** Default timeout for simulation requests */
  defaultTimeoutMs: 5000,
} as const;

/**
 * Helius provider configuration extending base config.
 */
export interface HeliusProviderConfig extends SimulationProviderConfig {
  /** Helius API key (required for Helius, optional for native RPC fallback) */
  heliusApiKey?: string;
  /** Fallback Solana RPC URL (for when Helius is unavailable) */
  fallbackRpcUrl?: string;
  /** Whether to use enhanced simulation (more detailed but costs more) */
  useEnhancedSimulation?: boolean;
  /** Default commitment level */
  defaultCommitment?: 'processed' | 'confirmed' | 'finalized';
}

// =============================================================================
// Helius Provider Implementation
// =============================================================================

/**
 * Helius simulation provider for Solana.
 *
 * Provides transaction simulation for Solana using:
 * 1. Helius RPC API (primary) - Enhanced simulation with detailed logs
 * 2. Native Solana RPC (fallback) - Basic simulation when Helius unavailable
 *
 * Hot-path optimizations:
 * - Reuses HTTP connections
 * - Caches API key in URL
 * - Minimal object allocations in simulation path
 */
export class HeliusSimulationProvider extends BaseSimulationProvider {
  readonly type: SimulationProviderType = 'helius';

  private readonly heliusApiKey: string | undefined;
  private readonly heliusRpcUrl: string | undefined;
  private readonly fallbackRpcUrl: string | undefined;
  private readonly useEnhancedSimulation: boolean;
  private readonly defaultCommitment: 'processed' | 'confirmed' | 'finalized';

  // Rate limit tracking (Helius free tier: 100K credits/month)
  private creditsUsedThisMonth = 0;
  private rateLimitResetDate: Date;
  private readonly monthlyCreditsLimit: number;

  // Fallback tracking
  private fallbackUsedCount = 0;
  private heliusUnavailableUntil = 0;

  constructor(config: HeliusProviderConfig) {
    // Override type to 'helius' (will be cast, see note below)
    super({ ...config, type: 'helius' as SimulationProviderType });

    // Helius API key is optional - will fall back to native RPC if not provided
    this.heliusApiKey = config.heliusApiKey;
    this.fallbackRpcUrl = config.fallbackRpcUrl;
    this.useEnhancedSimulation = config.useEnhancedSimulation ?? false;
    this.defaultCommitment = config.defaultCommitment ?? 'confirmed';

    // Build Helius RPC URL if API key provided
    if (this.heliusApiKey) {
      this.heliusRpcUrl = HELIUS_CONFIG.rpcUrlTemplate.replace('{apiKey}', this.heliusApiKey);
    }

    // Initialize rate limit tracking
    this.monthlyCreditsLimit = HELIUS_CONFIG.freeMonthlyCredits;
    this.rateLimitResetDate = this.getNextMonthStart();

    // Log initialization
    this.logger.info('HeliusSimulationProvider initialized', {
      chain: this.chain,
      hasHeliusApiKey: !!this.heliusApiKey,
      hasFallbackRpc: !!this.fallbackRpcUrl,
      useEnhancedSimulation: this.useEnhancedSimulation,
      defaultCommitment: this.defaultCommitment,
    });
  }

  // ===========================================================================
  // BaseSimulationProvider Abstract Method Implementation
  // ===========================================================================

  /**
   * Execute the actual simulation request.
   *
   * Priority:
   * 1. Helius RPC (if API key configured and within rate limit)
   * 2. Fallback RPC (if Helius unavailable)
   *
   * CRITICAL: This is hot-path code. Minimize allocations and async hops.
   */
  protected async executeSimulation(
    request: SimulationRequest,
    startTime: number
  ): Promise<SimulationResult> {
    // Validate this is a Solana request
    if (request.chain !== 'solana') {
      return this.createErrorResult(
        startTime,
        `HeliusSimulationProvider only supports Solana, got: ${request.chain}`
      );
    }

    // Cast to Solana request type
    const solanaRequest = request as unknown as SolanaSimulationRequest;

    // Check if we should use Helius or fallback
    const useHelius = this.shouldUseHelius();

    if (useHelius && this.heliusRpcUrl) {
      try {
        const result = await this.executeHeliusSimulation(solanaRequest, startTime);
        return result;
      } catch (error) {
        // Helius failed - mark as temporarily unavailable and try fallback
        this.heliusUnavailableUntil = Date.now() + 60000; // 1 minute cooldown
        this.logger.warn('Helius simulation failed, trying fallback', {
          error: getSimulationErrorMessage(error),
        });
      }
    }

    // Try fallback RPC
    if (this.fallbackRpcUrl) {
      this.fallbackUsedCount++;
      return this.executeFallbackSimulation(solanaRequest, startTime);
    }

    // No available providers
    return this.createErrorResult(
      startTime,
      'No Solana simulation provider available (Helius unavailable, no fallback configured)'
    );
  }

  /**
   * Health check for the provider.
   * Checks both Helius API and fallback RPC availability.
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const checks: string[] = [];
    let anyHealthy = false;

    // Check Helius
    if (this.heliusRpcUrl) {
      try {
        const response = await this.fetchWithTimeout(this.heliusRpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getHealth',
          }),
        });

        if (response.ok) {
          const data = await response.json() as { result?: string };
          if (data.result === 'ok') {
            checks.push('Helius: healthy');
            anyHealthy = true;
          } else {
            checks.push(`Helius: unhealthy (${data.result})`);
          }
        } else {
          checks.push(`Helius: error (${response.status})`);
        }
      } catch (error) {
        checks.push(`Helius: unreachable (${getSimulationErrorMessage(error)})`);
      }
    } else {
      checks.push('Helius: not configured');
    }

    // Check fallback
    if (this.fallbackRpcUrl) {
      try {
        const response = await this.fetchWithTimeout(this.fallbackRpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getHealth',
          }),
        });

        if (response.ok) {
          checks.push('Fallback RPC: healthy');
          anyHealthy = true;
        } else {
          checks.push(`Fallback RPC: error (${response.status})`);
        }
      } catch (error) {
        checks.push(`Fallback RPC: unreachable (${getSimulationErrorMessage(error)})`);
      }
    } else {
      checks.push('Fallback RPC: not configured');
    }

    return {
      healthy: anyHealthy,
      message: checks.join('; '),
    };
  }

  // ===========================================================================
  // Override: Include rate limit info in health
  // ===========================================================================

  /**
   * Get current health status including rate limit information.
   */
  override getHealth(): SimulationProviderHealth {
    this.checkRateLimitReset();

    return {
      ...super.getHealth(),
      requestsUsed: this.creditsUsedThisMonth,
      requestLimit: this.monthlyCreditsLimit,
    };
  }

  // ===========================================================================
  // Public Methods: Rate Limit Info
  // ===========================================================================

  /**
   * Get remaining credits for this month.
   */
  getRemainingCredits(): number {
    this.checkRateLimitReset();
    return Math.max(0, this.monthlyCreditsLimit - this.creditsUsedThisMonth);
  }

  /**
   * Get number of times fallback was used.
   */
  getFallbackUsedCount(): number {
    return this.fallbackUsedCount;
  }

  // ===========================================================================
  // Private Methods: Simulation Execution
  // ===========================================================================

  /**
   * Execute simulation using Helius RPC.
   */
  private async executeHeliusSimulation(
    request: SolanaSimulationRequest,
    startTime: number
  ): Promise<SolanaSimulationResult> {
    // Check rate limit before making request
    if (!this.isWithinRateLimit()) {
      throw new Error(
        `Helius rate limit exhausted (${this.creditsUsedThisMonth}/${this.monthlyCreditsLimit} credits)`
      );
    }

    const commitment = request.commitment ?? this.defaultCommitment;

    // Build simulation request
    const rpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: [
        request.transaction,
        {
          commitment,
          encoding: 'base64',
          replaceRecentBlockhash: request.replaceRecentBlockhash ?? true,
          sigVerify: false, // Skip signature verification for simulation
          accounts: request.accountsToReturn
            ? {
                addresses: request.accountsToReturn,
                encoding: 'base64',
              }
            : undefined,
          minContextSlot: request.minContextSlot,
        },
      ],
    };

    // Increment credit counter BEFORE request (Helius counts all requests)
    this.incrementCreditsCounter();

    const response = await this.fetchWithTimeout(this.heliusRpcUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcRequest),
    });

    if (!response.ok) {
      throw new Error(`Helius API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as HeliusSimulationResponse;
    return this.parseHeliusResponse(data, startTime);
  }

  /**
   * Execute simulation using fallback Solana RPC.
   */
  private async executeFallbackSimulation(
    request: SolanaSimulationRequest,
    startTime: number
  ): Promise<SolanaSimulationResult> {
    const commitment = request.commitment ?? this.defaultCommitment;

    const rpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: [
        request.transaction,
        {
          commitment,
          encoding: 'base64',
          replaceRecentBlockhash: request.replaceRecentBlockhash ?? true,
          sigVerify: false,
        },
      ],
    };

    const response = await this.fetchWithTimeout(this.fallbackRpcUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcRequest),
    });

    if (!response.ok) {
      return this.createSolanaErrorResult(
        startTime,
        `Fallback RPC error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json() as HeliusSimulationResponse;
    return this.parseHeliusResponse(data, startTime);
  }

  /**
   * Parse Helius/Solana RPC simulation response.
   */
  private parseHeliusResponse(
    data: HeliusSimulationResponse,
    startTime: number
  ): SolanaSimulationResult {
    // Check for RPC error
    if (data.error) {
      return this.createSolanaErrorResult(
        startTime,
        `RPC error: ${data.error.message || JSON.stringify(data.error)}`
      );
    }

    const result = data.result;
    if (!result) {
      return this.createSolanaErrorResult(startTime, 'No simulation result in response');
    }

    const value = result.value;

    // Check for simulation error (transaction would fail)
    const wouldRevert = value.err !== null;
    let revertReason: string | undefined;

    if (wouldRevert && value.err) {
      revertReason = this.extractRevertReason(value.err);
    }

    // Build result
    const simulationResult: SolanaSimulationResult = {
      success: true,
      wouldRevert,
      revertReason,
      provider: 'helius',
      latencyMs: Date.now() - startTime,
      // Solana-specific fields
      programLogs: value.logs ?? undefined,
      computeUnitsConsumed: value.unitsConsumed ?? undefined,
    };

    // Add account changes if present
    if (value.accounts && value.accounts.length > 0) {
      simulationResult.accountChanges = value.accounts
        .filter((acc): acc is NonNullable<typeof acc> => acc !== null)
        .map((acc) => ({
          pubkey: acc.pubkey || '',
          data: typeof acc.data === 'string' ? acc.data : acc.data?.[0] ?? '',
          owner: acc.owner || '',
          lamports: acc.lamports ?? 0,
          executable: acc.executable ?? false,
          rentEpoch: acc.rentEpoch ?? 0,
        }));
    }

    // Add inner instructions if present
    if (value.innerInstructions && value.innerInstructions.length > 0) {
      simulationResult.innerInstructions = value.innerInstructions;
    }

    return simulationResult;
  }

  /**
   * Extract human-readable revert reason from Solana error.
   */
  private extractRevertReason(err: unknown): string {
    if (typeof err === 'string') {
      return err;
    }

    if (typeof err === 'object' && err !== null) {
      // Handle InstructionError format
      if ('InstructionError' in err) {
        const instructionError = (err as { InstructionError: unknown[] }).InstructionError;
        if (Array.isArray(instructionError) && instructionError.length >= 2) {
          const [index, errorDetail] = instructionError;
          if (typeof errorDetail === 'object' && errorDetail !== null) {
            // Custom program error
            if ('Custom' in errorDetail) {
              return `Instruction ${index}: Custom error ${(errorDetail as { Custom: number }).Custom}`;
            }
            // Standard error
            return `Instruction ${index}: ${JSON.stringify(errorDetail)}`;
          }
          return `Instruction ${index}: ${errorDetail}`;
        }
      }

      // Try to stringify
      try {
        return JSON.stringify(err);
      } catch {
        return 'Unknown error';
      }
    }

    return 'Unknown error';
  }

  /**
   * Create Solana-specific error result.
   */
  private createSolanaErrorResult(startTime: number, error: string): SolanaSimulationResult {
    return {
      success: false,
      wouldRevert: false,
      error,
      provider: 'helius',
      latencyMs: Date.now() - startTime,
    };
  }

  // ===========================================================================
  // Private Methods: Rate Limiting
  // ===========================================================================

  /**
   * Check if we should use Helius (has API key, within rate limit, not in cooldown).
   */
  private shouldUseHelius(): boolean {
    if (!this.heliusApiKey || !this.heliusRpcUrl) {
      return false;
    }

    // Check cooldown from previous failure
    if (Date.now() < this.heliusUnavailableUntil) {
      return false;
    }

    // Check rate limit
    return this.isWithinRateLimit();
  }

  /**
   * Check if within monthly rate limit.
   */
  private isWithinRateLimit(): boolean {
    this.checkRateLimitReset();
    return this.creditsUsedThisMonth < this.monthlyCreditsLimit;
  }

  /**
   * Increment the credits counter.
   */
  private incrementCreditsCounter(): void {
    this.checkRateLimitReset();
    this.creditsUsedThisMonth += HELIUS_CONFIG.creditsPerSimulation;
  }

  /**
   * Check if rate limit should be reset (new month).
   */
  private checkRateLimitReset(): void {
    const now = new Date();
    if (now >= this.rateLimitResetDate) {
      this.creditsUsedThisMonth = 0;
      this.rateLimitResetDate = this.getNextMonthStart();
    }
  }

  /**
   * Get the start of the next month (UTC).
   */
  private getNextMonthStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  }
}

// =============================================================================
// Helius API Response Types
// =============================================================================

interface HeliusSimulationResponse {
  jsonrpc: string;
  id: number;
  result?: {
    context: {
      slot: number;
    };
    value: {
      err: unknown | null;
      logs: string[] | null;
      accounts: Array<{
        pubkey?: string;
        data: string | [string, string];
        owner?: string;
        lamports?: number;
        executable?: boolean;
        rentEpoch?: number;
      } | null> | null;
      unitsConsumed?: number;
      returnData?: {
        programId: string;
        data: [string, string];
      } | null;
      innerInstructions?: SolanaInnerInstruction[] | null;
    };
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a Helius simulation provider for Solana.
 *
 * @param config - Provider configuration
 * @returns HeliusSimulationProvider instance
 *
 * @example
 * ```typescript
 * const provider = createHeliusProvider({
 *   type: 'helius',
 *   chain: 'solana',
 *   provider: null as any, // Not used for Solana
 *   enabled: true,
 *   heliusApiKey: process.env.HELIUS_API_KEY,
 *   fallbackRpcUrl: process.env.SOLANA_RPC_URL,
 * });
 * ```
 */
export function createHeliusProvider(config: HeliusProviderConfig): HeliusSimulationProvider {
  return new HeliusSimulationProvider(config);
}
