import type { Address } from './types';

export const setPayeeTypes = {
  SetPayee: [
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export function signVaultDomain(chainId: number, verifyingContract: Address) {
  return { name: 'SignVault', version: '1', chainId, verifyingContract } as const;
}

export interface SetPayeeRequest {
  chainId: number;
  vault: Address;
  to: Address;
  amount: bigint;
  nonce: bigint;
}

/** The full typed data for viem's `signTypedData` and `verifyTypedData`. */
export function setPayeeTypedData({ chainId, vault, to, amount, nonce }: SetPayeeRequest) {
  return {
    domain: signVaultDomain(chainId, vault),
    types: setPayeeTypes,
    primaryType: 'SetPayee',
    message: { to, amount, nonce },
  } as const;
}
