// Polygon DEX Detector Service
import { ethers } from 'ethers';
import WebSocket from 'ws';
import { getRedisClient, RedisClient, createLogger, getPerformanceLogger, PerformanceLogger } from '../../../shared/core/src';
import { CHAINS, DEXES, CORE_TOKENS, ARBITRAGE_CONFIG, EVENT_CONFIG } from '../../../shared/config/src';
import {
  Dex,
  Token,
  PriceUpdate,
  ArbitrageOpportunity,
  SwapEvent,
  MessageEvent,
  Pair
} from '../../../shared/types/src';

export class PolygonDetectorService {
  private provider: ethers.JsonRpcProvider;
  private wsProvider: WebSocket | null = null;
  private redis = getRedisClient();
  private logger = createLogger('polygon-detector');
  private perfLogger: PerformanceLogger;
  private dexes: Dex[];
  private tokens: Token[];
  private pairs: Map<string, Pair> = new Map();
  private monitoredPairs: Set<string> = new Set();
  private isRunning = false;

  constructor() {
    this.perfLogger = getPerformanceLogger('polygon-detector');
    this.dexes = DEXES.polygon;
    this.tokens = CORE_TOKENS.polygon;
    this.provider = new ethers.JsonRpcProvider(CHAINS.polygon.rpcUrl);
  }

  async start(): Promise<void> {
      this.logger.info('Starting detector service');

      // Initialize Redis client
      await this.initializeRedis();

      // Initialize pairs
      this.logger.info('Starting Polygon detector service');

      await this.initializePairs();
      await this.connectWebSocket();
      await this.subscribeToEvents();

      this.isRunning = true;
      this.logger.info('Polygon detector service started successfully');

      this.startHealthMonitoring();

    } catch (error) {
      this.logger.error('Failed to start Polygon detector service', { error });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Polygon detector service');
    this.isRunning = false;

    if (this.wsProvider) {
      this.wsProvider.close();
      this.wsProvider = null;
    }

    await this.redis!.disconnect();
  }

  private async initializePairs(): Promise<void> {
    this.logger.info('Initializing Polygon trading pairs');

    for (const dex of this.dexes) {
      for (let i = 0; i < this.tokens.length; i++) {
        for (let j = i + 1; j < this.tokens.length; j++) {
          const token0 = this.tokens[i];
          const token1 = this.tokens[j];

            const factoryContract = new ethers.Contract(
              dex.factoryAddress,
              ['function getPair(address,address) view returns (address)'],
              this.provider
            );

            const pairAddress = await factoryContract.getPair(token0.address, token1.address);

            if (pairAddress !== ethers.ZeroAddress) {
              const pairKey = `${dex.name}_${token0.symbol}_${token1.symbol}`;
              const pair: Pair = {
                address: pairAddress,
                token0,
                token1,
                dex,
                reserve0: '0',
                reserve1: '0',
                blockNumber: 0,
                lastUpdate: 0
              };

              this.pairs.set(pairKey, pair);
              this.monitoredPairs.add(pairAddress);

              this.logger.debug(`Added Polygon pair: ${pairKey} at ${pairAddress}`);
            }
          } catch (error) {
            this.logger.warn(`Failed to initialize pair ${token0.symbol}-${token1.symbol} on ${dex.name}`, { error });
          }
        }
      }
    }

    this.logger.info(`Initialized ${this.pairs.size} Polygon trading pairs`);
  }

  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
        const wsUrl = CHAINS.polygon.wsUrl;
        this.logger.info(`Connecting to Polygon WebSocket: ${wsUrl}`);

        this.wsProvider = new WebSocket(wsUrl);

        this.wsProvider.on('open', () => {
          this.logger.info('Polygon WebSocket connected');
          resolve();
        });

        this.wsProvider.on('message', (data: Buffer) => {
          this.handleWebSocketMessage(data);
        });

        this.wsProvider.on('error', (error) => {
          this.logger.error('Polygon WebSocket error', { error });
          reject(error);
        });

        this.wsProvider.on('close', () => {
          this.logger.warn('Polygon WebSocket closed, attempting reconnection');
          if (this.isRunning) {
            setTimeout(() => this.connectWebSocket(), 5000);
          }
        });

      } catch (error) {
        this.logger.error('Failed to connect to Polygon WebSocket', { error });
        reject(error);
      }
    });
  }

  private async subscribeToEvents(): Promise<void> {
    if (!this.wsProvider) {
      throw new Error('WebSocket not connected');
    }

    if (EVENT_CONFIG.syncEvents.enabled) {
      const syncSubscription = {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_subscribe',
        params: [
          'logs',
          {
            topics: [
              '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
            ],
            address: Array.from(this.monitoredPairs)
          }
        ]
      };

      this.wsProvider.send(JSON.stringify(syncSubscription));
      this.logger.info(`Subscribed to Sync events for ${this.monitoredPairs.size} Polygon pairs`);
    }

    if (EVENT_CONFIG.swapEvents.enabled) {
      const swapSubscription = {
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_subscribe',
        params: [
          'logs',
          {
            topics: [
              '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822e',
            ],
            address: Array.from(this.monitoredPairs)
          }
        ]
      };

      this.wsProvider.send(JSON.stringify(swapSubscription));
      this.logger.info(`Subscribed to Swap events for ${this.monitoredPairs.size} Polygon pairs`);
    }
  }

  private handleWebSocketMessage(data: Buffer): void {
      const message = JSON.parse(data.toString());

      if (message.method === 'eth_subscription') {
        const { result } = message;
        this.processLogEvent(result);
      }
    } catch (error) {
      this.logger.error('Failed to process Polygon WebSocket message', { error, data: data.toString() });
    }
  }

  private async processLogEvent(log: any): Promise<void> {
    const startTime = performance.now();

      const pair = Array.from(this.pairs.values()).find(p => p.address.toLowerCase() === log.address.toLowerCase());
      if (!pair) {
        return;
      }

      if (log.topics[0] === '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1') {
        await this.processSyncEvent(log, pair);
      } else if (log.topics[0] === '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822e') {
        await this.processSwapEvent(log, pair);
      }

      const latency = performance.now() - startTime;
      this.perfLogger.logEventLatency('log_processing', latency, {
        pair: `${pair.token0.symbol}-${pair.token1.symbol}`,
        dex: pair.dex.name,
        eventType: log.topics[0]
      });

    } catch (error) {
      this.logger.error('Failed to process Polygon log event', { error, pair: log.address });
    }
  }

  private async processSyncEvent(log: any, pair: Pair): Promise<void> {
      const decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint112', 'uint112'],
        log.data
      );

      const reserve0 = decodedData[0].toString();
      const reserve1 = decodedData[1].toString();
      const blockNumber = parseInt(log.blockNumber, 16);

      pair.reserve0 = reserve0;
      pair.reserve1 = reserve1;
      pair.blockNumber = blockNumber;
      pair.lastUpdate = Date.now();

      const price = this.calculatePrice(pair);

      const priceUpdate: PriceUpdate = {
        pairKey: `${pair.dex.name}_${pair.token0.symbol}_${pair.token1.symbol}`,
        dex: pair.dex.name,
        chain: 'polygon',
        token0: pair.token0.symbol,
        token1: pair.token1.symbol,
        price,
        reserve0,
        reserve1,
        blockNumber,
        timestamp: Date.now(),
        latency: 0
      };

      await this.publishPriceUpdate(priceUpdate);
      await this.checkIntraDexArbitrage(pair);

    } catch (error) {
      this.logger.error('Failed to process Polygon sync event', { error, pair: pair.address });
    }
  }

  private async processSwapEvent(log: any, pair: Pair): Promise<void> {
      const decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint256', 'uint256', 'uint256', 'uint256'],
        log.data
      );

      const amount0In = decodedData[0].toString();
      const amount1In = decodedData[1].toString();
      const amount0Out = decodedData[2].toString();
      const amount1Out = decodedData[3].toString();

      const usdValue = await this.estimateUsdValue(pair, amount0In, amount1In, amount0Out, amount1Out);

      if (usdValue < EVENT_CONFIG.swapEvents.minAmountUSD) {
        if (Math.random() > EVENT_CONFIG.swapEvents.samplingRate) {
          return;
        }
      }

      const swapEvent: SwapEvent = {
        pairAddress: pair.address,
        sender: '0x' + log.topics[1].slice(26),
        recipient: '0x' + log.topics[2].slice(26),
        amount0In,
        amount1In,
        amount0Out,
        amount1Out,
        to: '0x' + log.topics[2].slice(26),
        blockNumber: parseInt(log.blockNumber, 16),
        transactionHash: log.transactionHash,
        timestamp: Date.now(),
        dex: pair.dex.name,
        chain: 'polygon',
        usdValue
      };

      await this.publishSwapEvent(swapEvent);
      await this.checkWhaleActivity(swapEvent);

    } catch (error) {
      this.logger.error('Failed to process Polygon swap event', { error, pair: pair.address });
    }
  }

  private calculatePrice(pair: Pair): number {
      const reserve0 = parseFloat(pair.reserve0);
      const reserve1 = parseFloat(pair.reserve1);

      if (reserve0 === 0 || reserve1 === 0) return 0;

      return reserve0 / reserve1;
    } catch (error) {
      this.logger.error('Failed to calculate Polygon price', { error, pair });
      return 0;
    }
  }

  private async checkIntraDexArbitrage(pair: Pair): Promise<void> {
    const opportunities: ArbitrageOpportunity[] = [];
    // Implementation will be enhanced with WebAssembly engine later

    if (opportunities.length > 0) {
      for (const opportunity of opportunities) {
        await this.publishArbitrageOpportunity(opportunity);
        this.perfLogger.logArbitrageOpportunity(opportunity);
      }
    }
  }

  private async checkWhaleActivity(swapEvent: SwapEvent): Promise<void> {
    if (!swapEvent.usdValue || swapEvent.usdValue < 50000) return; // $50K threshold for Polygon

    const whaleTransaction = {
      transactionHash: swapEvent.transactionHash,
      address: swapEvent.sender,
      token: swapEvent.amount0In > swapEvent.amount1In ? 'token0' : 'token1',
      amount: Math.max(parseFloat(swapEvent.amount0In), parseFloat(swapEvent.amount1In)),
      usdValue: swapEvent.usdValue,
      direction: swapEvent.amount0In > swapEvent.amount1In ? 'sell' : 'buy',
      dex: swapEvent.dex,
      chain: swapEvent.chain,
      timestamp: swapEvent.timestamp,
      impact: await this.calculatePriceImpact(swapEvent)
    };

    await this.publishWhaleTransaction(whaleTransaction);
  }

  private async estimateUsdValue(pair: Pair, amount0In: string, amount1In: string, amount0Out: string, amount1Out: string): Promise<number> {
    if (pair.token0.symbol === 'WMATIC' || pair.token1.symbol === 'WMATIC') {
      const maticPrice = 1.5; // Approximate MATIC price in USD
      const amount = Math.max(parseFloat(amount0In), parseFloat(amount1In), parseFloat(amount0Out), parseFloat(amount1Out));
      return (amount / 1e18) * maticPrice;
    }
    return 0;
  }

  private async calculatePriceImpact(swapEvent: SwapEvent): Promise<number> {
    return 0.02; // 2% default
  }

  private async publishPriceUpdate(update: PriceUpdate): Promise<void> {
    const message: MessageEvent = {
      type: 'price-update',
      data: update,
      timestamp: Date.now(),
      source: 'polygon-detector'
    };

    await this.redis!.publish('price-updates', message);
  }

  private async publishSwapEvent(swapEvent: SwapEvent): Promise<void> {
    const message: MessageEvent = {
      type: 'swap-event',
      data: swapEvent,
      timestamp: Date.now(),
      source: 'polygon-detector'
    };

    await this.redis!.publish('swap-events', message);
  }

  private async publishArbitrageOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    const message: MessageEvent = {
      type: 'arbitrage-opportunity',
      data: opportunity,
      timestamp: Date.now(),
      source: 'polygon-detector'
    };

    await this.redis!.publish('arbitrage-opportunities', message);
  }

  private async publishWhaleTransaction(whaleTransaction: any): Promise<void> {
    const message: MessageEvent = {
      type: 'whale-transaction',
      data: whaleTransaction,
      timestamp: Date.now(),
      source: 'polygon-detector'
    };

    await this.redis!.publish('whale-transactions', message);
  }

  private startHealthMonitoring(): void {
    setInterval(async () => {
        const health = {
          service: 'polygon-detector',
          status: (this.isRunning ? 'healthy' : 'unhealthy') as 'healthy' | 'degraded' | 'unhealthy',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().heapUsed,
          cpuUsage: 0,
          lastHeartbeat: Date.now(),
          pairs: this.pairs.size,
          websocket: this.wsProvider?.readyState === WebSocket.OPEN
        };

        await this.redis!.updateServiceHealth('polygon-detector', health);
        this.perfLogger.logHealthCheck('polygon-detector', health);

      } catch (error) {
        this.logger.error('Polygon health monitoring failed', { error });
      }
    }, 30000);
  }
}