'use client';

import type { ReactNode } from 'react';
import type { RunEvent } from '@signvault/shared';
import { shortAddress } from '@/lib/approve';
import { txUrl } from '@/lib/format';
import type { ColumnStory, PathEdge, PathNode, Stat, Step, StepKind, Tone } from '@/lib/story';
import { EventFeed } from './EventFeed';
import { Icon } from './icons';
import type { IconName } from './icons';

interface Props {
  title: string;
  /** How a rule change is approved on this wallet. */
  rule: string;
  icon: IconName;
  address: string | undefined;
  explorerUrl: string | undefined;
  story: ColumnStory;
  events: RunEvent[];
  children?: ReactNode;
  /** A section under the timeline, such as SignVault's treasury panel. */
  footer?: ReactNode;
}

/** One side of the dashboard: the outcome, three numbers, the attack path, the key steps, and the raw feed. */
export function WalletColumn({ title, rule, icon, address, explorerUrl, story, events, children, footer }: Props) {
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-white shadow-xs">
      <div className="flex flex-col gap-3.5 px-4 pt-5 pb-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-line text-ink-2">
              <Icon name={icon} />
            </span>
            <div className="flex min-w-0 flex-col">
              <h2 className="text-lg font-semibold">{title}</h2>
              <span className="text-[13px] text-faint">{rule}</span>
            </div>
          </div>
          {address && (
            <ExplorerLink href={explorerUrl && `${explorerUrl}/address/${address}`} className="text-[13px] font-medium">
              {shortAddress(address)}
            </ExplorerLink>
          )}
        </div>
        <Outcome headline={story.headline} />
        {children}
      </div>

      <dl className="grid border-y border-line sm:grid-cols-3">
        {story.stats.map((s) => <StatCell key={s.label} stat={s} />)}
      </dl>

      <div className="flex flex-col gap-3.5 border-b border-line px-4 py-4.5 sm:px-6">
        <SectionLabel>Attack path</SectionLabel>
        <AttackPath nodes={story.path.nodes} edges={story.path.edges} middleIcon={icon === 'shield' ? 'contract' : 'wallet'} />
      </div>

      <div className="flex flex-col gap-1 px-4 py-4.5 sm:px-6">
        <SectionLabel>Timeline</SectionLabel>
        {story.steps.length === 0 && <p className="px-2.5 py-2 text-sm text-faint">No run yet.</p>}
        <ol className="flex flex-col gap-0.5">
          {story.steps.map((s, i) => <StepRow key={i} step={s} explorerUrl={explorerUrl} />)}
        </ol>
        <details className="group mt-2">
          <summary className="inline-flex min-h-10 cursor-pointer list-none items-center rounded-lg border border-line-2 bg-white px-3 text-[13px] font-semibold text-ink-2 hover:bg-canvas [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">View raw events ({story.eventCount})</span>
            <span className="hidden group-open:inline">Hide raw events ({story.eventCount})</span>
          </summary>
          <div className="mt-3 rounded-lg border border-line">
            <EventFeed events={events} explorerUrl={explorerUrl} />
          </div>
        </details>
      </div>
      {footer}
    </section>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-semibold tracking-[0.06em] text-faint uppercase">{children}</h3>;
}

const OUTCOME: Record<Tone, { box: string; icon: string; title: string; detail: string; name: IconName }> = {
  bad: { box: 'border-bad-200 bg-bad-50', icon: 'text-bad-600', title: 'text-bad-700', detail: 'text-bad-800', name: 'xCircle' },
  good: { box: 'border-good-200 bg-good-50', icon: 'text-good-500', title: 'text-good-700', detail: 'text-good-800', name: 'shield' },
  wait: { box: 'border-wait-200 bg-wait-50', icon: 'text-wait-700', title: 'text-wait-700', detail: 'text-wait-700', name: 'clock' },
  neutral: { box: 'border-line bg-canvas', icon: 'text-faint', title: 'text-ink', detail: 'text-muted', name: 'clock' },
};

function Outcome({ headline }: { headline: ColumnStory['headline'] }) {
  const t = OUTCOME[headline.tone];
  return (
    <div className={`flex items-start gap-3 rounded-[10px] border px-3.5 py-3 ${t.box}`} role="status">
      <span className={`flex pt-px ${t.icon}`}><Icon name={t.name} strokeWidth={2} /></span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={`text-[15px] font-semibold ${t.title}`}>{headline.title}</span>
        <span className={`text-sm ${t.detail}`}>{headline.detail}</span>
      </div>
    </div>
  );
}

const NOTE: Record<Tone, string> = { bad: 'text-bad-700', good: 'text-good-700', wait: 'text-wait-700', neutral: 'text-faint' };

function StatCell({ stat }: { stat: Stat }) {
  return (
    <div className="flex flex-col gap-1 border-line px-4 py-3.5 not-last:border-b sm:px-6 sm:not-last:border-r sm:not-last:border-b-0">
      <dt className="text-[13px] text-faint">{stat.label}</dt>
      <dd className="text-2xl font-semibold">
        {stat.value} <span className="text-sm font-medium text-faint">{stat.unit}</span>
        {stat.note && <span className={`ml-1.5 text-[13px] font-medium ${NOTE[stat.noteTone ?? 'neutral']}`}>{stat.note}</span>}
      </dd>
    </div>
  );
}

const NODE_BOX: Record<Tone, string> = {
  bad: 'border-bad-200 bg-bad-50 text-bad-600',
  good: 'border-good-200 bg-good-50 text-good-700',
  wait: 'border-wait-200 bg-wait-50 text-wait-700',
  neutral: 'border-line bg-white text-ink-2 shadow-xs',
};
const NODE_ICON: IconName[] = ['inbox', 'agent', 'wallet', 'vendors'];

/** Inbox → Agent → Wallet or Contract → Vendors. A row from 640px up, a column below it. */
function AttackPath({ nodes, edges, middleIcon }: { nodes: PathNode[]; edges: PathEdge[]; middleIcon: IconName }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start">
      {nodes.map((node, i) => (
        <div key={node.label} className="contents">
          <PathStep node={node} icon={i === 2 ? middleIcon : NODE_ICON[i]} />
          {edges[i] && <PathArrow edge={edges[i]} />}
        </div>
      ))}
    </div>
  );
}

function PathStep({ node, icon }: { node: PathNode; icon: IconName }) {
  return (
    <div className="flex items-center gap-3 sm:w-24 sm:flex-none sm:flex-col sm:gap-1.5 sm:text-center">
      <span className={`flex size-11 flex-none items-center justify-center rounded-[10px] border ${NODE_BOX[node.tone]}`}>
        <Icon name={icon} />
      </span>
      <span className="flex min-w-0 flex-col sm:items-center">
        <span className="text-[13px] font-semibold">{node.label}</span>
        <span className={`text-xs ${NOTE[node.tone]}`}>{node.caption}</span>
      </span>
    </div>
  );
}

function PathArrow({ edge }: { edge: PathEdge }) {
  const line = edge.tone === 'bad' ? 'bg-bad-600' : 'bg-line-2';
  const arrow = edge.tone === 'bad' ? 'text-bad-600' : 'text-line-2';
  const label = edge.tone === 'bad' ? 'font-semibold text-bad-700' : edge.tone === 'good' ? 'font-medium text-good-700' : 'font-medium text-muted';
  return (
    <div className="flex items-center gap-3 py-1 pl-[21px] sm:min-w-14 sm:flex-1 sm:flex-col-reverse sm:items-stretch sm:gap-1 sm:p-0 sm:pt-1.5">
      <span className={`block h-6 w-0.5 rounded sm:hidden ${line}`} />
      <span className="hidden items-center sm:flex">
        <span className={`block h-0.5 flex-1 ${line}`} />
        <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true" className={arrow}><path d="M1 1 L8 6 L1 11 Z" fill="currentColor" /></svg>
      </span>
      <span className={`text-xs leading-tight sm:text-center ${label}`}>{edge.label}</span>
    </div>
  );
}

const STEP: Record<StepKind, { row: string; icon: string }> = {
  ok: { row: '', icon: 'bg-good-50 text-good-700' },
  no: { row: '', icon: 'bg-bad-50 text-bad-700' },
  breach: { row: 'bg-bad-50', icon: 'bg-bad-600 text-white' },
  info: { row: '', icon: 'bg-chip text-ink-2' },
  wait: { row: 'bg-wait-50', icon: 'bg-wait-50 text-wait-700' },
};

export function StepRow({ step, explorerUrl }: { step: Step; explorerUrl: string | undefined }) {
  const t = STEP[step.kind];
  const meta = [step.ts !== undefined && clock(step.ts), step.detail].filter(Boolean).join(' · ');
  return (
    <li className={`flex items-start gap-3 rounded-lg px-2.5 py-2 ${t.row}`} data-kind={step.kind}>
      <span className={`flex size-6 flex-none items-center justify-center rounded-full ${t.icon}`}>
        <Icon name={step.icon} size={14} strokeWidth={2.5} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-sm font-medium text-ink">{step.title}</span>
        {meta && <span className="text-xs text-faint">{meta}</span>}
      </span>
      {step.txHash && (
        <ExplorerLink href={explorerUrl && txUrl(explorerUrl, step.txHash)} className="pt-0.5 text-xs">
          {shortAddress(step.txHash)}
        </ExplorerLink>
      )}
    </li>
  );
}

/** A link on a chain with an explorer. Anvil has none, so there it is the plain hash or address. */
export function ExplorerLink({ href, className, children }: { href: string | undefined; className: string; children: ReactNode }) {
  const mono = `font-mono whitespace-nowrap ${className}`;
  if (!href) return <span className={`${mono} text-faint`}>{children}</span>;
  return <a className={`${mono} text-link hover:underline`} href={href} target="_blank" rel="noreferrer">{children}</a>;
}

/** "18:42:07" in the viewer's time zone. */
export function clock(ts: number) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}
