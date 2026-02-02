/**
 * RPC Module
 *
 * Provides optimized RPC client utilities including:
 * - BatchProvider: JSON-RPC 2.0 batch request support
 *
 * @see RPC_DATA_OPTIMIZATION_IMPLEMENTATION_PLAN.md Phase 3
 */

export {
  BatchProvider,
  createBatchProvider,
  BATCHABLE_METHODS,
  NON_BATCHABLE_METHODS,
} from './batch-provider';

export type {
  BatchProviderConfig,
  BatchProviderStats,
  JsonRpcRequest,
  JsonRpcResponse,
} from './batch-provider';
