'use client';

import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { AppState, Email, PendingChange } from '@signvault/shared';
import { describeChange } from '@/lib/approve';
import { Card, CardDescription, ClockGlyph, PanelHead, TxLink, buttonClass, linkButtonClass } from './ui';

const PANEL = 'gap-[18px] p-5 min-[560px]:px-7 min-[560px]:py-6';

const STATUS: Record<PendingChange['status'], { text: string; row: string; pill: string }> = {
  pending: { text: 'Awaiting signature', row: 'border-dashed border-pending', pill: 'bg-primary-soft text-primary-text' },
  applied: { text: 'Approved by the owner', row: 'border-primary-border', pill: 'bg-primary text-primary-foreground' },
  failed: { text: 'Failed', row: 'border-destructive-border', pill: 'bg-destructive-soft text-destructive-text' },
};

export function PendingChangesPanel({ state }: { state: AppState | undefined }) {
  const [approveUrl, setApproveUrl] = useState<string | null>(null);
  // The phone scans this, so it is whatever host the dashboard was opened on, not localhost.
  useEffect(() => setApproveUrl(`${window.location.origin}/approve`), []);
  const changes: PendingChange[] = state?.pendingChanges ?? [];

  return (
    <Card className={PANEL} aria-labelledby="pending-title">
      <PanelHead
        icon="lock-shield"
        id="pending-title"
        title="Pending changes"
        description="The agent can request a change. Only a signature from the owner's phone can apply it."
      />
      {changes.length === 0 && <p className="text-sm text-subtle-foreground">Nothing waiting for the owner.</p>}
      {changes.length > 0 && (
        <ul className="flex flex-col gap-2">
          {changes.map((c) => (
            <li key={c.id} className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-[14px] border px-3.5 py-3 ${STATUS[c.status].row}`}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[15px] font-semibold">{describeChange(c, state?.vendors ?? [])}</span>
                <span className="text-[13px] text-muted-foreground">
                  Requested by the agent, nonce <span className="font-mono">{c.nonce}</span>
                  {c.txHash && (
                    <>
                      {', '}
                      <TxLink txHash={c.txHash} explorerUrl={state?.explorerUrl} text="view transaction" />
                    </>
                  )}
                  {c.status === 'failed' && <span className="text-destructive-text">, {c.error ?? 'unknown error'}</span>}
                </span>
              </span>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap ${STATUS[c.status].pill}`}>
                {c.status === 'pending' && <ClockGlyph />}
                {STATUS[c.status].text}
              </span>
            </li>
          ))}
        </ul>
      )}
      {approveUrl && (
        <div className="mt-auto flex flex-wrap items-center gap-[18px] rounded-[18px] border border-border bg-muted p-3.5 min-[560px]:flex-nowrap">
          <span role="img" aria-label="QR code that opens the approval page" className="flex size-[120px] flex-none rounded-xl border border-border bg-white p-1.5">
            <QRCodeSVG value={approveUrl} size={106} marginSize={1} fgColor="#0e0f2c" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="font-display text-base font-[650]">Approve on your phone</span>
            <CardDescription>Scan to open the approval page. The owner signs there, and the contract checks the signature.</CardDescription>
            <span className="text-[13px] break-all text-subtle-foreground">{approveUrl}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Who sent it, in a few words, and whether a code is inside. */
function sender(e: Email) {
  if (e.from === 'no-reply@standardwallet.test') return { text: 'Wallet provider, code inside', risk: true };
  if (e.from === 'no-reply@signvault.test') return { text: 'SignVault, no code', risk: false };
  return { text: e.from, risk: false };
}

const SHOWN = 3;

export function InboxPanel({ inbox, form }: { inbox: Email[]; form: ReactNode }) {
  const [showAll, setShowAll] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const newest = [...inbox].reverse();
  const earlier = newest.length - SHOWN;
  const to = inbox.find((e) => e.to)?.to;

  return (
    <Card className={PANEL} aria-labelledby="inbox-title">
      <PanelHead icon="gmail" id="inbox-title" title="Shared inbox" description={to ? `${to}, which the agent reads` : 'The inbox the agent reads'} />
      {inbox.length === 0 && <p className="text-sm text-subtle-foreground">Empty.</p>}
      <ul className="flex flex-col">
        {(showAll ? newest : newest.slice(0, SHOWN)).map((e) => {
          const from = sender(e);
          return (
            <li key={e.id} className="flex flex-col gap-0.5 border-b border-border py-2.5 last:border-b-0">
              <span className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                <span className="text-sm font-semibold">{e.subject}</span>
                <span className={`text-[13px] ${from.risk ? 'font-semibold text-destructive-text' : 'text-subtle-foreground'}`}>{from.text}</span>
              </span>
              <span className="line-clamp-1 text-[13px] leading-[1.45] break-words text-muted-foreground">{e.body}</span>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
        {earlier > 0 ? (
          <button type="button" className={linkButtonClass} aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show only the newest 3' : `Show ${earlier} earlier email${earlier === 1 ? '' : 's'}`}
          </button>
        ) : <span />}
        <button type="button" className={buttonClass('outline', 'sm')} aria-expanded={formOpen} aria-controls="fake-email" onClick={() => setFormOpen((v) => !v)}>
          Send a fake email
        </button>
      </div>
      <div id="fake-email" hidden={!formOpen}>{form}</div>
    </Card>
  );
}

export function FakeEmailForm({ disabled, onSend }: { disabled: boolean; onSend: (e: { from: string; subject: string; body: string }) => Promise<void> }) {
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

  const input = 'w-full rounded-xl border border-input bg-card px-3 py-2 text-sm disabled:bg-muted disabled:text-subtle-foreground';
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <input className={input} aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} required disabled={disabled} />
      <input className={input} aria-label="Subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} required disabled={disabled} />
      <textarea className={input} aria-label="Body" placeholder="Body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} required disabled={disabled} />
      <button type="submit" disabled={disabled || status.kind === 'sending'} className={buttonClass('default', 'sm')}>
        {status.kind === 'sending' ? 'Sending…' : 'Send to the inbox'}
      </button>
      {disabled && <p className="text-[13px] text-subtle-foreground">Needs the live server. Off in recorded mode.</p>}
      {status.kind === 'sent' && <p className="text-[13px] text-primary-text">Delivered.</p>}
      {status.kind === 'error' && <p className="text-[13px] text-destructive-text">{status.message}</p>}
    </form>
  );
}
