import { keccak256, parseUnits, toBytes } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import type { Address, Hex } from './types';

export const MUSD_DECIMALS = 18;
export const INVOICE_AMOUNT = parseUnits('0.01', MUSD_DECIMALS);
export const STARTING_BALANCE = parseUnits('10', MUSD_DECIMALS);
export const BASELINE_DAILY_CAP = INVOICE_AMOUNT;
export const PERIOD_SECONDS = 86_400n;
export const PAIR_COUNT = 8;

/** Same as Solidity `bytes32(keccak256(label))`, used as a private key by `vm.addr(uint256(keccak256(label)))`. */
export function labelKey(label: string): Hex {
  return keccak256(toBytes(label));
}

export function labelAddress(label: string): Address {
  return privateKeyToAddress(labelKey(label));
}

export const VENDOR_NAMES = ['Vendor 1', 'Vendor 2', 'Vendor 3'] as const;
export const VENDOR_LABELS = ['signvault.vendor1', 'signvault.vendor2', 'signvault.vendor3'] as const;
export const ATTACKER_LABEL = 'signvault.attacker';

export const VENDORS: { name: string; address: Address }[] = VENDOR_NAMES.map((name, i) => ({
  name,
  address: labelAddress(VENDOR_LABELS[i]),
}));
export const ATTACKER: Address = labelAddress(ATTACKER_LABEL);

/** Key labels for the roles in deployments/fake.json. Derive the keys with `labelKey`; never commit them. */
export const FAKE_KEY_LABELS = {
  owner: 'signvault.fake.owner',
  agent: 'signvault.fake.agent',
  operator: 'signvault.fake.operator',
} as const;
