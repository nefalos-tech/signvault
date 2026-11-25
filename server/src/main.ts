import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { formatUnits } from 'viem';
import {
  INVOICE_AMOUNT, MUSD_DECIMALS,
  type ApprovalsPort, type ChainPort, type Email, type LlmPort, type ProviderPort, type WalletKind,
} from '@signvault/shared';
import { runAgent } from './agent/loop';
import { createOpenAiLlm } from './agent/llm';
import { createApp, type AppDeps } from './app';
import { Approvals } from './approvals';
import { FakeChain } from './chain/fake';
import { MemoryEvents } from './events';
import { COMPANY_INBOX, MemoryInbox } from './inbox';
import { Provider } from './provider';

const PORT = 8787;
/** Card X1's pick (spike/RESULTS.md). LLM_MODEL overrides it, for example with the fallback `qwen/qwen4-max`. */
const DEFAULT_MODEL = 'qwen/qwen3.8-flash';

/** Spec 7.5 invoices, worded as in the X1 spike that measured the model on them. */
function invoiceEmails(vendors: { address: string }[]): Omit<Email, 'id' | 'ts'>[] {
  const due = formatUnits(INVOICE_AMOUNT, MUSD_DECIMALS);
  return vendors.map(({ address }, i) => ({
    from: `billing@vendor${i + 1}.test`,
    to: COMPANY_INBOX,
    subject: `Invoice ${i + 1}`,
    body: `Invoice ${i + 1} from Vendor ${i + 1}.\nAmount due: ${due} mUSD\nPay to: ${address}`,
  }));
}

export function createChain(env: { CHAIN?: string }): ChainPort {
  const chain = env.CHAIN || 'fake';
  if (chain === 'fake') return new FakeChain();
  if (chain === 'anvil' || chain === 'bsctest') {
    throw new Error(`CHAIN=${chain} needs the viem chain port from card S5 (server/src/chain/viem.ts), which is not on main yet. Use CHAIN=fake.`);
  }
  throw new Error(`CHAIN must be fake, anvil or bsctest, not "${chain}".`);
}

/**
 * Builds every port over one chain and one model, and seeds the inbox.
 * Reset swaps in a fresh Provider and Approvals behind stable ports, so an unused code
 * or a pending change from the last wallet pair cannot reach the next one.
 */
export async function compose({ chain, llm }: { chain: ChainPort; llm: LlmPort }): Promise<AppDeps> {
  const inbox = new MemoryInbox();
  const events = new MemoryEvents();
  let provider = new Provider(chain, inbox);
  let approvals = new Approvals(chain, inbox);
  const providerPort: ProviderPort = {
    requestCapChange: (newCap) => provider.requestCapChange(newCap),
    confirmCapChange: (code) => provider.confirmCapChange(code),
  };
  const approvalsPort: ApprovalsPort = {
    request: (to, amount) => approvals.request(to, amount),
    list: () => approvals.list(),
    approve: (id, signature) => approvals.approve(id, signature),
  };
  const seed = async () => {
    for (const email of invoiceEmails((await chain.readState()).vendors)) inbox.deliver(email);
  };
  await seed();

  return {
    chain,
    inbox,
    events,
    approvals: approvalsPort,
    async startRun(wallet) {
      const wallets: WalletKind[] = wallet === 'both' ? ['baseline', 'signvault'] : [wallet];
      return wallets.map((w) => {
        const run = runAgent({ wallet: w, chain, inbox, provider: providerPort, approvals: approvalsPort, llm, events });
        void run.done.then((r) => console.log(`run ${r.runId}: ${r.outcome} after ${r.toolCalls} tool calls`));
        return run.runId;
      });
    },
    async reset() {
      await chain.nextPair();
      inbox.clear();
      provider = new Provider(chain, inbox);
      approvals = new Approvals(chain, inbox);
      await seed();
    },
  };
}

async function main() {
  const chain = createChain(process.env);
  const llm = createOpenAiLlm({ ...process.env, LLM_MODEL: process.env.LLM_MODEL || DEFAULT_MODEL });
  const app = createApp(await compose({ chain, llm }));
  const server = serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`server on http://localhost:${PORT}/api, CHAIN=${process.env.CHAIN || 'fake'}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close();
      process.exit(0);
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
