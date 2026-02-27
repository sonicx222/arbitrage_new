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

// =============================================================================
// Type Definitions
// =============================================================================

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

// =============================================================================
// Type Guard Validators
// =============================================================================

/**
 * Validate PriceUpdate message.
 * Type guard that ensures all required fields are present and valid.
 */
export function validatePriceUpdate(
  update: PriceUpdate | null | undefined | unknown
): update is PriceUpdate {
  if (!update || typeof update !== 'object') {
    return false;
  }

  const u = update as Record<string, unknown>;

  // Required string fields
  if (typeof u.chain !== 'string' || !u.chain) return false;
  if (typeof u.dex !== 'string' || !u.dex) return false;
  if (typeof u.pairKey !== 'string' || !u.pairKey) return false;

  // Required number fields
  // L1 FIX: Reject price === 0 (defense-in-depth; zero price is never valid for trading)
  if (typeof u.price !== 'number' || isNaN(u.price) || u.price <= 0) return false;
  if (typeof u.timestamp !== 'number' || u.timestamp <= 0) return false;

  // Optional fields validation
  if (u.blockNumber !== undefined && (typeof u.blockNumber !== 'number' || u.blockNumber < 0)) {
    return false;
  }

  if (u.reserves !== undefined) {
    if (typeof u.reserves !== 'object' || u.reserves === null) return false;
    const reserves = u.reserves as Record<string, unknown>;
    if (typeof reserves.reserve0 !== 'string' || typeof reserves.reserve1 !== 'string') {
      return false;
    }
  }

  return true;
}

/**
 * Validate WhaleTransaction message.
 * Type guard that ensures all required fields are present and valid.
 */
export function validateWhaleTransaction(
  tx: WhaleTransaction | null | undefined | unknown
): tx is WhaleTransaction {
  if (!tx || typeof tx !== 'object') {
    return false;
  }

  const t = tx as Record<string, unknown>;

  // Required string fields
  if (typeof t.chain !== 'string' || !t.chain) return false;
  if (typeof t.type !== 'string' || !t.type) return false;
  if (typeof t.hash !== 'string' || !t.hash) return false;
  if (typeof t.from !== 'string' || !t.from) return false;
  if (typeof t.to !== 'string' || !t.to) return false;
  if (typeof t.value !== 'string') return false;

  // Required number field
  if (typeof t.timestamp !== 'number' || t.timestamp <= 0) return false;

  // Optional fields validation
  if (t.token !== undefined && typeof t.token !== 'string') return false;
  if (t.blockNumber !== undefined && (typeof t.blockNumber !== 'number' || t.blockNumber < 0)) {
    return false;
  }

  return true;
}

/**
 * Validate SwapEvent message.
 * Type guard that ensures all required fields are present and valid.
 */
export function validateSwapEvent(
  event: SwapEvent | null | undefined | unknown
): event is SwapEvent {
  if (!event || typeof event !== 'object') {
    return false;
  }

  const e = event as Record<string, unknown>;

  // Required string fields
  if (typeof e.chain !== 'string' || !e.chain) return false;
  if (typeof e.dex !== 'string' || !e.dex) return false;
  if (typeof e.pairAddress !== 'string' || !e.pairAddress) return false;
  if (typeof e.token0 !== 'string' || !e.token0) return false;
  if (typeof e.token1 !== 'string' || !e.token1) return false;
  if (typeof e.amount0In !== 'string') return false;
  if (typeof e.amount1In !== 'string') return false;
  if (typeof e.amount0Out !== 'string') return false;
  if (typeof e.amount1Out !== 'string') return false;
  if (typeof e.sender !== 'string' || !e.sender) return false;
  if (typeof e.to !== 'string' || !e.to) return false;
  if (typeof e.transactionHash !== 'string' || !e.transactionHash) return false;

  // Required number fields
  if (typeof e.blockNumber !== 'number' || e.blockNumber < 0) return false;
  if (typeof e.logIndex !== 'number' || e.logIndex < 0) return false;
  if (typeof e.timestamp !== 'number' || e.timestamp <= 0) return false;

  return true;
}

/**
 * Validate ReserveUpdate message.
 * Type guard that ensures all required fields are present and valid.
 */
export function validateReserveUpdate(
  update: ReserveUpdate | null | undefined | unknown
): update is ReserveUpdate {
  if (!update || typeof update !== 'object') {
    return false;
  }

  const u = update as Record<string, unknown>;

  // Required string fields
  if (typeof u.chain !== 'string' || !u.chain) return false;
  if (typeof u.dex !== 'string' || !u.dex) return false;
  if (typeof u.pairAddress !== 'string' || !u.pairAddress) return false;
  if (typeof u.reserve0 !== 'string') return false;
  if (typeof u.reserve1 !== 'string') return false;

  // Required number fields
  if (typeof u.blockNumber !== 'number' || u.blockNumber < 0) return false;
  if (typeof u.timestamp !== 'number' || u.timestamp <= 0) return false;

  return true;
}

/**
 * Validate CoordinatorCommand message.
 * Type guard that ensures all required fields are present and valid.
 */
export function validateCoordinatorCommand(
  cmd: CoordinatorCommand | null | undefined | unknown
): cmd is CoordinatorCommand {
  if (!cmd || typeof cmd !== 'object') {
    return false;
  }

  const c = cmd as Record<string, unknown>;

  // Required type field with valid values
  const validTypes = ['start', 'stop', 'pause', 'resume', 'config_update'];
  if (typeof c.type !== 'string' || !validTypes.includes(c.type)) return false;

  // Required number field
  if (typeof c.timestamp !== 'number' || c.timestamp <= 0) return false;

  // Optional fields validation
  if (c.target !== undefined && typeof c.target !== 'string') return false;
  if (c.requestId !== undefined && typeof c.requestId !== 'string') return false;
  if (c.payload !== undefined && (typeof c.payload !== 'object' || c.payload === null)) {
    return false;
  }

  return true;
}

/**
 * Validate ServiceHealthStatus message.
 * Type guard that ensures all required fields are present and valid.
 */
export function validateServiceHealthStatus(
  status: ServiceHealthStatus | null | undefined | unknown
): status is ServiceHealthStatus {
  if (!status || typeof status !== 'object') {
    return false;
  }

  const s = status as Record<string, unknown>;

  // Required string fields
  if (typeof s.serviceId !== 'string' || !s.serviceId) return false;
  if (typeof s.serviceName !== 'string' || !s.serviceName) return false;

  // Required status field with valid values
  const validStatuses = ['healthy', 'degraded', 'unhealthy'];
  if (typeof s.status !== 'string' || !validStatuses.includes(s.status)) return false;

  // Required number field
  if (typeof s.timestamp !== 'number' || s.timestamp <= 0) return false;

  // Optional fields validation
  if (s.metrics !== undefined && (typeof s.metrics !== 'object' || s.metrics === null)) {
    return false;
  }
  if (s.errors !== undefined && !Array.isArray(s.errors)) {
    return false;
  }

  return true;
}

// =============================================================================
// Validation Utilities
// =============================================================================

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
export function validateMessage<T>(
  data: unknown,
  validator: (data: unknown) => data is T,
  typeName: string
): ValidationResult<T> {
  if (validator(data)) {
    return { valid: true, data };
  }

  // Generate helpful error messages
  const errors: string[] = [];

  if (data === null) {
    errors.push(`${typeName}: received null`);
  } else if (data === undefined) {
    errors.push(`${typeName}: received undefined`);
  } else if (typeof data !== 'object') {
    errors.push(`${typeName}: expected object, got ${typeof data}`);
  } else {
    errors.push(`${typeName}: validation failed - missing or invalid required fields`);
  }

  return { valid: false, errors };
}

/**
 * Batch validate an array of messages.
 * Returns valid messages and collects errors.
 */
export function validateBatch<T>(
  messages: unknown[],
  validator: (data: unknown) => data is T,
  typeName: string
): { valid: T[]; invalidCount: number; errors: string[] } {
  const valid: T[] = [];
  const errors: string[] = [];
  let invalidCount = 0;

  for (const msg of messages) {
    const result = validateMessage(msg, validator, typeName);
    if (result.valid && result.data) {
      valid.push(result.data);
    } else {
      invalidCount++;
      if (result.errors) {
        errors.push(...result.errors);
      }
    }
  }

  return { valid, invalidCount, errors };
}

// =============================================================================
// Message Factory Functions
// =============================================================================

/**
 * Create a validated PriceUpdate message.
 * Returns null if validation fails.
 */
export function createPriceUpdate(data: Partial<PriceUpdate>): PriceUpdate | null {
  const update: PriceUpdate = {
    chain: data.chain || '',
    dex: data.dex || '',
    pairKey: data.pairKey || '',
    price: data.price ?? -1,
    timestamp: data.timestamp || Date.now(),
    blockNumber: data.blockNumber,
    reserves: data.reserves
  };

  return validatePriceUpdate(update) ? update : null;
}

/**
 * Create a validated WhaleTransaction message.
 * Returns null if validation fails.
 */
export function createWhaleTransaction(data: Partial<WhaleTransaction>): WhaleTransaction | null {
  const tx: WhaleTransaction = {
    chain: data.chain || '',
    type: data.type || '',
    hash: data.hash || '',
    from: data.from || '',
    to: data.to || '',
    value: data.value || '0',
    token: data.token,
    timestamp: data.timestamp || Date.now(),
    blockNumber: data.blockNumber
  };

  return validateWhaleTransaction(tx) ? tx : null;
}

/**
 * Create a validated CoordinatorCommand message.
 * Returns null if validation fails.
 */
export function createCoordinatorCommand(
  data: Partial<CoordinatorCommand>
): CoordinatorCommand | null {
  const cmd: CoordinatorCommand = {
    type: data.type as CoordinatorCommand['type'],
    target: data.target,
    payload: data.payload,
    timestamp: data.timestamp || Date.now(),
    requestId: data.requestId
  };

  return validateCoordinatorCommand(cmd) ? cmd : null;
}
