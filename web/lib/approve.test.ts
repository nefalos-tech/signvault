import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { describe, expect, it } from 'vitest';
import { FAKE_KEY_LABELS, INVOICE_AMOUNT, VENDORS, labelAddress, labelKey } from '@signvault/shared';
import type { PendingChange } from '@signvault/shared';
import { MOCK_CHANGES, MOCK_STATE } from '../app/approve/fixture';
import { canApprove, changeTypedData, describeChange } from './approve';

const owner = privateKeyToAccount(labelKey(FAKE_KEY_LABELS.owner));
const state = MOCK_STATE;
const addVendor2: PendingChange = {
  id: 'c1',
  to: VENDORS[1].address,
  amount: INVOICE_AMOUNT.toString(),
  nonce: '3',
  status: 'pending',
};

describe('changeTypedData', () => {
  it('uses the spec 6.3 domain and the change as the SetPayee message', () => {
    const typed = changeTypedData(addVendor2, state);
    expect(typed.domain).toEqual({
      name: 'SignVault',
      version: '1',
      chainId: state.chainId,
      verifyingContract: state.addresses.signVault,
    });
    expect(typed.primaryType).toBe('SetPayee');
    expect(typed.message).toEqual({ to: VENDORS[1].address, amount: 10_000_000_000_000_000n, nonce: 3n });
  });

  it('gives a signature that verifies for the signer, and only for this vault and chain', async () => {
    const typed = changeTypedData(addVendor2, state);
    const signature = await owner.signTypedData(typed);

    expect(await verifyTypedData({ ...typed, address: owner.address, signature })).toBe(true);
    expect(await verifyTypedData({ ...typed, address: labelAddress(FAKE_KEY_LABELS.agent), signature })).toBe(false);

    const otherVault = changeTypedData(addVendor2, {
      ...state,
      addresses: { ...state.addresses, signVault: '0x3000000000000000000000000000000000000002' },
    });
    expect(await verifyTypedData({ ...otherVault, address: owner.address, signature })).toBe(false);

    const otherChain = changeTypedData(addVendor2, { ...state, chainId: 31337 });
    expect(await verifyTypedData({ ...otherChain, address: owner.address, signature })).toBe(false);
  });
});

describe('describeChange', () => {
  it('names a known vendor and the amount per day', () => {
    expect(describeChange(addVendor2, state.vendors)).toBe('Add Vendor 2 at 0.01 mUSD per day');
  });

  it('reads amount 0 as a removal', () => {
    expect(describeChange({ ...addVendor2, amount: '0' }, state.vendors)).toBe('Remove Vendor 2');
  });

  it('shortens an address that is not a known vendor', () => {
    const change = { ...addVendor2, to: '0x08324C0cba6EcF6AfC1A35E5E69483428bbE13dD', amount: '500000000000000000' } as const;
    expect(describeChange(change, state.vendors)).toBe('Add 0x0832…13dD at 0.5 mUSD per day');
  });
});

describe('canApprove', () => {
  it('lets the owner approve a pending change and sign again after a failed relay', () => {
    expect(canApprove('pending')).toBe(true);
    expect(canApprove('failed')).toBe(true);
  });

  it('refuses an applied change', () => {
    expect(canApprove('applied')).toBe(false);
  });
});

describe('mock fixture', () => {
  it('is one pending change, Vendor 2 at 0.01 mUSD, on deployments/fake.json pair 0', () => {
    const fake = JSON.parse(readFileSync(new URL('../../deployments/fake.json', import.meta.url), 'utf8'));
    expect(MOCK_STATE.chainId).toBe(fake.chainId);
    expect(MOCK_STATE.explorerUrl).toBe(fake.explorerUrl);
    expect(MOCK_STATE.addresses).toEqual({
      mockUsd: fake.mockUsd,
      baselineWallet: fake.pairs[0].baselineWallet,
      signVault: fake.pairs[0].signVault,
      owner: fake.owner,
      agent: fake.agent,
    });
    expect(MOCK_STATE.vendors).toEqual(fake.vendors);
    expect(MOCK_CHANGES).toHaveLength(1);
    expect(MOCK_CHANGES[0]).toMatchObject({ status: 'pending', nonce: '0' });
    expect(describeChange(MOCK_CHANGES[0], MOCK_STATE.vendors)).toBe('Add Vendor 2 at 0.01 mUSD per day');
  });
});
