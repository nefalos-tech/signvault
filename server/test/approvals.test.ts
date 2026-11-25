import { describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import {
  BASELINE_DAILY_CAP,
  INVOICE_AMOUNT,
  VENDORS,
  type Address,
  type ChainPort,
  type Email,
  type Hex,
  type InboxPort,
  type TxResult,
} from '@signvault/shared';
import { Approvals } from '../src/approvals';
import { Provider } from '../src/provider';

const VENDOR2 = VENDORS[1].address;
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
    await expect(new Approvals(chain, stubInbox()).approve('nope', SIG)).rejects.toThrow();
    expect(setPayeeCalls).toEqual([]);
  });

  it('callers cannot change recorded state through returned objects', async () => {
    const { chain } = stubChain();
    const approvals = new Approvals(chain, stubInbox());
    const change = await approvals.request(VENDOR2, INVOICE_AMOUNT);

    change.status = 'applied';
    approvals.list()[0].status = 'failed';

    expect(approvals.list()[0].status).toBe('pending');
  });
});
