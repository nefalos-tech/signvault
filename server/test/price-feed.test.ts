import { describe, expect, it } from 'vitest';
import { PriceFeed, type PriceSource } from '../src/price/feed';

const ONE = 10n ** 18n;
const NAV = 1_080_000_000_000_000_000n; // 1.08 mUSD per mUSDY

describe('PriceFeed', () => {
  it('has no price without a live source, and is not simulated', async () => {
    expect(await new PriceFeed().quote(NAV)).toEqual({ price: null, simulated: false });
  });

  it('turns the live USD price into mUSD wei per whole mUSDY', async () => {
    const feed = new PriceFeed(async () => ({ price: 1.0812, lastUpdated: '2026-11-26T12:00:00.000Z' }));
    expect(await feed.quote(NAV)).toEqual({ price: 1_081_200_000_000_000_000n, simulated: false, lastUpdated: '2026-11-26T12:00:00.000Z' });
  });

  it('a simulated shock puts the price 10% under the live price, or under the redemption value with no live price', async () => {
    const live = new PriceFeed(async () => ({ price: 1.1, lastUpdated: 't' }));
    live.shock(true);
    expect(await live.quote(NAV)).toEqual({ price: 990_000_000_000_000_000n, simulated: true });

    const none = new PriceFeed();
    none.shock(true);
    expect(await none.quote(NAV)).toEqual({ price: 972_000_000_000_000_000n, simulated: true });
    none.shock(false);
    expect(await none.quote(NAV)).toEqual({ price: null, simulated: false });
  });

  it('asks the source at most once a minute, failures included, because the dashboard polls every 2 seconds', async () => {
    let t = 0;
    let calls = 0;
    let fail = false;
    const source: PriceSource = async () => {
      calls++;
      if (fail) throw new TypeError('fetch failed');
      return { price: 1, lastUpdated: 't' };
    };
    const feed = new PriceFeed(source, () => t);
    await feed.quote(ONE);
    t = 59_000;
    await feed.quote(ONE);
    expect(calls).toBe(1);

    t = 61_000;
    fail = true;
    expect(await feed.quote(ONE)).toEqual({ price: null, simulated: false, error: 'TypeError' });
    t = 62_000;
    await feed.quote(ONE);
    expect(calls).toBe(2);
  });
});
