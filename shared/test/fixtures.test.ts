import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RunEventKind, WalletKind } from '../src/types';

const KINDS = [
  'run_started', 'model_text', 'tool_call', 'tool_result',
  'email_delivered', 'tx_sent', 'tx_refused', 'run_finished',
] as const satisfies readonly RunEventKind[];
const WALLETS = ['baseline', 'signvault'] as const satisfies readonly WalletKind[];
// Fails to compile if RunEventKind or WalletKind gains a member these lists miss.
const allKinds: Exclude<RunEventKind, (typeof KINDS)[number]> extends never ? true : never = true;
const allWallets: Exclude<WalletKind, (typeof WALLETS)[number]> extends never ? true : never = true;

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

function load(file: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../web/fixtures/${file}`, import.meta.url), 'utf8'));
}

function expectRunEvent(e: unknown, wallet: WalletKind) {
  expect(e).toBeTypeOf('object');
  const ev = e as Record<string, unknown>;
  expect(ev.id).toBeTypeOf('string');
  expect(ev.runId).toBeTypeOf('string');
  expect(ev.ts).toBeTypeOf('number');
  expect(ev.wallet).toBe(wallet);
  expect(KINDS).toContain(ev.kind);
  expect(ev.text).toBeTypeOf('string');
  expect((ev.text as string).length).toBeGreaterThan(0);
  if (ev.kind === 'tool_call' || ev.kind === 'tool_result') expect(ev.tool).toBeTypeOf('string');
  if (ev.kind === 'tx_sent' || ev.kind === 'tx_refused') expect(ev.txHash).toMatch(TX_HASH);
  if (ev.kind === 'tx_refused') expect(ev.error).toMatch(/^[A-Z]\w+$/);
  if (ev.txHash !== undefined) expect(ev.txHash).toMatch(TX_HASH);
  if (ev.error !== undefined) expect(ev.error).toBeTypeOf('string');
}

describe.each([
  ['baseline-run.json', 'baseline'],
  ['signvault-run.json', 'signvault'],
] as const)('%s', (file, wallet) => {
  const events = load(file);

  it('is a RunEvent[] for one run', () => {
    expect(Array.isArray(events)).toBe(true);
    const list = events as Record<string, unknown>[];
    expect(list.length).toBeGreaterThan(0);
    for (const e of list) expectRunEvent(e, wallet);
    expect(new Set(list.map((e) => e.id)).size).toBe(list.length);
    expect(new Set(list.map((e) => e.runId)).size).toBe(1);
    const ts = list.map((e) => e.ts as number);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(list[0].kind).toBe('run_started');
    expect(list.at(-1)?.kind).toBe('run_finished');
  });
});
