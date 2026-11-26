import { encodeFunctionData, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { signVaultAbi } from '@signvault/shared';
import type { Address, Hex } from '@signvault/shared';
import { applyBatch, describeCall, heistConfig, startTally } from './heist';
import type { PayeeChange, ScanBatch, TokenTransfer, VaultTx } from './heist';

const vault = getAddress('0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0');
const vendor1 = getAddress('0x63c4e507e171ca1fd9a3638502ee278c16d04b2c');
const vendor2 = getAddress('0xe0c855b40fbc11530989c2205b5c723848ba9e3a');
const stranger = getAddress('0x08324c0cba6ecf6afc1a35e5e69483428bbe13dd');
const agent = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
const CENT = 10n ** 16n;

let nextHash = 1;
const hash = (): Hex => `0x${(nextHash++).toString(16).padStart(64, '0')}`;

function tx(blockNumber: bigint, status: VaultTx['status'], extra: Partial<VaultTx> = {}): VaultTx {
  return {
    hash: hash(),
    blockNumber,
    from: agent,
    to: vault,
    status,
    input: encodeFunctionData({ abi: signVaultAbi, functionName: 'pay', args: [stranger] }),
    ...extra,
  };
}

function transfer(blockNumber: bigint, logIndex: number, to: Address, value = CENT): TokenTransfer {
  return { hash: hash(), blockNumber, logIndex, from: vault, to, value };
}

function batch(toBlock: bigint, parts: Partial<Omit<ScanBatch, 'toBlock'>>): ScanBatch {
  return { toBlock, txs: [], transfers: [], payeeChanges: [], ...parts };
}

const fresh = () => startTally(vault, 100n, [{ to: vendor1, amount: CENT }]);

describe('refused attempts', () => {
  it('counts reverted transactions sent to the vault and nothing else', () => {
    const t = applyBatch(fresh(), batch(105n, {
      txs: [
        tx(101n, 'reverted'),
        tx(102n, 'success'),
        tx(103n, 'reverted', { to: stranger }),
        tx(104n, 'reverted', { to: null }),
        // RPC results may come back lowercase.
        tx(105n, 'reverted', { to: vault.toLowerCase() as Address }),
      ],
    }));
    expect(t.refusedCount).toBe(2);
  });

  it('lists the latest refusals newest first, with the call they tried', () => {
    const t = applyBatch(fresh(), batch(102n, { txs: [tx(101n, 'reverted'), tx(102n, 'reverted', { input: '0x' })] }));
    expect(t.latestRefused.map((r) => r.blockNumber)).toEqual([102n, 101n]);
    expect(t.latestRefused[1]!.call).toBe(`pay(${stranger})`);
  });

  it('keeps only the latest 20 refusals but counts them all', () => {
    const txs = Array.from({ length: 25 }, (_, i) => tx(101n + BigInt(i), 'reverted'));
    const t = applyBatch(fresh(), batch(125n, { txs }));
    expect(t.refusedCount).toBe(25);
    expect(t.latestRefused).toHaveLength(20);
    expect(t.latestRefused[0]!.blockNumber).toBe(125n);
  });

  it('does not count a block twice when a range is applied again', () => {
    const b = batch(102n, { txs: [tx(101n, 'reverted'), tx(102n, 'reverted')] });
    const once = applyBatch(fresh(), b);
    const twice = applyBatch(once, b);
    expect(twice.refusedCount).toBe(2);
    expect(twice.scannedTo).toBe(102n);
  });

  it('gives the same result scanned in two ranges or in one', () => {
    const txs = [tx(101n, 'reverted'), tx(150n, 'reverted'), tx(200n, 'reverted')];
    const whole = applyBatch(fresh(), batch(200n, { txs }));
    const split = applyBatch(applyBatch(fresh(), batch(150n, { txs: txs.slice(0, 2) })), batch(200n, { txs }));
    expect(split.refusedCount).toBe(whole.refusedCount);
    expect(split.latestRefused).toEqual(whole.latestRefused);
  });

  it('ignores the start block itself', () => {
    expect(applyBatch(fresh(), batch(101n, { txs: [tx(100n, 'reverted')] })).refusedCount).toBe(0);
  });
});

describe('mUSD that left to an address not on the list', () => {
  it('is zero when every transfer out goes to a listed payee', () => {
    const t = applyBatch(fresh(), batch(110n, { transfers: [transfer(101n, 0, vendor1), transfer(110n, 3, vendor1)] }));
    expect(t.outsiderWei).toBe(0n);
  });

  it('adds up transfers out to addresses not on the list', () => {
    const t = applyBatch(fresh(), batch(110n, { transfers: [transfer(101n, 0, stranger, 5n), transfer(102n, 0, stranger, 7n)] }));
    expect(t.outsiderWei).toBe(12n);
    expect(t.outsiderTransfers).toHaveLength(2);
  });

  it('ignores mUSD coming into the vault', () => {
    const incoming: TokenTransfer = { ...transfer(101n, 0, vault), from: stranger };
    expect(applyBatch(fresh(), batch(101n, { transfers: [incoming] })).outsiderWei).toBe(0n);
  });

  it('follows the list as the owner changes it, in log order', () => {
    const added: PayeeChange = { blockNumber: 105n, logIndex: 1, to: vendor2, amount: CENT };
    const removed: PayeeChange = { blockNumber: 108n, logIndex: 0, to: vendor1, amount: 0n };
    const t = applyBatch(fresh(), batch(110n, {
      payeeChanges: [removed, added],
      transfers: [
        transfer(105n, 0, vendor2, 1n), // before vendor2 was added in the same block: not on the list
        transfer(105n, 2, vendor2, 2n), // after: on the list
        transfer(107n, 0, vendor1, 4n), // vendor1 still listed
        transfer(109n, 0, vendor1, 8n), // vendor1 removed at 108
      ],
    }));
    expect(t.outsiderWei).toBe(1n + 8n);
    expect(t.list.get(vendor1.toLowerCase())).toBeUndefined();
    expect(t.list.get(vendor2.toLowerCase())).toBe(CENT);
  });
});

describe('describeCall', () => {
  it('names the vault function and its arguments', () => {
    expect(describeCall(encodeFunctionData({ abi: signVaultAbi, functionName: 'pay', args: [stranger] }))).toBe(`pay(${stranger})`);
    const set = encodeFunctionData({ abi: signVaultAbi, functionName: 'setPayee', args: [stranger, 5n, '0x1234'] });
    expect(describeCall(set)).toBe(`setPayee(${stranger}, 5, 0x1234)`);
  });

  it('survives call data that is not a vault function', () => {
    expect(describeCall('0x')).toBe('no call data');
    expect(describeCall('0xdeadbeef00')).toBe('unknown call 0xdeadbeef');
    expect(describeCall('0x12')).toBe('unknown call 0x12');
  });
});

describe('heistConfig', () => {
  const key = generatePrivateKey();
  const open = {
    HEIST_OPEN: '1',
    HEIST_VAULT: vault,
    HEIST_RPC_URL: 'http://127.0.0.1:8545',
    HEIST_AGENT_PRIVATE_KEY: key,
    HEIST_BOUNTY_USD: '100',
    HEIST_FROM_BLOCK: '42',
  };

  it('is closed unless HEIST_OPEN is 1, and then carries nothing else', () => {
    for (const value of [undefined, '', '0', 'true', 'yes']) {
      expect(heistConfig({ ...open, HEIST_OPEN: value })).toEqual({ kind: 'closed' });
    }
  });

  it('opens with every setting, deriving the agent address from the key', () => {
    expect(heistConfig(open)).toEqual({
      kind: 'open',
      vault,
      rpcUrl: 'http://127.0.0.1:8545',
      explorerUrl: null,
      agentKey: key,
      agent: privateKeyToAccount(key).address,
      bountyUsd: 100,
      fromBlock: 42n,
    });
    expect(heistConfig({ ...open, HEIST_EXPLORER_URL: 'https://testnet.bscscan.com/' })).toMatchObject({
      explorerUrl: 'https://testnet.bscscan.com',
    });
  });

  it('refuses to open with a setting missing or malformed, and names it', () => {
    for (const name of ['HEIST_VAULT', 'HEIST_RPC_URL', 'HEIST_AGENT_PRIVATE_KEY', 'HEIST_BOUNTY_USD', 'HEIST_FROM_BLOCK'] as const) {
      const c = heistConfig({ ...open, [name]: undefined });
      expect(c.kind).toBe('broken');
      expect(c.kind === 'broken' && c.problem).toContain(name);
    }
    expect(heistConfig({ ...open, HEIST_VAULT: '0x1234' }).kind).toBe('broken');
    expect(heistConfig({ ...open, HEIST_AGENT_PRIVATE_KEY: '0xnot' }).kind).toBe('broken');
    expect(heistConfig({ ...open, HEIST_BOUNTY_USD: 'lots' }).kind).toBe('broken');
    expect(heistConfig({ ...open, HEIST_FROM_BLOCK: '-1' }).kind).toBe('broken');
  });

  it('never publishes the demo agent key, and never falls back to it', () => {
    const reused = heistConfig({ ...open, AGENT_PRIVATE_KEY: key });
    expect(reused.kind).toBe('broken');
    expect(JSON.stringify(reused)).not.toContain(key);

    const fallback = heistConfig({ ...open, HEIST_AGENT_PRIVATE_KEY: undefined, AGENT_PRIVATE_KEY: generatePrivateKey() });
    expect(fallback.kind).toBe('broken');
  });
});
