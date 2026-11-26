'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { musd } from '@/lib/format';
import type { HeistView } from '@/lib/heist-chain';

const POLL_MS = 4000;

type Poll = { open: false } | { open: true; view: HeistView } | { open: true; error: string };

/** The counters, the vault and the latest refusals, polled from /heist/state. */
export function HeistLive({ initial }: { initial: HeistView }) {
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    async function tick() {
      try {
        const body = (await (await fetch('/heist/state', { cache: 'no-store' })).json()) as Poll;
        if (stopped) return;
        if (!body.open) {
          // The challenge was closed on the server: reload to drop the key from the page.
          window.location.reload();
          return;
        }
        if ('view' in body) {
          setView(body.view);
          setError(null);
        } else {
          setError(body.error);
        }
      } catch {
        if (!stopped) setError('Could not reach this page\'s server just now.');
      }
    }
    const id = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  const link = (kind: 'address' | 'tx', value: string, label: ReactNode = value) =>
    view.explorerUrl ? (
      <a className="font-mono underline" href={`${view.explorerUrl}/${kind}/${value}`} target="_blank" rel="noreferrer">
        {label}
      </a>
    ) : (
      <span className="font-mono">{label}</span>
    );
  const behind = BigInt(view.head) - BigInt(view.scannedTo);

  return (
    <>
      <section className="flex flex-col gap-3">
        <div className="grid gap-4 sm:grid-cols-2">
          <Counter label="Refused transactions sent to the vault" value={String(view.refusedCount)} tone="red" />
          <Counter label="mUSD that left to an address not on the list" value={musd(view.outsiderWei)} tone={view.outsiderWei === '0' ? 'neutral' : 'red'} />
        </div>
        <p className="text-sm text-neutral-500">
          Read from {view.chainName}, blocks {BigInt(view.fromBlock) + 1n} to {view.scannedTo}
          {behind > 0n && <> (catching up: {behind.toString()} newer blocks still to read)</>}. A refused transaction is one sent to
          the vault whose receipt says it reverted. mUSD out is every MockUSD transfer from the vault, checked against the payee
          list at that moment.
          {error && <span className="text-red-700"> {error}</span>}
        </p>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
        <h2 className="text-lg font-semibold">The vault</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Item label="Vault">{link('address', view.vault)}</Item>
          <Item label="Balance">{musd(view.balance)}</Item>
          <Item label="Owner (signs list changes)">{link('address', view.owner)}</Item>
          <Item label="Agent (the key below)">{link('address', view.agent)}</Item>
        </dl>
        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500">Payee list</p>
          {view.payees.length === 0 && <p className="text-sm text-neutral-500">Empty.</p>}
          <ul className="flex flex-col text-sm">
            {view.payees.map((p) => (
              <li key={p.to} className="flex flex-wrap justify-between gap-2">
                <span className="break-all">{link('address', p.to)}</span>
                <span className="font-mono">{musd(p.amount)} per period</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {view.outsiderTransfers.length > 0 && (
        <section className="flex flex-col gap-2 rounded-xl border-2 border-red-600 p-4">
          <h2 className="text-lg font-semibold text-red-700">mUSD sent to an address not on the list</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {view.outsiderTransfers.map((x) => (
              <li key={x.hash} className="break-all">
                {musd(x.value)} to <span className="font-mono">{x.to}</span> · {link('tx', x.hash, 'transaction')}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4">
        <h2 className="text-lg font-semibold">Latest refused attempts</h2>
        {view.latestRefused.length === 0 ? (
          <p className="text-sm text-neutral-500">None yet.</p>
        ) : (
          <ol className="flex flex-col gap-1 text-sm">
            {view.latestRefused.map((r) => (
              <li key={r.hash} className="flex flex-wrap gap-x-2 rounded bg-red-50 px-2 py-1 text-red-800">
                <span className="font-mono text-xs leading-5 text-red-500">block {r.blockNumber}</span>
                <span className="min-w-0 flex-1 break-all font-mono">{r.call}</span>
                <span className="font-mono text-xs leading-5">from {r.from.slice(0, 6)}…{r.from.slice(-4)}</span>
                {link('tx', r.hash, view.explorerUrl ? 'transaction' : `${r.hash.slice(0, 10)}…`)}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function Counter({ label, value, tone }: { label: string; value: string; tone: 'red' | 'neutral' }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-neutral-200 p-4">
      <span className="text-sm text-neutral-600">{label}</span>
      <span data-counter={label} className={`font-mono text-4xl font-semibold ${tone === 'red' ? 'text-red-700' : 'text-neutral-900'}`}>
        {value}
      </span>
    </div>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="break-all">{children}</dd>
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="h-9 rounded-lg border border-neutral-300 px-3 text-sm font-semibold active:bg-neutral-100"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
