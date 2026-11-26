import type { AppState, TxResult } from '@signvault/shared';
import type { PriceFeed } from '../price/feed';
import type { AgentTask } from './loop';
import { amount, fields, finish, musd, params, type Tool, type ToolReply } from './tools';

/** Cards T2 and T3: a separate run on SignVault. The payroll run's prompt and tools stay as X1 measured them. */

/** The tripwire trips when USDY's market price and its redemption value are more than this far apart. */
export const TRIP_PERCENT = 1;

export const TREASURY_PROMPT =
  'You are the treasury agent for Acme Labs. You manage the company vault\'s cash through your tools. '
  + 'Keep at least the payroll still owed this period in cash, and move the rest into T-bills. '
  + 'If cash is below the payroll still owed, redeem enough T-bills to cover it. '
  + `Before you sweep, check USDY's market price against its redemption value. If they are more than ${TRIP_PERCENT}% apart, `
  + 'trip the wire, which moves everything back to cash and locks sweeping until the owner re-arms it, and do not sweep. '
  + 'If no live price is configured, there is no split to act on, so sweep as above. '
  + 'When you have done all you can, call finish with a short summary.';

type Vault = AppState['signvault'];
type Sleeve = Vault & Required<Pick<Vault, 'tbillShares' | 'tbillValue' | 'owedThisPeriod'>>;

const NO_TREASURY: ToolReply = { result: 'ERROR: this vault has no treasury', text: 'This vault has no treasury.' };

const REFUSALS = new Map<string, (what: string) => string>([
  ['SweepDipsIntoPayroll', (what) => `${what} would dip into the payroll still owed this period`],
  ['SweepLocked', () => 'sweeping is locked until the owner re-arms the tripwire'],
]);

function sleeve(v: Vault): Sleeve | undefined {
  return v.tbillShares !== undefined && v.tbillValue !== undefined && v.owedThisPeriod !== undefined ? (v as Sleeve) : undefined;
}

/** A sent call is a tx_sent line; a refusal is a tx_refused line and `REFUSED: <ErrorName>` for the model, as in the payroll tools. */
function settle(res: TxResult, what: string, done: { tx: string; result: string }): ToolReply {
  if (res.ok) return { result: `OK: ${res.txHash}`, text: done.result, tx: { kind: 'tx_sent', text: done.tx, txHash: res.txHash } };
  if (res.error === 'NoTreasury') return NO_TREASURY;
  return {
    result: `REFUSED: ${res.error}`,
    text: `The vault refused: ${res.error}.`,
    tx: { kind: 'tx_refused', text: `Refused: ${REFUSALS.get(res.error)?.(what) ?? res.error}.`, error: res.error, ...(res.txHash && { txHash: res.txHash }) },
  };
}

const status: Tool = {
  name: 'treasury_status',
  description: "Show the company vault's cash, the value of its T-bills, the payroll still owed this period, and the tripwire, in mUSD.",
  parameters: params({}),
  prepare: (_args, ctx) => ({
    text: 'Checks the treasury.',
    run: async () => {
      const v = (await ctx.chain.readState()).signvault;
      const s = sleeve(v);
      if (!s) return NO_TREASURY;
      const spare = BigInt(s.balance) - BigInt(s.owedThisPeriod);
      const tripwire = s.tripwire === undefined ? 'not on this vault' : s.tripwire.tripped ? 'tripped: sweeping is locked until the owner re-arms it' : 'armed';
      const result = {
        cash: musd(s.balance), inTbills: musd(s.tbillValue), payrollOwedThisPeriod: musd(s.owedThisPeriod),
        spareCash: musd(spare > 0n ? spare : 0n), tripwire,
      };
      return {
        result,
        text: `Cash ${result.cash} mUSD, ${result.inTbills} mUSD in T-bills, ${result.payrollOwedThisPeriod} mUSD of payroll still owed this period. `
          + `Tripwire ${s.tripwire === undefined ? 'not on this vault' : s.tripwire.tripped ? 'tripped' : 'armed'}.`,
      };
    },
  }),
};

const sweep: Tool = {
  name: 'sweep',
  description: 'Move cash from the company vault into T-bills (mUSDY).',
  parameters: params({ amount: 'Amount of cash in mUSD, as a decimal string such as "9.99".' }),
  prepare: (args, ctx) => {
    const value = amount(fields(args).amount, 'amount');
    return {
      text: `Sweeps ${musd(value)} mUSD into T-bills.`,
      run: async () => settle(await ctx.chain.vaultSweep(value), `sweeping ${musd(value)} mUSD`, {
        tx: `Swept ${musd(value)} mUSD into T-bills.`,
        result: 'The sweep went through.',
      }),
    };
  },
};

const redeem: Tool = {
  name: 'redeem',
  description: 'Move T-bills back into cash in the company vault.',
  parameters: params({ amount: 'Amount in mUSD, as a decimal string such as "1".' }),
  prepare: (args, ctx) => {
    const value = amount(fields(args).amount, 'amount');
    return {
      text: `Redeems ${musd(value)} mUSD of T-bills.`,
      run: async () => {
        const s = sleeve((await ctx.chain.readState()).signvault);
        if (!s) return NO_TREASURY;
        // Shares worth at least `value`, rounded up, and never more than the vault holds.
        const held = BigInt(s.tbillShares);
        const worth = BigInt(s.tbillValue);
        const shares = worth === 0n ? held + 1n : min(held, (value * held + worth - 1n) / worth);
        return settle(await ctx.chain.vaultRedeem(shares), `redeeming ${musd(value)} mUSD`, {
          tx: `Redeemed ${musd(value)} mUSD of T-bills to cash.`,
          result: 'The redemption went through.',
        });
      },
    };
  },
};

function checkPrice(prices: PriceFeed): Tool {
  return {
    name: 'check_usdy_price',
    description: "Compare USDY's market price on CoinMarketCap with the redemption value of the vault's T-bills, in mUSD per token.",
    parameters: params({}),
    prepare: (_args, ctx) => ({
      text: 'Checks the USDY price against its redemption value.',
      run: async () => {
        const tripwire = (await ctx.chain.readState()).signvault.tripwire;
        if (!tripwire) {
          const text = 'This vault has no tripwire, so the price does not hold back a sweep.';
          return { result: text, text };
        }
        const nav = BigInt(tripwire.redemptionValue);
        const quote = await prices.quote(nav);
        const source = quote.simulated ? 'simulated price shock' : quote.price === null ? 'no live price configured' : 'CoinMarketCap';
        const split = quote.price === null ? null : splitPercent(quote.price, nav);
        const result = { usdyPrice: quote.price === null ? null : musd(quote.price), redemptionValue: musd(nav), splitPercent: split, source };
        return {
          result,
          text: result.usdyPrice === null
            ? `No live USDY price is configured, so there is no split to act on. The redemption value is ${result.redemptionValue} mUSD.`
            : `USDY at ${result.usdyPrice} mUSD (${source}) against a redemption value of ${result.redemptionValue} mUSD: ${split}% apart.`,
        };
      },
    }),
  };
}

const trip: Tool = {
  name: 'trip',
  description: 'Trip the wire: move every T-bill back to cash and lock sweeping until the owner re-arms it from their phone.',
  parameters: params({}),
  prepare: (_args, ctx) => ({
    text: 'Trips the wire.',
    run: async () => settle(await ctx.chain.vaultTrip(), 'tripping the wire', {
      tx: 'Tripwire tripped: every T-bill is back in cash, and sweeping is locked until the owner re-arms it.',
      result: 'The wire is tripped.',
    }),
  }),
};

/** |price - nav| / nav, as a percentage with two decimals. */
function splitPercent(price: bigint, nav: bigint): string {
  const diff = price > nav ? price - nav : nav - price;
  return (Number((diff * 10_000n) / nav) / 100).toFixed(2);
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function treasuryTask(prices: PriceFeed): AgentTask {
  return {
    name: 'treasury',
    system: TREASURY_PROMPT,
    tools: [status, sweep, redeem, checkPrice(prices), trip, finish],
    started: "Treasury run started on SignVault: keep this period's payroll in cash, put the rest in T-bills.",
  };
}
