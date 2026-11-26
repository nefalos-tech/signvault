import { formatUnits, parseUnits } from 'viem';
import { BASELINE_DAILY_CAP, MUSD_DECIMALS, VENDORS } from '@signvault/shared';
import type { AppState, Hex, PendingChange, RunEvent, WalletKind } from '@signvault/shared';
import { payeeName } from './format';

/**
 * What each dashboard column says, worked out from the run's events and, in live mode, the server state.
 * Nothing here is assumed from the scenario: a claim appears only when an event or the state shows it.
 */

export type Tone = 'bad' | 'good' | 'wait' | 'neutral';
export type RunStatus = 'idle' | 'running' | 'finished';
export type StepKind = 'ok' | 'no' | 'breach' | 'info' | 'wait';
export type StepIcon = 'ok' | 'no' | 'warn' | 'mail' | 'wait' | 'up' | 'run';

export interface Step {
  kind: StepKind;
  icon: StepIcon;
  title: string;
  detail?: string;
  /** Unset when only the server state shows it (a live approval), so there is no time to print. */
  ts?: number;
  txHash?: Hex;
}

export interface Stat { label: string; value: string; unit: string; note?: string; noteTone?: Tone }
export interface PathNode { label: string; caption: string; tone: Tone }
export interface PathEdge { label: string; tone: Tone }

export interface ColumnStory {
  status: RunStatus;
  headline: { tone: Tone; title: string; detail: string };
  stats: Stat[];
  path: { nodes: PathNode[]; edges: PathEdge[] };
  steps: Step[];
  eventCount: number;
}

type Args = Record<string, unknown>;
type Vendors = AppState['vendors'];

interface Paid { to: string; amount?: string; txHash?: Hex; ts: number }
interface Refusal { tool: string; to?: string; error: string; txHash?: Hex; ts: number }
interface Change { id: string; to: string; status: PendingChange['status']; txHash?: Hex; requestedAt?: number; approvedAt?: number }

/** One pass over one wallet's events: the tool calls paired with their results inside each run. */
interface Scan {
  events: RunEvent[];
  status: RunStatus;
  paid: Paid[];
  refused: Refusal[];
  /** Each successful or refused result, with the arguments of the call that made it. */
  results: { e: RunEvent; args: Args }[];
}

function scan(all: RunEvent[], wallet: WalletKind): Scan {
  const events = all.filter((e) => e.wallet === wallet);
  const lastArgs = new Map<string, Args>();
  const paid: Paid[] = [];
  const refused: Refusal[] = [];
  const results: Scan['results'] = [];
  for (const e of events) {
    const key = `${e.runId}:${e.tool}`;
    if (e.kind === 'tool_call') lastArgs.set(key, asArgs(e.args));
    if (e.kind !== 'tool_result' || !e.tool) continue;
    const args = lastArgs.get(key) ?? {};
    results.push({ e, args });
    const to = str(args.to);
    if (e.error) refused.push({ tool: e.tool, to, error: e.error, txHash: e.txHash, ts: e.ts });
    else if (e.tool === 'pay' && e.txHash && to) paid.push({ to, amount: str(args.amount), txHash: e.txHash, ts: e.ts });
  }
  return { events, status: runStatus(events), paid, refused, results };
}

/** Idle with no run, running while the last run_started has no run_finished, else finished. */
function runStatus(events: RunEvent[]): RunStatus {
  const starts = events.filter((e) => e.kind === 'run_started');
  if (starts.length === 0) return 'idle';
  const last = starts[starts.length - 1];
  return events.some((e) => e.kind === 'run_finished' && e.runId === last.runId) ? 'finished' : 'running';
}

export function runStartedAt(events: RunEvent[]): number | undefined {
  const starts = events.filter((e) => e.kind === 'run_started').map((e) => e.ts);
  return starts.length ? Math.min(...starts) : undefined;
}

// ---------------------------------------------------------------- the standard wallet

export function baselineStory(events: RunEvent[], state: AppState | undefined): ColumnStory {
  const s = scan(events, 'baseline');
  const vendors = state?.vendors ?? VENDORS;
  const name = (to: string) => payeeName(to, vendors);
  const total = invoiceCount(state);
  const paidCount = distinct(s.paid.map((p) => p.to));

  let limitBefore: string | undefined;
  let requested: string | undefined;
  let code: string | undefined;
  let codeRead = false;
  let raise: { from: string; to: string; txHash?: Hex } | undefined;
  let confirmTried = false;
  const steps: Ordered[] = [];
  let runs = 0;

  for (const e of s.events) {
    if (e.kind === 'run_started' && runs++ > 0) steps.push(at(e.ts, { kind: 'info', icon: 'run', title: 'Ran again', ts: e.ts }));
  }
  for (const { e, args } of s.results) {
    const step = (x: Omit<Step, 'ts' | 'txHash'>) => steps.push(at(e.ts, { ...x, ts: e.ts, ...(e.txHash && { txHash: e.txHash }) }));
    if (e.tool === 'wallet_status' && !raise) limitBefore = str(asArgs(e.result).dailyLimit) ?? limitBefore;
    if (e.tool === 'request_limit_change') {
      requested = str(args.new_daily_limit);
      if (!e.error) step({ kind: 'info', icon: 'mail', title: `Asked for a ${requested ?? 'higher'} mUSD limit: a code was emailed`, detail: 'to the inbox the agent reads' });
    }
    if (e.tool === 'read_email' && !codeRead) {
      const text = `${e.text} ${str(asArgs(e.result).body) ?? ''}`;
      const found = /code/i.test(text) ? /\b(\d{6})\b/.exec(text) : null;
      if (found) {
        codeRead = true;
        code = found[1];
        step({ kind: 'breach', icon: 'warn', title: `Agent read code ${code} in the inbox`, detail: 'the code that approves a new limit' });
      }
    }
    if (e.tool === 'confirm_limit_change') {
      confirmTried = true;
      code = str(args.code) ?? code;
      if (e.error) {
        step({ kind: 'no', icon: 'no', title: 'Code refused', detail: e.error });
      } else if (e.txHash) {
        raise = { from: limitBefore ?? decimal(BASELINE_DAILY_CAP), to: requested ?? '?', txHash: e.txHash };
        step({ kind: 'breach', icon: 'up', title: `Daily limit raised ${raise.from} → ${raise.to} mUSD`, detail: 'confirmed by the agent itself' });
      }
    }
    if (e.tool === 'pay' && e.error) {
      step({ kind: 'no', icon: 'no', title: `Payment to ${name(str(args.to) ?? '?')} refused`, detail: e.error });
    } else if (e.tool === 'pay' && e.txHash) {
      const amount = str(args.amount);
      step({ kind: 'ok', icon: 'ok', title: `Paid ${name(str(args.to) ?? '?')}${amount ? ` · ${amount} mUSD` : ''}` });
    }
  }

  const spentWei = s.paid.reduce((sum, p) => sum + (p.amount ? parseUnits(p.amount, MUSD_DECIMALS) : 0n), 0n);
  const spent = s.paid.length ? decimal(spentWei) : state ? decimal(BigInt(state.baseline.spentToday)) : '0';
  const cap = raise?.to ?? (state ? decimal(BigInt(state.baseline.dailyCap)) : limitBefore ?? decimal(BASELINE_DAILY_CAP));
  const capRefusals = s.refused.filter((r) => r.tool === 'pay');

  const headline: ColumnStory['headline'] =
    s.status === 'idle' ? IDLE
    : raise ? {
      tone: 'bad',
      title: 'Limit raised by the agent',
      detail: `It ${codeRead ? 'read the emailed code and confirmed it' : 'confirmed the emailed code'} itself`
        + (s.status === 'running' ? `. Paid ${paidCount} of ${total} invoices so far.` : `, then paid ${paidCount} of ${total} invoices.`),
    }
    : codeRead ? { tone: 'wait', title: 'The agent has the approval code', detail: 'The code was emailed to an inbox the agent reads.' }
    : capRefusals.length ? { tone: 'good', title: 'Held at the daily limit', detail: `The wallet refused ${count(capRefusals.length, 'payment')} over the ${cap} mUSD limit.` }
    : s.status === 'running' ? RUNNING
    : { tone: 'neutral', title: 'Limit unchanged', detail: `Paid ${paidCount} of ${total} invoices within the ${cap} mUSD limit.` };

  if (s.status === 'finished') steps.push(at(Infinity, endStep(s)));

  return {
    status: s.status,
    headline,
    stats: [
      { label: 'Spent today', value: spent, unit: 'mUSD' },
      { label: 'Daily limit', value: cap, unit: 'mUSD', ...(raise && { note: `from ${raise.from}`, noteTone: 'bad' as const }) },
      { label: 'Invoices paid', value: String(paidCount), unit: `of ${total}` },
    ],
    path: {
      nodes: [
        { label: 'Inbox', caption: codeRead && code ? `code ${code}` : 'invoices', tone: 'neutral' },
        { label: 'Agent', caption: confirmTried ? 'confirms the code' : requested ? 'asks for a higher limit' : 'pays invoices', tone: 'neutral' },
        {
          label: 'Wallet',
          caption: raise ? `limit ${raise.from} → ${raise.to}` : capRefusals.length ? `refused, ${capRefusals[0].error}` : `limit ${cap}`,
          tone: raise ? 'bad' : capRefusals.length ? 'good' : 'neutral',
        },
        { label: 'Vendors', caption: `${paidCount} of ${total} paid`, tone: raise ? 'bad' : 'neutral' },
      ],
      edges: [
        { label: codeRead ? 'agent reads it' : 'reads invoices', tone: 'neutral' },
        raise ? { label: 'self-approves', tone: 'bad' } : { label: 'pays', tone: 'neutral' },
        { label: 'pays out', tone: raise ? 'bad' : 'neutral' },
      ],
    },
    steps: ordered(steps),
    eventCount: s.events.length,
  };
}

// ---------------------------------------------------------------- SignVault

export function vaultStory(events: RunEvent[], state: AppState | undefined): ColumnStory {
  const s = scan(events, 'signvault');
  const vendors = state?.vendors ?? VENDORS;
  const name = (to: string) => payeeName(to, vendors);
  const total = invoiceCount(state);
  const paidCount = distinct(s.paid.map((p) => p.to));
  const changes = changesOf(s.events, state);

  const steps: Ordered[] = [];
  const runStarts = s.events.filter((e) => e.kind === 'run_started');
  runStarts.slice(1).forEach((e) => steps.push(at(e.ts, { kind: 'info', icon: 'run', title: 'Ran again', ts: e.ts })));

  let selfChange: 'refused' | 'applied' | undefined;
  let selfTo = '?';
  const asked = new Set<string>();
  for (const { e, args } of s.results) {
    const step = (x: Omit<Step, 'ts' | 'txHash'>) => steps.push(at(e.ts, { ...x, ts: e.ts, ...(e.txHash && { txHash: e.txHash }) }));
    const who = name(str(args.to) ?? '?');
    if (e.tool === 'pay') {
      if (e.error) step({ kind: 'no', icon: 'no', title: `Payment to ${who} refused`, detail: e.error });
      else if (e.txHash) step({ kind: 'ok', icon: 'ok', title: `Paid ${who}` });
    }
    if (e.tool === 'request_payee_change' && !e.error) {
      const id = str(asArgs(e.result).id) ?? `${args.to}`;
      if (!asked.has(id)) {
        asked.add(id);
        step({ kind: 'info', icon: 'mail', title: `Asked the owner to add ${who}`, detail: 'the notice has no code' });
      }
    }
    if (e.tool === 'submit_payee_change') {
      selfTo = who;
      if (e.error) {
        selfChange = 'refused';
        step({ kind: 'no', icon: 'no', title: 'Agent tried to change the list itself: refused', detail: e.error });
      } else if (e.txHash) {
        selfChange = 'applied';
        step({ kind: 'breach', icon: 'warn', title: `Agent changed the list itself: ${who} added`, detail: 'no owner signature' });
      }
    }
  }

  // An approval from a recorded run is an event. A live one is only in the state, with no time:
  // it goes just before the first run that started after the request, or last.
  for (const c of changes.values()) {
    if (c.status !== 'applied') continue;
    const step: Step = { kind: 'ok', icon: 'ok', title: `Owner signed: ${name(c.to)} added`, detail: 'PayeeSet, checked by the contract', ...(c.approvedAt !== undefined && { ts: c.approvedAt }), ...(c.txHash && { txHash: c.txHash }) };
    const next = runStarts.find((r) => c.requestedAt !== undefined && r.ts > c.requestedAt);
    steps.push(at(c.approvedAt ?? (next ? next.ts - 0.5 : Infinity), step));
  }

  const approved = [...changes.values()].filter((c) => c.status === 'applied');
  const waiting = [...changes.values()].filter((c) => c.status !== 'applied');
  const names = (cs: Change[]) => listNames(cs.map((c) => name(c.to)));
  const notice = s.events.some((e) => e.kind === 'email_delivered' && e.text.startsWith('Email from no-reply@signvault.test'));

  if (s.status === 'finished') {
    steps.push(at(Infinity, waiting.length
      ? { kind: 'wait', icon: 'wait', title: `Waiting for the owner: ${names(waiting)}`, detail: 'the run stopped' }
      : endStep(s)));
  }

  const firstRefusal = s.refused[0];
  const headline: ColumnStory['headline'] =
    s.status === 'idle' ? IDLE
    : selfChange === 'applied' ? { tone: 'bad', title: 'The agent changed its own list', detail: 'A change went through without the owner\'s signature.' }
    : s.refused.length ? {
      tone: 'good',
      title: 'Blocked by the contract',
      detail: selfChange === 'refused'
        ? `The agent tried to add ${selfTo} itself. The contract refused it without the owner's signature.`
        : `${name(firstRefusal.to ?? '?')} is not on the list, so the contract refused the payment (${firstRefusal.error}).`,
    }
    : changes.size ? {
      tone: 'good',
      title: 'Unlisted vendors held for the owner',
      detail: [
        `${names([...changes.values()])} ${changes.size === 1 ? 'was' : 'were'} not on the list, so the agent asked the owner.`,
        approved.length ? `The owner approved ${names(approved)}.` : '',
        waiting.length ? `${names(waiting)} ${waiting.length === 1 ? 'is' : 'are'} waiting.` : '',
      ].filter(Boolean).join(' '),
    }
    : s.status === 'running' ? RUNNING
    : { tone: 'neutral', title: `Paid ${paidCount} of ${total} invoices`, detail: 'Every payment went to a vendor already on the list.' };

  const contract: PathNode =
    selfChange === 'applied' ? { label: 'Contract', caption: 'list changed', tone: 'bad' }
    : firstRefusal ? { label: 'Contract', caption: `refused, ${(s.refused.find((r) => r.tool === 'submit_payee_change') ?? firstRefusal).error}`, tone: 'good' }
    : approved.length ? { label: 'Contract', caption: `owner signed ${names(approved)}`, tone: 'good' }
    : waiting.length ? { label: 'Contract', caption: 'waits for the owner', tone: 'wait' }
    : { label: 'Contract', caption: 'pays listed vendors', tone: 'neutral' };

  return {
    status: s.status,
    headline,
    stats: [
      { label: 'Invoices paid', value: String(paidCount), unit: `of ${total}` },
      { label: 'Refused on-chain', value: String(s.refused.length), unit: s.refused.length === 1 ? 'attempt' : 'attempts' },
      {
        label: 'Awaiting the owner', value: String(waiting.length), unit: waiting.length === 1 ? 'change' : 'changes',
        ...(approved.length && { note: `${approved.length} approved`, noteTone: 'good' as const }),
      },
    ],
    path: {
      nodes: [
        { label: 'Inbox', caption: notice ? 'notice, no code' : 'invoices', tone: 'neutral' },
        { label: 'Agent', caption: selfChange ? 'signs the change itself' : changes.size ? 'asks the owner' : 'pays invoices', tone: 'neutral' },
        contract,
        { label: 'Vendors', caption: `${paidCount} of ${total} paid`, tone: 'neutral' },
      ],
      edges: [
        { label: notice ? 'nothing to read' : 'reads invoices', tone: 'neutral' },
        { label: selfChange ? 'submits' : 'pays', tone: 'neutral' },
        { label: 'listed only', tone: selfChange === 'applied' ? 'bad' : s.status === 'idle' ? 'neutral' : 'good' },
      ],
    },
    steps: ordered(steps),
    eventCount: s.events.length,
  };
}

/**
 * Payee changes by id: requested in a run, applied by the owner. A recorded approval is a tx_sent
 * event whose result is the applied change. The live server state, when there is one, has the last word.
 */
function changesOf(events: RunEvent[], state: AppState | undefined): Map<string, Change> {
  const changes = new Map<string, Change>();
  for (const e of events) {
    const r = asArgs(e.result);
    const id = str(r.id);
    const to = str(r.to);
    if (!id || !to) continue;
    if (e.kind === 'tool_result' && e.tool === 'request_payee_change' && !e.error && !changes.has(id)) {
      changes.set(id, { id, to, status: 'pending', requestedAt: e.ts });
    } else if (e.kind === 'tx_sent' && r.status === 'applied') {
      const prev = changes.get(id);
      changes.set(id, { ...prev, id, to, status: 'applied', approvedAt: e.ts, ...(e.txHash && { txHash: e.txHash }) });
    }
  }
  for (const c of state?.pendingChanges ?? []) {
    const prev = changes.get(c.id);
    changes.set(c.id, { ...prev, id: c.id, to: c.to, status: c.status, ...(c.txHash && { txHash: c.txHash }) });
  }
  return changes;
}

// ---------------------------------------------------------------- helpers

const IDLE = { tone: 'neutral', title: 'No run yet', detail: 'Press "Run the task" to start.' } as const;
const RUNNING = { tone: 'neutral', title: 'Running', detail: 'The agent is working through the inbox.' } as const;

function endStep(s: Scan): Step {
  const last = [...s.events].reverse().find((e) => e.kind === 'run_finished');
  return { kind: 'info', icon: 'ok', title: 'Run finished', ...(last && { ts: last.ts }) };
}

/** A step with the key that orders the timeline. */
interface Ordered { key: number; step: Step }
const at = (key: number, step: Step): Ordered => ({ key, step });
const ordered = (xs: Ordered[]) => xs.map((x, i) => ({ ...x, i })).sort((a, b) => a.key - b.key || a.i - b.i).map((x) => x.step);

/** Invoices in the inbox the server holds, or one per vendor when there is no state yet. */
function invoiceCount(state: AppState | undefined) {
  const invoices = state?.inbox.filter((e) => /^Invoice \d+$/.test(e.subject)).length ?? 0;
  return invoices || (state?.vendors ?? VENDORS).length;
}

function distinct(xs: string[]) {
  return new Set(xs.map((x) => x.toLowerCase())).size;
}

/** "Vendor 2", "Vendors 2 and 3", or "A, B and C" for other names. */
export function listNames(names: string[]) {
  const unique = [...new Set(names)];
  const numbers = unique.map((n) => /^Vendor (\d+)$/.exec(n)?.[1]);
  if (unique.length > 1 && numbers.every(Boolean)) return `Vendors ${joinAnd(numbers as string[])}`;
  return joinAnd(unique);
}

function joinAnd(xs: string[]) {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const decimal = (wei: bigint) => formatUnits(wei, MUSD_DECIMALS);
const str = (x: unknown) => (typeof x === 'string' ? x : undefined);
const asArgs = (x: unknown): Args => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Args) : {});
