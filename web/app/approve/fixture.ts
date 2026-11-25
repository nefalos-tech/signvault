import {
  BASELINE_DAILY_CAP,
  FAKE_KEY_LABELS,
  INVOICE_AMOUNT,
  STARTING_BALANCE,
  VENDORS,
  labelAddress,
} from '@signvault/shared';
import type { AppState, PendingChange } from '@signvault/shared';

/** One pending change on deployments/fake.json pair 0: add Vendor 2 at 0.01 mUSD. */
export const MOCK_CHANGES: PendingChange[] = [
  { id: 'mock-1', to: VENDORS[1].address, amount: INVOICE_AMOUNT.toString(), nonce: '0', status: 'pending' },
];

export const MOCK_STATE: AppState = {
  chainId: 97,
  explorerUrl: 'https://testnet.bscscan.com',
  addresses: {
    mockUsd: '0x1000000000000000000000000000000000000001',
    baselineWallet: '0x2000000000000000000000000000000000000001',
    signVault: '0x3000000000000000000000000000000000000001',
    owner: labelAddress(FAKE_KEY_LABELS.owner),
    agent: labelAddress(FAKE_KEY_LABELS.agent),
  },
  vendors: VENDORS,
  baseline: { balance: STARTING_BALANCE.toString(), dailyCap: BASELINE_DAILY_CAP.toString(), spentToday: '0' },
  signvault: {
    balance: STARTING_BALANCE.toString(),
    nonce: '0',
    payees: [{ to: VENDORS[0].address, amount: INVOICE_AMOUNT.toString(), paidThisPeriod: false }],
  },
  pendingChanges: MOCK_CHANGES,
  inbox: [],
};
