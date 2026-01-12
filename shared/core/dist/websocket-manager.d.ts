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
export declare class WebSocketManager {
    private ws;
    private config;
    private logger;
    private reconnectTimer;
    private heartbeatTimer;
    private connectionTimeoutTimer;
    private reconnectAttempts;
    private isConnecting;
    private isConnected;
    private isReconnecting;
    private isDisconnected;
    private subscriptions;
    private messageHandlers;
    private connectionHandlers;
    private nextSubscriptionId;
    constructor(config: WebSocketConfig);
    connect(): Promise<void>;
    disconnect(): void;
    subscribe(subscription: Omit<WebSocketSubscription, 'id'>): number;
    unsubscribe(subscriptionId: number): void;
    send(message: WebSocketMessage): void;
    onMessage(handler: WebSocketEventHandler): () => void;
    onConnectionChange(handler: ConnectionStateHandler): () => void;
    isWebSocketConnected(): boolean;
    getConnectionStats(): any;
    /**
     * P0-2 fix: Public method to clear all handlers.
     * Call this before stopping to prevent memory leaks from stale handlers.
     */
    removeAllListeners(): void;
    private handleMessage;
    private sendSubscription;
    private resubscribe;
    private scheduleReconnection;
    private startHeartbeat;
    private stopHeartbeat;
    private clearConnectionTimeout;
    private clearReconnectionTimer;
}
//# sourceMappingURL=websocket-manager.d.ts.map