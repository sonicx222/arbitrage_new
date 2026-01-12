"use strict";
// WebSocket Manager
// Handles WebSocket connections with reconnection logic, event subscription, and message handling
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketManager = void 0;
const ws_1 = __importDefault(require("ws"));
const logger_1 = require("./logger");
class WebSocketManager {
    constructor(config) {
        this.ws = null;
        this.logger = (0, logger_1.createLogger)('websocket-manager');
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.connectionTimeoutTimer = null;
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        this.isConnected = false;
        // P2-FIX: Track if reconnection is actively in progress to prevent overlapping attempts
        this.isReconnecting = false;
        // P2-FIX: Track if manager has been explicitly disconnected
        this.isDisconnected = false;
        this.subscriptions = new Map();
        this.messageHandlers = new Set();
        this.connectionHandlers = new Set();
        this.nextSubscriptionId = 1;
        this.config = {
            reconnectInterval: 5000,
            maxReconnectAttempts: 10,
            heartbeatInterval: 30000,
            connectionTimeout: 10000,
            ...config
        };
    }
    async connect() {
        if (this.isConnecting || this.isConnected) {
            return;
        }
        this.isConnecting = true;
        // P2-FIX: Clear disconnected flag when explicitly connecting
        this.isDisconnected = false;
        return new Promise((resolve, reject) => {
            try {
                this.logger.info(`Connecting to WebSocket: ${this.config.url}`);
                this.ws = new ws_1.default(this.config.url);
                this.connectionTimeoutTimer = setTimeout(() => {
                    if (this.ws && this.ws.readyState !== ws_1.default.OPEN) {
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
                this.ws.on('message', (data) => {
                    this.handleMessage(data);
                });
                this.ws.on('error', (error) => {
                    this.clearConnectionTimeout();
                    this.logger.error('WebSocket error', { error });
                    this.isConnecting = false;
                    reject(error);
                });
                this.ws.on('close', (code, reason) => {
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
            }
            catch (error) {
                this.isConnecting = false;
                this.logger.error('Failed to create WebSocket connection', { error });
                reject(error);
            }
        });
    }
    disconnect() {
        this.logger.info('Disconnecting WebSocket');
        // P2-FIX: Set disconnected flag to prevent reconnection attempts
        this.isDisconnected = true;
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
    subscribe(subscription) {
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
    unsubscribe(subscriptionId) {
        const subscription = this.subscriptions.get(subscriptionId);
        if (subscription) {
            this.subscriptions.delete(subscriptionId);
            this.logger.debug(`Removed subscription`, { id: subscriptionId });
        }
    }
    send(message) {
        if (!this.isConnected || !this.ws) {
            throw new Error('WebSocket not connected');
        }
        try {
            const data = JSON.stringify(message);
            this.ws.send(data);
        }
        catch (error) {
            this.logger.error('Failed to send WebSocket message', { error });
            throw error;
        }
    }
    onMessage(handler) {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }
    onConnectionChange(handler) {
        this.connectionHandlers.add(handler);
        return () => this.connectionHandlers.delete(handler);
    }
    isWebSocketConnected() {
        return this.isConnected && this.ws?.readyState === ws_1.default.OPEN;
    }
    getConnectionStats() {
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
    removeAllListeners() {
        this.messageHandlers.clear();
        this.connectionHandlers.clear();
    }
    handleMessage(data) {
        try {
            const message = JSON.parse(data.toString());
            // Notify all message handlers
            this.messageHandlers.forEach(handler => {
                try {
                    handler(message);
                }
                catch (error) {
                    this.logger.error('Error in WebSocket message handler', { error });
                }
            });
        }
        catch (error) {
            this.logger.error('Failed to parse WebSocket message', { error, data: data.toString() });
        }
    }
    sendSubscription(subscription) {
        if (!this.isConnected || !this.ws)
            return;
        try {
            const message = {
                jsonrpc: '2.0',
                id: subscription.id,
                method: subscription.method,
                params: subscription.params
            };
            this.ws.send(JSON.stringify(message));
            this.logger.debug(`Sent subscription`, { id: subscription.id, method: subscription.method });
        }
        catch (error) {
            this.logger.error('Failed to send subscription', { error, subscription });
        }
    }
    resubscribe() {
        // Re-send all active subscriptions
        for (const subscription of this.subscriptions.values()) {
            this.sendSubscription(subscription);
        }
    }
    scheduleReconnection() {
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
            }
            catch (error) {
                this.isReconnecting = false;
                this.logger.error(`Reconnection attempt ${this.reconnectAttempts} failed`, { error });
                // P2-FIX: Only schedule next attempt if not disconnected
                if (!this.isDisconnected) {
                    this.scheduleReconnection();
                }
            }
        }, delay);
    }
    startHeartbeat() {
        this.stopHeartbeat(); // Clear any existing heartbeat
        this.heartbeatTimer = setInterval(() => {
            if (this.isConnected && this.ws) {
                // Send a ping or simple request to keep connection alive
                try {
                    this.ws.ping();
                }
                catch (error) {
                    this.logger.error('Failed to send heartbeat ping', { error });
                }
            }
        }, this.config.heartbeatInterval);
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    clearConnectionTimeout() {
        if (this.connectionTimeoutTimer) {
            clearTimeout(this.connectionTimeoutTimer);
            this.connectionTimeoutTimer = null;
        }
    }
    clearReconnectionTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
exports.WebSocketManager = WebSocketManager;
//# sourceMappingURL=websocket-manager.js.map