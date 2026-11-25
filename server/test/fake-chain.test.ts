import {
  concat, hexToBigInt, IntegerOutOfRangeError, InvalidAddressError, numberToHex, parseSignature, parseUnits,
  verifyTypedData, zeroAddress, type PrivateKeyAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  FAKE_KEY_LABELS, INVOICE_AMOUNT, labelKey, PAIR_COUNT, PERIOD_SECONDS, setPayeeTypedData, STARTING_BALANCE,
  type Address, type ChainPort, type Hex,
} from '@signvault/shared';
import { loadDeployment } from '@signvault/shared/deployments';
import { FakeChain } from '../src/chain/fake';

const d = loadDeployment('fake');
const [v1, v2, v3] = d.vendors.map((v) => v.address);
const owner = privateKeyToAccount(labelKey(FAKE_KEY_LABELS.owner));
const agent = privateKeyToAccount(labelKey(FAKE_KEY_LABELS.agent));

const DAY = 86_400n;
const HOUR = 3_600n;
// 23:00 UTC, so one hour later is a new day for the baseline but still period 0 for the vault.
const START = 20_400n * DAY + 23n * HOUR;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const txHash = expect.stringMatching(/^0x[0-9a-f]{64}$/);
const sent = { ok: true, txHash };
const refused = (error: string) => ({ ok: false, error, txHash });
const wei = (n: bigint) => n.toString();

function setup() {
  let t = START;
  const chain: ChainPort = new FakeChain({ now: () => t });
  return { chain, advance: (seconds: bigint) => { t += seconds; } };
}

function typedData(to: Address, amount: bigint, nonce: bigint, vault = d.pairs[0].signVault) {
  return setPayeeTypedData({ chainId: d.chainId, vault, to, amount, nonce });
}

function sign(signer: PrivateKeyAccount, to: Address, amount: bigint, nonce: bigint, vault = d.pairs[0].signVault): Promise<Hex> {
  return signer.signTypedData(typedData(to, amount, nonce, vault));
}

describe('readState', () => {
  it('starts each wallet at 10 mUSD, the baseline cap at 0.01, and Vendor 1 on the list', async () => {
    const { chain } = setup();
    expect(await chain.readState()).toEqual({
      chainId: 97,
      explorerUrl: d.explorerUrl,
      addresses: { mockUsd: d.mockUsd, baselineWallet: d.pairs[0].baselineWallet, signVault: d.pairs[0].signVault, owner: d.owner, agent: d.agent },
      vendors: d.vendors,
      baseline: { balance: wei(STARTING_BALANCE), dailyCap: wei(INVOICE_AMOUNT), spentToday: '0' },
      signvault: { balance: wei(STARTING_BALANCE), nonce: '0', payees: [{ to: v1, amount: wei(INVOICE_AMOUNT), paidThisPeriod: false }] },
    });
  });
});

describe('the run table in spec 4', () => {
  it('BaselineWallet: the agent pays Vendor 1, is capped, raises the cap, then pays Vendor 2 and Vendor 3', async () => {
    const { chain } = setup();

    expect(await chain.baselinePay(v1, INVOICE_AMOUNT)).toEqual(sent);                         // step 1
    expect(await chain.baselinePay(v2, INVOICE_AMOUNT)).toEqual(refused('DailyCapExceeded'));  // step 2
    expect((await chain.readState()).baseline).toEqual({
      balance: wei(STARTING_BALANCE - INVOICE_AMOUNT), dailyCap: wei(INVOICE_AMOUNT), spentToday: wei(INVOICE_AMOUNT),
    });

    // Steps 3 and 4 are the provider's code email. Step 5: the operator applies the confirmed raise.
    const newCap = parseUnits('1', 18);
    expect(await chain.baselineSetDailyCap(newCap)).toEqual(sent);

    expect(await chain.baselinePay(v2, INVOICE_AMOUNT)).toEqual(sent);                         // step 6
    expect(await chain.baselinePay(v3, INVOICE_AMOUNT)).toEqual(sent);
    expect((await chain.readState()).baseline).toEqual({
      balance: wei(STARTING_BALANCE - 3n * INVOICE_AMOUNT), dailyCap: wei(newCap), spentToday: wei(3n * INVOICE_AMOUNT),
    });
  });

  it('SignVault: the agent pays Vendor 1, cannot pay Vendor 2, and cannot add Vendor 2 itself', async () => {
    const { chain } = setup();

    expect(await chain.vaultPay(v1)).toEqual(sent);                                             // step 1
    expect(await chain.vaultPay(v2)).toEqual(refused('NotOnTheList'));                          // step 2

    // Steps 3 and 4 are the approvals notice. Step 5: the agent signs the change with its own key.
    const own = await sign(agent, v2, INVOICE_AMOUNT, 0n);
    expect(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, own, 'agent')).toEqual(refused('OwnerApprovalRequired'));
    expect(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, '0x', 'agent')).toEqual(refused('OwnerApprovalRequired'));

    // Step 6: it can only wait. Nothing on the vault moved.
    expect(await chain.vaultPay(v2)).toEqual(refused('NotOnTheList'));
    expect((await chain.readState()).signvault).toEqual({
      balance: wei(STARTING_BALANCE - INVOICE_AMOUNT), nonce: '0',
      payees: [{ to: v1, amount: wei(INVOICE_AMOUNT), paidThisPeriod: true }],
    });
  });

  it('gives every transaction, refused or not, its own hash', async () => {
    const { chain } = setup();
    const results = [
      await chain.baselinePay(v1, INVOICE_AMOUNT),
      await chain.baselinePay(v2, INVOICE_AMOUNT),
      await chain.vaultPay(v1),
      await chain.vaultPay(v2),
    ];
    const hashes = results.map((r) => r.txHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('setPayee', () => {
  it('adds a payee with the owner signature, relayed by the operator, and the agent can then pay it', async () => {
    const { chain } = setup();
    const approval = await sign(owner, v2, INVOICE_AMOUNT, 0n);

    expect(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, approval, 'operator')).toEqual(sent);
    expect((await chain.readState()).signvault).toMatchObject({
      nonce: '1',
      payees: [
        { to: v1, amount: wei(INVOICE_AMOUNT), paidThisPeriod: false },
        { to: v2, amount: wei(INVOICE_AMOUNT), paidThisPeriod: false },
      ],
    });
    expect(await chain.vaultPay(v2)).toEqual(sent);
  });

  it('accepts the owner signature from any relayer', async () => {
    const { chain } = setup();
    const approval = await sign(owner, v2, INVOICE_AMOUNT, 0n);
    expect(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, approval, 'agent')).toEqual(sent);
  });

  it('refuses junk approvals with OwnerApprovalRequired and changes nothing', async () => {
    const { chain } = setup();
    const junk: Hex[] = ['0x', '0xdeadbeef', `0x${'00'.repeat(65)}`, `0x${'ab'.repeat(65)}`, `0x${'11'.repeat(64)}`];
    for (const approval of junk) {
      expect(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, approval, 'operator')).toEqual(refused('OwnerApprovalRequired'));
    }
    expect((await chain.readState()).signvault.nonce).toBe('0');
    expect((await chain.readState()).signvault.payees).toHaveLength(1);
  });

  it('refuses forms of the owner signature that ECDSA.tryRecover refuses: v of 0 or 1, and a high s', async () => {
    const { chain } = setup();
    const approval = await sign(owner, v2, INVOICE_AMOUNT, 0n);
    const { r, s, yParity } = parseSignature(approval);
    const vZeroOrOne = concat([r, s, numberToHex(yParity, { size: 1 })]);
    const highS = concat([r, numberToHex(SECP256K1_N - hexToBigInt(s), { size: 32 }), numberToHex(28 - yParity, { size: 1 })]);

    // viem verifies both against the owner, so only the canonical-form rule can refuse them.
    expect(await verifyTypedData({ address: d.owner, signature: vZeroOrOne, ...typedData(v2, INVOICE_AMOUNT, 0n) })).toBe(true);
    expect(await verifyTypedData({ address: d.owner, signature: highS, ...typedData(v2, INVOICE_AMOUNT, 0n) })).toBe(true);
    expect(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, vZeroOrOne, 'operator')).toEqual(refused('OwnerApprovalRequired'));
    expect(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, highS, 'operator')).toEqual(refused('OwnerApprovalRequired'));
    expect(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, approval, 'operator')).toEqual(sent);
  });

  it('refuses an owner signature for another payee, amount, nonce or vault', async () => {
    const { chain } = setup();
    const cases: [string, Hex][] = [
      ['payee', await sign(owner, v3, INVOICE_AMOUNT, 0n)],
      ['amount', await sign(owner, v2, 2n * INVOICE_AMOUNT, 0n)],
      ['nonce', await sign(owner, v2, INVOICE_AMOUNT, 1n)],
      ['vault', await sign(owner, v2, INVOICE_AMOUNT, 0n, d.pairs[1].signVault)],
    ];
    for (const [, approval] of cases) {
      expect(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, approval, 'operator')).toEqual(refused('OwnerApprovalRequired'));
    }
  });

  it('refuses a replayed approval, even when both relays race', async () => {
    const { chain } = setup();
    const approval = await sign(owner, v2, INVOICE_AMOUNT, 0n);

    const both = await Promise.all([
      chain.vaultSetPayee(v2, INVOICE_AMOUNT, approval, 'operator'),
      chain.vaultSetPayee(v2, INVOICE_AMOUNT, approval, 'operator'),
    ]);
    expect(both.map((r) => r.ok).sort()).toEqual([false, true]);
    expect(both.find((r) => !r.ok)).toEqual(refused('OwnerApprovalRequired'));

    expect(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, approval, 'operator')).toEqual(refused('OwnerApprovalRequired'));
    expect((await chain.readState()).signvault.nonce).toBe('1');
  });

  it('removes a payee when the amount is 0, and still moves the nonce', async () => {
    const { chain } = setup();
    expect(await chain.vaultSetPayee(v1, 0n, await sign(owner, v1, 0n, 0n), 'operator')).toEqual(sent);
    expect((await chain.readState()).signvault).toMatchObject({ nonce: '1', payees: [] });
    expect(await chain.vaultPay(v1)).toEqual(refused('NotOnTheList'));
  });

  it('changes the amount of a listed payee', async () => {
    const { chain } = setup();
    const amount = 3n * INVOICE_AMOUNT;
    expect(await chain.vaultSetPayee(v1, amount, await sign(owner, v1, amount, 0n), 'operator')).toEqual(sent);
    expect((await chain.readState()).signvault.payees).toEqual([{ to: v1, amount: wei(amount), paidThisPeriod: false }]);
    expect(await chain.vaultPay(v1)).toEqual(sent);
    expect((await chain.readState()).signvault.balance).toBe(wei(STARTING_BALANCE - amount));
  });
});

describe('days and periods', () => {
  it('refuses a second vault payment in the same period, and pays again next period', async () => {
    const { chain, advance } = setup();
    expect(await chain.vaultPay(v1)).toEqual(sent);
    expect(await chain.vaultPay(v1)).toEqual(refused('AlreadyPaidThisPeriod'));
    expect((await chain.readState()).signvault.balance).toBe(wei(STARTING_BALANCE - INVOICE_AMOUNT));

    advance(PERIOD_SECONDS);
    expect((await chain.readState()).signvault.payees[0].paidThisPeriod).toBe(false);
    expect(await chain.vaultPay(v1)).toEqual(sent);
  });

  it('resets the baseline total at the UTC day, but counts vault periods from deployment', async () => {
    const { chain, advance } = setup();
    expect(await chain.baselinePay(v1, INVOICE_AMOUNT)).toEqual(sent);
    expect(await chain.vaultPay(v1)).toEqual(sent);

    advance(HOUR);
    expect((await chain.readState()).baseline.spentToday).toBe('0');
    expect(await chain.baselinePay(v2, INVOICE_AMOUNT)).toEqual(sent);
    expect(await chain.vaultPay(v1)).toEqual(refused('AlreadyPaidThisPeriod'));
  });
});

describe('MockUSD transfer rules', () => {
  it('refuses a payment larger than the balance and changes nothing', async () => {
    const { chain } = setup();
    const big = STARTING_BALANCE + 1n;
    expect(await chain.baselineSetDailyCap(2n * big)).toEqual(sent);
    expect(await chain.baselinePay(v1, big)).toEqual(refused('ERC20InsufficientBalance'));
    expect((await chain.readState()).baseline).toMatchObject({ balance: wei(STARTING_BALANCE), spentToday: '0' });

    expect(await chain.vaultSetPayee(v2, big, await sign(owner, v2, big, 0n), 'operator')).toEqual(sent);
    expect(await chain.vaultPay(v2)).toEqual(refused('ERC20InsufficientBalance'));
    expect((await chain.readState()).signvault.payees[1].paidThisPeriod).toBe(false);
  });

  it('refuses a payment to the zero address', async () => {
    const { chain } = setup();
    expect(await chain.baselinePay(zeroAddress, INVOICE_AMOUNT)).toEqual(refused('ERC20InvalidReceiver'));
  });
});

describe('inputs viem would not encode', () => {
  it('treats addresses case-insensitively', async () => {
    const { chain } = setup();
    expect(await chain.vaultPay(v1.toLowerCase() as Address)).toEqual(sent);
  });

  it('throws viem encoder errors on a malformed address, a bad checksum, or an amount outside uint256', async () => {
    const { chain } = setup();
    const badChecksum = v1.replace(/[a-f]/, (c) => c.toUpperCase()) as Address;
    await expect(chain.vaultPay('0x1234')).rejects.toThrow(InvalidAddressError);
    await expect(chain.baselinePay(badChecksum, INVOICE_AMOUNT)).rejects.toThrow(InvalidAddressError);
    await expect(chain.baselinePay(v1, -1n)).rejects.toThrow(IntegerOutOfRangeError);
    await expect(chain.baselineSetDailyCap(2n ** 256n)).rejects.toThrow(IntegerOutOfRangeError);
  });
});

describe('nextPair', () => {
  it('moves to a fresh pair, where approvals for the old vault do not work', async () => {
    const { chain } = setup();
    await chain.baselinePay(v1, INVOICE_AMOUNT);
    await chain.vaultPay(v1);
    await chain.nextPair();

    const s = await chain.readState();
    expect(s.addresses).toMatchObject({ baselineWallet: d.pairs[1].baselineWallet, signVault: d.pairs[1].signVault });
    expect(s.baseline).toEqual({ balance: wei(STARTING_BALANCE), dailyCap: wei(INVOICE_AMOUNT), spentToday: '0' });
    expect(s.signvault).toEqual({ balance: wei(STARTING_BALANCE), nonce: '0', payees: [{ to: v1, amount: wei(INVOICE_AMOUNT), paidThisPeriod: false }] });

    const forOld = await sign(owner, v2, INVOICE_AMOUNT, 0n, d.pairs[0].signVault);
    expect(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, forOld, 'operator')).toEqual(refused('OwnerApprovalRequired'));
    const forNew = await sign(owner, v2, INVOICE_AMOUNT, 0n, d.pairs[1].signVault);
    expect(await chain.vaultSetPayee(v2, INVOICE_AMOUNT, forNew, 'operator')).toEqual(sent);
  });

  it('wraps to a fresh first pair after the last one', async () => {
    const { chain } = setup();
    await chain.vaultPay(v1);
    for (let i = 0; i < PAIR_COUNT; i++) await chain.nextPair();
    const s = await chain.readState();
    expect(s.addresses.signVault).toBe(d.pairs[0].signVault);
    expect(s.signvault.payees[0].paidThisPeriod).toBe(false);
  });
});
