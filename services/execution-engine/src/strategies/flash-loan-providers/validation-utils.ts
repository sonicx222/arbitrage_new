/**
 * Flash Loan Request Validation Utilities
 *
 * Shared validation logic for flash loan providers (Aave V3, Balancer V2, SyncSwap).
 * PancakeSwap V3 has custom validation (pool whitelisting) and is excluded.
 *
 * Extracted to eliminate ~225 lines of duplicated validation code across providers.
 *
 * @see aave-v3.provider.ts
 * @see balancer-v2.provider.ts
 * @see syncswap.provider.ts
 */

import { ethers } from 'ethers';
import type { FlashLoanRequest } from './types';

/**
 * Validation result type
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a flash loan request against standard rules.
 *
 * Checks performed:
 * 1. Chain matches provider chain
 * 2. Valid asset address
 * 3. Non-zero loan amount
 * 4. Non-empty swap path
 * 5. All routers are valid addresses and approved
 * 6. Swap path forms a valid cycle (ends with same token as starts)
 * 7. First token matches flash loan asset
 *
 * @param request - Flash loan request to validate
 * @param providerChain - The chain this provider is configured for
 * @param approvedRoutersSet - Pre-computed Set of lowercase approved router addresses
 * @returns Validation result with error message if invalid
 */
export function validateFlashLoanRequest(
  request: FlashLoanRequest,
  providerChain: string,
  approvedRoutersSet: Set<string>,
): ValidationResult {
  // Check chain matches
  if (request.chain !== providerChain) {
    return {
      valid: false,
      error: `[ERR_CHAIN_MISMATCH] Request chain '${request.chain}' does not match provider chain '${providerChain}'`,
    };
  }

  // Check asset is valid address
  if (!ethers.isAddress(request.asset)) {
    return {
      valid: false,
      error: '[ERR_INVALID_ASSET] Invalid asset address',
    };
  }

  // Check amount is non-zero
  if (request.amount === 0n) {
    return {
      valid: false,
      error: '[ERR_ZERO_AMOUNT] Flash loan amount cannot be zero',
    };
  }

  // Check swap path is not empty
  if (request.swapPath.length === 0) {
    return {
      valid: false,
      error: '[ERR_EMPTY_PATH] Swap path cannot be empty',
    };
  }

  // Check all routers in path are approved
  for (const step of request.swapPath) {
    if (!ethers.isAddress(step.router)) {
      return {
        valid: false,
        error: `[ERR_INVALID_ROUTER] Invalid router address: ${step.router}`,
      };
    }

    // Only validate against approved routers if the list is non-empty
    if (approvedRoutersSet.size > 0) {
      if (!approvedRoutersSet.has(step.router.toLowerCase())) {
        return {
          valid: false,
          error: `[ERR_UNAPPROVED_ROUTER] Router not approved: ${step.router}`,
        };
      }
    }
  }

  // Check swap path forms a valid cycle (ends with same token as starts)
  const firstToken = request.swapPath[0].tokenIn;
  const lastToken = request.swapPath[request.swapPath.length - 1].tokenOut;
  if (firstToken.toLowerCase() !== lastToken.toLowerCase()) {
    return {
      valid: false,
      error: '[ERR_INVALID_CYCLE] Swap path must end with the same token it starts with',
    };
  }

  // Check first token matches asset
  if (firstToken.toLowerCase() !== request.asset.toLowerCase()) {
    return {
      valid: false,
      error: '[ERR_ASSET_MISMATCH] First swap token must match flash loan asset',
    };
  }

  return { valid: true };
}
