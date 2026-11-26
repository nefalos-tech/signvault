import { readFileSync } from 'node:fs';
import { isAddress } from 'viem';
import type { Address } from './types';

export interface Deployment {
  chainId: number;
  explorerUrl: string;
  mockUsd: Address;
  owner: Address;
  agent: Address;
  operator: Address;
  vendors: { name: string; address: Address }[];
  attacker: Address;
  pairs: { baselineWallet: Address; signVault: Address }[];
  /** Cards T2 and T3: set in a treasury deployment, whose vaults sweep into this MockUSDY. */
  mockUsdy?: Address;
}

/** Reads deployments/<which>.json from the repo root. Node only: keep it out of the web bundle. */
export function loadDeployment(which: number | 'fake'): Deployment {
  const url = new URL(`../../deployments/${which}.json`, import.meta.url);
  const d = JSON.parse(readFileSync(url, 'utf8')) as Deployment;
  if (typeof d.chainId !== 'number' || !Array.isArray(d.pairs) || d.pairs.length === 0) {
    throw new Error(`${url.pathname}: missing chainId or pairs`);
  }
  const addresses = [
    d.mockUsd, d.owner, d.agent, d.operator, d.attacker,
    ...d.vendors.map((v) => v.address),
    ...d.pairs.flatMap((p) => [p.baselineWallet, p.signVault]),
    ...(d.mockUsdy === undefined ? [] : [d.mockUsdy]),
  ];
  const bad = addresses.find((a) => !isAddress(a));
  if (bad !== undefined) throw new Error(`${url.pathname}: not an address: ${bad}`);
  return d;
}
