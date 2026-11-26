// The open challenge page (card T4): its settings and the tally it reads from the chain.
// Pure: web/lib/heist-chain.ts does the RPC calls and feeds the results through applyBatch.
import { decodeFunctionData, isAddress, isAddressEqual, isHex, size, slice } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signVaultAbi } from '@signvault/shared';
import type { Address, Hex } from '@signvault/shared';

/** How many refusals the page lists. All of them are counted. */
export const LATEST = 20;

export type HeistConfig =
  | { kind: 'closed' }
  | { kind: 'broken'; problem: string }
  | {
      kind: 'open';
      vault: Address;
      rpcUrl: string;
      explorerUrl: string | null;
      agentKey: Hex;
      agent: Address;
      bountyUsd: number;
      /** Scanning starts after this block. Set it to the vault's deployment block. */
      fromBlock: bigint;
    };
export type OpenHeist = Extract<HeistConfig, { kind: 'open' }>;

/**
 * Reads the HEIST_* settings. Closed unless HEIST_OPEN is exactly "1": opening is a person's decision.
 * Only the HEIST_* names are read. The demo's AGENT_PRIVATE_KEY is looked at for one thing: to refuse to publish it.
 */
export function heistConfig(env: Record<string, string | undefined>): HeistConfig {
  if (env.HEIST_OPEN !== '1') return { kind: 'closed' };
  const broken = (problem: string): HeistConfig => ({ kind: 'broken', problem });

  const { HEIST_VAULT: vault, HEIST_RPC_URL: rpcUrl, HEIST_AGENT_PRIVATE_KEY: key, HEIST_BOUNTY_USD: bounty, HEIST_FROM_BLOCK: from } = env;
  if (!vault || !isAddress(vault)) return broken('HEIST_VAULT is missing or not an address.');
  if (!rpcUrl) return broken('HEIST_RPC_URL is missing.');
  if (!key || !isHex(key) || size(key) !== 32) return broken('HEIST_AGENT_PRIVATE_KEY is missing or not a 32-byte hex key.');
  if (env.AGENT_PRIVATE_KEY && env.AGENT_PRIVATE_KEY.toLowerCase() === key.toLowerCase()) {
    return broken('HEIST_AGENT_PRIVATE_KEY is the demo agent key. The challenge needs a key of its own.');
  }
  const bountyUsd = Number(bounty);
  if (!bounty || !Number.isFinite(bountyUsd) || bountyUsd <= 0) return broken('HEIST_BOUNTY_USD is missing or not a positive number.');
  if (!from || !/^\d+$/.test(from)) return broken('HEIST_FROM_BLOCK is missing or not a block number.');

  return {
    kind: 'open',
    vault,
    rpcUrl,
    explorerUrl: env.HEIST_EXPLORER_URL ? env.HEIST_EXPLORER_URL.replace(/\/+$/, '') : null,
    agentKey: key,
    agent: privateKeyToAccount(key).address,
    bountyUsd,
    fromBlock: BigInt(from),
  };
}

/** A transaction sent to the vault, with its receipt status. */
export interface VaultTx {
  hash: Hex;
  blockNumber: bigint;
  from: Address;
  to: Address | null;
  status: 'success' | 'reverted';
  input: Hex;
}

/** A MockUSD Transfer log. */
export interface TokenTransfer {
  hash: Hex;
  blockNumber: bigint;
  logIndex: number;
  from: Address;
  to: Address;
  value: bigint;
}

/** A PayeeSet log from the vault. Amount 0 removes the payee. */
export interface PayeeChange {
  blockNumber: bigint;
  logIndex: number;
  to: Address;
  amount: bigint;
}

/** Everything read for the blocks up to `toBlock`. */
export interface ScanBatch {
  toBlock: bigint;
  txs: VaultTx[];
  transfers: TokenTransfer[];
  payeeChanges: PayeeChange[];
}

export interface RefusedAttempt {
  hash: Hex;
  blockNumber: bigint;
  from: Address;
  call: string;
}

export interface Tally {
  vault: Address;
  /** Every block up to and including this one is counted. */
  scannedTo: bigint;
  /** The payee list as of `scannedTo`, keyed by lowercase address. */
  list: ReadonlyMap<string, bigint>;
  refusedCount: number;
  /** Newest first, at most LATEST. */
  latestRefused: RefusedAttempt[];
  outsiderWei: bigint;
  outsiderTransfers: TokenTransfer[];
}

/** A tally that starts after `fromBlock`, with the list the vault held at that block. */
export function startTally(vault: Address, fromBlock: bigint, list: readonly { to: Address; amount: bigint }[]): Tally {
  return {
    vault,
    scannedTo: fromBlock,
    list: new Map(list.map((p) => [p.to.toLowerCase(), p.amount])),
    refusedCount: 0,
    latestRefused: [],
    outsiderWei: 0n,
    outsiderTransfers: [],
  };
}

/**
 * Adds a batch to the tally. Anything at or below `scannedTo` is already counted and is skipped,
 * so applying the same range twice changes nothing.
 */
export function applyBatch(t: Tally, b: ScanBatch): Tally {
  const isNew = (x: { blockNumber: bigint }) => x.blockNumber > t.scannedTo && x.blockNumber <= b.toBlock;

  const refused = b.txs
    .filter((x) => isNew(x) && x.status === 'reverted' && x.to !== null && isAddressEqual(x.to, t.vault))
    .sort((x, y) => Number(x.blockNumber - y.blockNumber))
    .map((x): RefusedAttempt => ({ hash: x.hash, blockNumber: x.blockNumber, from: x.from, call: describeCall(x.input) }));

  // Replay list changes and transfers out in chain order, so each transfer is checked against the list at that moment.
  type Step = { blockNumber: bigint; logIndex: number } & ({ change: PayeeChange } | { transfer: TokenTransfer });
  const steps: Step[] = [
    ...b.payeeChanges.filter(isNew).map((c) => ({ blockNumber: c.blockNumber, logIndex: c.logIndex, change: c })),
    ...b.transfers
      .filter((x) => isNew(x) && isAddressEqual(x.from, t.vault))
      .map((x) => ({ blockNumber: x.blockNumber, logIndex: x.logIndex, transfer: x })),
  ].sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : Number(x.blockNumber - y.blockNumber)));

  const list = new Map(t.list);
  let outsiderWei = t.outsiderWei;
  const outsiderTransfers = [...t.outsiderTransfers];
  for (const step of steps) {
    if ('change' in step) {
      const key = step.change.to.toLowerCase();
      if (step.change.amount === 0n) list.delete(key);
      else list.set(key, step.change.amount);
    } else if (!list.has(step.transfer.to.toLowerCase())) {
      outsiderWei += step.transfer.value;
      outsiderTransfers.push(step.transfer);
    }
  }

  return {
    vault: t.vault,
    scannedTo: b.toBlock > t.scannedTo ? b.toBlock : t.scannedTo,
    list,
    refusedCount: t.refusedCount + refused.length,
    latestRefused: [...refused.reverse(), ...t.latestRefused].slice(0, LATEST),
    outsiderWei,
    outsiderTransfers,
  };
}

/** "pay(0x…)" for a vault call. Anyone can send the vault anything, so other data is named, never thrown on. */
export function describeCall(input: Hex): string {
  if (size(input) === 0) return 'no call data';
  try {
    const { functionName, args } = decodeFunctionData({ abi: signVaultAbi, data: input });
    return `${functionName}(${(args ?? []).map(String).join(', ')})`;
  } catch {
    return `unknown call ${size(input) >= 4 ? slice(input, 0, 4) : input}`;
  }
}
