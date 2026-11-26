import { describe, expect, it } from 'vitest';
import type { AppState, RunEvent } from '@signvault/shared';
import { MOCK_STATE } from '../app/approve/fixture';
import { isTreasuryEvent, treasuryView } from './treasury';

const E18 = 10n ** 18n;
const NAV = E18.toString();

function state(tripwire?: NonNullable<AppState['signvault']['tripwire']>): AppState {
  return {
    ...MOCK_STATE,
    signvault: {
      ...MOCK_STATE.signvault,
      balance: (E18 / 100n).toString(),
      tbillShares: (999n * E18 / 100n).toString(),
      tbillValue: (999n * E18 / 100n).toString(),
      owedThisPeriod: (E18 / 100n).toString(),
      ...(tripwire && { tripwire }),
    },
  };
}

let n = 0;
const ev = (runId: string, kind: RunEvent['kind'], text: string, extra: Partial<RunEvent> = {}): RunEvent =>
  ({ id: `e${++n}`, runId, ts: 1_000 + n, wallet: 'signvault', kind, text, ...extra });

describe('isTreasuryEvent', () => {
  it('is the treasury run and the owner re-arm, never a payroll run', () => {
    expect(isTreasuryEvent(ev('treasury-1a2b3c4d', 'run_started', ''))).toBe(true);
    expect(isTreasuryEvent(ev('treasury-owner-1a2b3c4d', 'tx_sent', ''))).toBe(true);
    expect(isTreasuryEvent(ev('signvault-1a2b3c4d', 'run_started', ''))).toBe(false);
  });
});

describe('treasuryView', () => {
  it('is undefined when the vault has no treasury, so the panel stays hidden', () => {
    expect(treasuryView([], MOCK_STATE)).toBeUndefined();
    expect(treasuryView([], undefined)).toBeUndefined();
  });

  it('shows cash, T-bills and the payroll floor in mUSD, and no tripwire on a TBillSignVault', () => {
    expect(treasuryView([], state())).toMatchObject({ cash: '0.01', inTbills: '9.99', owed: '0.01', tripwire: undefined, status: 'idle' });
  });

  it('rounds to 4 decimals, so ERC4626 rounding does not show as 9.989999999999999999', () => {
    const s = state();
    s.signvault.tbillValue = '9989999999999999999';
    expect(treasuryView([], s)!.inTbills).toBe('9.99');
  });

  it('with no live price it says so, and claims no split', () => {
    expect(treasuryView([], state({ tripped: false, usdyPrice: null, redemptionValue: NAV, simulated: false }))!.tripwire).toEqual({
      tripped: false, price: null, redemptionValue: '1', splitPercent: null, source: 'none', overThreshold: false,
    });
  });

  it('names CoinMarketCap only for a live, unsimulated price', () => {
    const live = state({ tripped: false, usdyPrice: (1005n * E18 / 1000n).toString(), redemptionValue: NAV, simulated: false });
    expect(treasuryView([], live)!.tripwire).toEqual({
      tripped: false, price: '1.005', redemptionValue: '1', splitPercent: '0.50', source: 'coinmarketcap', overThreshold: false,
    });
  });

  it('labels a shocked price as simulated, and flags a split over 1%', () => {
    const shocked = state({ tripped: true, usdyPrice: (9n * E18 / 10n).toString(), redemptionValue: NAV, simulated: true });
    expect(treasuryView([], shocked)!.tripwire).toEqual({
      tripped: true, price: '0.9', redemptionValue: '1', splitPercent: '10.00', source: 'simulated', overThreshold: true,
    });
  });

  it('builds its timeline from treasury events only, in the server words', () => {
    const events = [
      ev('signvault-aaaa', 'run_started', 'Run started on SignVault: pay every unpaid invoice in the inbox.'),
      ev('signvault-aaaa', 'tx_refused', 'Refused: Vendor 2 is not on the list.', { error: 'NotOnTheList' }),
      ev('treasury-bbbb', 'run_started', 'Treasury run started on SignVault.'),
      ev('treasury-bbbb', 'tool_result', 'USDY at 0.9 mUSD (simulated price shock) against a redemption value of 1 mUSD: 10.00% apart.', { tool: 'check_usdy_price' }),
      ev('treasury-bbbb', 'tx_refused', 'Refused: sweeping 10 mUSD would dip into the payroll still owed this period.', { error: 'SweepDipsIntoPayroll', txHash: '0xaa' }),
      ev('treasury-bbbb', 'tx_sent', 'Swept 9.99 mUSD into T-bills.', { txHash: '0xbb' }),
      ev('treasury-bbbb', 'tool_result', 'The sweep went through.', { tool: 'sweep', txHash: '0xbb' }),
      ev('treasury-bbbb', 'run_finished', 'Finished: swept 9.99 mUSD.'),
      ev('treasury-owner-cccc', 'tx_sent', 'The owner signed the re-arm. Sweeping is unlocked.', { txHash: '0xcc' }),
    ];
    const view = treasuryView(events, state())!;
    expect(view.status).toBe('finished');
    expect(view.steps.map(({ kind, title, detail, txHash }) => ({ kind, title, detail, txHash }))).toEqual([
      { kind: 'info', title: 'Treasury run started', detail: undefined, txHash: undefined },
      { kind: 'info', title: 'USDY at 0.9 mUSD (simulated price shock) against a redemption value of 1 mUSD: 10.00% apart.', detail: undefined, txHash: undefined },
      { kind: 'no', title: 'Refused: sweeping 10 mUSD would dip into the payroll still owed this period.', detail: 'SweepDipsIntoPayroll', txHash: '0xaa' },
      { kind: 'ok', title: 'Swept 9.99 mUSD into T-bills.', detail: undefined, txHash: '0xbb' },
      { kind: 'info', title: 'Treasury run finished', detail: undefined, txHash: undefined },
      { kind: 'ok', title: 'The owner signed the re-arm. Sweeping is unlocked.', detail: undefined, txHash: '0xcc' },
    ]);
  });
});
