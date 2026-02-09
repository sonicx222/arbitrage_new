/**
 * Flash Loan Aggregation - Application Layer Exports
 *
 * Application Layer (Clean Architecture):
 * - Use Cases (business logic orchestration)
 * - DTOs (data transfer objects)
 * - Application Services (cross-cutting concerns)
 *
 * Following Use Case Pattern:
 * - Single responsibility per use case
 * - Input/Output via DTOs
 * - Orchestrates domain services
 * - No business logic (delegates to domain)
 *
 * @see docs/CLEAN_ARCHITECTURE_DAY1_SUMMARY.md Application Layer
 */

// =============================================================================
// Use Cases
// =============================================================================

export {
  SelectProviderUseCase,
  createSelectProviderUseCase,
  type SelectProviderUseCaseDependencies,
} from './select-provider.usecase';

// =============================================================================
// DTOs (Data Transfer Objects)
// =============================================================================

export type {
  SelectProviderRequest,
  SelectProviderResponse,
  ValidateLiquidityRequest,
  ValidateLiquidityResponse,
  TrackProviderMetricsRequest,
  TrackProviderMetricsResponse,
  GetAggregatedMetricsRequest,
  GetAggregatedMetricsResponse,
} from './dtos';

export {
  toSelectProviderResponse,
  toValidateLiquidityResponse,
} from './dtos';
