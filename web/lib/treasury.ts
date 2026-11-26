import { formatUnits } from 'viem';
import { MUSD_DECIMALS } from '@signvault/shared';
import type { AppState, RunEvent } from '@signvault/shared';
import type { RunStatus, Step } from './story';

/**
 * The SignVault column's treasury panel (cards T2 and T3), worked out from the server state and the treasury events.
 * As in story.ts, nothing is assumed: a number or a claim shows only when the state or an event carries it.
 */

/** The treasury prompt trips the wire above this split (server/src/agent/treasury.ts, TRIP_PERCENT). */
export const TRIP_PERCENT = 1;

/** The server tags the treasury run `treasury-…` and the owner's re-arm `treasury-owner-…`. Payroll runs are `<wallet>-…`. */
export function isTreasuryEvent(e: RunEvent) {
  return e.runId.startsWith('treasury-');
}

export interface TripwireView {
  tripped: boolean;
  /** mUSD per mUSDY, as a decimal; null with no live price. */
  price: string | null;
  redemptionValue: string;
  splitPercent: string | null;
  /** Where `price` came from. Only a live, unsimulated price is CoinMarketCap's. */
  source: 'coinmarketcap' | 'simulated' | 'none';
  overThreshold: boolean;
}

export interface TreasuryView {
  cash: string;
  inTbills: string;
  /** The payroll still owed this period: the floor a sweep cannot go below. */
  owed: string;
  /** Undefined on a TBillSignVault, which has no tripwire. */
  tripwire?: TripwireView;
  status: RunStatus;
  steps: Step[];
}

export function treasuryView(events: RunEvent[], state: AppState | undefined): TreasuryView | undefined {
  const v = state?.signvault;
  if (v?.tbillShares === undefined || v.tbillValue === undefined || v.owedThisPeriod === undefined) return undefined;
  const mine = events.filter(isTreasuryEvent);
  return {
    cash: decimal(v.balance),
    inTbills: decimal(v.tbillValue),
    owed: decimal(v.owedThisPeriod),
    tripwire: v.tripwire && tripwireView(v.tripwire),
    status: runStatus(mine),
    steps: mine.flatMap(step),
  };
}

function tripwireView(t: NonNullable<AppState['signvault']['tripwire']>): TripwireView {
  const nav = BigInt(t.redemptionValue);
  const price = t.usdyPrice === null ? null : BigInt(t.usdyPrice);
  const bps = price === null || nav === 0n ? null : ((price > nav ? price - nav : nav - price) * 10_000n) / nav;
  return {
    tripped: t.tripped,
    price: price === null ? null : decimal(price),
    redemptionValue: decimal(nav),
    splitPercent: bps === null ? null : (Number(bps) / 100).toFixed(2),
    source: t.simulated ? 'simulated' : price === null ? 'none' : 'coinmarketcap',
    overThreshold: bps !== null && bps > BigInt(TRIP_PERCENT * 100),
  };
}

/** The lines worth a row: what reached the chain, the price checks, and where each run began and ended. */
function step(e: RunEvent): Step[] {
  const at = { ts: e.ts, ...(e.txHash && { txHash: e.txHash }) };
  switch (e.kind) {
    case 'run_started': return [{ kind: 'info', icon: 'run', title: 'Treasury run started', ts: e.ts }];
    // The model's own summary stays in the raw feed: it can say "$" for mUSD, which has no value.
    case 'run_finished': return [{ kind: 'info', icon: 'ok', title: 'Treasury run finished', ts: e.ts }];
    case 'tx_sent': return [{ kind: 'ok', icon: 'ok', title: e.text, ...at }];
    case 'tx_refused': return [{ kind: 'no', icon: 'no', title: e.text, ...(e.error && { detail: e.error }), ...at }];
    case 'tool_result': return e.tool === 'check_usdy_price' ? [{ kind: 'info', icon: 'warn', title: e.text, ts: e.ts }] : [];
    default: return [];
  }
}

function runStatus(events: RunEvent[]): RunStatus {
  const last = events.filter((e) => e.kind === 'run_started').at(-1);
  if (!last) return 'idle';
  return events.some((e) => e.kind === 'run_finished' && e.runId === last.runId) ? 'finished' : 'running';
}

const decimal = (wei: string | bigint) => formatUnits(BigInt(wei), MUSD_DECIMALS);
