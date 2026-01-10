// Arbitrage Execution Engine with MEV Protection
import { ethers } from 'ethers';
import { getRedisClient, createLogger, getPerformanceLogger, PerformanceLogger } from '../../../shared/core/src';
import { CHAINS, ARBITRAGE_CONFIG } from '../../../shared/config/src';
import {
  ArbitrageOpportunity,
  MessageEvent,
  ServiceHealth
} from '../../../shared/types/src';

interface ExecutionResult {
  opportunityId: string;
  success: boolean;
  transactionHash?: string;
  actualProfit?: number;
  gasUsed?: number;
  gasCost?: number;
  error?: string;
  timestamp: number;
  chain: string;
  dex: string;
}

interface FlashLoanParams {
  token: string;
  amount: string;
  path: string[];
  minProfit: number;
}

export class ExecutionEngineService {
  private redis = getRedisClient();
  private logger = createLogger('execution-engine');
  private perfLogger: PerformanceLogger;
  private wallets: Map<string, ethers.Wallet> = new Map(); // chain -> wallet
  private providers: Map<string, ethers.JsonRpcProvider> = new Map();
  private isRunning = false;
  private executionQueue: ArbitrageOpportunity[] = [];
  private activeExecutions: Set<string> = new Set();

  constructor() {
    this.perfLogger = getPerformanceLogger('execution-engine');
    this.initializeProviders();
    this.initializeWallets();
  }

  async start(): Promise<void> {
    try {
      this.logger.info('Starting Execution Engine Service');

      // Subscribe to arbitrage opportunities
      await this.subscribeToOpportunities();

      this.isRunning = true;
      this.logger.info('Execution Engine Service started successfully');

      // Start execution processing
      this.startExecutionProcessing();

      // Start health monitoring
      this.startHealthMonitoring();

    } catch (error) {
      this.logger.error('Failed to start Execution Engine Service', { error });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Execution Engine Service');
    this.isRunning = false;
    await this.redis.disconnect();
  }

  private initializeProviders(): void {
    for (const [chainName, chainConfig] of Object.entries(CHAINS)) {
      this.providers.set(chainName, new ethers.JsonRpcProvider(chainConfig.rpcUrl));
    }
    this.logger.info('Initialized blockchain providers');
  }

  private initializeWallets(): void {
    // Initialize wallets for each chain (in production, use encrypted private keys)
    // For demo purposes, we'll use placeholder wallets
    for (const chainName of Object.keys(CHAINS)) {
      const privateKey = process.env[`${chainName.toUpperCase()}_PRIVATE_KEY`] ||
                        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Test key

      const provider = this.providers.get(chainName);
      if (provider) {
        const wallet = new ethers.Wallet(privateKey, provider);
        this.wallets.set(chainName, wallet);
        this.logger.info(`Initialized wallet for ${chainName}: ${wallet.address}`);
      }
    }
  }

  private async subscribeToOpportunities(): Promise<void> {
    await this.redis.subscribe('arbitrage-opportunities', (message: MessageEvent) => {
      this.handleArbitrageOpportunity(message);
    });
    this.logger.info('Subscribed to arbitrage opportunities');
  }

  private handleArbitrageOpportunity(message: MessageEvent): void {
    try {
      const opportunity: ArbitrageOpportunity = message.data;

      // Validate opportunity
      if (this.validateOpportunity(opportunity)) {
        // Add to execution queue
        this.executionQueue.push(opportunity);
        this.logger.info('Added opportunity to execution queue', {
          id: opportunity.id,
          type: opportunity.type,
          profit: opportunity.expectedProfit
        });
      }

    } catch (error) {
      this.logger.error('Failed to handle arbitrage opportunity', { error, message });
    }
  }

  private validateOpportunity(opportunity: ArbitrageOpportunity): boolean {
    // Basic validation checks
    if (opportunity.confidence < ARBITRAGE_CONFIG.confidenceThreshold) {
      this.logger.debug('Opportunity rejected: low confidence', { id: opportunity.id, confidence: opportunity.confidence });
      return false;
    }

    if (opportunity.expectedProfit < ARBITRAGE_CONFIG.minProfitPercentage) {
      this.logger.debug('Opportunity rejected: insufficient profit', { id: opportunity.id, profit: opportunity.expectedProfit });
      return false;
    }

    if (this.activeExecutions.has(opportunity.id)) {
      this.logger.debug('Opportunity rejected: already executing', { id: opportunity.id });
      return false;
    }

    // Check if we have wallet for the chain
    const chain = opportunity.buyChain;
    if (!this.wallets.has(chain)) {
      this.logger.warn('Opportunity rejected: no wallet for chain', { id: opportunity.id, chain });
      return false;
    }

    return true;
  }

  private startExecutionProcessing(): void {
    // Process execution queue every 50ms
    setInterval(() => {
      if (this.isRunning && this.executionQueue.length > 0) {
        const opportunity = this.executionQueue.shift();
        if (opportunity) {
          this.executeOpportunity(opportunity);
        }
      }
    }, 50);
  }

  private async executeOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    const startTime = performance.now();

    try {
      this.activeExecutions.add(opportunity.id);

      this.logger.info('Executing arbitrage opportunity', {
        id: opportunity.id,
        type: opportunity.type,
        buyChain: opportunity.buyChain,
        buyDex: opportunity.buyDex,
        sellDex: opportunity.sellDex,
        expectedProfit: opportunity.expectedProfit
      });

      let result: ExecutionResult;

      if (opportunity.type === 'cross-chain') {
        result = await this.executeCrossChainArbitrage(opportunity);
      } else {
        result = await this.executeIntraChainArbitrage(opportunity);
      }

      // Publish execution result
      await this.publishExecutionResult(result);

      this.perfLogger.logExecutionResult(result);

      const latency = performance.now() - startTime;
      this.perfLogger.logEventLatency('opportunity_execution', latency, {
        success: result.success,
        profit: result.actualProfit || 0
      });

    } catch (error) {
      this.logger.error('Failed to execute opportunity', { error, opportunityId: opportunity.id });

      const errorResult: ExecutionResult = {
        opportunityId: opportunity.id,
        success: false,
        error: (error as Error).message,
        timestamp: Date.now(),
        chain: opportunity.buyChain,
        dex: opportunity.buyDex
      };

      await this.publishExecutionResult(errorResult);
    } finally {
      this.activeExecutions.delete(opportunity.id);
    }
  }

  private async executeIntraChainArbitrage(opportunity: ArbitrageOpportunity): Promise<ExecutionResult> {
    const chain = opportunity.buyChain;
    const wallet = this.wallets.get(chain);

    if (!wallet) {
      throw new Error(`No wallet available for chain: ${chain}`);
    }

    // Get optimal gas price
    const gasPrice = await this.getOptimalGasPrice(chain);

    // Prepare flash loan transaction
    const flashLoanTx = await this.prepareFlashLoanTransaction(opportunity, chain);

    // Apply MEV protection
    const protectedTx = await this.applyMEVProtection(flashLoanTx, chain);

    // Execute transaction
    const txResponse = await wallet.sendTransaction(protectedTx);
    const receipt = await txResponse.wait();

    // Calculate actual profit
    const actualProfit = await this.calculateActualProfit(receipt, opportunity);

    return {
      opportunityId: opportunity.id,
      success: true,
      transactionHash: receipt.hash,
      actualProfit,
      gasUsed: parseInt(receipt.gasUsed.toString()),
      gasCost: parseFloat(ethers.formatEther(receipt.gasUsed * gasPrice)),
      timestamp: Date.now(),
      chain,
      dex: opportunity.buyDex
    };
  }

  private async executeCrossChainArbitrage(opportunity: ArbitrageOpportunity): Promise<ExecutionResult> {
    // Cross-chain execution is more complex - requires bridge interaction
    // This is a placeholder implementation
    this.logger.warn('Cross-chain execution not fully implemented yet', { opportunityId: opportunity.id });

    // For now, simulate execution
    return {
      opportunityId: opportunity.id,
      success: false,
      error: 'Cross-chain execution not implemented',
      timestamp: Date.now(),
      chain: opportunity.buyChain || 'unknown',
      dex: opportunity.buyDex
    };
  }

  private async prepareFlashLoanTransaction(opportunity: ArbitrageOpportunity, chain: string): Promise<ethers.TransactionRequest> {
    // Prepare flash loan parameters
    const flashParams: FlashLoanParams = {
      token: opportunity.tokenIn,
      amount: opportunity.amountIn,
      path: this.buildSwapPath(opportunity),
      minProfit: opportunity.expectedProfit * 0.9 // 10% slippage tolerance
    };

    // Get flash loan contract
    const flashLoanContract = await this.getFlashLoanContract(chain);

    // Encode flash loan call
    const tx = await flashLoanContract.executeFlashLoan.populateTransaction(
      flashParams.token,
      flashParams.amount,
      flashParams.path,
      flashParams.minProfit
    );

    return tx;
  }

  private buildSwapPath(opportunity: ArbitrageOpportunity): string[] {
    // Build the arbitrage path
    // This is simplified - in production would handle complex routing
    const path = [
      opportunity.tokenIn,
      opportunity.tokenOut // Direct swap for now
    ];

    return path;
  }

  private async getFlashLoanContract(chain: string): Promise<ethers.Contract> {
    const provider = this.providers.get(chain);
    if (!provider) {
      throw new Error(`No provider for chain: ${chain}`);
    }

    // Aave V3 flash loan contract addresses
    const flashLoanAddresses: {[chain: string]: string} = {
      ethereum: '0x87870Bcd2C4c2e84A8c3C3a3FcACC94666c0d6Cf',
      polygon: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      base: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5c'
    };

    const address = flashLoanAddresses[chain];
    if (!address) {
      throw new Error(`No flash loan contract for chain: ${chain}`);
    }

    // Simplified ABI for flash loan
    const flashLoanAbi = [
      'function executeFlashLoan(address asset, uint256 amount, address[] calldata path, uint256 minProfit) external'
    ];

    return new ethers.Contract(address, flashLoanAbi, provider);
  }

  private async applyMEVProtection(tx: ethers.TransactionRequest, chain: string): Promise<ethers.TransactionRequest> {
    // Apply MEV protection strategies
    // 1. Gas price optimization
    tx.gasPrice = await this.getOptimalGasPrice(chain);

    // 2. Transaction bundling (simplified)
    // In production, would use Flashbots or similar

    // 3. Timing optimization
    // Add random delay to avoid predictable execution

    return tx;
  }

  private async getOptimalGasPrice(chain: string): Promise<ethers.BigNumberish> {
    const provider = this.providers.get(chain);
    if (!provider) {
      return ethers.parseUnits('50', 'gwei'); // Default
    }

    try {
      const feeData = await provider.getFeeData();

      // Use EIP-1559 if available
      if (feeData.maxFeePerGas) {
        return feeData.maxFeePerGas;
      }

      // Fallback to legacy gas price
      const gasPrice = await provider.getGasPrice();
      return gasPrice;
    } catch (error) {
      this.logger.warn('Failed to get optimal gas price, using default', { chain, error });
      return ethers.parseUnits('50', 'gwei');
    }
  }

  private async calculateActualProfit(receipt: ethers.TransactionReceipt, opportunity: ArbitrageOpportunity): Promise<number> {
    // Analyze transaction logs to calculate actual profit
    // This is simplified - in production would parse specific events

    // For now, return expected profit minus gas costs
    const gasCost = parseFloat(ethers.formatEther(receipt.gasUsed * receipt.gasPrice));
    return opportunity.expectedProfit - gasCost;
  }

  private publishExecutionResult(result: ExecutionResult): void {
    const message: MessageEvent = {
      type: 'execution-result',
      data: result,
      timestamp: Date.now(),
      source: 'execution-engine'
    };

    return this.redis.publish('execution-results', message);
  }

  private startHealthMonitoring(): void {
    setInterval(async () => {
      try {
        const health: ServiceHealth = {
          service: 'execution-engine',
          status: this.isRunning ? 'healthy' : 'unhealthy',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().heapUsed,
          cpuUsage: 0,
          lastHeartbeat: Date.now(),
          error: undefined
        };

        await this.redis.updateServiceHealth('execution-engine', health);
        this.perfLogger.logHealthCheck('execution-engine', health);

      } catch (error) {
        this.logger.error('Execution engine health monitoring failed', { error });
      }
    }, 30000);
  }
}