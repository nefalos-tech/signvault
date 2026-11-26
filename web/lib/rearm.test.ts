import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { describe, expect, it } from 'vitest';
import { FAKE_KEY_LABELS, labelAddress, labelKey } from '@signvault/shared';
import { MOCK_STATE } from '../app/approve/fixture';
import { rearmRequest } from './rearm';

const owner = privateKeyToAccount(labelKey(FAKE_KEY_LABELS.owner));
const state = { ...MOCK_STATE, signvault: { ...MOCK_STATE.signvault, nonce: '4' } };

describe('rearmRequest', () => {
  it("is Rearm over the vault's current nonce, on the vault's own domain", () => {
    const typed = rearmRequest(state);
    expect(typed.domain).toEqual({ name: 'SignVault', version: '1', chainId: state.chainId, verifyingContract: state.addresses.signVault });
    expect(typed.primaryType).toBe('Rearm');
    expect(typed.message).toEqual({ nonce: 4n });
  });

  it('gives a signature that verifies for the owner, and not once the nonce has moved', async () => {
    const signature = await owner.signTypedData(rearmRequest(state));
    expect(await verifyTypedData({ ...rearmRequest(state), address: owner.address, signature })).toBe(true);
    expect(await verifyTypedData({ ...rearmRequest(state), address: labelAddress(FAKE_KEY_LABELS.agent), signature })).toBe(false);
    const moved = { ...state, signvault: { ...state.signvault, nonce: '5' } };
    expect(await verifyTypedData({ ...rearmRequest(moved), address: owner.address, signature })).toBe(false);
  });
});
