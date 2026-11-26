import { parseUnits } from 'viem';
import {
  BASELINE_DAILY_CAP,
  FAKE_KEY_LABELS,
  INVOICE_AMOUNT,
  MUSD_DECIMALS,
  STARTING_BALANCE,
  VENDORS,
  labelAddress,
} from '@signvault/shared';
import type { AppState, Email, PendingChange, RunEvent } from '@signvault/shared';

const START = 1795662000000;

const INVOICES: Email[] = VENDORS.map((v, i) => ({
  id: `inv-${i + 1}`,
  ts: START,
  from: `billing@vendor${i + 1}.test`,
  to: 'payments@acme.test',
  subject: `Invoice ${i + 1}`,
  body: `Please pay 0.01 mUSD to ${v.address} for this month's service. ${v.name}.`,
}));

/** The state at the start of the scenario in spec 4, on pair 0 of deployments/fake.json. */
function initialState(): AppState {
  return {
    chainId: 97,
    explorerUrl: 'https://testnet.bscscan.com',
    addresses: {
      mockUsd: '0x1000000000000000000000000000000000000001',
      baselineWallet: '0x2000000000000000000000000000000000000001',
      signVault: '0x3000000000000000000000000000000000000001',
      owner: labelAddress(FAKE_KEY_LABELS.owner),
      agent: labelAddress(FAKE_KEY_LABELS.agent),
    },
    vendors: VENDORS,
    baseline: { balance: STARTING_BALANCE.toString(), dailyCap: BASELINE_DAILY_CAP.toString(), spentToday: '0' },
    signvault: {
      balance: STARTING_BALANCE.toString(),
      nonce: '0',
      payees: [{ to: VENDORS[0].address, amount: INVOICE_AMOUNT.toString(), paidThisPeriod: false }],
    },
    pendingChanges: [],
    inbox: INVOICES,
  };
}

type Args = Record<string, string>;
const wei = (musd: string) => parseUnits(musd, MUSD_DECIMALS);
const sub = (a: string, b: bigint) => (BigInt(a) - b).toString();
const add = (a: string, b: bigint) => (BigInt(a) + b).toString();

/** `Email from <from>, "<subject>": <body>`, the line the server writes for email_delivered. */
const EMAIL_LINE = /^Email from (\S+), "([^"]*)": ([\s\S]*)$/;

/**
 * What the server's /api/state would say after these events, for mock mode, where there is no server.
 * Folds the recorded runs over the spec 4 starting state: a successful pay moves money, a confirmed
 * limit change raises the cap, a payee change request adds a pending change, the owner's approval
 * applies it, a delivered email lands in the inbox. A refused call changes nothing.
 */
export function mockState(events: RunEvent[]): AppState {
  const s = initialState();
  const lastArgs: Record<string, Args> = {};
  for (const e of events) {
    const key = `${e.wallet}:${e.tool}`;
    if (e.kind === 'tool_call') {
      lastArgs[key] = (e.args ?? {}) as Args;
      continue;
    }
    if (e.kind === 'email_delivered') {
      const m = EMAIL_LINE.exec(e.text);
      s.inbox = [...s.inbox, {
        id: e.id, ts: e.ts, from: m?.[1] ?? 'unknown', to: 'payments@acme.test',
        subject: m?.[2] ?? '(no subject)', body: m?.[3] ?? e.text,
      }];
      continue;
    }
    if (e.kind === 'tx_sent' && e.runId === 'owner-approval' && isPendingChange(e.result)) {
      applyApproval(s, e.result);
      continue;
    }
    if (e.kind !== 'tool_result' || e.error) continue;
    const args = lastArgs[key] ?? {};
    if (e.wallet === 'baseline' && e.tool === 'pay' && e.txHash) {
      const amount = wei(args.amount);
      s.baseline = { ...s.baseline, balance: sub(s.baseline.balance, amount), spentToday: add(s.baseline.spentToday, amount) };
    } else if (e.wallet === 'baseline' && e.tool === 'confirm_limit_change' && e.txHash) {
      const requested = lastArgs['baseline:request_limit_change']?.new_daily_limit;
      if (requested) s.baseline = { ...s.baseline, dailyCap: wei(requested).toString() };
    } else if (e.wallet === 'signvault' && e.tool === 'pay' && e.txHash) {
      const to = args.to?.toLowerCase();
      const payee = s.signvault.payees.find((p) => p.to.toLowerCase() === to);
      if (payee) {
        s.signvault = {
          ...s.signvault,
          balance: sub(s.signvault.balance, BigInt(payee.amount)),
          payees: s.signvault.payees.map((p) => (p === payee ? { ...p, paidThisPeriod: true } : p)),
        };
      }
    } else if (e.wallet === 'signvault' && e.tool === 'request_payee_change' && isChangeRef(e.result)) {
      // The tool gives the model the amount in mUSD and no nonce, so both come from the call and the vault.
      // Asking again for an open change returns the same id, as the server does.
      const { id, to } = e.result;
      if (!s.pendingChanges.some((c) => c.id === id)) {
        s.pendingChanges = [...s.pendingChanges, { id, to, amount: wei(args.amount).toString(), nonce: s.signvault.nonce, status: 'pending' }];
      }
    }
  }
  return s;
}

/**
 * The owner signed and the server relayed it (the `owner-approval` line capture.mjs saves): the change is
 * applied, its payee joins the list, and the vault nonce moves on, taking every change still open with it.
 */
function applyApproval(s: AppState, applied: PendingChange) {
  const nonce = (BigInt(s.signvault.nonce) + 1n).toString();
  const changes = s.pendingChanges.map((c) => {
    if (c.id === applied.id) return applied;
    return c.status === 'applied' ? c : { ...c, nonce };
  });
  s.pendingChanges = changes.some((c) => c.id === applied.id) ? changes : [...changes, applied];
  const listed = s.signvault.payees.some((p) => p.to.toLowerCase() === applied.to.toLowerCase());
  s.signvault = {
    ...s.signvault,
    nonce,
    payees: listed ? s.signvault.payees : [...s.signvault.payees, { to: applied.to, amount: applied.amount, paidThisPeriod: false }],
  };
}

function isChangeRef(x: unknown): x is Pick<PendingChange, 'id' | 'to'> {
  if (!x || typeof x !== 'object') return false;
  const c = x as Record<string, unknown>;
  return typeof c.id === 'string' && typeof c.to === 'string';
}

function isPendingChange(x: unknown): x is PendingChange {
  if (!x || typeof x !== 'object') return false;
  const c = x as Record<string, unknown>;
  return typeof c.id === 'string' && typeof c.to === 'string' && typeof c.amount === 'string'
    && typeof c.nonce === 'string' && typeof c.status === 'string';
}
