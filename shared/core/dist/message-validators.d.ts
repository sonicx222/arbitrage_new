/**
 * Shared Message Validation Utilities
 *
 * REF-2 FIX: Centralized validation for message types used across services.
 * Eliminates duplicate validation logic and ensures consistent type checking.
 *
 * Used by:
 * - cross-chain-detector/detector.ts (PriceUpdate, WhaleTransaction validation)
 * - unified-detector/chain-instance.ts (swap event validation)
 * - coordinator/coordinator.ts (command validation)
 *
 * @see ARCHITECTURE_V2.md Section 4.2 (Message Types)
 */
/**
 * Price update message from price feeds.
 */
export interface PriceUpdate {
    chain: string;
    dex: string;
    pairKey: string;
    price: number;
    timestamp: number;
    blockNumber?: number;
    reserves?: {
        reserve0: string;
        reserve1: string;
    };
}
/**
 * Whale transaction alert message.
 */
export interface WhaleTransaction {
    chain: string;
    type: string;
    hash: string;
    from: string;
    to: string;
    value: string;
    token?: string;
    timestamp: number;
    blockNumber?: number;
}
/**
 * Swap event from DEX.
 */
export interface SwapEvent {
    chain: string;
    dex: string;
    pairAddress: string;
    token0: string;
    token1: string;
    amount0In: string;
    amount1In: string;
    amount0Out: string;
    amount1Out: string;
    sender: string;
    to: string;
    blockNumber: number;
    transactionHash: string;
    logIndex: number;
    timestamp: number;
}
/**
 * Reserve update from liquidity pool.
 */
export interface ReserveUpdate {
    chain: string;
    dex: string;
    pairAddress: string;
    reserve0: string;
    reserve1: string;
    blockNumber: number;
    timestamp: number;
}
/**
 * Coordinator command message.
 */
export interface CoordinatorCommand {
    type: 'start' | 'stop' | 'pause' | 'resume' | 'config_update';
    target?: string;
    payload?: Record<string, unknown>;
    timestamp: number;
    requestId?: string;
}
/**
 * Service health status message.
 */
export interface ServiceHealthStatus {
    serviceId: string;
    serviceName: string;
    status: 'healthy' | 'degraded' | 'unhealthy';
    timestamp: number;
    metrics?: Record<string, number>;
    errors?: string[];
}
/**
 * Validate PriceUpdate message.
 * Type guard that ensures all required fields are present and valid.
 */
export declare function validatePriceUpdate(update: PriceUpdate | null | undefined | unknown): update is PriceUpdate;
/**
 * Validate WhaleTransaction message.
 * Type guard that ensures all required fields are present and valid.
 */
export declare function validateWhaleTransaction(tx: WhaleTransaction | null | undefined | unknown): tx is WhaleTransaction;
/**
 * Validate SwapEvent message.
 * Type guard that ensures all required fields are present and valid.
 */
export declare function validateSwapEvent(event: SwapEvent | null | undefined | unknown): event is SwapEvent;
/**
 * Validate ReserveUpdate message.
 * Type guard that ensures all required fields are present and valid.
 */
export declare function validateReserveUpdate(update: ReserveUpdate | null | undefined | unknown): update is ReserveUpdate;
/**
 * Validate CoordinatorCommand message.
 * Type guard that ensures all required fields are present and valid.
 */
export declare function validateCoordinatorCommand(cmd: CoordinatorCommand | null | undefined | unknown): cmd is CoordinatorCommand;
/**
 * Validate ServiceHealthStatus message.
 * Type guard that ensures all required fields are present and valid.
 */
export declare function validateServiceHealthStatus(status: ServiceHealthStatus | null | undefined | unknown): status is ServiceHealthStatus;
/**
 * Generic validation result type.
 */
export interface ValidationResult<T> {
    valid: boolean;
    data?: T;
    errors?: string[];
}
/**
 * Validate and cast unknown data to a typed message.
 * Returns validation result with errors if invalid.
 */
export declare function validateMessage<T>(data: unknown, validator: (data: unknown) => data is T, typeName: string): ValidationResult<T>;
/**
 * Batch validate an array of messages.
 * Returns valid messages and collects errors.
 */
export declare function validateBatch<T>(messages: unknown[], validator: (data: unknown) => data is T, typeName: string): {
    valid: T[];
    invalidCount: number;
    errors: string[];
};
/**
 * Create a validated PriceUpdate message.
 * Returns null if validation fails.
 */
export declare function createPriceUpdate(data: Partial<PriceUpdate>): PriceUpdate | null;
/**
 * Create a validated WhaleTransaction message.
 * Returns null if validation fails.
 */
export declare function createWhaleTransaction(data: Partial<WhaleTransaction>): WhaleTransaction | null;
/**
 * Create a validated CoordinatorCommand message.
 * Returns null if validation fails.
 */
export declare function createCoordinatorCommand(data: Partial<CoordinatorCommand>): CoordinatorCommand | null;
//# sourceMappingURL=message-validators.d.ts.map