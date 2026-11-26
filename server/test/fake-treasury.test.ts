import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  FAKE_KEY_LABELS, INVOICE_AMOUNT, labelKey, rearmTypedData, STARTING_BALANCE,
} from '@signvault/shared';
import { loadDeployment } from '@signvault/shared/deployments';
import { FAKE_MOCK_USDY, FakeChain } from '../src/chain/fake';

// Cards T2 and T3 on the fake chain: TBillSignVault's sweep above the payroll floor, and TripwireVault's trip and re-arm.
const d = loadDeployment('fake');
const [v1] = d.vendors.map((v) => v.address);
const owner = privateKeyToAccount(labelKey(FAKE_KEY_LABELS.owner));
const agent = privateKeyToAccount(labelKey(FAKE_KEY_LABELS.agent));
const ONE = 10n ** 18n;

const txHash = expect.stringMatching(/^0x[0-9a-f]{64}$/);
const sent = { ok: true, txHash };
const refused = (error: string) => ({ ok: false, error, txHash });
const spare = STARTING_BALANCE - INVOICE_AMOUNT;

const rearmSignature = (signer = owner, nonce = 0n, vault = d.pairs[0].signVault) =>
  signer.signTypedData(rearmTypedData({ chainId: d.chainId, vault, nonce }));

describe('a fake chain with no treasury', () => {
  it('keeps the old state shape and refuses every treasury call without sending', async () => {
    const chain = new FakeChain();
    const s = await chain.readState();
    expect(s.addresses).not.toHaveProperty('mockUsdy');
    expect(Object.keys(s.signvault).sort()).toEqual(['balance', 'nonce', 'payees']);
    const none = { ok: false, error: 'NoTreasury' };
    expect(await chain.vaultSweep(1n)).toEqual(none);
    expect(await chain.vaultRedeem(1n)).toEqual(none);
    expect(await chain.vaultTrip()).toEqual(none);
    expect(await chain.vaultRearm(await rearmSignature())).toEqual(none);
  });
});

describe('a fake chain with the treasury (DEPLOYMENT=fake-treasury)', () => {
  it('starts with all cash, no T-bills, Vendor 1 owed, and the tripwire armed', async () => {
    const s = await new FakeChain({ treasury: true }).readState();
    expect(s.addresses.mockUsdy).toBe(FAKE_MOCK_USDY);
    expect(s.signvault).toMatchObject({
      balance: STARTING_BALANCE.toString(),
      tbillShares: '0',
      tbillValue: '0',
      owedThisPeriod: INVOICE_AMOUNT.toString(),
      tripwire: { tripped: false, usdyPrice: null, redemptionValue: ONE.toString(), simulated: false },
    });
  });

  it('sweeps spare cash and refuses, with SweepDipsIntoPayroll, a sweep that dips into unpaid payroll', async () => {
    const chain = new FakeChain({ treasury: true });
    expect(await chain.vaultSweep(spare + 1n)).toEqual(refused('SweepDipsIntoPayroll'));
    expect(await chain.vaultSweep(STARTING_BALANCE + 1n)).toEqual(refused('SweepDipsIntoPayroll'));
    expect(await chain.vaultSweep(spare)).toEqual(sent);
    const { signvault } = await chain.readState();
    expect(signvault).toMatchObject({ balance: INVOICE_AMOUNT.toString(), tbillShares: spare.toString(), tbillValue: spare.toString() });
    // Payroll still goes out of the cash that was kept.
    expect(await chain.vaultPay(v1)).toEqual(sent);
    expect((await chain.readState()).signvault).toMatchObject({ balance: '0', owedThisPeriod: '0' });
  });

  it('redeems shares back to cash', async () => {
    const chain = new FakeChain({ treasury: true });
    await chain.vaultSweep(spare);
    expect(await chain.vaultRedeem(spare + 1n)).toEqual(refused('ERC4626ExceededMaxRedeem'));
    expect(await chain.vaultRedeem(spare / 2n)).toEqual(sent);
    expect((await chain.readState()).signvault).toMatchObject({
      balance: (INVOICE_AMOUNT + spare / 2n).toString(),
      tbillShares: (spare - spare / 2n).toString(),
    });
  });

  it('trip moves every share back to cash and locks sweeping with SweepLocked', async () => {
    const chain = new FakeChain({ treasury: true });
    await chain.vaultSweep(spare);
    expect(await chain.vaultTrip()).toEqual(sent);
    expect((await chain.readState()).signvault).toMatchObject({
      balance: STARTING_BALANCE.toString(), tbillShares: '0', tbillValue: '0', tripwire: { tripped: true },
    });
    expect(await chain.vaultSweep(1n)).toEqual(refused('SweepLocked'));
  });

  it("only the owner's Rearm signature on the current nonce re-arms, once", async () => {
    const chain = new FakeChain({ treasury: true });
    await chain.vaultTrip();
    expect(await chain.vaultRearm(await rearmSignature(agent))).toEqual(refused('OwnerApprovalRequired'));
    expect(await chain.vaultRearm(await rearmSignature(owner, 1n))).toEqual(refused('OwnerApprovalRequired'));
    expect(await chain.vaultRearm(await rearmSignature(owner, 0n, d.pairs[1].signVault))).toEqual(refused('OwnerApprovalRequired'));

    const approval = await rearmSignature();
    expect(await chain.vaultRearm(approval)).toEqual(sent);
    expect((await chain.readState()).signvault).toMatchObject({ nonce: '1', tripwire: { tripped: false } });
    expect(await chain.vaultRearm(approval)).toEqual(refused('OwnerApprovalRequired'));
    expect(await chain.vaultSweep(spare)).toEqual(sent);
  });

  it('nextPair starts the next vault with its treasury fresh', async () => {
    const chain = new FakeChain({ treasury: true });
    await chain.vaultSweep(spare);
    await chain.vaultTrip();
    await chain.nextPair();
    expect((await chain.readState()).signvault).toMatchObject({
      balance: STARTING_BALANCE.toString(), tbillShares: '0', tripwire: { tripped: false },
    });
  });
});
