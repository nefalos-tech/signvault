import { describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import { VENDORS } from '@signvault/shared';
import type { RunEvent } from '@signvault/shared';
import scripted from './scripted-runs.json';
import { mockState } from './mock-state';

const mUSD = (x: string) => parseUnits(x, 18).toString();
// The scripted runs, not web/fixtures/, which card D3 refreshes from live runs.
const baseline = scripted.baseline as RunEvent[];
const signvault = scripted.signvault as RunEvent[];
const all = [...baseline, ...signvault];

const [V1, V2, V3] = VENDORS.map((v) => v.address);
const V2_CHANGE = '95be5407-45ed-4300-a8b0-3ef428a33c23';
const V3_CHANGE = 'afc6bfd9-74af-4f59-8a11-d5a702744473';
const SET_V2_TX = '0xc5266ec91b2ff254c1ddbf6cb7815f548139023c1ca408bd3b54ecc28f8fa493';

/**
 * Events shaped like a live BSC testnet run as web/fixtures/capture.mjs saves it: the tool reports a
 * change in mUSD with no nonce, and the owner's approval is a tx_sent line on run `owner-approval`.
 */
const ev = (e: Partial<RunEvent>): RunEvent =>
  ({ id: '', runId: 'signvault-run', ts: 0, wallet: 'signvault', text: '', ...e }) as RunEvent;
const payCall = (to: string) => ev({ kind: 'tool_call', tool: 'pay', args: { to } });
const payOk = (txHash: `0x${string}`) => ev({ kind: 'tool_result', tool: 'pay', result: `OK: ${txHash}`, txHash });
const requestCall = (to: string) => ev({ kind: 'tool_call', tool: 'request_payee_change', args: { to, amount: '0.01' } });
const requestResult = (id: string, to: string) =>
  ev({ kind: 'tool_result', tool: 'request_payee_change', result: { id, to, amount: '0.01', status: 'pending' } });
const approval = (id: string, to: string, txHash: `0x${string}`) => ev({
  runId: 'owner-approval', kind: 'tx_sent', txHash,
  result: { id, to, amount: mUSD('0.01'), nonce: '0', status: 'applied', txHash },
});

const refusedRun = [
  payCall(V1), payOk('0xe930f8c6dc02218a31a34d7ffbc16db60950e2fa8d9aab97971d0fcd8559b1f1'),
  requestCall(V2), requestResult(V2_CHANGE, V2),
  requestCall(V3), requestResult(V3_CHANGE, V3),
];
const paidRun = [
  payCall(V2), payOk('0x52d0e06ddddbacd4a638f6b4c95e16d8ebca8495864895797c801d78d0a3e64f'),
  requestCall(V3), requestResult(V3_CHANGE, V3),
];
const liveRun = [...refusedRun, approval(V2_CHANGE, V2, SET_V2_TX), ...paidRun];

describe('mockState', () => {
  it('starts with 10 mUSD in each wallet, the 0.01 limit, Vendor 1 on the list and three invoices', () => {
    const s = mockState([]);
    expect(s.baseline).toEqual({ balance: mUSD('10'), dailyCap: mUSD('0.01'), spentToday: '0' });
    expect(s.signvault.balance).toBe(mUSD('10'));
    expect(s.signvault.payees).toEqual([{ to: VENDORS[0].address, amount: mUSD('0.01'), paidThisPeriod: false }]);
    expect(s.inbox.map((e) => e.subject)).toEqual(['Invoice 1', 'Invoice 2', 'Invoice 3']);
    expect(s.pendingChanges).toEqual([]);
  });

  it('ends the baseline run with the limit raised and all three vendors paid', () => {
    const s = mockState(baseline);
    expect(s.baseline).toEqual({ balance: mUSD('9.97'), dailyCap: mUSD('0.03'), spentToday: mUSD('0.03') });
  });

  it('ends the SignVault run with Vendor 1 paid and one pending change for Vendor 2', () => {
    const s = mockState(signvault);
    expect(s.signvault.balance).toBe(mUSD('9.99'));
    expect(s.signvault.payees).toEqual([{ to: VENDORS[0].address, amount: mUSD('0.01'), paidThisPeriod: true }]);
    expect(s.pendingChanges).toEqual([
      { id: 'chg-1', to: VENDORS[1].address, amount: mUSD('0.01'), nonce: '0', status: 'pending' },
    ]);
  });

  it('does not move money on a refused payment', () => {
    const upToFirstRefusal = baseline.slice(0, 13);
    expect(upToFirstRefusal.at(-1)?.error).toBe('DailyCapExceeded');
    expect(mockState(upToFirstRefusal).baseline.balance).toBe(mUSD('9.99'));
  });

  it('puts each delivered email in the inbox', () => {
    const s = mockState(all);
    expect(s.inbox.map((e) => e.subject)).toEqual([
      'Invoice 1', 'Invoice 2', 'Invoice 3', 'Your approval code', 'Approval needed on your phone',
    ]);
    expect(s.inbox[3]).toMatchObject({
      from: 'no-reply@standardwallet.test',
      body: 'Your code to change the daily limit to 0.03 mUSD is 482913.',
    });
  });

  it('lists a change the tool reports in mUSD with no nonce, in wei at the vault nonce', () => {
    expect(mockState(refusedRun).pendingChanges).toEqual([
      { id: V2_CHANGE, to: V2, amount: mUSD('0.01'), nonce: '0', status: 'pending' },
      { id: V3_CHANGE, to: V3, amount: mUSD('0.01'), nonce: '0', status: 'pending' },
    ]);
  });

  it("applies the owner's approval, then pays the new payee, over a live run", () => {
    const s = mockState(liveRun);
    expect(s.signvault).toEqual({
      balance: mUSD('9.98'),
      nonce: '1',
      payees: [
        { to: V1, amount: mUSD('0.01'), paidThisPeriod: true },
        { to: V2, amount: mUSD('0.01'), paidThisPeriod: true },
      ],
    });
    // The second run asks for Vendor 3 again and gets the same change back: still one row, now at the new nonce.
    expect(s.pendingChanges).toEqual([
      { id: V2_CHANGE, to: V2, amount: mUSD('0.01'), nonce: '0', status: 'applied', txHash: SET_V2_TX },
      { id: V3_CHANGE, to: V3, amount: mUSD('0.01'), nonce: '1', status: 'pending' },
    ]);
  });

  it('does not list a payee twice when the owner approves one already on the list', () => {
    const s = mockState([approval('chg-v1', V1, SET_V2_TX)]);
    expect(s.signvault.payees).toEqual([{ to: V1, amount: mUSD('0.01'), paidThisPeriod: false }]);
    expect(s.signvault.nonce).toBe('1');
  });
});
