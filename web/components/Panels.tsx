'use client';

import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { AppState, Email, PendingChange } from '@signvault/shared';
import { describeChange } from '@/lib/approve';
import { txUrl } from '@/lib/format';
import { SectionLabel } from './WalletColumn';

function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <section className={`min-w-0 rounded-xl border border-line bg-white px-4 py-5 shadow-xs sm:px-6 ${className}`}>{children}</section>;
}

const STATUS: Record<PendingChange['status'], { text: string; pill: string }> = {
  pending: { text: 'Awaiting signature', pill: 'border-wait-200 bg-wait-50 text-wait-700' },
  applied: { text: 'Approved by the owner', pill: 'border-good-200 bg-good-50 text-good-700' },
  failed: { text: 'Failed', pill: 'border-bad-200 bg-bad-50 text-bad-700' },
};

export function PendingChangesPanel({ state }: { state: AppState | undefined }) {
  const [approveUrl, setApproveUrl] = useState<string | null>(null);
  // The phone scans this, so it is whatever host the dashboard was opened on, not localhost.
  useEffect(() => setApproveUrl(`${window.location.origin}/approve`), []);
  const changes: PendingChange[] = state?.pendingChanges ?? [];

  return (
    <Card className="flex flex-wrap items-center justify-between gap-5">
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-2.5">
        <SectionLabel>Pending changes</SectionLabel>
        {changes.length === 0 && <p className="text-sm text-faint">Nothing waiting for the owner.</p>}
        <ul className="flex flex-col gap-2">
          {changes.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-[10px] border border-line px-3.5 py-3">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-semibold">{describeChange(c, state?.vendors ?? [])}</span>
                <span className="text-xs text-faint">
                  Requested by the agent · nonce <span className="font-mono">{c.nonce}</span>
                  {c.txHash && state?.explorerUrl && (
                    <>
                      {' · '}
                      <a className="text-link hover:underline" href={txUrl(state.explorerUrl, c.txHash)} target="_blank" rel="noreferrer">view tx</a>
                    </>
                  )}
                  {c.status === 'failed' && <span className="text-bad-700"> · {c.error ?? 'unknown error'}</span>}
                </span>
              </span>
              <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${STATUS[c.status].pill}`}>
                {STATUS[c.status].text}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-[13px] text-muted">The agent can request a change. Only a signature from the owner&apos;s phone can apply it.</p>
      </div>
      {approveUrl && (
        <div className="flex items-center gap-3.5">
          <QRCodeSVG value={approveUrl} size={96} marginSize={1} className="flex-none rounded-[10px] border border-line" />
          <div className="flex max-w-48 flex-col gap-1">
            <span className="text-sm font-semibold">Approve on your phone</span>
            <span className="text-[13px] text-faint">Scan to open the approval page.</span>
            <span className="font-mono text-xs break-all text-faint">{approveUrl}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Who sent it, in a few words, and whether a code is inside. */
function sender(e: Email) {
  if (e.from === 'no-reply@standardwallet.test') return { text: 'Wallet provider · code inside', tone: 'text-bad-700' };
  if (e.from === 'no-reply@signvault.test') return { text: 'SignVault · no code', tone: 'text-faint' };
  return { text: e.from, tone: 'text-faint' };
}

export function InboxPanel({ inbox, form }: { inbox: Email[]; form: ReactNode }) {
  return (
    <Card className="flex flex-col gap-2.5">
      <SectionLabel>Shared inbox</SectionLabel>
      {inbox.length === 0 && <p className="text-sm text-faint">Empty.</p>}
      <ul className="flex max-h-80 flex-col overflow-y-auto">
        {[...inbox].reverse().map((e) => {
          const from = sender(e);
          return (
            <li key={e.id} className="flex flex-col gap-0.5 border-b border-chip py-2.5 last:border-b-0">
              <span className="flex flex-wrap justify-between gap-x-3">
                <span className="text-sm font-medium">{e.subject}</span>
                <span className={`text-xs ${from.tone}`}>{from.text}</span>
              </span>
              <span className="line-clamp-2 text-xs break-words text-muted">{e.body}</span>
            </li>
          );
        })}
      </ul>
      {form}
    </Card>
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

  const input = 'w-full rounded-lg border border-line-2 bg-white px-3 py-2 text-sm disabled:bg-chip';
  return (
    <details className="group">
      <summary className="inline-flex min-h-9 cursor-pointer list-none items-center rounded-lg border border-line-2 bg-white px-3 text-[13px] font-semibold text-ink-2 hover:bg-canvas [&::-webkit-details-marker]:hidden">
        Send a fake email
      </summary>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
        <input className={input} aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} required disabled={disabled} />
        <input className={input} aria-label="Subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} required disabled={disabled} />
        <textarea className={input} aria-label="Body" placeholder="Body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} required disabled={disabled} />
        <button
          type="submit"
          disabled={disabled || status.kind === 'sending'}
          className="h-10 rounded-lg bg-ink text-sm font-semibold text-white disabled:opacity-50"
        >
          {status.kind === 'sending' ? 'Sending…' : 'Send to the inbox'}
        </button>
        {disabled && <p className="text-xs text-faint">Needs the live server. Off in recorded mode.</p>}
        {status.kind === 'sent' && <p className="text-xs text-good-700">Delivered.</p>}
        {status.kind === 'error' && <p className="text-xs text-bad-700">{status.message}</p>}
      </form>
    </details>
  );
}
