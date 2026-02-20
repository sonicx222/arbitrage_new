/**
 * Shared test helpers for CommitRevealArbitrage test suites.
 *
 * Extracted from CommitRevealArbitrage.test.ts, CommitRevealArbitrage.security.test.ts,
 * and CommitRevealArbitrage.execution.test.ts to eliminate duplication.
 *
 * @see CommitRevealArbitrage.test.ts
 * @see CommitRevealArbitrage.security.test.ts
 * @see CommitRevealArbitrage.execution.test.ts
 */

import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';
import { CommitRevealArbitrage } from '../../typechain-types';
import { deployBaseFixture } from './common-setup';

/**
 * Deploy CommitRevealArbitrage contract with base fixture.
 * Used with loadFixture() for snapshot/restore efficiency.
 */
export async function deployCommitRevealFixture() {
  const base = await deployBaseFixture();

  // Deploy CommitRevealArbitrage contract (no flash loan provider needed)
  const CommitRevealArbitrageFactory = await ethers.getContractFactory('CommitRevealArbitrage');
  const commitRevealArbitrage = await CommitRevealArbitrageFactory.deploy(base.owner.address);

  // Fund user with tokens for direct arbitrage
  await base.weth.mint(base.user.address, ethers.parseEther('100'));

  return { commitRevealArbitrage, ...base };
}

/**
 * Create commitment hash matching the Solidity implementation.
 * keccak256(abi.encodePacked(msg.sender, abi.encode(params)))
 */
export function createCommitmentHash(
  sender: string,
  asset: string,
  amountIn: bigint,
  swapPath: any[],
  minProfit: bigint,
  deadline: number,
  salt: string
): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['tuple(address asset, uint256 amountIn, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline, bytes32 salt)'],
    [[asset, amountIn, swapPath, minProfit, deadline, salt]]
  );
  // Match Solidity: keccak256(abi.encodePacked(msg.sender, abi.encode(params)))
  const packed = ethers.solidityPacked(['address', 'bytes'], [sender, encoded]);
  return ethers.keccak256(packed);
}

/**
 * Mine a specified number of blocks (for testing time-based logic).
 */
export async function mineBlocks(count: number): Promise<void> {
  await mine(count);
}
