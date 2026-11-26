import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { ApprovalsPort, AppState, ChainPort, EventsPort, Hex, InboxPort, RunEvent, TxResult, WalletKind } from '@signvault/shared';
import { COMPANY_INBOX } from './inbox';
import type { PriceFeed } from './price/feed';

export type RunWallet = WalletKind | 'both';
/** The payroll run of spec 7.4, or SignVault's treasury run (cards T2 and T3). */
export type RunTask = 'payroll' | 'treasury';

export interface AppDeps {
  chain: ChainPort;
  inbox: InboxPort;
  events: EventsPort;
  approvals: ApprovalsPort;
  /** Starts the runs and returns their ids at once. It must not wait for the runs to finish. */
  startRun(wallet: RunWallet, task?: RunTask): Promise<string[]>;
  /** The USDY price the treasury agent and the dashboard both see, with the simulated shock. */
  prices: PriceFeed;
  /** Relays the owner's Rearm signature to the vault (card T3). */
  rearm(signature: Hex): Promise<TxResult>;
  /** Moves to the next wallet pair, clears the inbox and seeds the three invoices. */
  reset(): Promise<void>;
  /** How often GET /api/events writes a comment while nothing else happens. Defaults to 15 s. */
  heartbeatMs?: number;
}

const REPLAY = 200;
/** The web app's Next proxy and the Cloudflare tunnel close a stream that sends no bytes for 30 s. */
const HEARTBEAT_MS = 15_000;
const RUN_WALLETS: readonly string[] = ['baseline', 'signvault', 'both'] satisfies RunWallet[];
const RUN_TASKS: readonly string[] = ['payroll', 'treasury'] satisfies RunTask[];
const HEX = /^0x[0-9a-fA-F]+$/;

/** Tool args and results may hold bigints, which plain JSON.stringify refuses. */
const toJson = (e: RunEvent) => JSON.stringify(e, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

async function readJson(req: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

export function createApp(deps: AppDeps) {
  const { chain, inbox, events, approvals, prices, heartbeatMs = HEARTBEAT_MS } = deps;

  const buildState = async (): Promise<AppState> => {
    const state = await chain.readState();
    // The chain knows the tripwire and the redemption value; the price comes from the same feed the agent reads.
    const tripwire = state.signvault.tripwire;
    const quote = tripwire && (await prices.quote(BigInt(tripwire.redemptionValue)));
    const signvault = tripwire && quote
      ? { ...state.signvault, tripwire: { ...tripwire, usdyPrice: quote.price?.toString() ?? null, simulated: quote.simulated } }
      : state.signvault;
    return { ...state, signvault, pendingChanges: approvals.list(), inbox: inbox.list() };
  };

  const app = new Hono().basePath('/api');
  app.use('*', cors());
  app.onError((err, c) => c.text(err.message, 500));

  app.get('/state', async (c) => c.json(await buildState()));

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      // One chain, so frames never interleave.
      let writes = Promise.resolve();
      const enqueue = (write: () => Promise<unknown>) => {
        writes = writes.then(write).then(
          () => {},
          (err: unknown) => console.error('GET /api/events dropped a frame:', err),
        );
      };
      const send = (e: RunEvent) => enqueue(() => stream.writeSSE({ id: e.id, data: toJson(e) }));
      // The proxy sends no headers until the first byte, so open with a comment. EventSource fires nothing for one.
      enqueue(() => stream.write(': connected\n\n'));
      // Take the backlog and subscribe in the same tick, so no event falls between them.
      events.recent(REPLAY).forEach(send);
      const unsubscribe = events.subscribe(send);
      const heartbeat = setInterval(() => enqueue(() => stream.write(': ping\n\n')), heartbeatMs);
      await new Promise<void>((resolve) =>
        stream.onAbort(() => {
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        }),
      );
    }),
  );

  app.post('/runs', async (c) => {
    const { wallet, task } = await readJson(c.req);
    if (typeof wallet !== 'string' || !RUN_WALLETS.includes(wallet)) {
      return c.text("wallet must be 'baseline', 'signvault' or 'both'", 400);
    }
    if (task !== undefined && (typeof task !== 'string' || !RUN_TASKS.includes(task))) {
      return c.text("task must be 'payroll' or 'treasury'", 400);
    }
    if (task === 'treasury' && wallet !== 'signvault') return c.text("the treasury task runs on 'signvault' only", 400);
    return c.json({ runIds: await deps.startRun(wallet as RunWallet, task as RunTask | undefined) });
  });

  app.post('/inbox', async (c) => {
    const { from, subject, body } = await readJson(c.req);
    if (typeof from !== 'string' || typeof subject !== 'string' || typeof body !== 'string') {
      return c.text('from, subject and body must be strings', 400);
    }
    return c.json(inbox.deliver({ from, to: COMPANY_INBOX, subject, body }));
  });

  app.get('/vault/changes', (c) => c.json(approvals.list()));

  app.post('/vault/changes/:id/approve', async (c) => {
    const id = c.req.param('id');
    const { signature } = await readJson(c.req);
    if (typeof signature !== 'string' || !HEX.test(signature)) return c.text('signature must be 0x-prefixed hex', 400);
    if (!approvals.list().some((ch) => ch.id === id)) return c.text(`no pending change ${id}`, 404);
    return c.json(await approvals.approve(id, signature as Hex));
  });

  app.post('/vault/rearm', async (c) => {
    const { signature } = await readJson(c.req);
    if (typeof signature !== 'string' || !HEX.test(signature)) return c.text('signature must be 0x-prefixed hex', 400);
    return c.json(await deps.rearm(signature as Hex));
  });

  /** A test price shock, never a real price: the state and every agent line that shows it say "simulated". */
  app.post('/admin/price-shock', async (c) => {
    const { on } = await readJson(c.req);
    if (typeof on !== 'boolean') return c.text('on must be true or false', 400);
    prices.shock(on);
    return c.json(await buildState());
  });

  app.post('/admin/reset', async (c) => {
    await deps.reset();
    return c.json(await buildState());
  });

  return app;
}
