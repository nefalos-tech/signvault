import { describe, expect, it } from 'vitest';
import { buildFixtures, compressGaps, parseSse } from './capture.mjs';

const V1 = '0x63c4E507E171CA1FD9A3638502ee278c16D04B2C';
const V2 = '0xE0C855b40fbC11530989c2205b5C723848ba9E3A';
const V3 = '0x0000000000000000000000000000000000000003';
const VENDORS = [{ name: 'Vendor 1', address: V1 }, { name: 'Vendor 2', address: V2 }, { name: 'Vendor 3', address: V3 }];
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;

/** Server-shaped events: string ids from one counter, a ts that grows by `step` ms per event. */
function stream(runs, { start = 1_000_000, step = 1000 } = {}) {
  let id = 1;
  let ts = start;
  return runs.flatMap(({ runId, wallet, steps }) =>
    steps.map((e) => ({ id: String(id++), runId, ts: (ts += step), wallet, text: e.kind, ...e })),
  );
}

const pay = (to, n, error) => [
  { kind: 'tool_call', tool: 'pay', args: { to, amount: '0.01' } },
  error
    ? { kind: 'tx_refused', error, txHash: hash(n) }
    : { kind: 'tx_sent', txHash: hash(n) },
  { kind: 'tool_result', tool: 'pay', txHash: hash(n), ...(error && { error }), result: error ? `REFUSED: ${error}` : `OK: ${hash(n)}` },
];

const baselineDrains = (n) => [
  { kind: 'run_started' },
  ...pay(V1, n + 1),
  ...pay(V2, n + 2, 'DailyCapExceeded'),
  { kind: 'tool_call', tool: 'request_limit_change', args: { new_daily_limit: '0.03' } },
  { kind: 'tool_result', tool: 'request_limit_change', result: 'OK: a code was sent to the inbox.' },
  { kind: 'email_delivered' },
  { kind: 'tool_call', tool: 'confirm_limit_change', args: { code: '123456' } },
  { kind: 'tx_sent', txHash: hash(n + 3) },
  { kind: 'tool_result', tool: 'confirm_limit_change', txHash: hash(n + 3), result: 'The code was accepted.' },
  ...pay(V2, n + 4),
  ...pay(V3, n + 5),
  { kind: 'run_finished' },
];

const baselineGivesUp = [{ kind: 'run_started' }, ...pay(V1, 90), ...pay(V2, 91, 'DailyCapExceeded'), { kind: 'run_finished' }];

const vaultRefused = (changeId) => [
  { kind: 'run_started' },
  ...pay(V1, 20),
  ...pay(V2, 21, 'NotOnTheList'),
  { kind: 'tool_call', tool: 'request_payee_change', args: { to: V2, amount: '0.01' } },
  // The real tool result: amount in mUSD, no nonce.
  { kind: 'tool_result', tool: 'request_payee_change', result: { id: changeId, to: V2, amount: '0.01', status: 'pending' } },
  { kind: 'email_delivered' },
  { kind: 'run_finished' },
];

const vaultPaysVendor2 = [{ kind: 'run_started' }, ...pay(V2, 30), { kind: 'run_finished' }];

const applied = (id) => ({ id, to: V2, amount: '10000000000000000', nonce: '0', status: 'applied', txHash: hash(99) });

describe('parseSse', () => {
  it('reads each data frame as one event and skips keep-alives', () => {
    const text = 'id: 1\ndata: {"id":"1","kind":"run_started"}\n\n: ping\n\nid: 2\ndata: {"id":"2","kind":"run_finished"}\n\n';
    expect(parseSse(text).map((e) => e.id)).toEqual(['1', '2']);
  });
});

describe('buildFixtures, baseline', () => {
  it('picks the latest run that raised its own limit and paid all three vendors', () => {
    const events = stream([
      { runId: 'baseline-old', wallet: 'baseline', steps: baselineDrains(0) },
      { runId: 'baseline-giveup', wallet: 'baseline', steps: baselineGivesUp },
      { runId: 'baseline-good', wallet: 'baseline', steps: baselineDrains(10) },
      { runId: 'signvault-a', wallet: 'signvault', steps: vaultRefused('chg') },
    ]);
    const { baseline, picked } = buildFixtures(events, [], VENDORS);
    expect(picked.baseline).toBe('baseline-good');
    expect(new Set(baseline.map((e) => e.runId))).toEqual(new Set(['baseline-good']));
    expect(baseline.filter((e) => e.kind === 'tx_sent').map((e) => e.txHash)).toEqual([hash(11), hash(13), hash(14), hash(15)]);
  });

  it('keeps one wallet’s run whole when the other wallet’s events are interleaved', () => {
    const base = stream([{ runId: 'baseline-good', wallet: 'baseline', steps: baselineDrains(0) }]);
    const vault = stream([{ runId: 'signvault-a', wallet: 'signvault', steps: vaultRefused('chg') }], { start: 1_000_500 });
    const events = [...base, ...vault].sort((a, b) => a.ts - b.ts);
    const { baseline } = buildFixtures(events, [], VENDORS);
    expect(baseline).toHaveLength(base.length);
    expect(baseline.every((e) => e.wallet === 'baseline')).toBe(true);
  });

  it('takes a run that raised its limit before the cap refused it', () => {
    // Drop the refused payment to Vendor 2: its tool_call, tx_refused and tool_result.
    const early = baselineDrains(0).filter((e, i, all) => !e.error && !all[i + 1]?.error);
    const events = stream([
      { runId: 'baseline-early', wallet: 'baseline', steps: early },
      { runId: 'signvault-a', wallet: 'signvault', steps: vaultRefused('chg') },
    ]);
    expect(buildFixtures(events, [], VENDORS).picked.baseline).toBe('baseline-early');
  });

  it('fails with a hint when no baseline run drained the wallet', () => {
    const events = stream([
      { runId: 'baseline-giveup', wallet: 'baseline', steps: baselineGivesUp },
      { runId: 'signvault-a', wallet: 'signvault', steps: vaultRefused('chg') },
    ]);
    expect(() => buildFixtures(events, [], VENDORS)).toThrow(/--baseline/);
  });
});

describe('buildFixtures, SignVault', () => {
  const events = stream([
    { runId: 'baseline-good', wallet: 'baseline', steps: baselineDrains(0) },
    { runId: 'signvault-other', wallet: 'signvault', steps: vaultRefused('chg-other') },
    { runId: 'signvault-refused', wallet: 'signvault', steps: vaultRefused('chg-2') },
    { runId: 'signvault-paid', wallet: 'signvault', steps: vaultPaysVendor2 },
  ]);
  // The owner signs between the runs, minutes after the refusal.
  for (const e of events) if (e.runId === 'signvault-paid') e.ts += 300_000;
  const changes = [{ ...applied('chg-other'), status: 'pending', txHash: undefined }, applied('chg-2')];

  it('plays the refused run, the owner’s approval, then the run that pays Vendor 2', () => {
    const { signvault, picked } = buildFixtures(events, changes, VENDORS);
    expect(picked.signvault).toEqual(['signvault-refused', 'signvault-paid']);
    expect([...new Set(signvault.map((e) => e.runId))]).toEqual(['signvault-refused', 'owner-approval', 'signvault-paid']);
  });

  it('records the approval as a tx line with PayeeSet’s hash and the applied change', () => {
    const { signvault } = buildFixtures(events, changes, VENDORS);
    const approval = signvault.find((e) => e.runId === 'owner-approval');
    expect(approval).toMatchObject({ wallet: 'signvault', kind: 'tx_sent', txHash: hash(99), result: applied('chg-2') });
    expect(approval.text).toContain('Vendor 2');
    expect(approval.text).toContain('0.01 mUSD');
  });

  it('falls back to the refused run alone when no change was applied', () => {
    const pending = changes.map((c) => ({ ...c, status: 'pending', txHash: undefined }));
    const { signvault, picked, warnings } = buildFixtures(events, pending, VENDORS);
    expect(picked.signvault).toEqual(['signvault-refused']);
    expect(new Set(signvault.map((e) => e.runId))).toEqual(new Set(['signvault-refused']));
    expect(warnings.join(' ')).toMatch(/refused run only/);
  });

  it('takes the runs named on the command line', () => {
    const { picked } = buildFixtures(events, changes, VENDORS, { baseline: 'baseline-good', signvault: ['signvault-other'] });
    expect(picked.signvault).toEqual(['signvault-other']);
  });
});

describe('buildFixtures, ids and timing', () => {
  const events = stream([
    { runId: 'baseline-good', wallet: 'baseline', steps: baselineDrains(0) },
    { runId: 'signvault-refused', wallet: 'signvault', steps: vaultRefused('chg-2') },
    { runId: 'signvault-paid', wallet: 'signvault', steps: vaultPaysVendor2 },
  ]);
  for (const e of events) if (e.runId === 'signvault-paid') e.ts += 300_000;

  it('gives every event a stable id that is unique across both files', () => {
    const { baseline, signvault } = buildFixtures(events, [applied('chg-2')], VENDORS);
    const ids = [...baseline, ...signvault].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(baseline[0].id).toBe('recorded-baseline-01');
    expect(signvault.at(-1).id).toBe(`recorded-signvault-${String(signvault.length).padStart(2, '0')}`);
  });

  it('shortens the wait for the owner to the longest allowed gap', () => {
    const { signvault } = buildFixtures(events, [applied('chg-2')], VENDORS, { maxGapMs: 2000 });
    const gaps = signvault.slice(1).map((e, i) => e.ts - signvault[i].ts);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2000);
  });
});

describe('compressGaps', () => {
  it('caps long gaps, keeps short ones, the first ts and the order', () => {
    const events = [0, 500, 60_500, 61_000].map((ts, i) => ({ id: String(i), ts }));
    expect(compressGaps(events, 3000).map((e) => e.ts)).toEqual([0, 500, 3500, 4000]);
  });
});
