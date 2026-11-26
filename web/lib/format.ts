import { formatUnits } from 'viem';
import { MUSD_DECIMALS } from '@signvault/shared';
import type { AppState } from '@signvault/shared';
import { shortAddress } from './approve';

/** mUSD to at most 4 decimals, rounded half up, for display only. Any math uses the exact wei. */
const SHOWN = 4;
export function shownMusd(wei: string | bigint) {
  const step = 10n ** BigInt(MUSD_DECIMALS - SHOWN);
  return formatUnits((BigInt(wei) + step / 2n) / step, SHOWN);
}

/** "0.01 mUSD" from a wei decimal string. */
export function musd(wei: string) {
  return `${shownMusd(wei)} mUSD`;
}

/** "Vendor 2" for a known vendor, else the short address. */
export function payeeName(address: string, vendors: AppState['vendors']) {
  return vendors.find((v) => v.address.toLowerCase() === address.toLowerCase())?.name ?? shortAddress(address);
}

export function txUrl(explorerUrl: string, txHash: string) {
  return `${explorerUrl}/tx/${txHash}`;
}
