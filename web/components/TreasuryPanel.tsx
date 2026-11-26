'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { RunEvent } from '@signvault/shared';
import { TRIP_PERCENT, type TreasuryView, type TripwireView } from '@/lib/treasury';
import { EventFeed } from './EventFeed';
import { SectionLabel, StepRow } from './WalletColumn';

interface Props {
  view: TreasuryView;
  /** The treasury events, for the raw feed. */
  events: RunEvent[];
  explorerUrl: string | undefined;
  /** Off in recorded mode, which has no server to run the task or move the price. */
  disabled: boolean;
  onRun: () => void;
  onShock: (on: boolean) => void;
}

/** SignVault's treasury (cards T2 and T3): spare cash in T-bills above the payroll floor, and the tripwire. */
export function TreasuryPanel({ view, events, explorerUrl, disabled, onRun, onShock }: Props) {
  const shockOn = view.tripwire?.source === 'simulated';
  return (
    <section className="flex flex-col gap-3.5 border-t border-line px-4 py-4.5 sm:px-6" aria-label="Treasury">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <SectionLabel>Treasury</SectionLabel>
          <span className="text-[13px] text-faint">Rule: spare cash goes into T-bills, never below this period&apos;s unpaid payroll</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {view.tripwire && (
            <button
              type="button"
              onClick={() => onShock(!shockOn)}
              disabled={disabled}
              aria-pressed={shockOn}
              className={`min-h-10 rounded-lg border px-3.5 text-sm font-semibold disabled:opacity-50 ${shockOn ? 'border-wait-200 bg-wait-50 text-wait-700' : 'border-line-2 bg-white text-ink-2 hover:bg-canvas'}`}
            >
              Simulate a price shock: {shockOn ? 'on' : 'off'}
            </button>
          )}
          <button
            type="button"
            onClick={onRun}
            disabled={disabled || view.status === 'running'}
            className="min-h-10 rounded-lg border border-ink bg-ink px-3.5 text-sm font-semibold text-white active:bg-ink-2 disabled:opacity-50"
          >
            {view.status === 'running' ? 'Treasury task running…' : 'Run the treasury task'}
          </button>
        </div>
      </div>

      <dl className="grid overflow-hidden rounded-[10px] border border-line sm:grid-cols-3">
        <Cell label="Cash" value={view.cash} unit="mUSD" />
        <Cell label="In T-bills" value={view.inTbills} unit="mUSD" note="yield simulated" />
        <Cell label="Payroll still owed this period" value={view.owed} unit="mUSD" note="the floor a sweep can't go below" />
      </dl>

      {view.tripwire && <Tripwire t={view.tripwire} />}

      {view.steps.length > 0 && (
        <ol className="flex flex-col gap-0.5">
          {view.steps.map((s, i) => <StepRow key={i} step={s} explorerUrl={explorerUrl} />)}
        </ol>
      )}
      {events.length > 0 && (
        <details className="group">
          <summary className="inline-flex min-h-10 cursor-pointer list-none items-center rounded-lg border border-line-2 bg-white px-3 text-[13px] font-semibold text-ink-2 hover:bg-canvas [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">View raw treasury events ({events.length})</span>
            <span className="hidden group-open:inline">Hide raw treasury events ({events.length})</span>
          </summary>
          <div className="mt-3 rounded-lg border border-line">
            <EventFeed events={events} explorerUrl={explorerUrl} />
          </div>
        </details>
      )}

      <p className="text-xs text-faint">
        mUSD stands in for USDT/USDC. mUSDY stands in for a tokenized T-bill such as Ondo&apos;s USDY. Yield simulated.
        {shockOn && ' Price shock simulated.'}
      </p>
    </section>
  );
}

function Cell({ label, value, unit, note }: { label: string; value: string; unit: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1 border-line px-3.5 py-3 not-last:border-b sm:not-last:border-r sm:not-last:border-b-0">
      <dt className="text-[13px] text-faint">{label}</dt>
      <dd className="text-xl font-semibold">
        {value} <span className="text-sm font-medium text-faint">{unit}</span>
      </dd>
      {note && <span className="text-xs text-faint">{note}</span>}
    </div>
  );
}

const SOURCE: Record<TripwireView['source'], ReactNode> = {
  coinmarketcap: <span className="text-xs text-faint">CoinMarketCap</span>,
  simulated: <span className="rounded-full border border-wait-200 bg-wait-50 px-2 py-0.5 text-xs font-semibold text-wait-700">simulated</span>,
  none: <span className="text-xs text-faint">no live price configured</span>,
};

function Tripwire({ t }: { t: TripwireView }) {
  const [rearmUrl, setRearmUrl] = useState<string | null>(null);
  // The phone scans this, so it is whatever host the dashboard was opened on, not localhost.
  useEffect(() => setRearmUrl(`${window.location.origin}/rearm`), []);
  const box = t.tripped ? 'border-bad-200 bg-bad-50' : 'border-good-200 bg-good-50';
  return (
    <div className={`flex flex-wrap items-center justify-between gap-4 rounded-[10px] border px-3.5 py-3 ${box}`} role="status">
      <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1.5">
        <span className={`text-[15px] font-semibold ${t.tripped ? 'text-bad-700' : 'text-good-700'}`}>
          Tripwire {t.tripped ? 'tripped' : 'armed'}
        </span>
        <span className={`text-sm ${t.tripped ? 'text-bad-800' : 'text-good-800'}`}>
          {t.tripped
            ? "Everything is back in cash. Sweeping is locked until the owner re-arms it from their phone."
            : `Trips if USDY's market price and its redemption value are more than ${TRIP_PERCENT}% apart.`}
        </span>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
          <div className="flex items-center gap-1.5">
            <dt className="text-faint">USDY price</dt>
            <dd className="font-semibold">{t.price === null ? '—' : `${t.price} mUSD`}</dd>
            {SOURCE[t.source]}
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-faint">Redemption value</dt>
            <dd className="font-semibold">{t.redemptionValue} mUSD</dd>
          </div>
          {t.splitPercent !== null && (
            <div className="flex items-center gap-1.5">
              <dt className="text-faint">Apart</dt>
              <dd className={`font-semibold ${t.overThreshold ? 'text-bad-700' : ''}`}>{t.splitPercent}%</dd>
            </div>
          )}
        </dl>
      </div>
      {t.tripped && rearmUrl && (
        <div className="flex items-center gap-3">
          <QRCodeSVG value={rearmUrl} size={80} marginSize={1} className="flex-none rounded-[10px] border border-line bg-white" />
          <div className="flex max-w-44 flex-col gap-1">
            <span className="text-sm font-semibold">Re-arm on your phone</span>
            <span className="font-mono text-xs break-all text-faint">{rearmUrl}</span>
          </div>
        </div>
      )}
    </div>
  );
}
