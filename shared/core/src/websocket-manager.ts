// WebSocket Manager
// Handles WebSocket connections with reconnection logic, event subscription, and message handling

import WebSocket from 'ws';
import { createLogger } from './logger';

export interface WebSocketConfig {
  url: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number;
  connectionTimeout?: number;
}

export interface WebSocketSubscription {
  id: number;
  method: string;
  params: any[];
  type?: string; // Optional subscription type (e.g., 'logs', 'newHeads', 'sync')
  topics?: string[]; // Optional topics for log subscriptions
  callback?: (data: any) => void; // Optional callback for subscription results
}

export interface WebSocketMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

export type WebSocketEventHandler = (data: WebSocketMessage) => void;
export type ConnectionStateHandler = (connected: boolean) => void;
export type ErrorEventHandler = (error: Error) => void;
export type GenericEventHandler = (...args: any[]) => void;

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private config: WebSocketConfig;
  private logger = createLogger('websocket-manager');

  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectionTimeoutTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isConnecting = false;
  private isConnected = false;
  // P2-FIX: Track if reconnection is actively in progress to prevent overlapping attempts
  private isReconnecting = false;
  // P2-FIX: Track if manager has been explicitly disconnected
  private isDisconnected = false;
  // P1-FIX: Connection mutex to prevent TOCTOU race condition
  private connectMutex: Promise<void> | null = null;

  private subscriptions = new Map<number, WebSocketSubscription>();
  private messageHandlers = new Set<WebSocketEventHandler>();
  private connectionHandlers = new Set<ConnectionStateHandler>();
  private errorHandlers = new Set<ErrorEventHandler>();
  private eventHandlers = new Map<string, Set<GenericEventHandler>>();

  private nextSubscriptionId = 1;

  constructor(config: WebSocketConfig) {
    this.config = {
      reconnectInterval: 5000,
      maxReconnectAttempts: 10,
      heartbeatInterval: 30000,
      connectionTimeout: 10000,
      ...config
    };
  }

  async connect(): Promise<void> {
    // P1-FIX: Use mutex to prevent TOCTOU race condition
    // If a connection is already in progress, wait for it instead of starting a new one
    if (this.connectMutex) {
      return this.connectMutex;
    }

    if (this.isConnected) {
      return;
    }

    // Create mutex promise before any async operations
    let resolveMutex: () => void;
    this.connectMutex = new Promise<void>((resolve) => {
      resolveMutex = resolve;
    });

    this.isConnecting = true;
    // P2-FIX: Clear disconnected flag when explicitly connecting
    this.isDisconnected = false;

    const connectionPromise = new Promise<void>((resolve, reject) => {
      try {
        this.logger.info(`Connecting to WebSocket: ${this.config.url}`);

        this.ws = new WebSocket(this.config.url);

        this.connectionTimeoutTimer = setTimeout(() => {
          if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
            this.ws.close();
            reject(new Error('WebSocket connection timeout'));
          }
        }, this.config.connectionTimeout);

        this.ws.on('open', () => {
          this.clearConnectionTimeout();
          this.logger.info('WebSocket connected');
          this.isConnecting = false;
          this.isConnected = true;
          this.reconnectAttempts = 0;

          // Start heartbeat
          this.startHeartbeat();

          // Re-subscribe to existing subscriptions
          this.resubscribe();

          // Notify connection handlers
          this.connectionHandlers.forEach(handler => handler(true));

          resolve();
        });

        this.ws.on('message', (data: Buffer) => {
          this.handleMessage(data);
        });

        this.ws.on('error', (error) => {
          this.clearConnectionTimeout();
          this.logger.error('WebSocket error', { error });
          this.isConnecting = false;
          // Notify error handlers
          this.errorHandlers.forEach(handler => {
            try {
              handler(error as Error);
            } catch (handlerError) {
              this.logger.error('Error in error handler', { handlerError });
            }
          });
          reject(error);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          this.clearConnectionTimeout();
          this.logger.warn('WebSocket closed', { code, reason: reason.toString() });
          this.isConnecting = false;
          this.isConnected = false;

          // Stop heartbeat
          this.stopHeartbeat();

          // Notify connection handlers
          this.connectionHandlers.forEach(handler => handler(false));

          // Attempt reconnection if not manually closed
          if (code !== 1000) {
            this.scheduleReconnection();
          }
        });

      } catch (error) {
        this.isConnecting = false;
        this.logger.error('Failed to create WebSocket connection', { error });
        reject(error);
      }
    });

    // P1-FIX: Wrap promise to clear mutex when done (success or failure)
    try {
      await connectionPromise;
    } finally {
      this.connectMutex = null;
      resolveMutex!();
    }
  }

  disconnect(): void {
    this.logger.info('Disconnecting WebSocket');

    // P2-FIX: Set disconnected flag to prevent reconnection attempts
    this.isDisconnected = true;
    // P1-FIX: Clear connection mutex on disconnect
    this.connectMutex = null;

    // Clear timers
    this.clearReconnectionTimer();
    this.clearConnectionTimeout();
    this.stopHeartbeat();

    // Close connection
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    // P0-2 fix: Clear handler sets to prevent memory leaks
    this.messageHandlers.clear();
    this.connectionHandlers.clear();
    this.subscriptions.clear();

    this.isConnected = false;
    this.isConnecting = false;
    // P2-FIX: Reset reconnection state
    this.isReconnecting = false;
  }

  subscribe(subscription: Omit<WebSocketSubscription, 'id'>): number {
    const id = this.nextSubscriptionId++;
    const fullSubscription = { ...subscription, id };

    this.subscriptions.set(id, fullSubscription);

    // Send subscription if connected
    if (this.isConnected && this.ws) {
      this.sendSubscription(fullSubscription);
    }

    this.logger.debug(`Added subscription`, { id, method: subscription.method });
    return id;
  }

  unsubscribe(subscriptionId: number): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription) {
      this.subscriptions.delete(subscriptionId);
      this.logger.debug(`Removed subscription`, { id: subscriptionId });
    }
  }

  send(message: WebSocketMessage): void {
    if (!this.isConnected || !this.ws) {
      throw new Error('WebSocket not connected');
    }

    try {
      const data = JSON.stringify(message);
      this.ws.send(data);
    } catch (error) {
      this.logger.error('Failed to send WebSocket message', { error });
      throw error;
    }
  }

  onMessage(handler: WebSocketEventHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onConnectionChange(handler: ConnectionStateHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /**
   * Event emitter-style API for subscribing to WebSocket events.
   * Supports: 'message', 'error', 'connected', 'disconnected'
   */
  on(event: string, handler: GenericEventHandler): () => void {
    if (event === 'message') {
      this.messageHandlers.add(handler as WebSocketEventHandler);
      return () => this.messageHandlers.delete(handler as WebSocketEventHandler);
    }
    if (event === 'error') {
      this.errorHandlers.add(handler as ErrorEventHandler);
      return () => this.errorHandlers.delete(handler as ErrorEventHandler);
    }
    if (event === 'connected' || event === 'disconnected') {
      const wrappedHandler: ConnectionStateHandler = (connected: boolean) => {
        if ((event === 'connected' && connected) || (event === 'disconnected' && !connected)) {
          handler();
        }
      };
      this.connectionHandlers.add(wrappedHandler);
      return () => this.connectionHandlers.delete(wrappedHandler);
    }
    // Generic event handler
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
    return () => this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Emit an event to all registered handlers.
   */
  private emit(event: string, ...args: any[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(...args);
        } catch (error) {
          this.logger.error(`Error in event handler for ${event}`, { error });
        }
      });
    }
  }

  isWebSocketConnected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  getConnectionStats(): any {
    return {
      connected: this.isConnected,
      connecting: this.isConnecting,
      reconnectAttempts: this.reconnectAttempts,
      subscriptions: this.subscriptions.size,
      readyState: this.ws?.readyState
    };
  }

  /**
   * P0-2 fix: Public method to clear all handlers.
   * Call this before stopping to prevent memory leaks from stale handlers.
   */
  removeAllListeners(): void {
    this.messageHandlers.clear();
    this.connectionHandlers.clear();
    this.errorHandlers.clear();
    this.eventHandlers.clear();
  }

  private handleMessage(data: Buffer): void {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString());

      // Notify all message handlers
      this.messageHandlers.forEach(handler => {
        try {
          handler(message);
        } catch (error) {
          this.logger.error('Error in WebSocket message handler', { error });
        }
      });

    } catch (error) {
      this.logger.error('Failed to parse WebSocket message', { error, data: data.toString() });
    }
  }

  private sendSubscription(subscription: WebSocketSubscription): void {
    if (!this.isConnected || !this.ws) return;

    try {
      const message = {
        jsonrpc: '2.0',
        id: subscription.id,
        method: subscription.method,
        params: subscription.params
      };

      this.ws.send(JSON.stringify(message));
      this.logger.debug(`Sent subscription`, { id: subscription.id, method: subscription.method });
    } catch (error) {
      this.logger.error('Failed to send subscription', { error, subscription });
    }
  }

  private resubscribe(): void {
    // Re-send all active subscriptions
    for (const subscription of this.subscriptions.values()) {
      this.sendSubscription(subscription);
    }
  }

  private scheduleReconnection(): void {
    // P2-FIX: Don't reconnect if explicitly disconnected
    if (this.isDisconnected) {
      this.logger.debug('Skipping reconnection - manager was explicitly disconnected');
      return;
    }

    // P2-FIX: Don't schedule if already reconnecting or timer exists
    if (this.reconnectTimer || this.isReconnecting) {
      return;
    }

    if (this.reconnectAttempts >= (this.config.maxReconnectAttempts || 10)) {
      this.logger.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectInterval || 5000;

    this.logger.info(`Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);

    this.reconnectTimer = setTimeout(async () => {
      // P2-FIX: Clear timer reference immediately and set reconnecting flag
      this.reconnectTimer = null;

      // P2-FIX: Check if we were disconnected while waiting
      if (this.isDisconnected) {
        this.logger.debug('Aborting reconnection - manager was disconnected during wait');
        return;
      }

      this.isReconnecting = true;

      try {
        await this.connect();
        this.isReconnecting = false;
      } catch (error) {
        this.isReconnecting = false;
        this.logger.error(`Reconnection attempt ${this.reconnectAttempts} failed`, { error });

        // P2-FIX: Only schedule next attempt if not disconnected
        if (!this.isDisconnected) {
          this.scheduleReconnection();
        }
      }
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat(); // Clear any existing heartbeat

    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected && this.ws) {
        // Send a ping or simple request to keep connection alive
        try {
          this.ws.ping();
        } catch (error) {
          this.logger.error('Failed to send heartbeat ping', { error });
        }
      }
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeoutTimer) {
      clearTimeout(this.connectionTimeoutTimer);
      this.connectionTimeoutTimer = null;
    }
  }

  private clearReconnectionTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}