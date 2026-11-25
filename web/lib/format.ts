import { formatUnits } from 'viem';
import { MUSD_DECIMALS } from '@signvault/shared';
import type { AppState } from '@signvault/shared';
import { shortAddress } from './approve';

/** "0.01 mUSD" from a wei decimal string. */
export function musd(wei: string) {
  return `${formatUnits(BigInt(wei), MUSD_DECIMALS)} mUSD`;
}

/** "Vendor 2" for a known vendor, else the short address. */
export function payeeName(address: string, vendors: AppState['vendors']) {
  return vendors.find((v) => v.address.toLowerCase() === address.toLowerCase())?.name ?? shortAddress(address);
}

export function txUrl(explorerUrl: string, txHash: string) {
  return `${explorerUrl}/tx/${txHash}`;
}
