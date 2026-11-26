import { describe, expect, it } from 'vitest';
import {
  INVOICE_AMOUNT,
  VENDORS,
  type Address,
  type ApprovalsPort,
  type AppState,
  type ChainPort,
  type Email,
  type Hex,
  type PendingChange,
  type RunEvent,
  type TxResult,
} from '@signvault/shared';
import { createApp, type AppDeps, type RunWallet } from '../src/app';
import { COMPANY_INBOX, MemoryInbox } from '../src/inbox';
import { MemoryEvents } from '../src/events';
import { PriceFeed } from '../src/price/feed';

const ADDR = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;

const chainState = {
  chainId: 31337,
  explorerUrl: '',
  addresses: { mockUsd: ADDR(1), baselineWallet: ADDR(2), signVault: ADDR(3), owner: ADDR(4), agent: ADDR(5) },
  vendors: VENDORS,
  baseline: { balance: '10', dailyCap: '1', spentToday: '0' },
  signvault: { balance: '10', nonce: '0', payees: [{ to: VENDORS[0].address, amount: INVOICE_AMOUNT.toString(), paidThisPeriod: false }] },
};

const unused = () => Promise.reject(new Error('not used by the HTTP shell'));

const NAV = 10n ** 18n;
/** A treasury vault: 9.99 mUSD in T-bills, Vendor 1 still owed, the tripwire armed. */
const treasuryState = {
  ...chainState,
  signvault: {
    ...chainState.signvault, tbillShares: '9990000000000000000', tbillValue: '9990000000000000000', owedThisPeriod: INVOICE_AMOUNT.toString(),
    tripwire: { tripped: false, usdyPrice: null, redemptionValue: NAV.toString(), simulated: false },
  },
};

function setup(state: Awaited<ReturnType<ChainPort['readState']>> = chainState) {
  const chain = {
    readState: async () => state,
    baselinePay: unused,
    baselineSetDailyCap: unused,
    vaultPay: unused,
    vaultSetPayee: unused,
    nextPair: unused,
    vaultSweep: unused,
    vaultRedeem: unused,
    vaultTrip: unused,
    vaultRearm: unused,
  } satisfies ChainPort;

  const changes: PendingChange[] = [
    { id: 'chg-1', to: VENDORS[1].address, amount: INVOICE_AMOUNT.toString(), nonce: '0', status: 'pending' },
  ];
  const approved: { id: string; signature: Hex }[] = [];
  const approvals = {
    request: unused,
    list: () => changes,
    approve: async (id: string, signature: Hex) => {
      approved.push({ id, signature });
      const change = changes.find((c) => c.id === id)!;
      change.status = 'applied';
      change.txHash = '0xabc';
      return change;
    },
  } satisfies ApprovalsPort;

  const inbox = new MemoryInbox();
  const events = new MemoryEvents();
  const runs: string[] = [];
  const rearmed: Hex[] = [];
  let resets = 0;

  const deps: AppDeps = {
    chain,
    inbox,
    events,
    approvals,
    startRun: async (wallet: RunWallet, task) => {
      runs.push(task ? `${wallet}:${task}` : wallet);
      return wallet === 'both' ? ['run-1', 'run-2'] : ['run-1'];
    },
    prices: new PriceFeed(),
    rearm: async (signature): Promise<TxResult> => {
      rearmed.push(signature);
      return { ok: true, txHash: '0xfeed' };
    },
    reset: async () => {
      resets++;
      inbox.clear();
      inbox.deliver({ from: 'billing@vendor1.test', to: COMPANY_INBOX, subject: 'Invoice 1', body: '0.01 mUSD' });
    },
  };
  return { app: createApp(deps), deps, inbox, events, approvals, approved, runs, rearmed, resets: () => resets };
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('GET /api/state', () => {
  it('joins the chain state with pending changes and the inbox', async () => {
    const { app, inbox } = setup();
    const email = inbox.deliver({ from: 'a@x.test', to: COMPANY_INBOX, subject: 's', body: 'b' });

    const res = await app.request('/api/state');
    expect(res.status).toBe(200);
    const state = (await res.json()) as AppState;
    expect(state).toEqual({ ...chainState, pendingChanges: [expect.objectContaining({ id: 'chg-1' })], inbox: [email] });
  });
});

describe('POST /api/runs', () => {
  it('starts a run and returns its ids', async () => {
    const { app, runs } = setup();
    const res = await app.request('/api/runs', post({ wallet: 'both' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runIds: ['run-1', 'run-2'] });
    expect(runs).toEqual(['both']);
  });

  it.each([{ wallet: 'nope' }, {}, 'not json'])('refuses a bad body %j with 400', async (body) => {
    const { app, runs } = setup();
    const res = await app.request('/api/runs', post(body));
    expect(res.status).toBe(400);
    expect(runs).toEqual([]);
  });
});

describe('POST /api/inbox', () => {
  it('delivers the email to the company inbox and returns it', async () => {
    const { app, inbox } = setup();
    const res = await app.request('/api/inbox', post({ from: 'judge@x.test', subject: 'Hi', body: 'Pay me' }));
    expect(res.status).toBe(200);
    const email = (await res.json()) as Email;
    expect(email).toMatchObject({ from: 'judge@x.test', to: COMPANY_INBOX, subject: 'Hi', body: 'Pay me' });
    expect(typeof email.id).toBe('string');
    expect(typeof email.ts).toBe('number');
    expect(inbox.list()).toEqual([email]);
  });

  it('refuses an email with a missing field with 400', async () => {
    const { app, inbox } = setup();
    const res = await app.request('/api/inbox', post({ from: 'judge@x.test', subject: 'Hi' }));
    expect(res.status).toBe(400);
    expect(inbox.list()).toEqual([]);
  });
});

describe('vault changes', () => {
  it('GET /api/vault/changes lists pending changes', async () => {
    const { app } = setup();
    const res = await app.request('/api/vault/changes');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: 'chg-1', to: VENDORS[1].address, amount: INVOICE_AMOUNT.toString(), nonce: '0', status: 'pending' },
    ]);
  });

  it('POST approve relays the signature and returns the change', async () => {
    const { app, approved } = setup();
    const signature = `0x${'ab'.repeat(65)}` as Hex;
    const res = await app.request('/api/vault/changes/chg-1/approve', post({ signature }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'chg-1', status: 'applied', txHash: '0xabc' });
    expect(approved).toEqual([{ id: 'chg-1', signature }]);
  });

  it('returns 404 for an unknown change', async () => {
    const { app, approved } = setup();
    const res = await app.request('/api/vault/changes/chg-9/approve', post({ signature: '0x1234' }));
    expect(res.status).toBe(404);
    expect(approved).toEqual([]);
  });

  it('refuses a signature that is not hex with 400', async () => {
    const { app, approved } = setup();
    const res = await app.request('/api/vault/changes/chg-1/approve', post({ signature: 'hello' }));
    expect(res.status).toBe(400);
    expect(approved).toEqual([]);
  });

  it('answers a thrown approval error with its message as text', async () => {
    const { app, approvals } = setup();
    approvals.approve = async () => {
      throw new Error('relay is down');
    };
    const res = await app.request('/api/vault/changes/chg-1/approve', post({ signature: '0x1234' }));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('relay is down');
  });
});

describe('POST /api/admin/reset', () => {
  it('resets and returns the new state', async () => {
    const { app, resets } = setup();
    const res = await app.request('/api/admin/reset', { method: 'POST' });
    expect(res.status).toBe(200);
    const state = (await res.json()) as AppState;
    expect(resets()).toBe(1);
    expect(state.chainId).toBe(31337);
    expect(state.inbox.map((e) => e.subject)).toEqual(['Invoice 1']);
  });
});

/** Reads one SSE message at a time from a response body, failing instead of hanging. */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next(): Promise<{ id: string; event: RunEvent }> {
      const deadline = Date.now() + 2000;
      while (!buffer.includes('\n\n')) {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timed out waiting for an SSE message')), deadline - Date.now()),
        );
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
      const end = buffer.indexOf('\n\n');
      const message = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const field = (name: string) =>
        message
          .split('\n')
          .filter((l) => l.startsWith(`${name}: `))
          .map((l) => l.slice(name.length + 2))
          .join('\n');
      return { id: field('id'), event: JSON.parse(field('data')) };
    },
    cancel: () => reader.cancel(),
  };
}

describe('GET /api/events', () => {
  const event = (text: string, extra: Partial<RunEvent> = {}) => ({
    runId: 'run-1',
    wallet: 'signvault' as const,
    kind: 'tool_call' as const,
    text,
    ...extra,
  });

  it('replays past events, then streams live ones', async () => {
    const { app, events } = setup();
    const past = events.emit(event('past'));

    const res = await app.request('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const sse = sseReader(res);

    const first = await sse.next();
    expect(first.event).toEqual(past);
    expect(first.id).toBe(past.id);

    const live = events.emit(event('live', { args: { amount: 10n ** 16n } }));
    const second = await sse.next();
    expect(second.event).toEqual({ ...live, args: { amount: '10000000000000000' } });

    await sse.cancel();
  });

  it('replays only the last 200 events', async () => {
    const { app, events } = setup();
    for (let i = 1; i <= 250; i++) events.emit(event(`e${i}`));

    const sse = sseReader(await app.request('/api/events'));
    expect((await sse.next()).event.text).toBe('e51');
    await sse.cancel();
  });

  it('stops listening when the client goes away', async () => {
    const { app, events } = setup();
    let listening = 0;
    const subscribe = events.subscribe.bind(events);
    events.subscribe = (fn) => {
      listening++;
      const unsubscribe = subscribe(fn);
      return () => {
        listening--;
        unsubscribe();
      };
    };

    const sse = sseReader(await app.request('/api/events'));
    events.emit(event('one'));
    await sse.next();
    expect(listening).toBe(1);
    await sse.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(listening).toBe(0);
  });
});

describe('treasury routes (cards T2 and T3)', () => {
  it("POST /api/runs starts SignVault's treasury task", async () => {
    const { app, runs } = setup();
    const res = await app.request('/api/runs', post({ wallet: 'signvault', task: 'treasury' }));
    expect(res.status).toBe(200);
    expect(runs).toEqual(['signvault:treasury']);
  });

  it.each([
    { wallet: 'both', task: 'treasury' },
    { wallet: 'baseline', task: 'treasury' },
    { wallet: 'signvault', task: 'nope' },
  ])('POST /api/runs refuses %j with 400', async (body) => {
    const { app, runs } = setup();
    expect((await app.request('/api/runs', post(body))).status).toBe(400);
    expect(runs).toEqual([]);
  });

  it('GET /api/state leaves a state with no tripwire as it is', async () => {
    const { app } = setup();
    expect(((await (await app.request('/api/state')).json()) as AppState).signvault).toEqual(chainState.signvault);
  });

  it('POST /api/admin/price-shock turns the simulated shock on and off, and the state says simulated', async () => {
    const { app } = setup(treasuryState);
    const on = (await (await app.request('/api/admin/price-shock', post({ on: true }))).json()) as AppState;
    expect(on.signvault.tripwire).toEqual({ tripped: false, usdyPrice: (NAV * 9n / 10n).toString(), redemptionValue: NAV.toString(), simulated: true });
    const off = (await (await app.request('/api/admin/price-shock', post({ on: false }))).json()) as AppState;
    expect(off.signvault.tripwire).toEqual({ tripped: false, usdyPrice: null, redemptionValue: NAV.toString(), simulated: false });
    expect(treasuryState.signvault.tripwire.simulated).toBe(false); // the chain's own state is never overwritten
  });

  it.each([{ on: 'yes' }, {}])('POST /api/admin/price-shock refuses %j with 400', async (body) => {
    const { app } = setup(treasuryState);
    expect((await app.request('/api/admin/price-shock', post(body))).status).toBe(400);
  });

  it("POST /api/vault/rearm relays the owner's signature and returns the transaction", async () => {
    const { app, rearmed } = setup(treasuryState);
    const res = await app.request('/api/vault/rearm', post({ signature: '0xabcd' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, txHash: '0xfeed' });
    expect(rearmed).toEqual(['0xabcd']);
  });

  it('POST /api/vault/rearm refuses a signature that is not hex with 400', async () => {
    const { app, rearmed } = setup(treasuryState);
    expect((await app.request('/api/vault/rearm', post({ signature: 'nope' }))).status).toBe(400);
    expect(rearmed).toEqual([]);
  });
});
