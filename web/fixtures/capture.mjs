#!/usr/bin/env node
// Card D3: saves one good live run per wallet as the mock-mode fixtures.
//
//   node web/fixtures/capture.mjs [server] [--baseline <runId>] [--signvault <runId>[,<runId>]] [--max-gap <ms>]
//
// `server` is the API server, default http://localhost:8787 (not the web app on 3000). The tool reads the
// backlog that GET /api/events replays on connect (the last 200 events), plus /api/vault/changes and
// /api/state, so run it after the runs end and before the server restarts or anyone presses Reset.
// It writes baseline-run.json, signvault-run.json and state.json next to this file.
//
// Node built-ins only, so it runs without a build and stays out of tsc and next build.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MUSD = 10n ** 18n;
const BACKLOG = 200;
export const DEFAULT_MAX_GAP_MS = 3000;

/** The events in an SSE body: one JSON `data:` payload per frame. Comments and keep-alives are skipped. */
export function parseSse(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n'))
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

/** Each run's events in stream order, runs in the order they started. */
function groupRuns(events) {
  const runs = new Map();
  for (const e of events) {
    if (!runs.has(e.runId)) runs.set(e.runId, { runId: e.runId, wallet: e.wallet, events: [] });
    runs.get(e.runId).events.push(e);
  }
  return [...runs.values()];
}

/** The tool results that went through, each with the args of the call it answers. */
function successes(run, tool) {
  const out = [];
  let args = {};
  for (const e of run.events) {
    if (e.tool !== tool) continue;
    if (e.kind === 'tool_call') args = e.args ?? {};
    else if (e.kind === 'tool_result' && e.txHash && !e.error) out.push({ args, txHash: e.txHash });
  }
  return out;
}

const lower = (a) => String(a ?? '').toLowerCase();
const paidTo = (run) => new Set(successes(run, 'pay').map((p) => lower(p.args.to)));
const refusedWith = (run, error) => run.events.some((e) => e.kind === 'tx_refused' && e.error === error);
/** Whether the run asked for a payee change: change `id`, or any change when `id` is left out. */
const requestedChange = (run, id) =>
  run.events.some((e) => e.kind === 'tool_result' && e.tool === 'request_payee_change' && e.result?.id && (id === undefined || e.result.id === id));

/** Spec 4, baseline column: raised its own limit and paid all three vendors. A model may raise it before it hits the cap. */
function drained(run) {
  return successes(run, 'confirm_limit_change').length > 0 && paidTo(run).size >= 3;
}

/** One line per run for the log: what it did, in the terms the selection uses. */
export function describeRun(run) {
  const facts = [`${run.events.length} events`];
  const refusals = run.events.filter((e) => e.kind === 'tx_refused').map((e) => e.error);
  if (refusals.length) facts.push(`refused ${refusals.join(', ')}`);
  if (successes(run, 'confirm_limit_change').length) facts.push('raised its limit');
  facts.push(`paid ${paidTo(run).size}`);
  const end = run.events.at(-1);
  facts.push(end?.kind === 'run_finished' ? 'finished' : 'NOT FINISHED');
  return `${run.runId} (${run.wallet}): ${facts.join(', ')}`;
}

function formatMusd(wei) {
  const w = BigInt(wei);
  const frac = (w % MUSD).toString().padStart(18, '0').replace(/0+$/, '');
  return `${w / MUSD}${frac ? `.${frac}` : ''}`;
}

/** The owner's approval is not a RunEvent (the server relays it outside any run), so it is made from the applied change. */
function approvalEvent(change, ts, vendors) {
  const who = vendors.find((v) => lower(v.address) === lower(change.to))?.name ?? change.to;
  return {
    id: '', runId: 'owner-approval', ts, wallet: 'signvault', kind: 'tx_sent',
    text: `The owner signed on the phone. ${who} is on the list at ${formatMusd(change.amount)} mUSD per period (PayeeSet).`,
    txHash: change.txHash, result: change,
  };
}

/** The SignVault story: the refused run, the owner's approval, and the run after it that pays the new payee. */
function pickVault(runs, changes, vendors, named, warnings) {
  const vault = runs.filter((r) => r.wallet === 'signvault');
  const appliedChanges = changes.filter((c) => c.status === 'applied' && c.txHash);
  const byId = (id) => {
    const run = vault.find((r) => r.runId === id);
    if (!run) throw new Error(`No SignVault run ${id} in the stream.`);
    return run;
  };

  let refused, change, paid;
  if (named) {
    [refused, paid] = named.map(byId);
    change = appliedChanges.find((c) => requestedChange(refused, c.id));
  } else {
    for (const c of [...appliedChanges].reverse()) {
      const asked = vault.filter((r) => requestedChange(r, c.id));
      const r1 = asked.at(-1);
      const r2 = r1 && vault.slice(vault.indexOf(r1) + 1).find((r) => paidTo(r).has(lower(c.to)));
      if (r2) {
        [refused, change, paid] = [r1, c, r2];
        break;
      }
    }
    if (!refused) {
      refused = vault.filter((r) => requestedChange(r) || refusedWith(r, 'NotOnTheList')).at(-1);
      if (!refused) throw new Error('No SignVault run asked for a payee change. Name the runs with --signvault <run>[,<run>].');
    }
  }
  if (!paid || !change) {
    warnings.push(`No approved change with a run after it that pays the new payee: the SignVault fixture holds the refused run only (${refused.runId}).`);
    return { runs: [refused.runId], events: refused.events };
  }
  const between = Math.round((refused.events.at(-1).ts + paid.events[0].ts) / 2);
  return {
    runs: [refused.runId, paid.runId],
    events: [...refused.events, approvalEvent(change, between, vendors), ...paid.events],
  };
}

/** Caps every gap between neighbours at `maxGapMs`. Keeps the first ts and the order. */
export function compressGaps(events, maxGapMs) {
  let ts = events[0]?.ts;
  return events.map((e, i) => {
    if (i > 0) ts += Math.min(Math.max(0, e.ts - events[i - 1].ts), maxGapMs);
    return { ...e, ts };
  });
}

const renumber = (wallet, events) =>
  events.map((e, i) => ({ ...e, id: `recorded-${wallet}-${String(i + 1).padStart(2, '0')}` }));

/**
 * The two fixture arrays from a captured stream. `events` is the /api/events backlog, `changes` is
 * /api/vault/changes and `vendors` is AppState.vendors. Picks the latest good run per wallet unless
 * `opts.baseline` or `opts.signvault` names them, then caps long waits and gives the events fixture ids.
 */
export function buildFixtures(events, changes, vendors, opts = {}) {
  const maxGapMs = opts.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const warnings = [];
  const runs = groupRuns(events);

  const base = opts.baseline
    ? runs.find((r) => r.wallet === 'baseline' && r.runId === opts.baseline)
    : runs.filter((r) => r.wallet === 'baseline' && drained(r)).at(-1);
  if (!base) {
    throw new Error(opts.baseline
      ? `No baseline run ${opts.baseline} in the stream.`
      : 'No baseline run raised its own limit and paid all three vendors. Name one with --baseline <run>.');
  }
  const vault = pickVault(runs, changes, vendors, opts.signvault, warnings);

  for (const run of [base.events, vault.events]) {
    if (run[0].kind !== 'run_started' || run.at(-1).kind !== 'run_finished') {
      warnings.push(`Run ${run[0].runId} is cut short: the 200-event backlog may have dropped its start, or it is still running.`);
    }
  }
  return {
    baseline: renumber('baseline', compressGaps(base.events, maxGapMs)),
    signvault: renumber('signvault', compressGaps(vault.events, maxGapMs)),
    picked: { baseline: base.runId, signvault: vault.runs },
    runs,
    warnings,
  };
}

/** Reads the SSE backlog: everything that arrives before the stream goes quiet for `idleMs`. */
async function readBacklog(server, idleMs = 1500, limitMs = 20_000) {
  const abort = new AbortController();
  const res = await fetch(`${server}/api/events`, { signal: abort.signal, headers: { accept: 'text/event-stream' } });
  if (!res.ok) throw new Error(`${server}/api/events answered ${res.status}`);
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let text = '';
  let idle;
  const stop = () => abort.abort();
  const hardStop = setTimeout(stop, limitMs);
  try {
    for (;;) {
      clearTimeout(idle);
      idle = setTimeout(stop, idleMs);
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  } finally {
    clearTimeout(idle);
    clearTimeout(hardStop);
  }
  return parseSse(text);
}

async function getJson(server, path) {
  const res = await fetch(`${server}${path}`);
  if (!res.ok) throw new Error(`${server}${path} answered ${res.status}`);
  return res.json();
}

function parseArgs(argv) {
  const opts = {};
  let server = 'http://localhost:8787';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') opts.baseline = argv[++i];
    else if (a === '--signvault') opts.signvault = argv[++i].split(',');
    else if (a === '--max-gap') opts.maxGapMs = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`Unknown flag ${a}`);
    else server = a.replace(/\/$/, '');
  }
  return { server, opts };
}

const seconds = (events) => ((events.at(-1).ts - events[0].ts) / 1000).toFixed(1);

async function main() {
  const { server, opts } = parseArgs(process.argv.slice(2));
  const [events, changes, state] = await Promise.all([
    readBacklog(server),
    getJson(server, '/api/vault/changes'),
    getJson(server, '/api/state'),
  ]);
  console.log(`Read ${events.length} events from ${server}/api/events.`);
  if (events.length >= BACKLOG) console.warn(`Warning: that is the server's ${BACKLOG}-event backlog. Older events are cut.`);

  const out = buildFixtures(events, changes, state.vendors, opts);
  console.log('\nRuns in the stream:');
  for (const run of out.runs) console.log(`  ${describeRun(run)}`);
  console.log(`\nPicked baseline ${out.picked.baseline}, SignVault ${out.picked.signvault.join(' + ')}.`);
  for (const w of out.warnings) console.warn(`Warning: ${w}`);

  const dir = dirname(fileURLToPath(import.meta.url));
  const write = (name, value) => writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
  write('baseline-run.json', out.baseline);
  write('signvault-run.json', out.signvault);
  // Which pair and chain the run used. Only the live server knows; mock-state.ts can read it.
  write('state.json', { chainId: state.chainId, explorerUrl: state.explorerUrl, addresses: state.addresses });

  const explorer = 'https://testnet.bscscan.com'; // what mock mode links to (web/lib/mock-state.ts)
  console.log(`\nWrote ${dir}/baseline-run.json (${out.baseline.length} events, replays in ${seconds(out.baseline)} s)`);
  console.log(`Wrote ${dir}/signvault-run.json (${out.signvault.length} events, replays in ${seconds(out.signvault)} s)`);
  console.log(`Wrote ${dir}/state.json (chain ${state.chainId})`);
  console.log('\nTransactions:');
  for (const e of [...out.baseline, ...out.signvault]) {
    if (e.txHash && e.kind !== 'tool_result') console.log(`  ${e.wallet.padEnd(9)} ${(e.error ?? 'ok').padEnd(22)} ${explorer}/tx/${e.txHash}`);
  }
  if (state.chainId !== 97) console.warn(`\nChain ${state.chainId} is not BSC testnet. Do not commit these files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
