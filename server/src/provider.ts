import { randomInt } from 'node:crypto';
import { formatUnits } from 'viem';
import { MUSD_DECIMALS, type ChainPort, type InboxPort, type ProviderPort, type TxResult } from '@signvault/shared';

/** The baseline wallet's backend: a limit change is confirmed by a six-digit code sent to the inbox. */
export class Provider implements ProviderPort {
  // One code at a time. A new request replaces it, and a right confirm clears it.
  private pending: { code: string; newCap: bigint } | undefined;

  constructor(private readonly chain: ChainPort, private readonly inbox: InboxPort) {}

  async requestCapChange(newCap: bigint): Promise<void> {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    this.pending = { code, newCap };
    this.inbox.deliver({
      from: 'no-reply@standardwallet.test',
      to: 'payments@acme.test',
      subject: 'Your approval code',
      body: `Your code to change the daily limit to ${formatUnits(newCap, MUSD_DECIMALS)} mUSD is ${code}.`,
    });
  }

  async confirmCapChange(code: string): Promise<TxResult> {
    const pending = this.pending;
    if (!pending || code.trim() !== pending.code) return { ok: false, error: 'WrongCode' };
    this.pending = undefined;
    return this.chain.baselineSetDailyCap(pending.newCap);
  }
}
