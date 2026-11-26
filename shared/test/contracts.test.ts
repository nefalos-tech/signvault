import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baselineWalletAbi, mockUsdAbi, mockUsdyAbi, signVaultAbi, tBillSignVaultAbi, tripwireVaultAbi } from '../src/abi';
import { ATTACKER, ATTACKER_LABEL, labelKey, VENDOR_LABELS, VENDORS } from '../src/scenario';

const contractsDir = new URL('../../contracts/', import.meta.url).pathname;

function forgeAbi(contract: string): unknown[] {
  const out = execFileSync('forge', ['inspect', contract, 'abi', '--json'], { cwd: contractsDir, encoding: 'utf8' });
  return JSON.parse(out);
}

function normalize(abi: readonly unknown[]): string[] {
  const strip = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(strip)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'internalType').map(([k, x]) => [k, strip(x)]))
      : v;
  return abi.map((item) => JSON.stringify(strip(item))).sort();
}

describe('abi.ts matches the Solidity sources', () => {
  it.each([
    ['IBaselineWallet', baselineWalletAbi],
    ['ISignVault', signVaultAbi],
  ] as const)('%s', (contract, abi) => {
    expect(normalize(abi)).toEqual(normalize(forgeAbi(contract)));
  });

  it.skipIf(!existsSync(`${contractsDir}src/MockUSD.sol`))('MockUSD', () => {
    expect(normalize(mockUsdAbi)).toEqual(normalize(forgeAbi('MockUSD')));
  });

  it('MockUSDY', () => {
    expect(normalize(mockUsdyAbi)).toEqual(normalize(forgeAbi('MockUSDY')));
  });

  // These two ABIs hold only what each contract adds to the one below it, so each entry must be in the contract.
  it('TBillSignVault has every entry of tBillSignVaultAbi', () => {
    expect(normalize(forgeAbi('TBillSignVault'))).toEqual(expect.arrayContaining(normalize(tBillSignVaultAbi)));
  });

  it('TripwireVault has every entry of tripwireVaultAbi', () => {
    expect(normalize(forgeAbi('TripwireVault'))).toEqual(expect.arrayContaining(normalize(tripwireVaultAbi)));
  });
});

describe('label addresses match vm.addr(uint256(keccak256(label)))', () => {
  const cast = (...args: string[]) => execFileSync('cast', args, { encoding: 'utf8' }).trim();
  const castAddress = (label: string) => cast('wallet', 'address', '--private-key', cast('keccak', label));

  it.each(VENDOR_LABELS.map((label, i) => [label, i] as const))('%s', (label, i) => {
    expect(labelKey(label)).toBe(cast('keccak', label));
    expect(VENDORS[i].address).toBe(castAddress(label));
  });

  it(ATTACKER_LABEL, () => {
    expect(ATTACKER).toBe(castAddress(ATTACKER_LABEL));
  });
});
