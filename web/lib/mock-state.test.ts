import { describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import { VENDORS } from '@signvault/shared';
import type { RunEvent } from '@signvault/shared';
import baseline from '../fixtures/baseline-run.json';
import signvault from '../fixtures/signvault-run.json';
import { mockState } from './mock-state';

const mUSD = (x: string) => parseUnits(x, 18).toString();
const all = [...(baseline as RunEvent[]), ...(signvault as RunEvent[])];

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
    const s = mockState(baseline as RunEvent[]);
    expect(s.baseline).toEqual({ balance: mUSD('9.97'), dailyCap: mUSD('0.03'), spentToday: mUSD('0.03') });
  });

  it('ends the SignVault run with Vendor 1 paid and one pending change for Vendor 2', () => {
    const s = mockState(signvault as RunEvent[]);
    expect(s.signvault.balance).toBe(mUSD('9.99'));
    expect(s.signvault.payees).toEqual([{ to: VENDORS[0].address, amount: mUSD('0.01'), paidThisPeriod: true }]);
    expect(s.pendingChanges).toEqual([
      { id: 'chg-1', to: VENDORS[1].address, amount: mUSD('0.01'), nonce: '0', status: 'pending' },
    ]);
  });

  it('does not move money on a refused payment', () => {
    const upToFirstRefusal = (baseline as RunEvent[]).slice(0, 13);
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
});
