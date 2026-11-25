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
  addresses: { mockUsd: Address; baselineWallet: Address; signVault: Address; owner: Address; agent: Address };
  vendors: { name: string; address: Address }[];
  baseline: { balance: string; dailyCap: string; spentToday: string };
  signvault: { balance: string; nonce: string; payees: { to: Address; amount: string; paidThisPeriod: boolean }[] };
  pendingChanges: PendingChange[];
  inbox: Email[];
}
