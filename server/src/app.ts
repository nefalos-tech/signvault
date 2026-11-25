import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { ApprovalsPort, AppState, ChainPort, EventsPort, Hex, InboxPort, RunEvent, WalletKind } from '@signvault/shared';
import { COMPANY_INBOX } from './inbox';

export type RunWallet = WalletKind | 'both';

export interface AppDeps {
  chain: ChainPort;
  inbox: InboxPort;
  events: EventsPort;
  approvals: ApprovalsPort;
  /** Starts the runs and returns their ids at once. It must not wait for the runs to finish. */
  startRun(wallet: RunWallet): Promise<string[]>;
  /** Moves to the next wallet pair, clears the inbox and seeds the three invoices. */
  reset(): Promise<void>;
}

const REPLAY = 200;
const RUN_WALLETS: readonly string[] = ['baseline', 'signvault', 'both'] satisfies RunWallet[];
const HEX = /^0x[0-9a-fA-F]+$/;

/** Tool args and results may hold bigints, which plain JSON.stringify refuses. */
const toJson = (e: RunEvent) => JSON.stringify(e, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

async function readJson(req: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

export function createApp(deps: AppDeps) {
  const { chain, inbox, events, approvals } = deps;

  const buildState = async (): Promise<AppState> => ({
    ...(await chain.readState()),
    pendingChanges: approvals.list(),
    inbox: inbox.list(),
  });

  const app = new Hono().basePath('/api');
  app.use('*', cors());
  app.onError((err, c) => c.text(err.message, 500));

  app.get('/state', async (c) => c.json(await buildState()));

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      // Take the backlog and subscribe in the same tick, so no event falls between them.
      let writes = Promise.resolve();
      const send = (e: RunEvent) => {
        writes = writes.then(() => stream.writeSSE({ id: e.id, data: toJson(e) }));
      };
      events.recent(REPLAY).forEach(send);
      const unsubscribe = events.subscribe(send);
      await new Promise<void>((resolve) =>
        stream.onAbort(() => {
          unsubscribe();
          resolve();
        }),
      );
    }),
  );

  app.post('/runs', async (c) => {
    const { wallet } = await readJson(c.req);
    if (typeof wallet !== 'string' || !RUN_WALLETS.includes(wallet)) {
      return c.text("wallet must be 'baseline', 'signvault' or 'both'", 400);
    }
    return c.json({ runIds: await deps.startRun(wallet as RunWallet) });
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

  app.post('/admin/reset', async (c) => {
    await deps.reset();
    return c.json(await buildState());
  });

  return app;
}
