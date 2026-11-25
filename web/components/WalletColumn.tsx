'use client';

import type { ReactNode } from 'react';
import type { AppState, RunEvent } from '@signvault/shared';
import { shortAddress } from '@/lib/approve';
import { musd, payeeName } from '@/lib/format';
import { EventFeed } from './EventFeed';

interface Props {
  title: string;
  subtitle: string;
  address: string | undefined;
  events: RunEvent[];
  explorerUrl: string | undefined;
  children: ReactNode;
}

/** One side of the dashboard: the wallet's rules on top, its run feed below. */
export function WalletColumn({ title, subtitle, address, events, explorerUrl, children }: Props) {
  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-neutral-200">
      <header className="flex flex-col gap-3 border-b border-neutral-200 p-4">
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="text-sm text-neutral-500">
            {subtitle}
            {address && explorerUrl && (
              <>
                {' · '}
                <a className="font-mono underline" href={`${explorerUrl}/address/${address}`} target="_blank" rel="noreferrer">
                  {shortAddress(address)}
                </a>
              </>
            )}
          </p>
        </div>
        {children}
      </header>
      <EventFeed events={events} explorerUrl={explorerUrl} />
    </section>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="font-mono text-base">{value}</dd>
    </div>
  );
}

export function BaselineRules({ baseline }: { baseline: AppState['baseline'] | undefined }) {
  if (!baseline) return <p className="text-sm text-neutral-500">Waiting for the server…</p>;
  return (
    <dl className="grid grid-cols-3 gap-3">
      <Stat label="Balance" value={musd(baseline.balance)} />
      <Stat label="Daily limit" value={musd(baseline.dailyCap)} />
      <Stat label="Spent today" value={musd(baseline.spentToday)} />
    </dl>
  );
}

export function VaultRules({ state }: { state: AppState | undefined }) {
  if (!state) return <p className="text-sm text-neutral-500">Waiting for the server…</p>;
  const { signvault, vendors } = state;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-3 gap-3">
        <Stat label="Balance" value={musd(signvault.balance)} />
        <Stat label="Owner nonce" value={signvault.nonce} />
      </dl>
      <div>
        <p className="text-xs uppercase tracking-wide text-neutral-500">Payee list</p>
        {signvault.payees.length === 0 && <p className="text-sm text-neutral-500">Empty.</p>}
        <ul className="flex flex-col text-sm">
          {signvault.payees.map((p) => (
            <li key={p.to} className="flex justify-between gap-2 font-mono">
              <span>{payeeName(p.to, vendors)}</span>
              <span>
                {musd(p.amount)} per day{' '}
                <span className={p.paidThisPeriod ? 'text-green-700' : 'text-neutral-400'}>
                  {p.paidThisPeriod ? '· paid' : '· unpaid'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
