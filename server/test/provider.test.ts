import { describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import { BASELINE_DAILY_CAP, type ChainPort, type Email, type Hex, type InboxPort } from '@signvault/shared';
import { Provider } from '../src/provider';

const TX = `0x${'ab'.repeat(32)}` as Hex;

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

function stubChain() {
  let dailyCap = BASELINE_DAILY_CAP;
  const setCapCalls: bigint[] = [];
  const chain = {
    async readState() {
      return { baseline: { balance: '0', dailyCap: dailyCap.toString(), spentToday: '0' } };
    },
    async baselineSetDailyCap(newCap: bigint) {
      setCapCalls.push(newCap);
      dailyCap = newCap;
      return { ok: true as const, txHash: TX };
    },
  } as unknown as ChainPort;
  return { chain, setCapCalls };
}

const NEW_CAP = parseUnits('0.03', 18);

function codeFrom(email: Email): string {
  const m = email.body.match(/^Your code to change the daily limit to 0\.03 mUSD is (\d{6})\.$/);
  if (!m) throw new Error(`unexpected code email body: ${email.body}`);
  return m[1];
}

describe('Provider', () => {
  it('emails a six-digit code for the requested limit', async () => {
    const inbox = stubInbox();
    const { chain, setCapCalls } = stubChain();
    await new Provider(chain, inbox).requestCapChange(NEW_CAP);

    const [email] = inbox.list();
    expect(inbox.list()).toHaveLength(1);
    expect(email.from).toBe('no-reply@standardwallet.test');
    expect(email.subject).toBe('Your approval code');
    expect(codeFrom(email)).toMatch(/^\d{6}$/);
    expect(setCapCalls).toEqual([]);
  });

  it('the right code changes the cap on chain', async () => {
    const inbox = stubInbox();
    const { chain, setCapCalls } = stubChain();
    const provider = new Provider(chain, inbox);
    await provider.requestCapChange(NEW_CAP);

    const result = await provider.confirmCapChange(codeFrom(inbox.list()[0]));

    expect(result).toEqual({ ok: true, txHash: TX });
    expect(setCapCalls).toEqual([NEW_CAP]);
    expect((await chain.readState()).baseline.dailyCap).toBe(NEW_CAP.toString());
  });

  it('accepts the code with surrounding whitespace', async () => {
    const inbox = stubInbox();
    const { chain } = stubChain();
    const provider = new Provider(chain, inbox);
    await provider.requestCapChange(NEW_CAP);

    const result = await provider.confirmCapChange(` ${codeFrom(inbox.list()[0])}\n`);

    expect(result.ok).toBe(true);
  });

  it('a wrong code returns WrongCode and leaves the cap alone', async () => {
    const inbox = stubInbox();
    const { chain, setCapCalls } = stubChain();
    const provider = new Provider(chain, inbox);
    await provider.requestCapChange(NEW_CAP);
    const code = codeFrom(inbox.list()[0]);
    const wrong = code === '000000' ? '000001' : '000000';

    expect(await provider.confirmCapChange(wrong)).toEqual({ ok: false, error: 'WrongCode' });
    expect(await provider.confirmCapChange('abcdef')).toEqual({ ok: false, error: 'WrongCode' });
    expect(setCapCalls).toEqual([]);
    expect((await chain.readState()).baseline.dailyCap).toBe(BASELINE_DAILY_CAP.toString());

    // A wrong guess does not burn the real code.
    expect((await provider.confirmCapChange(code)).ok).toBe(true);
  });

  it('a code works once', async () => {
    const inbox = stubInbox();
    const { chain, setCapCalls } = stubChain();
    const provider = new Provider(chain, inbox);
    await provider.requestCapChange(NEW_CAP);
    const code = codeFrom(inbox.list()[0]);

    expect((await provider.confirmCapChange(code)).ok).toBe(true);
    expect(await provider.confirmCapChange(code)).toEqual({ ok: false, error: 'WrongCode' });
    expect(setCapCalls).toEqual([NEW_CAP]);
  });

  it('with no request pending, every code is wrong', async () => {
    const { chain, setCapCalls } = stubChain();
    expect(await new Provider(chain, stubInbox()).confirmCapChange('123456')).toEqual({ ok: false, error: 'WrongCode' });
    expect(setCapCalls).toEqual([]);
  });

  it('a new request replaces the old code', async () => {
    const inbox = stubInbox();
    const { chain, setCapCalls } = stubChain();
    const provider = new Provider(chain, inbox);
    await provider.requestCapChange(NEW_CAP);
    await provider.requestCapChange(NEW_CAP);
    const [first, second] = inbox.list().map(codeFrom);
    if (first === second) return; // one in a million: the two codes collide

    expect(await provider.confirmCapChange(first)).toEqual({ ok: false, error: 'WrongCode' });
    expect((await provider.confirmCapChange(second)).ok).toBe(true);
    expect(setCapCalls).toEqual([NEW_CAP]);
  });
});
