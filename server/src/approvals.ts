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

  async request(to: Address, amount: bigint): Promise<PendingChange> {
    const { signvault } = await this.chain.readState();
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
    return { ...next };
  }
}
