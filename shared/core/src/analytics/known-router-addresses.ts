/**
 * Known DEX Router Addresses
 *
 * Builds a set of known DEX router addresses from the DEXES config.
 * Used by SwapEventFilter to suppress false-positive whale alerts caused
 * by DEX router contracts appearing as swap senders in `log.topics[1]`.
 *
 * Two PancakeSwap routers (0x10ED43C... and 0x13f4EA8...) alone generated
 * 1,684 false-positive whale alerts.
 *
 * @see swap-event-filter.ts - Consumer of this module
 * @see @arbitrage/config/dexes - Source of DEX router addresses
 */

import { DEXES } from '@arbitrage/config/dexes';

// Lazy singleton cache
let cachedRouterAddresses: Set<string> | null = null;

/**
 * Get a Set of all known DEX router addresses (lowercased).
 *
 * Iterates `Object.values(DEXES)` and collects each DEX's `routerAddress`,
 * lowercased. Addresses starting with `0x00000` are skipped (stub/placeholder
 * addresses used by Mantle and Mode chains).
 *
 * The result is cached as a lazy singleton for performance.
 *
 * @returns Set of lowercased router addresses
 */
export function getKnownRouterAddresses(): Set<string> {
  if (cachedRouterAddresses) {
    return cachedRouterAddresses;
  }

  const addresses = new Set<string>();

  for (const dexes of Object.values(DEXES)) {
    for (const dex of dexes) {
      const addr = dex.routerAddress.toLowerCase();
      // Skip stub/placeholder addresses (Mantle, Mode chains)
      if (addr.startsWith('0x00000')) {
        continue;
      }
      addresses.add(addr);
    }
  }

  cachedRouterAddresses = addresses;
  return cachedRouterAddresses;
}

/**
 * Reset the cached router addresses.
 * Intended for testing only.
 */
export function _resetKnownRouterCache(): void {
  cachedRouterAddresses = null;
}
