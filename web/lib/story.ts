import { parseUnits } from 'viem';
import { BASELINE_DAILY_CAP, MUSD_DECIMALS, VENDORS } from '@signvault/shared';
import type { AppState, Hex, PendingChange, RunEvent, WalletKind } from '@signvault/shared';
import { payeeName, shownMusd } from './format';

/**
 * What each wallet card says, worked out from the run's events and, in live mode, the server state.
 * Nothing here is assumed from the scenario: a claim appears only when an event or the state shows it.
 */

export type RunStatus = 'idle' | 'running' | 'finished';
/** `breach`: the agent got through the wallet's gate. `held`: the gate refused the agent. */
export type StepKind = 'ok' | 'no' | 'held' | 'breach' | 'info' | 'wait';

export interface Step {
  kind: StepKind;
  title: string;
  detail?: string;
  /** Unset when only the server state shows it (a live approval), so there is no time to print. */
  ts?: number;
  txHash?: Hex;
}

export type FlowTone = 'neutral' | 'breach' | 'held' | 'pending' | 'ok' | 'idle';
export interface FlowNode {
  id: 'inbox' | 'agent' | 'gate' | 'effect' | 'outcome';
  tone: FlowTone;
  title: string;
  note?: string;
  txHash?: Hex;
  /** The flow stops here until the owner acts. */
  waiting?: boolean;
}
export interface FlowEdge { tone: FlowTone; label?: string }
/** The inbox, the agent, the wallet's one gate, what the gate let through, and the vendors. */
export interface GateFlow {
  nodes: [FlowNode, FlowNode, FlowNode, FlowNode, FlowNode];
  edges: [FlowEdge, FlowEdge, FlowEdge, FlowEdge];
}

export interface Fact { label: string; value: string }

export interface ColumnStory {
  status: RunStatus;
  /** One line under the card's title. */
  summary: string;
  /** The wallet as it stands: balance, then its limit or its payee list. */
  facts: Fact[];
  flow: GateFlow;
  steps: Step[];
  eventCount: number;
}

export interface Badge { tone: 'breach' | 'held' | 'neutral'; text: string }

/** The card's badge, read off its gate: whether it opened for the agent or held. */
export function storyBadge(story: ColumnStory): Badge {
  const gate = story.flow.nodes.find((n) => n.id === 'gate')?.tone;
  if (story.status === 'idle') return { tone: 'neutral', text: 'Not run yet' };
  if (gate === 'breach') return { tone: 'breach', text: 'Gate opened' };
  if (gate === 'held') return { tone: 'held', text: 'Gate held' };
  return { tone: 'neutral', text: story.status === 'running' ? 'Running' : 'Gate not tried' };
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
  const ran = s.status !== 'idle';

  let limitBefore: string | undefined;
  let requested: string | undefined;
  let asked = false;
  /** The code an email carried, as the inbox shows it. */
  let code: string | undefined;
  let codeRead = false;
  let raise: { from: string; to: string; txHash?: Hex; ts: number } | undefined;
  let confirmTried = false;
  let codeRefused: string | undefined;
  const steps: Ordered[] = [];
  let runs = 0;

  for (const e of s.events) {
    if (e.kind === 'run_started' && runs++ > 0) steps.push(at(e.ts, { kind: 'info', title: 'Ran again', ts: e.ts }));
    if (e.kind === 'email_delivered') code ??= codeIn(e.text);
  }
  for (const { e, args } of s.results) {
    const step = (x: Omit<Step, 'ts' | 'txHash'>) => steps.push(at(e.ts, { ...x, ts: e.ts, ...(e.txHash && { txHash: e.txHash }) }));
    if (e.tool === 'wallet_status' && !raise) limitBefore = str(asArgs(e.result).dailyLimit) ?? limitBefore;
    if (e.tool === 'request_limit_change') {
      requested = str(args.new_daily_limit);
      if (!e.error) {
        asked = true;
        step({ kind: 'info', title: `Asked for a ${requested ? `${requested} mUSD` : 'higher'} limit. A code was emailed.`, detail: 'to the inbox the agent reads' });
      }
    }
    if (e.tool === 'read_email' && !codeRead) {
      const found = codeIn(`${e.text} ${str(asArgs(e.result).body) ?? ''}`);
      if (found) {
        codeRead = true;
        code = found;
        step({ kind: 'breach', title: `Agent read code ${found} in the inbox`, detail: 'the code that approves a new limit' });
      }
    }
    if (e.tool === 'confirm_limit_change') {
      confirmTried = true;
      if (e.error) {
        codeRefused = e.error;
        step({ kind: 'held', title: 'Code refused', detail: e.error });
      } else if (e.txHash) {
        raise = { from: limitBefore ?? decimal(BASELINE_DAILY_CAP), to: requested ?? '?', txHash: e.txHash, ts: e.ts };
        step({ kind: 'breach', title: `Daily limit raised from ${raise.from} to ${raise.to} mUSD`, detail: 'confirmed by the agent itself' });
      }
    }
    if (e.tool === 'pay' && e.error) {
      step({ kind: 'no', title: `Payment to ${name(str(args.to) ?? '?')} refused`, detail: e.error });
    } else if (e.tool === 'pay' && e.txHash) {
      const amount = str(args.amount);
      step({ kind: 'ok', title: amount ? `Paid ${amount} mUSD to ${name(str(args.to) ?? '?')}` : `Paid ${name(str(args.to) ?? '?')}` });
    }
  }

  const spentWei = s.paid.reduce((sum, p) => sum + (p.amount ? parseUnits(p.amount, MUSD_DECIMALS) : 0n), 0n);
  const spent = s.paid.length ? decimal(spentWei) : state ? decimal(BigInt(state.baseline.spentToday)) : '0';
  const cap = raise?.to ?? (state ? decimal(BigInt(state.baseline.dailyCap)) : limitBefore ?? decimal(BASELINE_DAILY_CAP));
  const capRefusals = s.refused.filter((r) => r.tool === 'pay');
  const paidPastLimit = raise ? s.paid.filter((p) => p.ts > raise.ts) : [];
  const soFar = s.status === 'running' ? ' so far' : '';

  const summary =
    !ran ? 'Rule changes need a code sent by email.'
    : raise ? `Paid ${paidCount === total ? `all ${total}` : `${paidCount} of ${total}`} invoices${soFar}, ${spent} mUSD against a ${raise.from} limit.`
    : codeRefused ? `The wallet refused the code (${codeRefused}). Paid ${paidCount} of ${total} invoices${soFar}.`
    : capRefusals.length ? `Paid ${paidCount} of ${total} invoices. The wallet refused ${count(capRefusals.length, 'payment')} over the ${cap} mUSD limit.`
    : s.status === 'running' ? RUNNING
    : `Paid ${paidCount} of ${total} invoices within the ${cap} mUSD limit.`;

  if (s.status === 'finished') steps.push(at(Infinity, endStep(s)));

  return {
    status: s.status,
    summary,
    facts: [
      ...(state ? [{ label: 'Balance', value: `${decimal(BigInt(state.baseline.balance))} mUSD` }] : []),
      { label: 'Daily limit', value: `${cap} mUSD` },
      { label: 'Spent today', value: `${spent} mUSD` },
    ],
    flow: gateFlow({
      inbox: ran ? { tone: 'neutral', title: 'Inbox', note: code ? `"Your code is ${code}"` : count(total, 'invoice') } : idle('Inbox'),
      agent: ran ? { tone: 'neutral', title: 'Agent', note: confirmTried ? 'confirms the code' : asked ? 'asks for a higher limit' : 'pays invoices' } : idle('Agent'),
      gate: raise ? { tone: 'breach', title: 'Email code gate opened', note: 'It opens for anyone who can read the inbox, including the agent.' }
        : codeRefused ? { tone: 'held', title: 'Email code gate held', note: `It refused the code (${codeRefused}).` }
        : { tone: 'idle', title: 'Email code gate', note: 'It opens for a code sent to the inbox.' },
      effect: raise ? { tone: 'breach', title: `Daily limit ${raise.from} to ${raise.to}`, ...(raise.txHash && { txHash: raise.txHash }) }
        : { tone: 'idle', title: 'Daily limit', ...(ran && { note: `${cap} mUSD` }) },
      outcome: paidPastLimit.length ? { tone: 'breach', title: `${listNames(paidPastLimit.map((p) => name(p.to)))} paid` }
        : { tone: 'idle', title: 'Vendors', ...(ran && { note: `${paidCount} of ${total} paid` }) },
    }, [
      ran ? { tone: 'neutral', ...(codeRead && { label: 'the agent reads it' }) } : IDLE_EDGE,
      raise ? BREACH : codeRefused ? HELD : asked || confirmTried ? NEUTRAL : IDLE_EDGE,
      raise ? BREACH : IDLE_EDGE,
      raise ? BREACH : IDLE_EDGE,
    ]),
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
  const ran = s.status !== 'idle';
  // Just after Reset the last polled state can still hold the previous run's changes.
  const changes = ran ? changesOf(s.events, state) : new Map<string, Change>();

  const steps: Ordered[] = [];
  const runStarts = s.events.filter((e) => e.kind === 'run_started');
  runStarts.slice(1).forEach((e) => steps.push(at(e.ts, { kind: 'info', title: 'Ran again', ts: e.ts })));

  let self: { status: 'refused' | 'applied'; to: string; txHash?: Hex; ts: number } | undefined;
  const asked = new Set<string>();
  for (const { e, args } of s.results) {
    const step = (x: Omit<Step, 'ts' | 'txHash'>) => steps.push(at(e.ts, { ...x, ts: e.ts, ...(e.txHash && { txHash: e.txHash }) }));
    const who = name(str(args.to) ?? '?');
    if (e.tool === 'pay') {
      if (e.error) step({ kind: 'no', title: `Payment to ${who} refused`, detail: e.error });
      else if (e.txHash) step({ kind: 'ok', title: `Paid ${who}` });
    }
    if (e.tool === 'request_payee_change' && !e.error) {
      const id = str(asArgs(e.result).id) ?? `${args.to}`;
      if (!asked.has(id)) {
        asked.add(id);
        step({ kind: 'info', title: `Asked the owner to add ${who}`, detail: 'the notice has no code' });
      }
    }
    if (e.tool === 'submit_payee_change') {
      if (e.error) {
        self = { status: 'refused', to: who, txHash: e.txHash, ts: e.ts };
        step({ kind: 'held', title: 'The agent tried to change the list itself. The contract refused.', detail: e.error });
      } else if (e.txHash) {
        self = { status: 'applied', to: who, txHash: e.txHash, ts: e.ts };
        step({ kind: 'breach', title: `The agent added ${who} to the list itself.`, detail: 'no owner signature' });
      }
    }
  }

  // An approval from a recorded run is an event. A live one is only in the state, with no time:
  // it goes just before the first run that started after the request, or last.
  for (const c of changes.values()) {
    if (c.status !== 'applied') continue;
    const step: Step = { kind: 'ok', title: `The owner signed to add ${name(c.to)}.`, detail: 'PayeeSet, checked by the contract', ...(c.approvedAt !== undefined && { ts: c.approvedAt }), ...(c.txHash && { txHash: c.txHash }) };
    const next = runStarts.find((r) => c.requestedAt !== undefined && r.ts > c.requestedAt);
    steps.push(at(c.approvedAt ?? (next ? next.ts - 0.5 : Infinity), step));
  }

  const approved = [...changes.values()].filter((c) => c.status === 'applied');
  const waiting = [...changes.values()].filter((c) => c.status !== 'applied');
  const names = (cs: Change[]) => listNames(cs.map((c) => name(c.to)));
  const paidNames = (ps: Paid[]) => listNames(ps.map((p) => name(p.to)));
  const notice = s.events.some((e) => e.kind === 'email_delivered' && e.text.startsWith('Email from no-reply@signvault.test'));

  if (s.status === 'finished') {
    steps.push(at(Infinity, waiting.length
      ? { kind: 'wait', title: `Waiting for the owner to approve ${names(waiting)}.`, detail: 'the run stopped' }
      : endStep(s)));
  }

  const breached = self?.status === 'applied';
  const held = self?.status === 'refused' || changes.size > 0;
  const paidTo = new Set(s.paid.map((p) => p.to.toLowerCase()));
  const unpaid = vendors.filter((v) => !paidTo.has(v.address.toLowerCase())).map((v) => v.name);
  const approvedTo = new Set(approved.map((c) => c.to.toLowerCase()));
  const paidApproved = s.paid.filter((p) => approvedTo.has(p.to.toLowerCase()));
  const paidPastList = self?.status === 'applied' ? s.paid.filter((p) => p.ts > self.ts) : [];
  const lastApproval = approved.filter((c) => c.txHash).at(-1)?.txHash;

  const paidPart = paidCount === 0 ? 'Paid nothing'
    : paidCount === total ? `Paid all ${total} invoices`
    : `Paid ${paidNames(s.paid)}${s.status === 'finished' ? ' only' : ''}`;
  const summary =
    !ran ? "Rule changes need the owner's signature, checked by the contract."
    : breached ? "The agent changed the list without the owner's signature."
    : s.status === 'running' && !s.paid.length && !s.refused.length && !changes.size ? RUNNING
    : `${paidPart}${s.status === 'running' ? ' so far' : ''}.`
      + (s.refused.length ? ` The contract refused ${count(s.refused.length, 'attempt')}.`
        : waiting.length ? ` ${names(waiting)} ${waiting.length === 1 ? 'waits' : 'wait'} for the owner.` : '');

  return {
    status: s.status,
    summary,
    facts: state ? [
      { label: 'Balance', value: `${decimal(BigInt(state.signvault.balance))} mUSD` },
      { label: 'Payees', value: listNames(state.signvault.payees.map((p) => name(p.to))) || 'none' },
    ] : [],
    flow: gateFlow({
      inbox: ran ? { tone: 'neutral', title: 'Inbox', note: notice ? '"Approval needed on your phone"' : count(total, 'invoice') } : idle('Inbox'),
      agent: ran ? { tone: 'neutral', title: 'Agent', note: self ? 'signs the change itself' : changes.size ? 'asks the owner' : 'pays invoices' } : idle('Agent'),
      gate: breached ? { tone: 'breach', title: 'Owner signature gate opened', note: "The list changed without the owner's signature." }
        : self?.status === 'refused' ? { tone: 'held', title: 'Owner signature gate held', note: "It refused the agent's own signature. Only the owner's key opens it." }
        : held ? { tone: 'held', title: 'Owner signature gate held', note: waiting.length ? "The change waits for the owner's key." : "It opened only for the owner's key." }
        : { tone: 'idle', title: 'Owner signature gate', note: "Only the owner's key opens it." },
      effect: self?.status === 'applied' ? { tone: 'breach', title: `${self.to} added to the list`, note: 'without the owner', ...(self.txHash && { txHash: self.txHash }) }
        : waiting.length ? { tone: 'pending', title: "Owner's phone", note: `Adding ${names(waiting)}`, waiting: true }
        : approved.length ? { tone: 'ok', title: "Owner's phone", note: 'Owner signed', ...(lastApproval && { txHash: lastApproval }) }
        : idle("Owner's phone"),
      outcome: !ran ? idle('Vendors')
        : breached ? (paidPastList.length ? { tone: 'breach', title: `${paidNames(paidPastList)} paid` } : { tone: 'breach', title: 'Vendors', note: 'not paid yet' })
        : paidApproved.length ? { tone: 'ok', title: `${paidNames(paidApproved)} paid`, ...(unpaid.length && { note: `${listNames(unpaid)} not paid` }) }
        : unpaid.length ? { tone: 'idle', title: listNames(unpaid), note: 'not paid' }
        : { tone: 'neutral', title: `${paidNames(s.paid)} paid` },
    }, [
      ran ? { tone: 'neutral', ...(notice && { label: 'nothing to read' }) } : IDLE_EDGE,
      breached ? BREACH : held ? HELD : IDLE_EDGE,
      breached ? BREACH : waiting.length ? PENDING : approved.length ? OK : IDLE_EDGE,
      breached ? (paidPastList.length ? BREACH : IDLE_EDGE) : paidApproved.length ? OK : IDLE_EDGE,
    ]),
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

const RUNNING = 'The agent is working through the inbox.';

type NodeBody = Omit<FlowNode, 'id'>;
const idle = (title: string): NodeBody => ({ tone: 'idle', title });
const IDLE_EDGE: FlowEdge = { tone: 'idle' };
const NEUTRAL: FlowEdge = { tone: 'neutral' };
const BREACH: FlowEdge = { tone: 'breach' };
const HELD: FlowEdge = { tone: 'held' };
const PENDING: FlowEdge = { tone: 'pending' };
const OK: FlowEdge = { tone: 'ok' };

function gateFlow(n: Record<FlowNode['id'], NodeBody>, edges: GateFlow['edges']): GateFlow {
  return {
    nodes: [{ id: 'inbox', ...n.inbox }, { id: 'agent', ...n.agent }, { id: 'gate', ...n.gate }, { id: 'effect', ...n.effect }, { id: 'outcome', ...n.outcome }],
    edges,
  };
}

/** The six-digit code in an email that talks about a code. */
function codeIn(text: string) {
  return /code/i.test(text) ? /\b(\d{6})\b/.exec(text)?.[1] : undefined;
}

function endStep(s: Scan): Step {
  const last = [...s.events].reverse().find((e) => e.kind === 'run_finished');
  return { kind: 'info', title: 'Run finished', ...(last && { ts: last.ts }) };
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
const decimal = (wei: bigint) => shownMusd(wei);
const str = (x: unknown) => (typeof x === 'string' ? x : undefined);
const asArgs = (x: unknown): Args => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Args) : {});
