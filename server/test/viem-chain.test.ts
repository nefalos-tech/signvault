import { existsSync } from 'node:fs';
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVOICE_AMOUNT, STARTING_BALANCE, VENDORS, setPayeeTypedData, type ChainPort, type Hex, type TxResult } from '@signvault/shared';
import { loadDeployment, type Deployment } from '@signvault/shared/deployments';
import { createViemChain } from '../src/chain/viem';

// Runs the spec 4 table on anvil against `pnpm deploy:local`. Skips, with the reason, when either is missing.
const rpcUrl = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
const deploymentFile = new URL('../../deployments/31337.json', import.meta.url);

async function whyNotRunnable(): Promise<string | undefined> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(1000),
    });
    const { result } = (await res.json()) as { result?: string };
    if (Number(result) !== anvil.id) return `${rpcUrl} is chain ${Number(result)}, not anvil (${anvil.id})`;
  } catch {
    return `anvil does not answer at ${rpcUrl}`;
  }
  if (!existsSync(deploymentFile)) return 'deployments/31337.json is missing: run `pnpm deploy:local`';
  return undefined;
}

const skipReason = await whyNotRunnable();
// Vitest hides console output from a skipped file, so write the reason straight to stderr.
if (skipReason) process.stderr.write(`viem-chain.test.ts skipped: ${skipReason}\n`);

describe.skipIf(skipReason !== undefined)('viem ChainPort on anvil', () => {
  const client = createPublicClient({ chain: anvil, transport: http(rpcUrl) });
  const signer = createWalletClient({ chain: anvil, transport: http(rpcUrl) });
  const node = createTestClient({ chain: anvil, mode: 'anvil', transport: http(rpcUrl) });
  const [v1, v2, v3] = VENDORS.map((v) => v.address) as [Address, Address, Address];
  let d: Deployment;
  let chain: ChainPort;
  let snapshot: Hex;

  async function expectRefused(result: TxResult, error: string) {
    expect(result).toMatchObject({ ok: false, error, txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    const receipt = await client.getTransactionReceipt({ hash: result.txHash! });
    expect(receipt.status).toBe('reverted');
    expect((await client.getTransaction({ hash: result.txHash! })).gas).toBe(200_000n);
  }

  async function expectSent(result: TxResult) {
    expect(result).toMatchObject({ ok: true });
    const receipt = await client.getTransactionReceipt({ hash: result.txHash! });
    expect(receipt.status).toBe('success');
  }

  beforeAll(async () => {
    snapshot = await node.snapshot();
    d = loadDeployment(anvil.id);
    chain = createViemChain({ rpcUrl, deployment: d, agent: d.agent, operator: d.operator });
  });

  afterAll(async () => {
    if (snapshot) await node.revert({ id: snapshot });
  });

  it('starts on pair 0 with 10 mUSD in each wallet and Vendor 1 on the list', async () => {
    const s = await chain.readState();
    expect(s.chainId).toBe(anvil.id);
    expect(s.vendors).toEqual(VENDORS);
    expect(s.addresses).toMatchObject({ baselineWallet: d.pairs[0]!.baselineWallet, signVault: d.pairs[0]!.signVault });
    expect(s.baseline).toEqual({ balance: STARTING_BALANCE.toString(), dailyCap: INVOICE_AMOUNT.toString(), spentToday: '0' });
    expect(s.signvault).toEqual({
      balance: STARTING_BALANCE.toString(),
      nonce: '0',
      payees: [{ to: v1, amount: INVOICE_AMOUNT.toString(), paidThisPeriod: false }],
    });
  });

  describe('BaselineWallet run', () => {
    it('step 1: pays Vendor 1', async () => {
      await expectSent(await chain.baselinePay(v1, INVOICE_AMOUNT));
    });

    it('step 2: Vendor 2 is refused with DailyCapExceeded, on chain', async () => {
      await expectRefused(await chain.baselinePay(v2, INVOICE_AMOUNT), 'DailyCapExceeded');
    });

    it('step 5: the operator raises the limit once the code is confirmed', async () => {
      await expectSent(await chain.baselineSetDailyCap(3n * INVOICE_AMOUNT));
    });

    it('step 6: pays Vendor 2 and Vendor 3', async () => {
      await expectSent(await chain.baselinePay(v2, INVOICE_AMOUNT));
      await expectSent(await chain.baselinePay(v3, INVOICE_AMOUNT));
      const { baseline } = await chain.readState();
      expect(baseline).toEqual({
        balance: (STARTING_BALANCE - 3n * INVOICE_AMOUNT).toString(),
        dailyCap: (3n * INVOICE_AMOUNT).toString(),
        spentToday: (3n * INVOICE_AMOUNT).toString(),
      });
    });
  });

  describe('SignVault run', () => {
    // The signer is an anvil dev account, so anvil signs for it: no key in the test.
    async function approval(account: Address) {
      const { signvault, addresses } = await chain.readState();
      const typed = setPayeeTypedData({
        chainId: anvil.id, vault: addresses.signVault, to: v2, amount: INVOICE_AMOUNT, nonce: BigInt(signvault.nonce),
      });
      return signer.signTypedData({ account, ...typed });
    }

    it('step 1: pays Vendor 1', async () => {
      await expectSent(await chain.vaultPay(v1));
    });

    it('step 2: Vendor 2 is refused with NotOnTheList, on chain', async () => {
      await expectRefused(await chain.vaultPay(v2), 'NotOnTheList');
    });

    it('step 5: the agent adding Vendor 2 itself is refused with OwnerApprovalRequired, on chain', async () => {
      await expectRefused(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, await approval(d.agent), 'agent'), 'OwnerApprovalRequired');
    });

    it("then the owner's signature, relayed by the operator, adds Vendor 2 and a second run pays it", async () => {
      await expectSent(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, await approval(d.owner), 'operator'));
      await expectSent(await chain.vaultPay(v2));
      const { signvault } = await chain.readState();
      expect(signvault).toEqual({
        balance: (STARTING_BALANCE - 2n * INVOICE_AMOUNT).toString(),
        nonce: '1',
        payees: [
          { to: v1, amount: INVOICE_AMOUNT.toString(), paidThisPeriod: true },
          { to: v2, amount: INVOICE_AMOUNT.toString(), paidThisPeriod: true },
        ],
      });
    });
  });

  it('a private-key account signs locally, and its refusal also lands on chain', async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    await node.setBalance({ address: stranger.address, value: parseEther('1') });
    const port = createViemChain({ rpcUrl, deployment: d, agent: stranger, operator: stranger });
    await expectRefused(await port.vaultPay(v1), 'OnlyAgent');
  });

  it('nextPair moves to a fresh pair, and refuses to run past the last one', async () => {
    await chain.nextPair();
    const s = await chain.readState();
    expect(s.addresses).toMatchObject({ baselineWallet: d.pairs[1]!.baselineWallet, signVault: d.pairs[1]!.signVault });
    expect(s.baseline.spentToday).toBe('0');
    expect(s.signvault.nonce).toBe('0');

    const last = createViemChain({ rpcUrl, deployment: d, agent: d.agent, operator: d.operator, pair: d.pairs.length - 1 });
    await expect(last.nextPair()).rejects.toThrow(/all \d+ wallet pairs are used/);
  });
});
