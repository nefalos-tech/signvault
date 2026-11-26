import { parseUnits } from 'viem';
import { MUSD_DECIMALS } from '@signvault/shared';

/**
 * A live USDY price in USD. Card T3's `fetchUsdyPrice` (server/src/price/cmc.ts) is one:
 * `() => fetchUsdyPrice(apiKey)`.
 */
export type PriceSource = () => Promise<{ price: number; lastUpdated: string }>;

/** The USDY price the agent and the dashboard see, in mUSD wei per whole mUSDY, so it compares with `convertToAssets(1e18)`. */
export interface Quote { price: bigint | null; simulated: boolean; lastUpdated?: string; error?: string }

/** A simulated shock puts the price this far under the live price, or under the redemption value when there is none. */
export const SHOCK_PERCENT = 10n;
/** CoinMarketCap's free plan allows about 30 calls a minute, and the dashboard polls every 2 seconds. */
const REFRESH_MS = 60_000;

type Live = { price: bigint | null; lastUpdated?: string; error?: string };

/** One price for everyone: the agent's price check and `GET /api/state` both read it. */
export class PriceFeed {
  private shocked = false;
  private live?: { at: number; value: Live };

  constructor(private readonly source?: PriceSource, private readonly now: () => number = Date.now) {}

  shock(on: boolean) {
    this.shocked = on;
  }

  async quote(redemptionValue: bigint): Promise<Quote> {
    const live = await this.read();
    if (this.shocked) return { price: ((live.price ?? redemptionValue) * (100n - SHOCK_PERCENT)) / 100n, simulated: true };
    return { ...live, simulated: false };
  }

  private async read(): Promise<Live> {
    if (!this.source) return { price: null };
    if (this.live && this.now() - this.live.at < REFRESH_MS) return this.live.value;
    const value = await this.source().then(
      ({ price, lastUpdated }): Live => {
        if (!Number.isFinite(price) || price <= 0) return { price: null, error: 'BadPrice' };
        return { price: parseUnits(price.toFixed(8), MUSD_DECIMALS), lastUpdated };
      },
      // The name only: a fetch error can carry the request URL, and with it the API key.
      (err: unknown): Live => ({ price: null, error: err instanceof Error ? err.name : 'Error' }),
    );
    this.live = { at: this.now(), value };
    return value;
  }
}
