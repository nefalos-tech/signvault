import { afterEach, describe, expect, it, vi } from 'vitest';
import { CMC_KEYLESS_URL, CMC_PRO_URL, CmcError, fetchUsdyPrice, USDY_CMC_ID } from '../src/price/cmc';

const KEY = 'test-key-not-real';
const PRO = 'https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=29256';
const KEYLESS = 'https://pro-api.coinmarketcap.com/public-api/v3/cryptocurrency/quotes/latest?id=29256';

/** The keyed v2 shape recorded on #25: `data` keyed by id, `quote` keyed by currency. */
function proBody({ id = 29256, quote = usd(1.1544448527382942) }: { id?: number; quote?: unknown } = {}) {
  return { status: { error_code: 0, error_message: null }, data: { [id]: { id, symbol: 'USDY', quote } } };
}

function usd(price: unknown, last_updated = '2026-11-26T12:38:00.000Z') {
  return { USD: { price, last_updated } };
}

/** The keyless v3 shape recorded on #25: `data` and `quote` are arrays. */
function keylessBody({
  id = 29256,
  quote = [{ symbol: 'USD', price: 1.1544389293881476 }],
  errorCode = '0',
}: { id?: number; quote?: unknown; errorCode?: unknown } = {}) {
  return { status: { error_code: errorCode }, data: [{ id, symbol: 'USDY', last_updated: '2026-11-26T12:25:00.000Z', quote }] };
}

/** Answers every call with one response and records what CoinMarketCap would have received. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

const headersOf = (init?: RequestInit) => Object.fromEntries(new Headers(init?.headers));
const silenceWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchUsdyPrice', () => {
  it('with a key, asks the Pro API for id 29256, sends the key only in X-CMC_PRO_API_KEY, and returns the USD price', async () => {
    const warn = silenceWarn();
    const { fetchImpl, calls } = fakeFetch(200, proBody());

    const quote = await fetchUsdyPrice(KEY, fetchImpl);

    expect(quote).toEqual({ price: 1.1544448527382942, lastUpdated: '2026-11-26T12:38:00.000Z', cmcId: 29256 });
    expect(calls.map((c) => c.url)).toEqual([PRO]);
    expect(headersOf(calls[0].init)).toEqual({ accept: 'application/json', 'x-cmc_pro_api_key': KEY });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['no key', undefined],
    ['an empty key', ''],
    ['a blank key', ' \n'],
  ])('with %s, falls back to the keyless API with no key header, warns, and reads the array shape', async (_, key) => {
    const warn = silenceWarn();
    const { fetchImpl, calls } = fakeFetch(200, keylessBody());

    const quote = await fetchUsdyPrice(key, fetchImpl);

    expect(quote).toEqual({ price: 1.1544389293881476, lastUpdated: '2026-11-26T12:25:00.000Z', cmcId: 29256 });
    expect(calls.map((c) => c.url)).toEqual([KEYLESS]);
    expect(headersOf(calls[0].init)).toEqual({ accept: 'application/json' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/CMC_API_KEY is not set.*Pro API/);
  });

  it.each([0, '0'])('takes a keyless error_code of %j as success', async (errorCode) => {
    silenceWarn();
    const { fetchImpl } = fakeFetch(200, keylessBody({ errorCode }));

    await expect(fetchUsdyPrice(undefined, fetchImpl)).resolves.toMatchObject({ price: 1.1544389293881476 });
  });

  it('a refused key rejects with CmcError that names the path, status and reason but not the key, and does not fall back', async () => {
    const warn = silenceWarn();
    const { fetchImpl, calls } = fakeFetch(401, { status: { error_code: 1001, error_message: `This API Key is invalid: ${KEY}` } });

    const err = await fetchUsdyPrice(KEY, fetchImpl).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CmcError);
    expect(String(err)).toMatch(/^CmcError: .*\/v2\/cryptocurrency\/quotes\/latest.*401.*1001.*This API Key is invalid/);
    expect(String(err)).not.toContain(KEY);
    expect(calls.map((c) => c.url)).toEqual([PRO]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['a quote for another id', KEY, 200, proBody({ id: 25505 })],
    ['no USD quote', KEY, 200, proBody({ quote: {} })],
    ['a zero price', KEY, 200, proBody({ quote: usd(0) })],
    ['a price that is not a number', KEY, 200, proBody({ quote: usd('1.15') })],
    ['an empty last_updated', KEY, 200, proBody({ quote: usd(1.15, '') })],
    ['a non-zero error_code', KEY, 200, { ...proBody(), status: { error_code: 1008, error_message: 'Rate limit reached.' } }],
    ['a 500 whose body holds a good quote', KEY, 500, proBody()],
    ['a 502 that is not JSON', KEY, 502, '<html>Bad Gateway</html>'],
    ['a keyless quote for another id', undefined, 200, keylessBody({ id: 25505 })],
    ['a keyless answer with no USD entry', undefined, 200, keylessBody({ quote: [{ symbol: 'EUR', price: 1.07 }] })],
    ['a keyless non-zero error_code', undefined, 200, keylessBody({ errorCode: '1006' })],
  ])('%s rejects with CmcError', async (_, key, status, body) => {
    silenceWarn();
    const { fetchImpl } = fakeFetch(status, body);

    await expect(fetchUsdyPrice(key, fetchImpl)).rejects.toBeInstanceOf(CmcError);
  });

  it('exports the id and both endpoints, so the run feed can name the call without the key', () => {
    expect({ USDY_CMC_ID, CMC_PRO_URL, CMC_KEYLESS_URL }).toEqual({ USDY_CMC_ID: 29256, CMC_PRO_URL: PRO, CMC_KEYLESS_URL: KEYLESS });
  });
});
