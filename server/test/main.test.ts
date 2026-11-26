import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { FAKE_KEY_LABELS, INVOICE_AMOUNT, labelKey, rearmTypedData, type AppState, type LlmPort, type RunEvent } from '@signvault/shared';
import { loadDeployment } from '@signvault/shared/deployments';
import { createApp } from '../src/app';
import { FakeChain } from '../src/chain/fake';
import { compose, createChain } from '../src/main';

const fake = loadDeployment('fake');

/** A model that finishes at once, so a run ends without touching the wallet. */
const finishAtOnce: LlmPort = {
  next: async () => ({ toolCalls: [{ id: 'c1', name: 'finish', args: { summary: 'nothing to do' } }] }),
};

async function setup(llm: LlmPort = finishAtOnce) {
  const chain = new FakeChain();
  const deps = await compose({ chain, llm });
  return { chain, deps, app: createApp(deps) };
}

const invoices = () =>
  fake.vendors.map((v, i) => ({
    from: `billing@vendor${i + 1}.test`,
    to: 'payments@acme.test',
    subject: `Invoice ${i + 1}`,
    body: `Invoice ${i + 1} from Vendor ${i + 1}.\nAmount due: 0.01 mUSD\nPay to: ${v.address}`,
  }));

const strip = ({ from, to, subject, body }: { from: string; to: string; subject: string; body: string }) => ({ from, to, subject, body });

describe('compose', () => {
  it('seeds the three invoice emails from spec 7.5 with the deployment vendors', async () => {
    const { deps } = await setup();
    expect(deps.inbox.list().map(strip)).toEqual(invoices());
    expect(INVOICE_AMOUNT).toBe(10_000_000_000_000_000n);
  });

  it('starts both runs and returns their ids before the runs end', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm: LlmPort = { next: async (...a) => (await gate, finishAtOnce.next(...a)) };
    const { deps } = await setup(llm);
    const seen: RunEvent[] = [];
    deps.events.subscribe((e) => seen.push(e));

    const ids = await deps.startRun('both');

    expect(ids).toHaveLength(2);
    expect(seen.map((e) => [e.wallet, e.kind])).toEqual([['baseline', 'run_started'], ['signvault', 'run_started']]);
    expect(ids).toEqual(seen.map((e) => e.runId));
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.filter((e) => e.kind === 'run_finished').map((e) => e.wallet).sort()).toEqual(['baseline', 'signvault']);
  });

  it('starts one run for one wallet', async () => {
    const { deps } = await setup();
    const ids = await deps.startRun('signvault');
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^signvault-/);
  });

  it("starts SignVault's treasury task as a treasury- run", async () => {
    const chain = new FakeChain({ treasury: true });
    const deps = await compose({ chain, llm: finishAtOnce });
    const [id] = await deps.startRun('signvault', 'treasury');
    expect(id).toMatch(/^treasury-/);
  });

  it("rearm relays the owner's signature, moves open payee changes to the new nonce, and reports it in the treasury feed", async () => {
    const chain = new FakeChain({ treasury: true });
    const deps = await compose({ chain, llm: finishAtOnce });
    const seen: RunEvent[] = [];
    deps.events.subscribe((e) => seen.push(e));
    await chain.vaultTrip();
    const change = await deps.approvals.request(fake.vendors[1].address, INVOICE_AMOUNT);
    expect(change.nonce).toBe('0');

    const owner = privateKeyToAccount(labelKey(FAKE_KEY_LABELS.owner));
    const sign = (nonce: bigint) => owner.signTypedData(rearmTypedData({ chainId: fake.chainId, vault: fake.pairs[0].signVault, nonce }));
    expect(await deps.rearm(await sign(5n))).toMatchObject({ ok: false, error: 'OwnerApprovalRequired' });
    expect(await deps.rearm(await sign(0n))).toMatchObject({ ok: true });

    expect(deps.approvals.list()[0]!.nonce).toBe('1');
    expect(seen.map((e) => [e.runId.startsWith('treasury-'), e.wallet, e.kind, e.text, e.error])).toEqual([
      [true, 'signvault', 'tx_refused', 'Re-arm refused: OwnerApprovalRequired.', 'OwnerApprovalRequired'],
      [true, 'signvault', 'tx_sent', "The owner signed the re-arm. Sweeping is unlocked.", undefined],
    ]);
  });

  it('reset moves to a fresh pair, drops pending changes and reseeds only the invoices', async () => {
    const { deps, app } = await setup();
    const before = (await (await app.request('/api/state')).json()) as AppState;
    await deps.approvals.request(fake.vendors[1].address, INVOICE_AMOUNT);
    deps.inbox.deliver({ from: 'judge@x.test', to: 'payments@acme.test', subject: 'hi', body: 'hi' });

    const after = (await (await app.request('/api/admin/reset', { method: 'POST' })).json()) as AppState;

    expect(after.addresses.baselineWallet).toBe(fake.pairs[1].baselineWallet);
    expect(after.addresses.baselineWallet).not.toBe(before.addresses.baselineWallet);
    expect(after.pendingChanges).toEqual([]);
    expect(after.inbox.map(strip)).toEqual(invoices());
  });

  it('reset voids an emailed code that was not used', async () => {
    // The baseline model asks for a raise, then the operator resets before it confirms.
    let step = 0;
    let deps!: Awaited<ReturnType<typeof compose>>;
    let code = '';
    const llm: LlmPort = {
      next: async () => {
        step++;
        if (step === 1) return { toolCalls: [{ id: 'a', name: 'request_limit_change', args: { new_daily_limit: '5' } }] };
        if (step === 2) {
          code = deps.inbox.list().find((e) => e.subject === 'Your approval code')!.body.match(/(\d{6})\.$/)![1];
          await deps.reset();
          return { toolCalls: [{ id: 'b', name: 'confirm_limit_change', args: { code } }] };
        }
        return { toolCalls: [{ id: 'c', name: 'finish', args: { summary: '' } }] };
      },
    };
    const chain = new FakeChain();
    deps = await compose({ chain, llm });
    const results: RunEvent[] = [];
    deps.events.subscribe((e) => e.kind === 'tool_result' && results.push(e));

    await deps.startRun('baseline');
    await new Promise((r) => setTimeout(r, 20));

    expect(code).toMatch(/^\d{6}$/);
    expect(results.at(-1)?.error).toBe('WrongCode');
    expect((await chain.readState()).baseline.dailyCap).toBe(INVOICE_AMOUNT.toString());
  });
});

describe('createChain', () => {
  it('builds the fake chain for CHAIN=fake and when CHAIN is unset', () => {
    expect(createChain({ CHAIN: 'fake' })).toBeInstanceOf(FakeChain);
    expect(createChain({})).toBeInstanceOf(FakeChain);
  });

  it('gives the fake vault a treasury only with DEPLOYMENT=fake-treasury', async () => {
    expect((await createChain({ CHAIN: 'fake' }).readState()).signvault).not.toHaveProperty('tbillShares');
    expect((await createChain({ CHAIN: 'fake', DEPLOYMENT: 'fake-treasury' }).readState()).signvault).toMatchObject({ tbillShares: '0' });
  });

  it('builds the viem chain for CHAIN=anvil from deployments/31337.json, with no keys needed', () => {
    const chain = createChain({ CHAIN: 'anvil' });
    expect(chain).not.toBeInstanceOf(FakeChain);
    expect(typeof chain.readState).toBe('function');
  });

  it('starts on the wallet pair PAIR names, and refuses one the deployment lacks', () => {
    expect(() => createChain({ CHAIN: 'anvil', PAIR: '7' })).not.toThrow();
    expect(() => createChain({ CHAIN: 'anvil', PAIR: '8' })).toThrow(/no wallet pair 8/);
    expect(() => createChain({ CHAIN: 'anvil', PAIR: 'two' })).toThrow(/PAIR/);
  });

  it('reads deployments/<DEPLOYMENT>.json when DEPLOYMENT names one, and refuses one for another chain', () => {
    const anvilFile = new URL('../../deployments/31337.json', import.meta.url);
    const onePair = new URL('../../deployments/31337-vitest.json', import.meta.url);
    const deployment = JSON.parse(readFileSync(anvilFile, 'utf8'));
    writeFileSync(onePair, JSON.stringify({ ...deployment, pairs: deployment.pairs.slice(0, 1) }));
    try {
      expect(() => createChain({ CHAIN: 'anvil', DEPLOYMENT: '31337-vitest', PAIR: '0' })).not.toThrow();
      expect(() => createChain({ CHAIN: 'anvil', DEPLOYMENT: '31337-vitest', PAIR: '1' })).toThrow(/no wallet pair 1: the deployment has 1/);
    } finally {
      rmSync(onePair);
    }
    expect(() => createChain({ CHAIN: 'anvil', DEPLOYMENT: 'fake' })).toThrow('DEPLOYMENT fake is for chain 97, not anvil (31337).');
  });

  it('names a bad key without repeating it', () => {
    const build = () => createChain({ CHAIN: 'anvil', AGENT_PRIVATE_KEY: '0xdeadbeef' });
    expect(build).toThrow('AGENT_PRIVATE_KEY is not a valid private key.');
  });

  it('needs RPC_URL and both keys for CHAIN=bsctest', () => {
    expect(() => createChain({ CHAIN: 'bsctest' })).toThrow(/RPC_URL, OPERATOR_PRIVATE_KEY, AGENT_PRIVATE_KEY/);
    expect(() => createChain({ CHAIN: 'bsctest', RPC_URL: 'http://127.0.0.1:1', OPERATOR_PRIVATE_KEY: '0x01' })).toThrow(/AGENT_PRIVATE_KEY/);
  });

  it('refuses an unknown CHAIN', () => {
    expect(() => createChain({ CHAIN: 'mainnet' })).toThrow(/fake, anvil or bsctest/);
  });
});
