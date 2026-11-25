import type { Address, AppState, Email, Hex, PendingChange, RunEvent } from './types';

export type TxResult = { ok: true; txHash: Hex } | { ok: false; error: string; txHash?: Hex };

export interface ChainPort {
  readState(): Promise<Pick<AppState, 'chainId' | 'explorerUrl' | 'addresses' | 'vendors' | 'baseline' | 'signvault'>>;
  baselinePay(to: Address, amount: bigint): Promise<TxResult>;        // agent key
  baselineSetDailyCap(newCap: bigint): Promise<TxResult>;             // operator key
  vaultPay(to: Address): Promise<TxResult>;                           // agent key
  vaultSetPayee(to: Address, amount: bigint, approval: Hex, as: 'agent' | 'operator'): Promise<TxResult>;
  nextPair(): Promise<void>;                                          // move to a fresh wallet pair
}

export interface InboxPort {
  list(): Email[]; get(id: string): Email | undefined;
  deliver(e: Omit<Email, 'id' | 'ts'>): Email; clear(): void;
}

export interface EventsPort {
  emit(e: Omit<RunEvent, 'id' | 'ts'>): RunEvent;
  recent(n: number): RunEvent[];
  subscribe(fn: (e: RunEvent) => void): () => void;
}

export interface ProviderPort {                 // the baseline wallet's backend
  requestCapChange(newCap: bigint): Promise<void>;        // emails a 6-digit code to the inbox
  confirmCapChange(code: string): Promise<TxResult>;      // right code: operator calls setDailyCap
}

export interface ApprovalsPort {                // SignVault rule changes
  request(to: Address, amount: bigint): Promise<PendingChange>;   // emails a notice with no code
  list(): PendingChange[];
  approve(id: string, signature: Hex): Promise<PendingChange>;    // relays setPayee as the operator
}

export interface LlmPort {
  next(messages: unknown[], tools: unknown[]): Promise<{ text?: string; toolCalls: { id: string; name: string; args: unknown }[] }>;
}
