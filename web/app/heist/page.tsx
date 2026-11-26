import type { Metadata } from 'next';
import { connection } from 'next/server';
import { heistConfig } from '@/lib/heist';
import { readHeist } from '@/lib/heist-chain';
import type { HeistRead } from '@/lib/heist-chain';
import { CopyButton, HeistLive } from './HeistLive';

export const metadata: Metadata = {
  title: 'SignVault open challenge',
  description: 'An open challenge: try to move mUSD out of a SignVault to an address that is not on its list.',
};

export default async function HeistPage() {
  await connection();
  const cfg = heistConfig(process.env);
  if (cfg.kind === 'closed') return <NotOpen />;
  if (cfg.kind === 'broken') return <NotOpen problem={cfg.problem} />;

  let read: HeistRead;
  try {
    read = await readHeist(cfg);
  } catch (err) {
    // The error can carry the RPC URL, which may hold an API key, so it stays in the server log.
    console.error('heist: reading the chain failed', err);
    return <NotOpen problem="The page could not read the chain, so it cannot check the vault and the key yet." />;
  }
  if (!read.ok) return <NotOpen problem={read.problem} />;
  const { view } = read;

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Open challenge: get the mUSD out of this SignVault</h1>
        <p className="text-neutral-600">
          Below is the private key of this vault&apos;s agent on {view.chainName}. It is the key an AI agent would hold. Use it
          however you like and try to send the vault&apos;s mUSD to an address that is not on its payee list. Every transaction
          sent straight to the vault that reverts is counted here, read from the chain.
        </p>
      </header>

      <section className="rounded-xl border-2 border-neutral-900 p-4">
        <h2 className="text-lg font-semibold">The rule</h2>
        <p className="mt-1">
          We pay <strong>{cfg.bountyUsd} USD</strong>, by hand, to anyone who gets mUSD out of this vault to an address that is not
          on its payee list. Tell the SignVault team, with the transaction link.
        </p>
      </section>

      <HeistLive initial={view} />

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
        <h2 className="text-lg font-semibold">The agent key</h2>
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This is a key on {view.chainName}, published for this challenge only. mUSD is a test token with no value, and gas is
          paid in the chain&apos;s test coin. Do not send real funds to this address.
        </p>
        <dl className="flex flex-col gap-2 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Agent address</dt>
            <dd className="break-all font-mono">{view.agent}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Agent private key</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code className="break-all font-mono">{cfg.agentKey}</code>
              <CopyButton text={cfg.agentKey} />
            </dd>
          </div>
        </dl>
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4">
        <h2 className="text-lg font-semibold">What the contract allows</h2>
        <ul className="list-disc pl-5 text-sm leading-6">
          <li>
            <code>pay(to)</code> works only when the agent calls it. It sends the amount the list sets for <code>to</code>, at most
            once per period. The caller cannot choose the amount, and an address that is not on the list gets nothing.
          </li>
          <li>
            The list changes only through <code>setPayee</code>, with an EIP-712 signature from the owner&apos;s wallet. Anyone may
            send that transaction, but the contract checks the owner&apos;s signature, and each signature works once, for this
            vault only.
          </li>
          <li>The contract has no other function that changes anything: no transfer, no withdrawal, no way to change the owner or the agent.</li>
        </ul>
        <p className="text-sm text-neutral-500">
          That is what the code says. The bounty is there in case we got it wrong.
        </p>
      </section>
    </main>
  );
}

function NotOpen({ problem }: { problem?: string }) {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-3 p-6">
      <h1 className="text-2xl font-semibold">SignVault open challenge</h1>
      <p className="text-neutral-600">The challenge is not open yet.</p>
      {problem && <p className="text-sm text-neutral-500">Setup: {problem}</p>}
    </main>
  );
}
