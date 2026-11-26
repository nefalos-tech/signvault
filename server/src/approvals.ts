import { randomUUID } from 'node:crypto';
import { formatUnits } from 'viem';
import {
  MUSD_DECIMALS,
  type Address,
  type ApprovalsPort,
  type ChainPort,
  type Hex,
  type InboxPort,
  type PendingChange,
} from '@signvault/shared';

/** SignVault rule changes: the inbox gets a notice with no code, and only the owner's signature applies a change. */
export class Approvals implements ApprovalsPort {
  private readonly changes = new Map<string, PendingChange>();

  constructor(private readonly chain: ChainPort, private readonly inbox: InboxPort) {}

  /** A change that is already open (same payee and amount, not yet applied) is returned as it stands, with no second notice. */
  async request(to: Address, amount: bigint): Promise<PendingChange> {
    const { signvault } = await this.chain.readState();
    // Checked after the await, so two requests in flight at once still make one row.
    const open = [...this.changes.values()].find(
      (c) => c.status !== 'applied' && c.to.toLowerCase() === to.toLowerCase() && c.amount === amount.toString(),
    );
    if (open) return { ...open };
    const change: PendingChange = { id: randomUUID(), to, amount: amount.toString(), nonce: signvault.nonce, status: 'pending' };
    this.changes.set(change.id, change);
    this.inbox.deliver({
      from: 'no-reply@signvault.test',
      to: 'payments@acme.test',
      subject: 'Approval needed on your phone',
      body: `A change is waiting: add ${to} at ${formatUnits(amount, MUSD_DECIMALS)} mUSD per period. Open SignVault on your phone to approve. There is no code.`,
    });
    return { ...change };
  }

  list(): PendingChange[] {
    return [...this.changes.values()].map((c) => ({ ...c }));
  }

  async approve(id: string, signature: Hex): Promise<PendingChange> {
    const change = this.changes.get(id);
    if (!change) throw new Error(`UnknownChange: ${id}`);
    // An applied change is final. A failed one stays approvable, so the owner can sign again.
    if (change.status === 'applied') return { ...change };

    const result = await this.chain.vaultSetPayee(change.to, BigInt(change.amount), signature, 'operator');
    const { to, amount, nonce } = change;
    const next: PendingChange = result.ok
      ? { id, to, amount, nonce, status: 'applied', txHash: result.txHash }
      : { id, to, amount, nonce, status: 'failed', txHash: result.txHash, error: result.error };
    this.changes.set(id, next);
    // The vault's nonce went up by one, so every change still open now needs an approval over the new nonce.
    if (result.ok) {
      const newNonce = (BigInt(nonce) + 1n).toString();
      for (const c of this.changes.values()) if (c.status !== 'applied') c.nonce = newNonce;
    }
    return { ...next };
  }

  /** Something else spent the vault's nonce (card T3's re-arm), so every open change now needs an approval over `nonce`. */
  syncNonce(nonce: string): void {
    for (const c of this.changes.values()) if (c.status !== 'applied') c.nonce = nonce;
  }
}
