/**
 * Shared test helpers for BalancerV2FlashArbitrage test suites.
 *
 * Extracted from BalancerV2FlashArbitrage.test.ts and
 * BalancerV2FlashArbitrage.callback-admin.test.ts to eliminate duplication.
 *
 * @see BalancerV2FlashArbitrage.test.ts
 * @see BalancerV2FlashArbitrage.callback-admin.test.ts
 */

import { ethers } from 'hardhat';
import { BalancerV2FlashArbitrage, MockBalancerVault } from '../../typechain-types';
import { deployBaseFixture, fundProvider, type BaseFixture } from './common-setup';

/** Balancer V2 uses 10x the default funding amounts */
export const BALANCER_AMOUNTS = {
  wethPerRouter: ethers.parseEther('10000'),
  usdcPerRouter: ethers.parseUnits('10000000', 6),
  daiPerRouter: ethers.parseEther('10000000'),
};

export interface BalancerV2Fixture extends BaseFixture {
  arbitrage: BalancerV2FlashArbitrage;
  vault: MockBalancerVault;
}

/**
 * Deploy BalancerV2FlashArbitrage contract with base fixture.
 * Used with loadFixture() for snapshot/restore efficiency.
 */
export async function deployBalancerV2Fixture(): Promise<BalancerV2Fixture> {
  const base = await deployBaseFixture(BALANCER_AMOUNTS);

  // Deploy Balancer Vault and fund it for flash loans
  const MockBalancerVaultFactory = await ethers.getContractFactory('MockBalancerVault');
  const vault = await MockBalancerVaultFactory.deploy();
  await fundProvider(base, await vault.getAddress(), BALANCER_AMOUNTS);

  // Deploy BalancerV2FlashArbitrage contract
  const BalancerV2FlashArbitrageFactory = await ethers.getContractFactory('BalancerV2FlashArbitrage');
  const arbitrage = await BalancerV2FlashArbitrageFactory.deploy(
    await vault.getAddress(),
    base.owner.address
  );

  return { arbitrage, vault, ...base };
}
