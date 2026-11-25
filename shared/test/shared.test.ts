import { verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { loadDeployment } from '../src/deployments';
import { setPayeeTypedData } from '../src/eip712';
import {
  ATTACKER, BASELINE_DAILY_CAP, FAKE_KEY_LABELS, INVOICE_AMOUNT, labelAddress, labelKey,
  PAIR_COUNT, STARTING_BALANCE, VENDORS,
} from '../src/scenario';

describe('scenario', () => {
  it('has the spec 4 amounts in wei', () => {
    expect(INVOICE_AMOUNT).toBe(10_000_000_000_000_000n);
    expect(STARTING_BALANCE).toBe(10_000_000_000_000_000_000n);
    expect(BASELINE_DAILY_CAP).toBe(INVOICE_AMOUNT);
  });
});

describe('deployments/fake.json', () => {
  const d = loadDeployment('fake');

  it('derives its roles from FAKE_KEY_LABELS', () => {
    expect(d.owner).toBe(labelAddress(FAKE_KEY_LABELS.owner));
    expect(d.agent).toBe(labelAddress(FAKE_KEY_LABELS.agent));
    expect(d.operator).toBe(labelAddress(FAKE_KEY_LABELS.operator));
  });

  it('uses the scenario vendors and attacker, and has every pair', () => {
    expect(d.vendors).toEqual(VENDORS);
    expect(d.attacker).toBe(ATTACKER);
    expect(d.pairs).toHaveLength(PAIR_COUNT);
  });
});

describe('setPayeeTypedData', () => {
  const d = loadDeployment('fake');
  const owner = privateKeyToAccount(labelKey(FAKE_KEY_LABELS.owner));
  const request = { chainId: d.chainId, vault: d.pairs[0].signVault, to: VENDORS[1].address, amount: INVOICE_AMOUNT, nonce: 0n };

  it('round-trips an owner signature through viem', async () => {
    const signature = await owner.signTypedData(setPayeeTypedData(request));
    expect(await verifyTypedData({ address: d.owner, signature, ...setPayeeTypedData(request) })).toBe(true);
  });

  it('binds the signature to the nonce and the vault', async () => {
    const signature = await owner.signTypedData(setPayeeTypedData(request));
    const replay = setPayeeTypedData({ ...request, nonce: 1n });
    const otherVault = setPayeeTypedData({ ...request, vault: d.pairs[1].signVault });
    expect(await verifyTypedData({ address: d.owner, signature, ...replay })).toBe(false);
    expect(await verifyTypedData({ address: d.owner, signature, ...otherVault })).toBe(false);
  });
});
