'use client';

import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { AppState, Email, PendingChange } from '@signvault/shared';
import { describeChange } from '@/lib/approve';
import { txUrl } from '@/lib/format';

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-neutral-200 p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function InboxPanel({ inbox }: { inbox: Email[] }) {
  return (
    <Panel title="Inbox">
      {inbox.length === 0 && <p className="text-sm text-neutral-500">Empty.</p>}
      <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto text-sm">
        {[...inbox].reverse().map((e) => (
          <li key={e.id} className="rounded-lg bg-neutral-50 px-3 py-2">
            <p className="font-medium">{e.subject}</p>
            <p className="text-xs text-neutral-500">{e.from}</p>
            <p className="mt-1 break-words text-neutral-700">{e.body}</p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function PendingChangesPanel({ state }: { state: AppState | undefined }) {
  const [approveUrl, setApproveUrl] = useState<string | null>(null);
  // The phone scans this, so it is whatever host the dashboard was opened on, not localhost.
  useEffect(() => setApproveUrl(`${window.location.origin}/approve`), []);
  const changes: PendingChange[] = state?.pendingChanges ?? [];

  return (
    <Panel title="Pending changes">
      {changes.length === 0 && <p className="text-sm text-neutral-500">Nothing waiting for the owner.</p>}
      <ul className="flex flex-col gap-2 text-sm">
        {changes.map((c) => (
          <li key={c.id} className="flex flex-col rounded-lg bg-neutral-50 px-3 py-2">
            <span className="font-medium">{describeChange(c, state?.vendors ?? [])}</span>
            <span className={c.status === 'failed' ? 'text-red-700' : c.status === 'applied' ? 'text-green-700' : 'text-amber-700'}>
              {c.status === 'pending' && 'Waiting for the owner'}
              {c.status === 'applied' && 'Approved by the owner'}
              {c.status === 'failed' && `Failed: ${c.error ?? 'unknown error'}`}
              {c.txHash && state && (
                <>
                  {' · '}
                  <a className="underline" href={txUrl(state.explorerUrl, c.txHash)} target="_blank" rel="noreferrer">view tx</a>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {approveUrl && (
        <div className="flex items-center gap-4">
          <QRCodeSVG value={approveUrl} size={112} marginSize={1} />
          <p className="text-sm text-neutral-600">
            Owner: scan to approve on your phone.
            <br />
            <span className="break-all font-mono text-xs">{approveUrl}</span>
          </p>
        </div>
      )}
    </Panel>
  );
}

export function FakeEmailPanel({ disabled, onSend }: { disabled: boolean; onSend: (e: { from: string; subject: string; body: string }) => Promise<void> }) {
  const [from, setFrom] = useState('no-reply@standardwallet.test');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<{ kind: 'idle' | 'sending' | 'sent' } | { kind: 'error'; message: string }>({ kind: 'idle' });

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setStatus({ kind: 'sending' });
    try {
      await onSend({ from, subject, body });
      setSubject('');
      setBody('');
      setStatus({ kind: 'sent' });
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const input = 'w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm disabled:bg-neutral-100';
  return (
    <Panel title="Send a fake email">
      <form onSubmit={submit} className="flex flex-col gap-2">
        <input className={input} aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} required disabled={disabled} />
        <input className={input} aria-label="Subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} required disabled={disabled} />
        <textarea className={input} aria-label="Body" placeholder="Body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} required disabled={disabled} />
        <button
          type="submit"
          disabled={disabled || status.kind === 'sending'}
          className="h-10 rounded-lg bg-neutral-900 text-sm font-semibold text-white disabled:opacity-50"
        >
          {status.kind === 'sending' ? 'Sending…' : 'Send to the inbox'}
        </button>
        {disabled && <p className="text-xs text-neutral-500">Needs the live server. Off in recorded mode.</p>}
        {status.kind === 'sent' && <p className="text-xs text-green-700">Delivered.</p>}
        {status.kind === 'error' && <p className="text-xs text-red-700">{status.message}</p>}
      </form>
    </Panel>
  );
}
