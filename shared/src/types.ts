export type Hex = `0x${string}`;
export type Address = Hex;
export type WalletKind = 'baseline' | 'signvault';

export interface Email { id: string; ts: number; from: string; to: string; subject: string; body: string; }

export interface PendingChange {
  id: string; to: Address; amount: string; nonce: string;      // amount and nonce are decimal strings (wei)
  status: 'pending' | 'applied' | 'failed'; txHash?: Hex; error?: string;
}

export type RunEventKind =
  | 'run_started' | 'model_text' | 'tool_call' | 'tool_result'
  | 'email_delivered' | 'tx_sent' | 'tx_refused' | 'run_finished';

export interface RunEvent {
  id: string; runId: string; ts: number; wallet: WalletKind; kind: RunEventKind;
  text: string;                       // one plain-English line for the feed
  tool?: string; args?: unknown; result?: unknown;
  txHash?: Hex; error?: string;       // error is the Solidity error name, e.g. "NotOnTheList"
}

export interface AppState {
  chainId: number; explorerUrl: string;
  addresses: { mockUsd: Address; baselineWallet: Address; signVault: Address; owner: Address; agent: Address; mockUsdy?: Address };
  vendors: { name: string; address: Address }[];
  baseline: { balance: string; dailyCap: string; spentToday: string };
  signvault: {
    balance: string; nonce: string; payees: { to: Address; amount: string; paidThisPeriod: boolean }[];
    // Cards T2 and T3 (#57), set only on a treasury deployment. Decimal wei strings; tbillValue is convertToAssets(tbillShares).
    tbillShares?: string; tbillValue?: string; owedThisPeriod?: string;
    // Set only when the vault is a TripwireVault. usdyPrice and redemptionValue are mUSD wei per whole mUSDY (1e18 shares):
    // usdyPrice is the price the agent sees, null with no live price; simulated is true while a test price shock is on.
    tripwire?: { tripped: boolean; usdyPrice: string | null; redemptionValue: string; simulated: boolean };
  };
  pendingChanges: PendingChange[];
  inbox: Email[];
}
