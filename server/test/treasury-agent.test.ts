import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { INVOICE_AMOUNT, STARTING_BALANCE, type LlmPort, type RunEvent } from '@signvault/shared';
import { runAgent } from '../src/agent/loop';
import { TOOLS } from '../src/agent/tools';
import { TREASURY_PROMPT, treasuryTask } from '../src/agent/treasury';
import { Approvals } from '../src/approvals';
import { FakeChain } from '../src/chain/fake';
import { MemoryEvents } from '../src/events';
import { MemoryInbox } from '../src/inbox';
import { PriceFeed } from '../src/price/feed';
import { Provider } from '../src/provider';

type Reply = Awaited<ReturnType<LlmPort['next']>>;
type Message = { role: string; content?: string | null };

let callCount = 0;
const call = (name: string, args: unknown = {}) => ({ id: `call-${++callCount}`, name, args });
const toolNames = (tools: unknown[]) => (tools as { function: { name: string } }[]).map((t) => t.function.name).sort();
const lastToolReply = (messages: Message[]) => messages.filter((m) => m.role === 'tool').at(-1)?.content ?? '';

function world() {
  const chain = new FakeChain({ treasury: true });
  const inbox = new MemoryInbox();
  const events = new MemoryEvents();
  const prices = new PriceFeed();
  const log: RunEvent[] = [];
  events.subscribe((e) => log.push(e));
  return { chain, inbox, events, prices, log, provider: new Provider(chain, inbox), approvals: new Approvals(chain, inbox) };
}

/** Plays `steps` in order, then finishes. Each turn sees the messages so far. */
async function play(w: ReturnType<typeof world>, steps: ((m: Message[]) => Reply)[]) {
  const turns: { messages: Message[]; tools: unknown[] }[] = [];
  const llm: LlmPort = {
    async next(messages, tools) {
      turns.push({ messages: structuredClone(messages) as Message[], tools });
      const step = steps[turns.length - 1];
      return step ? step(messages as Message[]) : { toolCalls: [call('finish', { summary: 'done' })] };
    },
  };
  const run = runAgent({ wallet: 'signvault', llm, ...w, task: treasuryTask(w.prices) });
  const result = await run.done;
  return { result, turns, feed: w.log.filter((e) => e.runId === run.runId).map((e) => [e.kind, e.text]) };
}

describe('the treasury task', () => {
  it('runs as treasury-… on SignVault, with its own prompt and tools', async () => {
    const w = world();
    const { result, turns, feed } = await play(w, []);
    expect(result.runId).toMatch(/^treasury-[0-9a-f]{8}$/);
    expect(w.log.every((e) => e.wallet === 'signvault')).toBe(true);
    expect(turns[0]!.messages[0]).toEqual({ role: 'system', content: TREASURY_PROMPT });
    expect(TREASURY_PROMPT).toContain('more than 1%');
    expect(TREASURY_PROMPT).toContain('If no live price is configured, there is no split to act on, so sweep as above.');
    expect(toolNames(turns[0]!.tools)).toEqual(['check_usdy_price', 'finish', 'redeem', 'sweep', 'treasury_status', 'trip']);
    expect(feed[0]).toEqual(['run_started', 'Treasury run started on SignVault: keep this period\'s payroll in cash, put the rest in T-bills.']);
  });

  it('sweeps the spare cash above the payroll floor, and the vault refuses a sweep that dips into it', async () => {
    const w = world();
    const { feed, turns } = await play(w, [
      () => ({ toolCalls: [call('treasury_status')] }),
      () => ({ toolCalls: [call('sweep', { amount: '10' })] }),
      () => ({ toolCalls: [call('sweep', { amount: '9.99' })] }),
    ]);
    expect(JSON.parse(turns[1]!.messages.at(-1)!.content!)).toEqual({
      cash: '10', inTbills: '0', payrollOwedThisPeriod: '0.01', spareCash: '9.99', tripwire: 'armed',
    });
    expect(feed.slice(1, -2)).toEqual([
      ['tool_call', 'Checks the treasury.'],
      ['tool_result', 'Cash 10 mUSD, 0 mUSD in T-bills, 0.01 mUSD of payroll still owed this period. Tripwire armed.'],
      ['tool_call', 'Sweeps 10 mUSD into T-bills.'],
      ['tx_refused', 'Refused: sweeping 10 mUSD would dip into the payroll still owed this period.'],
      ['tool_result', 'The vault refused: SweepDipsIntoPayroll.'],
      ['tool_call', 'Sweeps 9.99 mUSD into T-bills.'],
      ['tx_sent', 'Swept 9.99 mUSD into T-bills.'],
      ['tool_result', 'The sweep went through.'],
    ]);
    expect((await w.chain.readState()).signvault).toMatchObject({ balance: INVOICE_AMOUNT.toString(), tbillValue: (STARTING_BALANCE - INVOICE_AMOUNT).toString() });
  });

  it('redeems an amount in mUSD back to cash', async () => {
    const w = world();
    await w.chain.vaultSweep(STARTING_BALANCE - INVOICE_AMOUNT);
    const { feed } = await play(w, [() => ({ toolCalls: [call('redeem', { amount: '1' })] })]);
    expect(feed.slice(1, 4)).toEqual([
      ['tool_call', 'Redeems 1 mUSD of T-bills.'],
      ['tx_sent', 'Redeemed 1 mUSD of T-bills to cash.'],
      ['tool_result', 'The redemption went through.'],
    ]);
    expect((await w.chain.readState()).signvault.balance).toBe((INVOICE_AMOUNT + 10n ** 18n).toString());
  });

  it('on a simulated price shock, labelled as simulated, the agent trips the wire and sweeping is locked', async () => {
    const w = world();
    await w.chain.vaultSweep(STARTING_BALANCE - INVOICE_AMOUNT);
    w.prices.shock(true);
    const { feed, turns } = await play(w, [
      () => ({ toolCalls: [call('check_usdy_price')] }),
      () => ({ toolCalls: [call('trip')] }),
      () => ({ toolCalls: [call('sweep', { amount: '1' })] }),
      (m) => ({ toolCalls: [call('treasury_status')], text: lastToolReply(m) }),
    ]);
    expect(JSON.parse(turns[1]!.messages.at(-1)!.content!)).toEqual({
      usdyPrice: '0.9', redemptionValue: '1', splitPercent: '10.00', source: 'simulated price shock',
    });
    expect(feed.slice(1, 10)).toEqual([
      ['tool_call', 'Checks the USDY price against its redemption value.'],
      ['tool_result', 'USDY at 0.9 mUSD (simulated price shock) against a redemption value of 1 mUSD: 10.00% apart.'],
      ['tool_call', 'Trips the wire.'],
      ['tx_sent', 'Tripwire tripped: every T-bill is back in cash, and sweeping is locked until the owner re-arms it.'],
      ['tool_result', 'The wire is tripped.'],
      ['tool_call', 'Sweeps 1 mUSD into T-bills.'],
      ['tx_refused', 'Refused: sweeping is locked until the owner re-arms the tripwire.'],
      ['tool_result', 'The vault refused: SweepLocked.'],
      ['model_text', 'REFUSED: SweepLocked'],
    ]);
    expect((await w.chain.readState()).signvault).toMatchObject({ balance: STARTING_BALANCE.toString(), tbillShares: '0', tripwire: { tripped: true } });
  });

  it('says so when no live price is configured, instead of guessing one', async () => {
    const w = world();
    const { turns, feed } = await play(w, [() => ({ toolCalls: [call('check_usdy_price')] })]);
    expect(JSON.parse(turns[1]!.messages.at(-1)!.content!)).toEqual({
      usdyPrice: null, redemptionValue: '1', splitPercent: null, source: 'no live price configured',
    });
    expect(feed[2]).toEqual(['tool_result', 'No live USDY price is configured, so there is no split to act on. The redemption value is 1 mUSD.']);
  });

  it('rounds the amounts in its feed lines to 4 decimals, and keeps them exact for the model', async () => {
    const w = world();
    const { feed, turns } = await play(w, [
      () => ({ toolCalls: [call('sweep', { amount: '9.979999999999999999' })] }),
      () => ({ toolCalls: [call('treasury_status')] }),
    ]);
    expect(feed.slice(1, 6)).toEqual([
      ['tool_call', 'Sweeps 9.98 mUSD into T-bills.'],
      ['tx_sent', 'Swept 9.98 mUSD into T-bills.'],
      ['tool_result', 'The sweep went through.'],
      ['tool_call', 'Checks the treasury.'],
      ['tool_result', 'Cash 0.02 mUSD, 9.98 mUSD in T-bills, 0.01 mUSD of payroll still owed this period. Tripwire armed.'],
    ]);
    expect(JSON.parse(turns[2]!.messages.at(-1)!.content!)).toEqual({
      cash: '0.020000000000000001', inTbills: '9.979999999999999999', payrollOwedThisPeriod: '0.01', spareCash: '0.010000000000000001', tripwire: 'armed',
    });
    expect((await w.chain.readState()).signvault.tbillValue).toBe('9979999999999999999');
  });

  it('rounds the refused amount in its feed line too', async () => {
    const w = world();
    const { feed } = await play(w, [() => ({ toolCalls: [call('sweep', { amount: '9.990000000000000001' })] })]);
    expect(feed.slice(1, 3)).toEqual([
      ['tool_call', 'Sweeps 9.99 mUSD into T-bills.'],
      ['tx_refused', 'Refused: sweeping 9.99 mUSD would dip into the payroll still owed this period.'],
    ]);
  });

  it('rounds the live price and the redemption value to 4 decimals in its feed line, and splits on the exact values', async () => {
    const w = world();
    w.prices = new PriceFeed(async () => ({ price: 1.15410633, lastUpdated: '2026-11-26T00:00:00Z' }));
    const read = w.chain.readState.bind(w.chain);
    w.chain.readState = async () => {
      const s = await read();
      s.signvault.tripwire = { ...s.signvault.tripwire!, redemptionValue: '1154400000000000001' };
      return s;
    };
    const { feed, turns } = await play(w, [() => ({ toolCalls: [call('check_usdy_price')] })]);
    expect(JSON.parse(turns[1]!.messages.at(-1)!.content!)).toEqual({
      usdyPrice: '1.15410633', redemptionValue: '1.154400000000000001', splitPercent: '0.02', source: 'CoinMarketCap',
      lastUpdated: '2026-11-26T00:00:00Z',
    });
    expect(feed[2]).toEqual(['tool_result', 'CoinMarketCap: 1.1541 USD at 2026-11-26T00:00:00Z, against a redemption value of 1.1544 mUSD: 0.02% apart.']);
  });

  it('rounds the redemption value when no live price is configured', async () => {
    const w = world();
    const read = w.chain.readState.bind(w.chain);
    w.chain.readState = async () => {
      const s = await read();
      s.signvault.tripwire = { ...s.signvault.tripwire!, redemptionValue: '1154400000000000001' };
      return s;
    };
    const { feed } = await play(w, [() => ({ toolCalls: [call('check_usdy_price')] })]);
    expect(feed[2]).toEqual(['tool_result', 'No live USDY price is configured, so there is no split to act on. The redemption value is 1.1544 mUSD.']);
  });

  it('on a vault with no treasury, every tool says so', async () => {
    const w = { ...world(), chain: new FakeChain() };
    const { feed } = await play(w, [() => ({ toolCalls: [call('treasury_status')] }), () => ({ toolCalls: [call('sweep', { amount: '1' })] })]);
    expect(feed.slice(2, 5)).toEqual([
      ['tool_result', 'This vault has no treasury.'],
      ['tool_call', 'Sweeps 1 mUSD into T-bills.'],
      ['tool_result', 'This vault has no treasury.'],
    ]);
  });
});

describe('the payroll run', () => {
  // X1's spike measured the model on these exact tool schemas. The treasury task must not change a byte of them.
  it('keeps the tool schemas X1 measured', () => {
    const schemas = JSON.stringify(Object.values(TOOLS).flat().map(({ name, description, parameters }) => ({ name, description, parameters })));
    expect(createHash('sha256').update(schemas).digest('hex')).toBe('7cf7dd09bcfaa103c15a3b9412a8e6710c94a2c3b66675d7decb0c067a2f3c99');
  });
});
