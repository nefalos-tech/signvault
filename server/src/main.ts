import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { formatUnits, type Account } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  INVOICE_AMOUNT, MUSD_DECIMALS,
  type Address, type ApprovalsPort, type ChainPort, type Email, type Hex, type LlmPort, type ProviderPort, type WalletKind,
} from '@signvault/shared';
import { loadDeployment } from '@signvault/shared/deployments';
import { runAgent } from './agent/loop';
import { createOpenAiLlm } from './agent/llm';
import { treasuryTask } from './agent/treasury';
import { createApp, type AppDeps } from './app';
import { Approvals } from './approvals';
import { FakeChain } from './chain/fake';
import { createViemChain } from './chain/viem';
import { MemoryEvents } from './events';
import { COMPANY_INBOX, MemoryInbox } from './inbox';
import { fetchUsdyPrice, USDY_CMC_ID } from './price/cmc';
import { PriceFeed } from './price/feed';
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

type ChainEnv = Partial<Record<'CHAIN' | 'RPC_URL' | 'OPERATOR_PRIVATE_KEY' | 'AGENT_PRIVATE_KEY' | 'PAIR' | 'DEPLOYMENT', string>>;

/**
 * CHAIN picks the port. On anvil the keys are optional: without them the node signs for the
 * deployment's unlocked agent and operator. PAIR is the wallet pair to start on, so a testnet
 * server can restart past the pairs it already used. DEPLOYMENT names another file in deployments/
 * for the same chain, such as `31337-passkey` from card T1's DeployPasskey.s.sol. With CHAIN=fake,
 * DEPLOYMENT=fake-treasury gives each vault the T-bill sleeve and tripwire of cards T2 and T3.
 */
export function createChain(env: ChainEnv): ChainPort {
  const chain = env.CHAIN || 'fake';
  if (chain === 'fake') return new FakeChain({ treasury: env.DEPLOYMENT === 'fake-treasury' });
  if (chain !== 'anvil' && chain !== 'bsctest') throw new Error(`CHAIN must be fake, anvil or bsctest, not "${chain}".`);

  if (chain === 'bsctest') {
    const missing = (['RPC_URL', 'OPERATOR_PRIVATE_KEY', 'AGENT_PRIVATE_KEY'] as const).filter((name) => !env[name]);
    if (missing.length > 0) throw new Error(`CHAIN=bsctest needs ${missing.join(', ')}.`);
  }
  const pair = Number(env.PAIR || 0);
  if (!Number.isInteger(pair) || pair < 0) throw new Error(`PAIR must be a wallet pair index, not "${env.PAIR}".`);
  const chainId = chain === 'anvil' ? 31337 : 97;
  // loadDeployment reads deployments/<which>.json, so any file name works there, though its type says number | 'fake'.
  const deployment = loadDeployment((env.DEPLOYMENT || chainId) as number);
  if (deployment.chainId !== chainId) {
    throw new Error(`DEPLOYMENT ${env.DEPLOYMENT} is for chain ${deployment.chainId}, not ${chain} (${chainId}).`);
  }
  return createViemChain({
    rpcUrl: env.RPC_URL || 'http://127.0.0.1:8545',
    deployment,
    agent: signer('AGENT_PRIVATE_KEY', env, deployment.agent),
    operator: signer('OPERATOR_PRIVATE_KEY', env, deployment.operator),
    pair,
  });
}

/** A key from env, or the unlocked address when it is unset. The error never repeats the key. */
function signer(name: 'AGENT_PRIVATE_KEY' | 'OPERATOR_PRIVATE_KEY', env: ChainEnv, unlocked: Address): Account | Address {
  const key = env[name];
  if (!key) return unlocked;
  try {
    return privateKeyToAccount(key as Hex);
  } catch {
    throw new Error(`${name} is not a valid private key.`);
  }
}

/**
 * Builds every port over one chain and one model, and seeds the inbox.
 * Reset swaps in a fresh Provider and Approvals behind stable ports, so an unused code
 * or a pending change from the last wallet pair cannot reach the next one.
 */
/**
 * Card T3: USDY's live price from CoinMarketCap. With CMC_API_KEY set it calls the Pro API, and without it the
 * keyless public API. `priceSource` names the endpoint for the treasury feed. The key goes only in the request
 * header: it is never logged, put in an event, or sent to the web.
 */
export function livePriceFeed(env: { CMC_API_KEY?: string }, fetchImpl: typeof fetch = fetch): { prices: PriceFeed; priceSource: string } {
  const key = env.CMC_API_KEY?.trim();
  return {
    prices: new PriceFeed(() => fetchUsdyPrice(key, fetchImpl)),
    priceSource: `CoinMarketCap ${key ? 'Pro API' : 'keyless public API'}, USDY id ${USDY_CMC_ID}`,
  };
}

export async function compose({ chain, llm, prices = new PriceFeed(), priceSource }: {
  chain: ChainPort; llm: LlmPort; prices?: PriceFeed; priceSource?: string;
}): Promise<AppDeps> {
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
    prices,
    async startRun(wallet, task) {
      const wallets: WalletKind[] = wallet === 'both' ? ['baseline', 'signvault'] : [wallet];
      return wallets.map((w) => {
        const run = runAgent({
          wallet: w, chain, inbox, provider: providerPort, approvals: approvalsPort, llm, events,
          ...(task === 'treasury' && { task: treasuryTask(prices, priceSource) }),
        });
        void run.done.then((r) => console.log(`run ${r.runId}: ${r.outcome} after ${r.toolCalls} tool calls`));
        return run.runId;
      });
    },
    /** Card T3: the operator relays the owner's Rearm. It spends the vault's nonce, so open payee changes move to the next one. */
    async rearm(signature) {
      const result = await chain.vaultRearm(signature);
      if (result.ok) approvals.syncNonce((await chain.readState()).signvault.nonce);
      events.emit({
        runId: `treasury-owner-${randomUUID().slice(0, 8)}`,
        wallet: 'signvault',
        ...(result.ok
          ? { kind: 'tx_sent', text: 'The owner signed the re-arm. Sweeping is unlocked.', txHash: result.txHash }
          : { kind: 'tx_refused', text: `Re-arm refused: ${result.error}.`, error: result.error, ...(result.txHash && { txHash: result.txHash }) }),
      });
      return result;
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
  const app = createApp(await compose({ chain, llm, ...livePriceFeed(process.env) }));
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
