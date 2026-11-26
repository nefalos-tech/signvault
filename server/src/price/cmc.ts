/** USDY (Ondo US Dollar Yield) on CoinMarketCap. The symbol USDY also matches an inactive token, id 25505, so calls ask by id. */
export const USDY_CMC_ID = 29256;
/** The Pro API, called when a key is set. */
export const CMC_PRO_URL = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=${USDY_CMC_ID}`;
/** The keyless public API, the fallback when no key is set. */
export const CMC_KEYLESS_URL = `https://pro-api.coinmarketcap.com/public-api/v3/cryptocurrency/quotes/latest?id=${USDY_CMC_ID}`;

/** CoinMarketCap gave no usable USDY price. The message names the endpoint and HTTP status, never the key. */
export class CmcError extends Error {
  name = 'CmcError';
}

/**
 * USDY's live USD price from CoinMarketCap. With a key, it calls the Pro API and sends the key only in the
 * `X-CMC_PRO_API_KEY` header. A refused key rejects and does not fall back. With no key, it warns and calls
 * the keyless public API. An answer without a price above 0 for id 29256 rejects with `CmcError`. A network
 * failure or the 10-second timeout rejects with fetch's own error.
 */
export async function fetchUsdyPrice(
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ price: number; lastUpdated: string; cmcId: number }> {
  const key = apiKey?.trim();
  if (!key) console.warn("CMC_API_KEY is not set, so USDY's price comes from CoinMarketCap's keyless public API. That call may not count as a Pro API call.");
  const url = key ? CMC_PRO_URL : CMC_KEYLESS_URL;
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', ...(key && { 'X-CMC_PRO_API_KEY': key }) },
    signal: AbortSignal.timeout(10_000),
  });
  const body = parseJson(await res.text());
  const fail = (reason: string) => {
    const message = `GET ${url} answered HTTP ${res.status}: ${reason}`;
    return new CmcError(key ? message.replaceAll(key, '<key>') : message);
  };

  const status = field(body, 'status');
  const code = field(status, 'error_code');
  if (!res.ok || (code !== 0 && code !== '0')) {
    const errorMessage = field(status, 'error_message');
    throw fail(`error_code ${code ?? 'missing'}${typeof errorMessage === 'string' ? `, ${errorMessage}` : ''}`);
  }
  const { id, usd, lastUpdated } = key ? fromPro(body) : fromKeyless(body);
  if (id !== USDY_CMC_ID) throw fail(`no quote for id ${USDY_CMC_ID}`);
  const price = field(usd, 'price');
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) throw fail(`USD price ${String(price)} is not a number above 0`);
  if (typeof lastUpdated !== 'string' || !lastUpdated) throw fail('no last_updated');
  return { price, lastUpdated, cmcId: USDY_CMC_ID };
}

/** v2 Pro: `data` is keyed by id and `quote` by currency. */
function fromPro(body: unknown) {
  const entry = field(field(body, 'data'), String(USDY_CMC_ID));
  const usd = field(field(entry, 'quote'), 'USD');
  return { id: field(entry, 'id'), usd, lastUpdated: field(usd, 'last_updated') };
}

/** v3 keyless: `data` and `quote` are arrays, and the time is on the entry. */
function fromKeyless(body: unknown) {
  const entry = field(field(body, 'data'), 0);
  const quotes = field(entry, 'quote');
  const usd: unknown = Array.isArray(quotes) ? quotes.find((q) => field(q, 'symbol') === 'USD') : undefined;
  return { id: field(entry, 'id'), usd, lastUpdated: field(entry, 'last_updated') };
}

function field(value: unknown, key: string | number): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
