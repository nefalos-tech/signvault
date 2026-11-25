import { describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BASELINE_DAILY_CAP,
  FAKE_KEY_LABELS,
  INVOICE_AMOUNT,
  labelKey,
  setPayeeTypedData,
  VENDORS,
  type Address,
  type ChainPort,
  type Email,
  type Hex,
  type InboxPort,
  type TxResult,
} from '@signvault/shared';
import { Approvals } from '../src/approvals';
import { FakeChain } from '../src/chain/fake';
import { Provider } from '../src/provider';

const VENDOR2 = VENDORS[1].address;
const VENDOR3 = VENDORS[2].address;
const SIG = `0x${'11'.repeat(65)}` as Hex;
const TX = `0x${'cd'.repeat(32)}` as Hex;

function stubInbox(): InboxPort {
  let emails: Email[] = [];
  return {
    list: () => [...emails],
    get: (id) => emails.find((e) => e.id === id),
    deliver: (e) => {
      const email = { ...e, id: `e${emails.length + 1}`, ts: Date.now() };
      emails.push(email);
      return email;
    },
    clear: () => { emails = []; },
  };
}

type SetPayeeCall = [to: Address, amount: bigint, approval: Hex, as: 'agent' | 'operator'];

function stubChain(setPayeeResult: TxResult = { ok: true, txHash: TX }) {
  let dailyCap = BASELINE_DAILY_CAP;
  const setPayeeCalls: SetPayeeCall[] = [];
  const setCapCalls: bigint[] = [];
  const chain = {
    async readState() {
      return {
        baseline: { balance: '0', dailyCap: dailyCap.toString(), spentToday: '0' },
        signvault: { balance: '0', nonce: '7', payees: [] },
      };
    },
    async baselineSetDailyCap(newCap: bigint) {
      setCapCalls.push(newCap);
      dailyCap = newCap;
      return { ok: true as const, txHash: TX };
    },
    async vaultSetPayee(...args: SetPayeeCall) {
      setPayeeCalls.push(args);
      return setPayeeResult;
    },
  } as unknown as ChainPort;
  return { chain, setPayeeCalls, setCapCalls };
}

describe('Approvals', () => {
  it('a request records a pending change at the vault nonce and emails a notice', async () => {
    const inbox = stubInbox();
    const { chain, setPayeeCalls } = stubChain();
    const approvals = new Approvals(chain, inbox);

    const change = await approvals.request(VENDOR2, INVOICE_AMOUNT);

    expect(change).toMatchObject({ to: VENDOR2, amount: '10000000000000000', nonce: '7', status: 'pending' });
    expect(change.id).toBeTruthy();
    expect(approvals.list()).toEqual([change]);
    expect(setPayeeCalls).toEqual([]);

    const [email] = inbox.list();
    expect(inbox.list()).toHaveLength(1);
    expect(email.from).toBe('no-reply@signvault.test');
    expect(email.subject).toBe('Approval needed on your phone');
    expect(email.body).toBe(
      `A change is waiting: add ${VENDOR2} at 0.01 mUSD per period. Open SignVault on your phone to approve. There is no code.`,
    );
  });

  // Reading of "no digits that work as a code": while a real code is pending, every six-digit
  // window of the notice's digits (non-digits stripped) is rejected by confirmCapChange.
  it('the notice has no digits that work as a code', async () => {
    const inbox = stubInbox();
    const { chain, setCapCalls } = stubChain();
    const provider = new Provider(chain, inbox);
    const approvals = new Approvals(chain, inbox);

    await approvals.request(VENDOR2, INVOICE_AMOUNT);
    const notice = inbox.list()[0];
    const digits = notice.body.replace(/\D/g, '');
    const windows = new Set<string>();
    for (let i = 0; i + 6 <= digits.length; i++) windows.add(digits.slice(i, i + 6));
    expect(windows.size).toBeGreaterThan(0);

    // Make a real code pending, re-requesting until it is not one of the windows by chance.
    const newCap = parseUnits('0.03', 18);
    let realCode = '';
    do {
      await provider.requestCapChange(newCap);
      realCode = inbox.list().at(-1)!.body.match(/is (\d{6})\.$/)![1];
    } while (windows.has(realCode));

    for (const w of windows) {
      expect(await provider.confirmCapChange(w)).toEqual({ ok: false, error: 'WrongCode' });
    }
    expect(setCapCalls).toEqual([]);

    // The provider was live the whole time: the real code still works.
    expect((await provider.confirmCapChange(realCode)).ok).toBe(true);
    expect(setCapCalls).toEqual([newCap]);
  });

  it('an approved change is relayed as the operator and ends applied with a tx hash', async () => {
    const { chain, setPayeeCalls } = stubChain();
    const approvals = new Approvals(chain, stubInbox());
    const { id } = await approvals.request(VENDOR2, INVOICE_AMOUNT);

    const approved = await approvals.approve(id, SIG);

    expect(setPayeeCalls).toEqual([[VENDOR2, INVOICE_AMOUNT, SIG, 'operator']]);
    expect(approved).toMatchObject({ id, status: 'applied', txHash: TX });
    expect(approved.error).toBeUndefined();
    expect(approvals.list()).toEqual([approved]);
  });

  it('a refused relay ends failed with the error and tx hash', async () => {
    const { chain } = stubChain({ ok: false, error: 'BadSignature', txHash: TX });
    const approvals = new Approvals(chain, stubInbox());
    const { id } = await approvals.request(VENDOR2, INVOICE_AMOUNT);

    const result = await approvals.approve(id, SIG);

    expect(result).toMatchObject({ id, status: 'failed', error: 'BadSignature', txHash: TX });
    expect(approvals.list()[0]).toEqual(result);
  });

  it('approving an applied change again does not relay twice', async () => {
    const { chain, setPayeeCalls } = stubChain();
    const approvals = new Approvals(chain, stubInbox());
    const { id } = await approvals.request(VENDOR2, INVOICE_AMOUNT);

    const first = await approvals.approve(id, SIG);
    const second = await approvals.approve(id, SIG);

    expect(second).toEqual(first);
    expect(setPayeeCalls).toHaveLength(1);
  });

  it('approving an unknown change rejects', async () => {
    const { chain, setPayeeCalls } = stubChain();
    await expect(new Approvals(chain, stubInbox()).approve('nope', SIG)).rejects.toThrow(/UnknownChange/);
    expect(setPayeeCalls).toEqual([]);
  });

  it('a failed change can be approved again, and success clears the error', async () => {
    const { chain, setPayeeCalls } = stubChain({ ok: false, error: 'BadSignature', txHash: TX });
    const approvals = new Approvals(chain, stubInbox());
    const { id } = await approvals.request(VENDOR2, INVOICE_AMOUNT);
    expect((await approvals.approve(id, SIG)).status).toBe('failed');

    chain.vaultSetPayee = async (...args: SetPayeeCall) => {
      setPayeeCalls.push(args);
      return { ok: true, txHash: TX };
    };
    const retried = await approvals.approve(id, SIG);

    expect(retried).toMatchObject({ id, status: 'applied', txHash: TX });
    expect(retried.error).toBeUndefined();
    expect(setPayeeCalls).toHaveLength(2);
  });

  it('callers cannot change recorded state through returned objects', async () => {
    const { chain } = stubChain();
    const approvals = new Approvals(chain, stubInbox());
    const change = await approvals.request(VENDOR2, INVOICE_AMOUNT);

    change.status = 'applied';
    approvals.list()[0].status = 'failed';

    expect(approvals.list()[0].status).toBe('pending');
  });

  // Seen live on anvil: the agent files Vendor 2 and Vendor 3 at nonce 0, the owner approves one,
  // and the other could never be approved because /approve signed the stale nonce it carried.
  it('every pending change stays approvable, in any order, after another one applies', async () => {
    const chain = new FakeChain();
    const approvals = new Approvals(chain, stubInbox());
    const owner = privateKeyToAccount(labelKey(FAKE_KEY_LABELS.owner));
    // What /approve does: sign SetPayee over the nonce the pending change carries.
    const ownerSigns = async (change: { to: Address; amount: string; nonce: string }) => {
      const { chainId, addresses } = await chain.readState();
      return owner.signTypedData(setPayeeTypedData({
        chainId, vault: addresses.signVault, to: change.to, amount: BigInt(change.amount), nonce: BigInt(change.nonce),
      }));
    };

    const v2 = await approvals.request(VENDOR2, INVOICE_AMOUNT);
    const v3 = await approvals.request(VENDOR3, INVOICE_AMOUNT);
    expect([v2.nonce, v3.nonce]).toEqual(['0', '0']);

    const first = await approvals.approve(v3.id, await ownerSigns(v3));
    expect(first).toMatchObject({ status: 'applied' });

    const left = approvals.list().find((c) => c.id === v2.id)!;
    expect(left).toMatchObject({ status: 'pending', nonce: (await chain.readState()).signvault.nonce });
    const second = await approvals.approve(left.id, await ownerSigns(left));

    expect(second).toMatchObject({ status: 'applied' });
    expect(second.error).toBeUndefined();
    const { signvault } = await chain.readState();
    expect(signvault.nonce).toBe('2');
    expect(signvault.payees.map((p) => p.to)).toEqual(expect.arrayContaining([VENDOR2, VENDOR3]));
  });

  // The spec is silent. Chosen: a request matching an open change (same payee and amount, not yet
  // applied) returns that change as it stands and sends no second notice.
  it('a request for a change that is already open adds no row and sends no second notice', async () => {
    const inbox = stubInbox();
    const { chain } = stubChain();
    const approvals = new Approvals(chain, inbox);

    const first = await approvals.request(VENDOR2, INVOICE_AMOUNT);
    const again = await approvals.request(VENDOR2.toLowerCase() as Address, INVOICE_AMOUNT);

    expect(again).toEqual(first);
    expect(approvals.list()).toEqual([first]);
    expect(inbox.list()).toHaveLength(1);

    // A different amount, or the same change once applied, is a new request.
    await approvals.request(VENDOR2, INVOICE_AMOUNT * 2n);
    await approvals.approve(first.id, SIG);
    await approvals.request(VENDOR2, INVOICE_AMOUNT);
    expect(approvals.list()).toHaveLength(3);
    expect(inbox.list()).toHaveLength(3);
  });
});
