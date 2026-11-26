// Server only: reads the challenge vault over RPC and keeps a tally of what it has scanned.
import { createPublicClient, getAbiItem, http, isAddressEqual } from 'viem';
import type { PublicClient } from 'viem';
import { mockUsdAbi, signVaultAbi } from '@signvault/shared';
import type { Address } from '@signvault/shared';
import { applyBatch, startTally } from './heist';
import type { OpenHeist, Tally, VaultTx } from './heist';

const CHAIN_NAMES: Record<number, string> = { 31337: 'anvil (local)', 97: 'BSC testnet' };
/** Blocks scanned per request. The page polls, so a long gap closes over several requests. */
const MAX_BLOCKS = 200n;

const transferEvent = getAbiItem({ abi: mockUsdAbi, name: 'Transfer' });
const payeeSetEvent = getAbiItem({ abi: signVaultAbi, name: 'PayeeSet' });

/** Everything the page shows, as JSON: bigints are decimal strings. */
export interface HeistView {
  chainId: number;
  chainName: string;
  explorerUrl: string | null;
  vault: Address;
  owner: Address;
  agent: Address;
  balance: string;
  payees: { to: Address; amount: string }[];
  head: string;
  scannedTo: string;
  fromBlock: string;
  refusedCount: number;
  latestRefused: { hash: string; blockNumber: string; from: Address; call: string }[];
  outsiderWei: string;
  outsiderTransfers: { hash: string; to: Address; value: string }[];
}

export type HeistRead = { ok: true; view: HeistView } | { ok: false; problem: string };

interface Watch {
  client: PublicClient;
  chainId: number;
  cash: Address;
  owner: Address;
  tally: Tally;
}

const watches = new Map<string, Watch>();
const inflight = new Map<string, Promise<HeistRead>>();

/** Scans the next blocks and returns the page's view. Concurrent callers share one scan. */
export function readHeist(cfg: OpenHeist): Promise<HeistRead> {
  const key = [cfg.rpcUrl, cfg.vault, cfg.agent, cfg.fromBlock].join('|');
  let read = inflight.get(key);
  if (read === undefined) {
    read = poll(key, cfg).finally(() => inflight.delete(key));
    inflight.set(key, read);
  }
  return read;
}

async function poll(key: string, cfg: OpenHeist): Promise<HeistRead> {
  let w = watches.get(key);
  if (w === undefined) {
    const started = await start(cfg);
    if ('problem' in started) return { ok: false, problem: started.problem };
    w = started;
    watches.set(key, w);
  }

  const head = await w.client.getBlockNumber();
  if (head > w.tally.scannedTo) {
    const from = w.tally.scannedTo + 1n;
    const to = head < from + MAX_BLOCKS - 1n ? head : from + MAX_BLOCKS - 1n;
    w.tally = applyBatch(w.tally, await scan(w, cfg.vault, from, to));
  }

  const [balance, payees] = await Promise.all([
    w.client.readContract({ address: w.cash, abi: mockUsdAbi, functionName: 'balanceOf', args: [cfg.vault] }),
    w.client.readContract({ address: cfg.vault, abi: signVaultAbi, functionName: 'payees' }),
  ]);
  const t = w.tally;
  return {
    ok: true,
    view: {
      chainId: w.chainId,
      chainName: CHAIN_NAMES[w.chainId]!,
      explorerUrl: cfg.explorerUrl,
      vault: cfg.vault,
      owner: w.owner,
      agent: cfg.agent,
      balance: balance.toString(),
      payees: payees.map((p) => ({ to: p.to, amount: p.amount.toString() })),
      head: head.toString(),
      scannedTo: t.scannedTo.toString(),
      fromBlock: cfg.fromBlock.toString(),
      refusedCount: t.refusedCount,
      latestRefused: t.latestRefused.map((r) => ({ ...r, blockNumber: r.blockNumber.toString() })),
      outsiderWei: t.outsiderWei.toString(),
      outsiderTransfers: t.outsiderTransfers.map((x) => ({ hash: x.hash, to: x.to, value: x.value.toString() })),
    },
  };
}

/** The checks that must pass before the page publishes the key, then the list the vault held at fromBlock. */
async function start(cfg: OpenHeist): Promise<Watch | { problem: string }> {
  // cacheTime 0: viem otherwise reuses the block number for 4 s, and a poll would miss the newest block.
  const client = createPublicClient({ transport: http(cfg.rpcUrl, { batch: true }), cacheTime: 0 });
  const chainId = await client.getChainId();
  if (CHAIN_NAMES[chainId] === undefined) {
    return { problem: `HEIST_RPC_URL is chain ${chainId}. The challenge runs only on anvil (31337) or BSC testnet (97).` };
  }
  const read = <F extends 'agent' | 'cash' | 'owner'>(functionName: F) =>
    client.readContract({ address: cfg.vault, abi: signVaultAbi, functionName });
  const [agent, cash, owner] = await Promise.all([read('agent'), read('cash'), read('owner')]);
  if (!isAddressEqual(agent, cfg.agent)) {
    return { problem: `HEIST_AGENT_PRIVATE_KEY is not the agent of HEIST_VAULT. The vault's agent is ${agent}.` };
  }
  // Reading at a past block needs a node that still has that state (any anvil, an archive RPC on testnet).
  const list = await client.readContract({
    address: cfg.vault, abi: signVaultAbi, functionName: 'payees', blockNumber: cfg.fromBlock,
  });
  return { client, chainId, cash, owner, tally: startTally(cfg.vault, cfg.fromBlock, list) };
}

async function scan(w: Watch, vault: Address, from: bigint, to: bigint) {
  const numbers = Array.from({ length: Number(to - from + 1n) }, (_, i) => from + BigInt(i));
  const [blocks, transferLogs, changeLogs] = await Promise.all([
    Promise.all(numbers.map((blockNumber) => w.client.getBlock({ blockNumber, includeTransactions: true }))),
    w.client.getLogs({ address: w.cash, event: transferEvent, args: { from: vault }, fromBlock: from, toBlock: to }),
    w.client.getLogs({ address: vault, event: payeeSetEvent, fromBlock: from, toBlock: to }),
  ]);
  const sent = blocks.flatMap((b) => b.transactions).filter((tx) => tx.to != null && isAddressEqual(tx.to, vault));
  const receipts = await Promise.all(sent.map((tx) => w.client.getTransactionReceipt({ hash: tx.hash })));
  const txs: VaultTx[] = sent.map((tx, i) => ({
    hash: tx.hash,
    blockNumber: tx.blockNumber,
    from: tx.from,
    to: tx.to,
    status: receipts[i]!.status,
    input: tx.input,
  }));
  return {
    toBlock: to,
    txs,
    transfers: transferLogs.map((l) => ({
      hash: l.transactionHash, blockNumber: l.blockNumber, logIndex: l.logIndex, from: l.args.from!, to: l.args.to!, value: l.args.value!,
    })),
    payeeChanges: changeLogs.map((l) => ({ blockNumber: l.blockNumber, logIndex: l.logIndex, to: l.args.to!, amount: l.args.amount! })),
  };
}
