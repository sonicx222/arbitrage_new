// Security module exports
export {
  AuthService,
  // Singleton pattern for AuthService (FIX: avoid per-request instantiation)
  getAuthService,
  resetAuthService,
  authenticate,
  authorize,
  // Phase 4: API Key + Unified Auth
  apiAuth,
  apiAuthorize,
  initializeApiKeys,
  clearApiKeyStore,  // For testing
  validateApiKey,
  isApiKeyAuthEnabled,
  isJwtAuthEnabled,
  isAuthEnabled,
} from './auth';
export { validateArbitrageRequest, validateHealthRequest, validateMetricsRequest, validateConfigUpdate, validateLoginRequest, validateRegisterRequest, validateWebhookRequest, sanitizeInput, createRateLimitRule } from './validation';
export { RateLimiter, createApiRateLimiter, createArbitrageRateLimiter, createAuthRateLimiter, createCriticalRateLimiter } from './rate-limiter';

// Re-export types for convenience
export type { User, AuthToken, LoginRequest, RegisterRequest, ApiKeyUser, ApiKeyEntry, AuthOptions } from './auth';
export type { RateLimitInfo, RateLimitConfig } from './rate-limiter';