/**
 * Swap Path Construction Helpers
 *
 * Builder functions for the SwapStep[] arrays used in arbitrage execution.
 * Replaces 127+ occurrences of inline path construction across test files.
 *
 * @see performance-refactor.md Refactoring #3: Extract Swap Path Builders
 */
import { ethers } from 'hardhat';

// =============================================================================
// Types
// =============================================================================

export interface SwapStep {
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountOutMin: bigint;
}

// =============================================================================
// Path Builders
// =============================================================================

/**
 * Build a 2-hop arbitrage path: tokenA -> tokenB -> tokenA
 *
 * This is the most common pattern: borrow asset, swap to intermediate,
 * swap back to original asset with profit.
 *
 * @param routerAddr - Router address (same router for both legs)
 * @param tokenA - First token address (flash loan asset)
 * @param tokenB - Second token address (intermediate)
 * @param amountOutMin1 - Minimum output for leg 1 (0n for no slippage check)
 * @param amountOutMin2 - Minimum output for leg 2 (0n for no slippage check)
 */
export function build2HopPath(
  routerAddr: string,
  tokenA: string,
  tokenB: string,
  amountOutMin1: bigint = 0n,
  amountOutMin2: bigint = 0n,
): SwapStep[] {
  return [
    { router: routerAddr, tokenIn: tokenA, tokenOut: tokenB, amountOutMin: amountOutMin1 },
    { router: routerAddr, tokenIn: tokenB, tokenOut: tokenA, amountOutMin: amountOutMin2 },
  ];
}

/**
 * Build a 2-hop path across two different routers.
 *
 * @param router1Addr - Router for first leg
 * @param router2Addr - Router for second leg
 * @param tokenA - First token address
 * @param tokenB - Second token address
 * @param amountOutMin1 - Minimum output for leg 1
 * @param amountOutMin2 - Minimum output for leg 2
 */
export function build2HopCrossRouterPath(
  router1Addr: string,
  router2Addr: string,
  tokenA: string,
  tokenB: string,
  amountOutMin1: bigint = 0n,
  amountOutMin2: bigint = 0n,
): SwapStep[] {
  return [
    { router: router1Addr, tokenIn: tokenA, tokenOut: tokenB, amountOutMin: amountOutMin1 },
    { router: router2Addr, tokenIn: tokenB, tokenOut: tokenA, amountOutMin: amountOutMin2 },
  ];
}

/**
 * Build a 3-hop triangular arbitrage path: A -> B -> C -> A
 *
 * @param router1Addr - Router for legs 1 and 2
 * @param router2Addr - Router for leg 3
 * @param tokenA - Start/end token
 * @param tokenB - First intermediate
 * @param tokenC - Second intermediate
 * @param amountOutMins - Minimum outputs per leg (defaults to 0)
 */
export function build3HopPath(
  router1Addr: string,
  router2Addr: string,
  tokenA: string,
  tokenB: string,
  tokenC: string,
  amountOutMins: [bigint, bigint, bigint] = [0n, 0n, 0n],
): SwapStep[] {
  return [
    { router: router1Addr, tokenIn: tokenA, tokenOut: tokenB, amountOutMin: amountOutMins[0] },
    { router: router1Addr, tokenIn: tokenB, tokenOut: tokenC, amountOutMin: amountOutMins[1] },
    { router: router2Addr, tokenIn: tokenC, tokenOut: tokenA, amountOutMin: amountOutMins[2] },
  ];
}

/**
 * Get a deadline timestamp N seconds from now.
 * Most tests use 300 seconds (5 minutes).
 */
export async function getDeadline(seconds: number = 300): Promise<number> {
  const block = await ethers.provider.getBlock('latest');
  return block!.timestamp + seconds;
}
