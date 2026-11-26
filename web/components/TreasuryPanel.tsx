'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { RunEvent } from '@signvault/shared';
import { TRIP_PERCENT, type TreasuryView, type TripwireView } from '@/lib/treasury';
import { EventFeed } from './EventFeed';
import { Card, H3, Icon, PanelHead, StepList, buttonClass, linkButtonClass } from './ui';

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
  const [showEvents, setShowEvents] = useState(false);
  return (
    <Card className="gap-5 p-5 min-[560px]:px-7 min-[560px]:py-6" aria-labelledby="treasury-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PanelHead
          icon="money"
          id="treasury-title"
          title="Treasury"
          description="SignVault moves spare cash into T-bills, never below this period's unpaid payroll."
        />
        <div className="flex flex-wrap items-center gap-4">
          {view.tripwire && (
            <button
              type="button"
              role="switch"
              aria-checked={shockOn}
              onClick={() => onShock(!shockOn)}
              disabled={disabled}
              className="group inline-flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium text-secondary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="flex h-6 w-10 flex-none rounded-full bg-input p-[3px] transition-colors duration-150 group-aria-checked:bg-primary">
                <span className="size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(14,15,44,0.2)] transition-transform duration-150 group-aria-checked:translate-x-4" />
              </span>
              Simulate a price shock
            </button>
          )}
          <button type="button" onClick={onRun} disabled={disabled || view.status === 'running'} className={buttonClass()}>
            {view.status === 'running' ? 'Treasury task running…' : 'Run the treasury task'}
          </button>
        </div>
      </div>

      <div className="grid items-start gap-7 min-[1040px]:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="flex min-w-0 flex-col gap-3.5">
          <dl className="grid overflow-hidden rounded-2xl border border-border min-[560px]:grid-cols-3">
            <Stat label="Cash" value={view.cash} />
            <Stat label="In T-bills" value={view.inTbills} note="yield simulated" />
            <Stat label="Payroll still owed this period" value={view.owed} note="the floor a sweep can't go below" />
          </dl>
          {view.tripwire && <Tripwire t={view.tripwire} />}
        </div>

        <div className="flex min-w-0 flex-col gap-2.5">
          <H3>Last treasury run</H3>
          {view.steps.length === 0
            ? <p className="px-3 text-[15px] text-subtle-foreground">No treasury run yet.</p>
            : <StepList steps={view.steps} explorerUrl={explorerUrl} />}
          {events.length > 0 && (
            <>
              <button type="button" className={linkButtonClass} aria-expanded={showEvents} aria-controls="treasury-events" onClick={() => setShowEvents((v) => !v)}>
                {showEvents ? 'Hide raw treasury events' : 'View raw treasury events'} ({events.length})
              </button>
              {showEvents && (
                <div id="treasury-events" className="rounded-xl border border-border">
                  <EventFeed events={events} explorerUrl={explorerUrl} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <p className="text-[13px] text-subtle-foreground">
        mUSD stands in for USDT or USDC. mUSDY stands in for a tokenized T-bill such as Ondo&apos;s USDY. Yield is simulated.
        {shockOn && ' Price shock simulated.'}
      </p>
    </Card>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1 border-border px-4 py-3.5 not-last:border-b min-[560px]:not-last:border-r min-[560px]:not-last:border-b-0">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="text-sm text-muted-foreground">
        <span className="font-display text-[26px] font-[650] tracking-[-0.02em] text-foreground tabular-nums">{value}</span> mUSD
      </dd>
      {note && <dd className="text-[13px] text-subtle-foreground">{note}</dd>}
    </div>
  );
}

const SOURCE: Record<TripwireView['source'], ReactNode> = {
  coinmarketcap: <span className="text-[13px] text-subtle-foreground">CoinMarketCap</span>,
  simulated: <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[13px] font-semibold text-primary-text">simulated</span>,
  none: <span className="text-[13px] text-subtle-foreground">no live price configured</span>,
};

function Tripwire({ t }: { t: TripwireView }) {
  const [rearmUrl, setRearmUrl] = useState<string | null>(null);
  // The phone scans this, so it is whatever host the dashboard was opened on, not localhost.
  useEffect(() => setRearmUrl(`${window.location.origin}/rearm`), []);
  const tone = t.tripped
    ? { box: 'border-destructive-border bg-destructive-tint', tile: 'border-destructive-border', title: 'text-destructive-deep', note: 'text-destructive-ink' }
    : { box: 'border-primary-border bg-primary-tint', tile: 'border-primary-border', title: 'text-primary-deep', note: 'text-primary-ink' };
  return (
    <div className={`flex flex-wrap items-start gap-x-3.5 gap-y-4 rounded-2xl border px-4 py-3.5 ${tone.box}`} role="status">
      <span className={`flex size-10 flex-none items-center justify-center rounded-[11px] border bg-white ${tone.tile}`}>
        <Icon name={t.tripped ? 'lock' : 'shield-check'} size={22} />
      </span>
      <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-1.5">
        <span className={`font-display text-base font-[650] ${tone.title}`}>Tripwire {t.tripped ? 'tripped' : 'armed'}</span>
        <span className={`text-sm leading-[1.45] ${tone.note}`}>
          {t.tripped
            ? 'Everything is back in cash. Sweeping is locked until the owner re-arms it from their phone.'
            : `It trips if USDY's market price and its redemption value are more than ${TRIP_PERCENT}% apart.`}
        </span>
        <dl className="flex flex-wrap gap-x-[22px] gap-y-1.5 text-sm">
          <div className="flex items-baseline gap-1.5">
            <dt className="text-muted-foreground">USDY price</dt>
            <dd className="font-semibold tabular-nums">{t.price === null ? '—' : `${t.price} mUSD`}</dd>
            <dd>{SOURCE[t.source]}</dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-muted-foreground">Redemption value</dt>
            <dd className="font-semibold tabular-nums">{t.redemptionValue} mUSD</dd>
          </div>
          {t.splitPercent !== null && (
            <div className="flex items-baseline gap-1.5">
              <dt className="text-muted-foreground">Apart</dt>
              <dd className={`font-semibold tabular-nums ${t.overThreshold ? 'text-destructive-text' : ''}`}>{t.splitPercent}%</dd>
            </div>
          )}
        </dl>
      </div>
      {t.tripped && rearmUrl && (
        <div className="flex items-center gap-3">
          <span role="img" aria-label="QR code that opens the re-arm page" className="flex size-[92px] flex-none rounded-xl border border-border bg-white p-1.5">
            <QRCodeSVG value={rearmUrl} size={78} marginSize={1} fgColor="#0e0f2c" />
          </span>
          <div className="flex max-w-44 flex-col gap-1">
            <span className="font-display text-sm font-[650]">Re-arm on your phone</span>
            <span className="text-[13px] break-all text-subtle-foreground">{rearmUrl}</span>
          </div>
        </div>
      )}
    </div>
  );
}
