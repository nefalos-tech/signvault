'use client';

import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import type { RunEvent, WalletKind } from '@signvault/shared';
import { shortAddress } from '@/lib/approve';
import { storyBadge } from '@/lib/story';
import type { ColumnStory, FlowEdge, FlowNode, FlowTone } from '@/lib/story';
import { EventFeed } from './EventFeed';
import { Badge, Card, CardDescription, CardIcon, CardTitle, ClockGlyph, ExplorerLink, H3, Icon, StepList, TxLink, linkButtonClass } from './ui';
import type { IconName } from './ui';

const WALLET: Record<WalletKind, { title: string; icon: IconName; nodes: Record<FlowNode['id'], IconName> }> = {
  baseline: { title: 'Standard wallet', icon: 'coins', nodes: { inbox: 'gmail', agent: 'qwen', gate: 'mail-alert', effect: 'gauge', outcome: 'store' } },
  signvault: { title: 'SignVault', icon: 'logo', nodes: { inbox: 'gmail', agent: 'qwen', gate: 'lock', effect: 'phone', outcome: 'store' } },
};

interface Props {
  wallet: WalletKind;
  story: ColumnStory;
  /** This wallet's events, for the raw feed. */
  events: RunEvent[];
  address: string | undefined;
  explorerUrl: string | undefined;
  /** A button beside "Show every event", such as "Run again on SignVault". */
  action?: ReactNode;
}

/** One wallet: what happened in a line, the gate the agent met, the steps, and every raw event on request. */
export function GateColumn({ wallet, story, events, address, explorerUrl, action }: Props) {
  const w = WALLET[wallet];
  const badge = storyBadge(story);
  const [showEvents, setShowEvents] = useState(false);
  const titleId = `${wallet}-title`;
  const feedId = `${wallet}-events`;

  return (
    <Card aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-4 p-5 min-[560px]:flex-nowrap min-[560px]:px-7 min-[560px]:pt-6">
        <div className="flex min-w-0 items-start gap-3.5">
          <CardIcon name={w.icon} />
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle size="lg" id={titleId}>{w.title}</CardTitle>
            <CardDescription>{story.summary}</CardDescription>
            {story.facts.length > 0 && (
              <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-[13px]">
                {story.facts.map((f) => (
                  <div key={f.label} className="flex gap-1.5">
                    <dt className="text-muted-foreground">{f.label}</dt>
                    <dd className="font-medium text-foreground tabular-nums">{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {address && (
              <ExplorerLink
                href={explorerUrl && `${explorerUrl}/address/${address}`}
                text={`Contract ${shortAddress(address)}`}
                fallback={`Contract ${shortAddress(address)}`}
                className="self-start text-[13px] font-medium"
              />
            )}
          </div>
        </div>
        <Badge tone={badge.tone}>{badge.text}</Badge>
      </div>

      <div
        className="flex flex-auto flex-col items-center border-t border-border bg-muted bg-[radial-gradient(var(--color-dot)_1.2px,transparent_1.2px)] bg-[length:18px_18px] px-4 py-6 min-[560px]:px-6 min-[560px]:pt-7 min-[560px]:pb-[30px]"
      >
        {story.flow.nodes.map((node, i) => {
          const edge = story.flow.edges[i];
          return (
            <Fragment key={node.id}>
              {node.id === 'gate'
                ? <Gate node={node} icon={w.nodes.gate} />
                : <Node node={node} icon={w.nodes[node.id]} explorerUrl={explorerUrl} />}
              {edge && <Edge edge={edge} tall={node.id === 'agent' || node.id === 'gate'} />}
            </Fragment>
          );
        })}
      </div>

      <div className="flex flex-col gap-3 border-t border-border px-5 pt-5 pb-6 min-[560px]:px-7">
        <H3>What happened</H3>
        {story.steps.length === 0
          ? <p className="px-3 text-[15px] text-subtle-foreground">{story.status === 'idle' ? 'No run yet.' : 'Waiting for the first step.'}</p>
          : <StepList steps={story.steps} explorerUrl={explorerUrl} />}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="button" className={linkButtonClass} aria-expanded={showEvents} aria-controls={feedId} onClick={() => setShowEvents((v) => !v)}>
            {showEvents ? 'Hide every event' : 'Show every event'} ({story.eventCount})
          </button>
          {action}
        </div>
        {showEvents && (
          <div id={feedId} className="rounded-xl border border-border">
            <EventFeed events={events} explorerUrl={explorerUrl} />
          </div>
        )}
      </div>
    </Card>
  );
}

const SHADOW = 'shadow-[0_1px_2px_rgba(14,15,44,0.06)]';
const NODE: Record<FlowTone, { box: string; icon: string; note: string }> = {
  neutral: { box: `border-border ${SHADOW}`, icon: 'border-border', note: 'text-muted-foreground' },
  breach: { box: `border-destructive-border ${SHADOW}`, icon: 'border-destructive-border', note: 'text-muted-foreground' },
  held: { box: `border-primary-border ${SHADOW}`, icon: 'border-primary-border', note: 'text-primary-text' },
  ok: { box: `border-primary-border ${SHADOW}`, icon: 'border-primary-border', note: 'text-primary-text' },
  pending: { box: 'border-dashed border-pending', icon: 'border-primary-border', note: 'text-primary-text' },
  idle: { box: 'border-dashed border-input', icon: 'border-border', note: 'text-subtle-foreground' },
};

function Node({ node, icon, explorerUrl }: { node: FlowNode; icon: IconName; explorerUrl: string | undefined }) {
  const t = NODE[node.tone];
  const isIdle = node.tone === 'idle';
  return (
    <div data-tone={node.tone} className={`flex w-[300px] max-w-full items-center gap-3 rounded-[14px] border bg-card px-3.5 py-3 ${t.box}`}>
      <span className={`flex size-[34px] flex-none items-center justify-center rounded-[10px] border bg-card ${t.icon}`}>
        <Icon name={icon} size={20} className={isIdle ? 'opacity-50 grayscale' : ''} />
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className={`font-display text-[15px] font-[650] ${isIdle ? 'text-muted-foreground' : ''}`}>{node.title}</span>
        {node.note && <span className={`text-[13px] ${t.note}`}>{node.note}</span>}
        {node.txHash && <TxLink txHash={node.txHash} explorerUrl={explorerUrl} text="View transaction" className="text-[13px] font-medium" />}
      </span>
      {node.waiting && (
        <span className="ml-auto inline-flex flex-none items-center gap-1.5 rounded-full bg-primary-soft px-2.5 py-1 text-[13px] font-semibold text-primary-text">
          <ClockGlyph />
          Waiting
        </span>
      )}
    </div>
  );
}

const HELD_GATE = {
  box: 'border-primary bg-primary-tint shadow-[0_12px_28px_-16px_rgba(91,75,255,0.6)]',
  icon: 'border-primary-border',
  title: 'text-primary-deep',
  note: 'text-primary-ink',
};
const GATE: Record<FlowTone, typeof HELD_GATE> = {
  breach: {
    box: 'border-destructive bg-destructive-tint shadow-[0_12px_28px_-16px_rgba(229,72,77,0.55)]',
    icon: 'border-destructive-border',
    title: 'text-destructive-deep',
    note: 'text-destructive-ink',
  },
  held: HELD_GATE,
  ok: HELD_GATE,
  pending: { ...HELD_GATE, box: 'border-dashed border-pending bg-primary-tint' },
  neutral: { box: 'border-border bg-card', icon: 'border-border', title: '', note: 'text-muted-foreground' },
  idle: { box: 'border-dashed border-input bg-card', icon: 'border-border', title: 'text-muted-foreground', note: 'text-subtle-foreground' },
};

/** The one gate between the agent and more spending, larger than the nodes around it. */
function Gate({ node, icon }: { node: FlowNode; icon: IconName }) {
  const t = GATE[node.tone];
  return (
    <div data-tone={node.tone} className={`flex w-[380px] max-w-full items-center gap-4 rounded-[20px] border-2 px-5 py-[18px] ${t.box}`}>
      <span className={`flex size-[52px] flex-none items-center justify-center rounded-2xl border bg-card shadow-[0_1px_2px_rgba(14,15,44,0.08)] ${t.icon}`}>
        <Icon name={icon} size={30} className={node.tone === 'idle' ? 'opacity-50 grayscale' : ''} />
      </span>
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className={`font-display text-xl font-bold tracking-[-0.01em] ${t.title}`}>{node.title}</span>
        {node.note && <span className={`text-sm leading-[1.4] ${t.note}`}>{node.note}</span>}
      </span>
    </div>
  );
}

const EDGE: Record<FlowTone, string> = {
  neutral: 'w-0.5 bg-line',
  breach: 'w-[3px] bg-destructive',
  held: 'w-[3px] bg-primary',
  ok: 'w-[3px] bg-primary',
  pending: 'w-0 border-l-[3px] border-dashed border-pending',
  idle: 'w-0 border-l-2 border-dashed border-input',
};

function Edge({ edge, tall }: { edge: FlowEdge; tall: boolean }) {
  const line = <span aria-hidden="true" className={`block ${tall ? 'h-[30px]' : 'h-[22px]'} ${EDGE[edge.tone]}`} />;
  if (!edge.label) return line;
  return (
    <>
      {line}
      <span className="rounded-full border border-border bg-card px-2.5 py-[3px] text-[13px] font-semibold text-secondary-foreground">{edge.label}</span>
      {line}
    </>
  );
}
