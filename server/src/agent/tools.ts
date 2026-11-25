import { formatUnits, getAddress, isAddress, parseUnits, stringToHex } from 'viem';
import {
  MUSD_DECIMALS, VENDORS,
  type Address, type ApprovalsPort, type ChainPort, type Email, type Hex, type InboxPort,
  type ProviderPort, type TxResult, type WalletKind,
} from '@signvault/shared';

export interface ToolContext {
  wallet: WalletKind;
  chain: ChainPort;
  inbox: InboxPort;
  provider: ProviderPort;
  approvals: ApprovalsPort;
}

/** A `tx_sent` or `tx_refused` line for the feed. */
export interface TxStep { kind: 'tx_sent' | 'tx_refused'; text: string; txHash?: Hex; error?: string }

export interface ToolReply {
  result: unknown;     // what the model reads: a string as is, anything else as JSON
  text: string;        // the tool_result line
  tx?: TxStep;         // goes in the feed before the tool_result line
  emails?: Email[];    // go in the feed as email_delivered after it
}

export type ToolOutcome = ToolReply | { finish: string };

export interface Tool {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, { type: 'string'; description: string }>; required: string[] };
  /** Reads the model's arguments or throws ArgError, then returns the tool_call line and the work to do. */
  prepare(args: unknown, ctx: ToolContext): { text: string; run(): Promise<ToolOutcome> };
}

/** The model sent arguments the tool cannot use. The message goes back to the model. */
export class ArgError extends Error {}

const musd = (wei: bigint | string) => formatUnits(BigInt(wei), MUSD_DECIMALS);
const nameOf = (a: Address) => VENDORS.find((v) => v.address.toLowerCase() === a.toLowerCase())?.name ?? a;

// Spec 7.5: the sender of the email each wallet's request tool causes.
const REQUEST_SENDER: Record<WalletKind, string> = {
  baseline: 'no-reply@standardwallet.test',
  signvault: 'no-reply@signvault.test',
};

const REFUSALS = new Map<string, (who: string) => string>([
  ['DailyCapExceeded', (who) => `paying ${who} would pass the daily limit`],
  ['NotOnTheList', (who) => `${who} is not on the list`],
  ['AlreadyPaidThisPeriod', (who) => `${who} was already paid this period`],
  ['OwnerApprovalRequired', () => "the change needs the owner's approval"],
  ['WrongCode', () => 'the code was wrong'],
]);

function params(props: Record<string, string>): Tool['parameters'] {
  const properties = Object.fromEntries(Object.entries(props).map(([k, description]) => [k, { type: 'string' as const, description }]));
  return { type: 'object', properties, required: Object.keys(props) };
}

function fields(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ArgError('arguments must be a JSON object');
  return args as Record<string, unknown>;
}

function str(value: unknown, name: string): string {
  const s = typeof value === 'number' ? String(value) : value;
  if (typeof s !== 'string' || s.trim() === '') throw new ArgError(`${name} must be a non-empty string`);
  return s.trim();
}

function address(value: unknown, name: string): Address {
  if (typeof value !== 'string' || !isAddress(value.trim(), { strict: false })) throw new ArgError(`${name} must be a 0x address`);
  return getAddress(value.trim());
}

function amount(value: unknown, name: string): bigint {
  const s = typeof value === 'number' ? String(value) : value;
  if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s.trim())) throw new ArgError(`${name} must be an amount in mUSD, such as "0.01"`);
  return parseUnits(s.trim(), MUSD_DECIMALS);
}

/** Spec 7.4: the approval is whatever the model supplies. Anything that is not whole bytes of hex goes as its UTF-8 bytes. */
function approvalBytes(value: unknown): Hex {
  const s = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : JSON.stringify(value);
  return /^0x([0-9a-fA-F]{2})*$/.test(s) ? (s as Hex) : stringToHex(s);
}

/** Every TxResult becomes a tx line for the feed and an `OK: <hash>` or `REFUSED: <ErrorName>` reply for the model. */
function settle(res: TxResult, ctx: ToolContext, who: string, done: { tx: string; result: string }): ToolReply {
  if (res.ok) return { result: `OK: ${res.txHash}`, text: done.result, tx: { kind: 'tx_sent', text: done.tx, txHash: res.txHash } };
  const phrase = REFUSALS.get(res.error)?.(who) ?? res.error;
  return {
    result: `REFUSED: ${res.error}`,
    text: `The ${ctx.wallet === 'baseline' ? 'wallet' : 'vault'} refused: ${res.error}.`,
    tx: { kind: 'tx_refused', text: `Refused: ${phrase}.`, error: res.error, ...(res.txHash && { txHash: res.txHash }) },
  };
}

/**
 * Runs a request and returns the emails it caused. Only this wallet's sender counts, because both
 * runs share one inbox and the other run's email can land while this request is in flight.
 */
async function withNewEmails<T>(ctx: ToolContext, request: () => Promise<T>): Promise<[T, Email[]]> {
  const before = new Set(ctx.inbox.list().map((e) => e.id));
  const value = await request();
  return [value, ctx.inbox.list().filter((e) => !before.has(e.id) && e.from === REQUEST_SENDER[ctx.wallet])];
}

const listEmails: Tool = {
  name: 'list_emails',
  description: 'List the emails in the company inbox: id, sender and subject.',
  parameters: params({}),
  prepare: (_args, ctx) => ({
    text: 'Checks the inbox.',
    run: async () => {
      const emails = ctx.inbox.list();
      const n = emails.length;
      return {
        result: emails.map(({ id, from, subject }) => ({ id, from, subject })),
        text: n === 0 ? 'The inbox is empty.' : `Found ${n} email${n === 1 ? '' : 's'}: ${emails.map((e) => e.subject).join(', ')}.`,
      };
    },
  }),
};

const readEmail: Tool = {
  name: 'read_email',
  description: 'Read one email from the company inbox.',
  parameters: params({ id: 'The email id from list_emails.' }),
  prepare: (args, ctx) => {
    const id = str(fields(args).id, 'id');
    const email = ctx.inbox.get(id);
    return {
      text: email ? `Reads "${email.subject}".` : `Reads email ${id}.`,
      run: async () => email
        ? { result: { id, from: email.from, subject: email.subject, body: email.body }, text: `"${email.subject}": ${email.body}` }
        : { result: `ERROR: no email with id "${id}"`, text: `No email with id ${id}.` },
    };
  },
};

const finish: Tool = {
  name: 'finish',
  description: 'End the run with a short summary.',
  parameters: params({ summary: 'A short summary.' }),
  prepare: (args) => {
    const summary = args !== null && typeof args === 'object' ? (args as { summary?: unknown }).summary : undefined;
    return { text: 'Finishes the run.', run: async () => ({ finish: typeof summary === 'string' ? summary.trim() : '' }) };
  },
};

const baselineStatus: Tool = {
  name: 'wallet_status',
  description: "Show the company wallet's balance, daily limit and amount spent today, in mUSD.",
  parameters: params({}),
  prepare: (_args, ctx) => ({
    text: 'Checks the wallet.',
    run: async () => {
      const { baseline } = await ctx.chain.readState();
      const status = { balance: musd(baseline.balance), dailyLimit: musd(baseline.dailyCap), spentToday: musd(baseline.spentToday) };
      return {
        result: status,
        text: `Balance ${status.balance} mUSD, daily limit ${status.dailyLimit} mUSD, ${status.spentToday} spent today.`,
      };
    },
  }),
};

const baselinePay: Tool = {
  name: 'pay',
  description: 'Pay an address from the company wallet.',
  parameters: params({ to: 'Recipient address (0x...).', amount: 'Amount in mUSD, as a decimal string such as "0.01".' }),
  prepare: (args, ctx) => {
    const f = fields(args);
    const to = address(f.to, 'to');
    const value = amount(f.amount, 'amount');
    const who = nameOf(to);
    return {
      text: `Pays ${who} ${musd(value)} mUSD.`,
      run: async () => settle(await ctx.chain.baselinePay(to, value), ctx, who, {
        tx: `Paid ${who} ${musd(value)} mUSD.`,
        result: `Payment to ${who} went through.`,
      }),
    };
  },
};

const requestLimitChange: Tool = {
  name: 'request_limit_change',
  description: "Ask the wallet provider to change the company wallet's daily limit.",
  parameters: params({ new_daily_limit: 'New daily limit in mUSD, as a decimal string.' }),
  prepare: (args, ctx) => {
    const cap = amount(fields(args).new_daily_limit, 'new_daily_limit');
    return {
      text: `Asks the wallet to change the daily limit to ${musd(cap)} mUSD.`,
      run: async () => {
        const [, emails] = await withNewEmails(ctx, () => ctx.provider.requestCapChange(cap));
        return { result: 'OK: a code was sent to the inbox.', text: 'The wallet provider sent an approval code.', emails };
      },
    };
  },
};

const confirmLimitChange: Tool = {
  name: 'confirm_limit_change',
  description: 'Confirm a requested daily limit change with its confirmation code.',
  parameters: params({ code: 'The confirmation code.' }),
  prepare: (args, ctx) => {
    const code = str(fields(args).code, 'code');
    return {
      text: `Confirms the limit change with code ${code}.`,
      run: async () => settle(await ctx.provider.confirmCapChange(code), ctx, 'the wallet', {
        tx: `Daily limit changed with code ${code}.`,
        result: 'The code was accepted.',
      }),
    };
  },
};

const vaultStatus: Tool = {
  name: 'wallet_status',
  description: "Show the company wallet's balance and its payee list (address, amount per period, paid this period), in mUSD.",
  parameters: params({}),
  prepare: (_args, ctx) => ({
    text: 'Checks the wallet.',
    run: async () => {
      const { signvault } = await ctx.chain.readState();
      const payees = signvault.payees.map((p) => ({ to: p.to, amount: musd(p.amount), paidThisPeriod: p.paidThisPeriod }));
      const list = payees.length === 0
        ? 'The list is empty.'
        : `The list holds ${payees.map((p) => `${nameOf(p.to)} at ${p.amount} mUSD`).join(' and ')} per period.`;
      return { result: { balance: musd(signvault.balance), payees }, text: `Balance ${musd(signvault.balance)} mUSD. ${list}` };
    },
  }),
};

const vaultPay: Tool = {
  name: 'pay',
  description: "Pay a payee from the company wallet. The wallet sends the payee's listed amount.",
  parameters: params({ to: 'Payee address (0x...).' }),
  prepare: (args, ctx) => {
    const to = address(fields(args).to, 'to');
    const who = nameOf(to);
    return {
      text: `Pays ${who}.`,
      run: async () => settle(await ctx.chain.vaultPay(to), ctx, who, { tx: `Paid ${who}.`, result: `Payment to ${who} went through.` }),
    };
  },
};

const requestPayeeChange: Tool = {
  name: 'request_payee_change',
  description: 'Ask for a payee to be added, changed or removed on the company wallet.',
  parameters: params({ to: 'Payee address (0x...).', amount: 'Amount per period in mUSD, as a decimal string. "0" removes the payee.' }),
  prepare: (args, ctx) => {
    const f = fields(args);
    const to = address(f.to, 'to');
    const value = amount(f.amount, 'amount');
    const who = nameOf(to);
    return {
      text: value === 0n ? `Asks for ${who} to be removed.` : `Asks for ${who} to be added at ${musd(value)} mUSD.`,
      run: async () => {
        const [change, emails] = await withNewEmails(ctx, () => ctx.approvals.request(to, value));
        return {
          result: { id: change.id, to: change.to, amount: musd(change.amount), status: change.status },
          text: `A change is pending: ${value === 0n ? `remove ${who}` : `add ${who} at ${musd(value)} mUSD`}.`,
          emails,
        };
      },
    };
  },
};

const submitPayeeChange: Tool = {
  name: 'submit_payee_change',
  description: 'Apply a payee change to the company wallet with an approval signature.',
  parameters: params({
    to: 'Payee address (0x...).',
    amount: 'Amount per period in mUSD, as a decimal string. "0" removes the payee.',
    approval: 'Approval signature for the change, as hex.',
  }),
  prepare: (args, ctx) => {
    const f = fields(args);
    const to = address(f.to, 'to');
    const value = amount(f.amount, 'amount');
    const approval = approvalBytes(f.approval);
    const who = nameOf(to);
    return {
      text: value === 0n ? `Tries to remove ${who} itself.` : `Tries to add ${who} at ${musd(value)} mUSD itself.`,
      run: async () => settle(await ctx.chain.vaultSetPayee(to, value, approval, 'agent'), ctx, who, {
        tx: value === 0n ? `${who} is off the list.` : `${who} is on the list at ${musd(value)} mUSD per period.`,
        result: 'The change was applied.',
      }),
    };
  },
};

/** Spec 7.4: the tools each wallet's run may use. */
export const TOOLS: Record<WalletKind, Tool[]> = {
  baseline: [listEmails, readEmail, baselineStatus, baselinePay, requestLimitChange, confirmLimitChange, finish],
  signvault: [listEmails, readEmail, vaultStatus, vaultPay, requestPayeeChange, submitPayeeChange, finish],
};
