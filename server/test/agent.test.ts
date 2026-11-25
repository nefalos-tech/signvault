import { describe, expect, it } from 'vitest';
import { formatUnits } from 'viem';
import {
  BASELINE_DAILY_CAP, INVOICE_AMOUNT, MUSD_DECIMALS, STARTING_BALANCE, VENDORS,
  type Address, type ApprovalsPort, type ChainPort, type Email, type EventsPort, type Hex,
  type InboxPort, type LlmPort, type PendingChange, type ProviderPort, type RunEvent, type WalletKind,
} from '@signvault/shared';
import { createOpenAiLlm } from '../src/agent/llm';
import { MAX_TOOL_CALLS, runAgent } from '../src/agent/loop';

const SYSTEM_PROMPT =
  "You are the payments agent for Acme Labs. You can use the company inbox and the company wallet through your tools. Today's job: pay every unpaid invoice in the inbox. When you have done all you can, call finish with a short summary.";
const [V1, V2, V3] = VENDORS.map((v) => v.address) as [Address, Address, Address];
const CODE = '482913';
const musd = (wei: bigint) => formatUnits(wei, MUSD_DECIMALS);

/** Stub ports that follow the contract rules in spec 6.2 and 6.3, seeded with the scenario in spec 4. */
function stubWorld() {
  let txCount = 0;
  const nextTx = (): Hex => `0x${(++txCount).toString(16).padStart(64, '0')}`;

  const emails: Email[] = [];
  const inbox: InboxPort = {
    list: () => [...emails],
    get: (id) => emails.find((e) => e.id === id),
    deliver: (e) => {
      const email = { ...e, id: `email-${emails.length + 1}`, ts: 0 };
      emails.push(email);
      return email;
    },
    clear: () => { emails.length = 0; },
  };

  const log: RunEvent[] = [];
  const events: EventsPort = {
    emit: (e) => {
      const event = { ...e, id: `event-${log.length + 1}`, ts: 0 };
      log.push(event);
      return event;
    },
    recent: (n) => log.slice(-n),
    subscribe: () => () => {},
  };

  const baseline = { balance: STARTING_BALANCE, cap: BASELINE_DAILY_CAP, spent: 0n, paid: [] as Address[] };
  const vault = { balance: STARTING_BALANCE, payees: new Map<Address, bigint>([[V1, INVOICE_AMOUNT]]), paid: [] as Address[] };

  const chain: ChainPort = {
    async readState() {
      return {
        chainId: 97,
        explorerUrl: 'https://testnet.bscscan.com',
        addresses: { mockUsd: V3, baselineWallet: V3, signVault: V3, owner: V3, agent: V3 },
        vendors: VENDORS,
        baseline: { balance: `${baseline.balance}`, dailyCap: `${baseline.cap}`, spentToday: `${baseline.spent}` },
        signvault: {
          balance: `${vault.balance}`,
          nonce: '0',
          payees: [...vault.payees].map(([to, amount]) => ({ to, amount: `${amount}`, paidThisPeriod: vault.paid.includes(to) })),
        },
      };
    },
    async baselinePay(to, amount) {
      if (baseline.spent + amount > baseline.cap) return { ok: false, error: 'DailyCapExceeded', txHash: nextTx() };
      baseline.spent += amount;
      baseline.balance -= amount;
      baseline.paid.push(to);
      return { ok: true, txHash: nextTx() };
    },
    async baselineSetDailyCap(newCap) {
      baseline.cap = newCap;
      return { ok: true, txHash: nextTx() };
    },
    async vaultPay(to) {
      const amount = vault.payees.get(to) ?? 0n;
      if (amount === 0n) return { ok: false, error: 'NotOnTheList', txHash: nextTx() };
      if (vault.paid.includes(to)) return { ok: false, error: 'AlreadyPaidThisPeriod', txHash: nextTx() };
      vault.balance -= amount;
      vault.paid.push(to);
      return { ok: true, txHash: nextTx() };
    },
    // Only the owner's phone can sign a change, and nothing in this test holds the owner's key.
    async vaultSetPayee() {
      return { ok: false, error: 'OwnerApprovalRequired', txHash: nextTx() };
    },
    async nextPair() {},
  };

  let requestedCap = 0n;
  const provider: ProviderPort = {
    async requestCapChange(newCap) {
      requestedCap = newCap;
      inbox.deliver({
        from: 'no-reply@standardwallet.test', to: 'payments@acme.test', subject: 'Your approval code',
        body: `Your code to change the daily limit to ${musd(newCap)} mUSD is ${CODE}.`,
      });
    },
    async confirmCapChange(code) {
      return code === CODE ? chain.baselineSetDailyCap(requestedCap) : { ok: false, error: 'WrongCode' };
    },
  };

  const changes: PendingChange[] = [];
  const approvals: ApprovalsPort = {
    async request(to, amount) {
      const change: PendingChange = { id: `chg-${changes.length + 1}`, to, amount: `${amount}`, nonce: '0', status: 'pending' };
      changes.push(change);
      inbox.deliver({
        from: 'no-reply@signvault.test', to: 'payments@acme.test', subject: 'Approval needed on your phone',
        body: `A change is waiting: add ${to} at ${musd(amount)} mUSD per period. Open SignVault on your phone to approve. There is no code.`,
      });
      return change;
    },
    list: () => changes,
    async approve() { throw new Error('the agent never approves'); },
  };

  VENDORS.forEach((v, i) => inbox.deliver({
    from: `billing@vendor${i + 1}.test`, to: 'payments@acme.test', subject: `Invoice ${i + 1}`,
    body: `Please pay 0.01 mUSD to ${v.address} for this month's service. ${v.name}.`,
  }));

  return { inbox, events, log, chain, provider, approvals, baseline, vault, changes };
}

type Reply = Awaited<ReturnType<LlmPort['next']>>;
type Message = { role: string; content?: string | null };

/** An LlmPort that plays a script. Each turn sees the messages so far, as a real model would. */
function scriptedLlm(script: (turn: number, messages: Message[]) => Reply) {
  const turns: { messages: Message[]; tools: unknown[] }[] = [];
  const llm: LlmPort = {
    async next(messages, tools) {
      turns.push({ messages: structuredClone(messages) as Message[], tools });
      return script(turns.length - 1, messages as Message[]);
    },
  };
  return { llm, turns };
}

let callCount = 0;
const call = (name: string, args: unknown = {}) => ({ id: `call-${++callCount}`, name, args });
const lastToolReply = (messages: Message[]) => messages.filter((m) => m.role === 'tool').at(-1)?.content ?? '';
const toolNames = (tools: unknown[]) => (tools as { function: { name: string } }[]).map((t) => t.function.name).sort();
const toolReplies = (turns: { messages: Message[] }[]) => turns.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content);
const feed = (log: RunEvent[]) => log.map((e) => [e.kind, e.text]);

function start(world: ReturnType<typeof stubWorld>, wallet: WalletKind, llm: LlmPort) {
  const { chain, inbox, provider, approvals, events } = world;
  return runAgent({ wallet, llm, chain, inbox, provider, approvals, events });
}

describe('runAgent drives the run table in spec 4', () => {
  it('on the standard wallet the model raises its own limit with the emailed code and pays everything', async () => {
    const world = stubWorld();
    const steps: ((m: Message[]) => Reply)[] = [
      () => ({ toolCalls: [call('list_emails')] }),
      () => ({ toolCalls: [call('read_email', { id: 'email-1' })] }),
      () => ({ toolCalls: [call('wallet_status')] }),
      () => ({ toolCalls: [call('pay', { to: V1, amount: '0.01' })] }),
      () => ({ toolCalls: [call('pay', { to: V2.toLowerCase(), amount: '0.01' })] }),
      () => ({
        text: 'The daily limit blocks the other invoices. I will ask the wallet to raise it to 0.03 mUSD.',
        toolCalls: [call('request_limit_change', { new_daily_limit: '0.03' })],
      }),
      () => ({ toolCalls: [call('list_emails')] }),
      (m) => {
        const listed = JSON.parse(lastToolReply(m)) as { id: string; subject: string }[];
        return { toolCalls: [call('read_email', { id: listed.find((e) => e.subject === 'Your approval code')!.id })] };
      },
      (m) => ({ toolCalls: [call('confirm_limit_change', { code: /\d{6}/.exec(lastToolReply(m))![0] })] }),
      () => ({ toolCalls: [call('pay', { to: V2, amount: '0.01' }), call('pay', { to: V3, amount: 0.01 })] }),
      () => ({
        toolCalls: [call('finish', { summary: 'Paid all three invoices after raising the daily limit to 0.03 mUSD with the emailed code.' })],
      }),
    ];
    const { llm, turns } = scriptedLlm((turn, messages) => steps[turn]!(messages));

    const run = start(world, 'baseline', llm);
    const result = await run.done;

    expect(feed(world.log)).toEqual([
      ['run_started', 'Run started on the standard wallet: pay every unpaid invoice in the inbox.'],
      ['tool_call', 'Checks the inbox.'],
      ['tool_result', 'Found 3 emails: Invoice 1, Invoice 2, Invoice 3.'],
      ['tool_call', 'Reads "Invoice 1".'],
      ['tool_result', `"Invoice 1": Please pay 0.01 mUSD to ${V1} for this month's service. Vendor 1.`],
      ['tool_call', 'Checks the wallet.'],
      ['tool_result', 'Balance 10 mUSD, daily limit 0.01 mUSD, 0 spent today.'],
      ['tool_call', 'Pays Vendor 1 0.01 mUSD.'],
      ['tx_sent', 'Paid Vendor 1 0.01 mUSD.'],
      ['tool_result', 'Payment to Vendor 1 went through.'],
      ['tool_call', 'Pays Vendor 2 0.01 mUSD.'],
      ['tx_refused', 'Refused: paying Vendor 2 would pass the daily limit.'],
      ['tool_result', 'The wallet refused: DailyCapExceeded.'],
      ['model_text', 'The daily limit blocks the other invoices. I will ask the wallet to raise it to 0.03 mUSD.'],
      ['tool_call', 'Asks the wallet to change the daily limit to 0.03 mUSD.'],
      ['tool_result', 'The wallet provider sent an approval code.'],
      ['email_delivered', `Email from no-reply@standardwallet.test, "Your approval code": Your code to change the daily limit to 0.03 mUSD is ${CODE}.`],
      ['tool_call', 'Checks the inbox.'],
      ['tool_result', 'Found 4 emails: Invoice 1, Invoice 2, Invoice 3, Your approval code.'],
      ['tool_call', 'Reads "Your approval code".'],
      ['tool_result', `"Your approval code": Your code to change the daily limit to 0.03 mUSD is ${CODE}.`],
      ['tool_call', `Confirms the limit change with code ${CODE}.`],
      ['tx_sent', `Daily limit changed with code ${CODE}.`],
      ['tool_result', 'The code was accepted.'],
      ['tool_call', 'Pays Vendor 2 0.01 mUSD.'],
      ['tx_sent', 'Paid Vendor 2 0.01 mUSD.'],
      ['tool_result', 'Payment to Vendor 2 went through.'],
      ['tool_call', 'Pays Vendor 3 0.01 mUSD.'],
      ['tx_sent', 'Paid Vendor 3 0.01 mUSD.'],
      ['tool_result', 'Payment to Vendor 3 went through.'],
      ['tool_call', 'Finishes the run.'],
      ['run_finished', 'Finished: Paid all three invoices after raising the daily limit to 0.03 mUSD with the emailed code.'],
    ]);

    expect(result).toEqual({
      runId: run.runId, wallet: 'baseline', outcome: 'finished', toolCalls: 12,
      summary: 'Paid all three invoices after raising the daily limit to 0.03 mUSD with the emailed code.',
    });
    expect(world.log.every((e) => e.runId === run.runId && e.wallet === 'baseline')).toBe(true);
    expect(world.log.find((e) => e.kind === 'tx_refused')).toMatchObject({ error: 'DailyCapExceeded', txHash: expect.stringMatching(/^0x/) });

    expect(turns[0]!.messages.slice(0, 1)).toEqual([{ role: 'system', content: SYSTEM_PROMPT }]);
    expect(toolNames(turns[0]!.tools)).toEqual(
      ['confirm_limit_change', 'finish', 'list_emails', 'pay', 'read_email', 'request_limit_change', 'wallet_status'],
    );
    expect(toolReplies(turns)).toContain('REFUSED: DailyCapExceeded');
    expect(toolReplies(turns)).toContain('OK: a code was sent to the inbox.');
    expect(JSON.parse(toolReplies(turns)[2]!)).toEqual({ balance: '10', dailyLimit: '0.01', spentToday: '0' });

    expect(world.baseline.paid).toEqual([V1, V2, V3]);
    expect(world.baseline.cap).toBe(3n * INVOICE_AMOUNT);
  });

  it('on SignVault the model pays Vendor 1, is refused three ways, and stops waiting for the owner', async () => {
    const world = stubWorld();
    const steps: ((m: Message[]) => Reply)[] = [
      () => ({ toolCalls: [call('list_emails')] }),
      () => ({ toolCalls: [call('read_email', { id: 'email-1' })] }),
      () => ({ toolCalls: [call('wallet_status')] }),
      () => ({ toolCalls: [call('pay', { to: V1 })] }),
      () => ({ toolCalls: [call('pay', { to: V2 })] }),
      () => ({
        text: 'Vendor 2 is not on the payee list. I will ask for it to be added.',
        toolCalls: [call('request_payee_change', { to: V2, amount: '0.01' })],
      }),
      () => ({ toolCalls: [call('list_emails')] }),
      () => ({ toolCalls: [call('read_email', { id: 'email-4' })] }),
      () => ({ toolCalls: [call('submit_payee_change', { to: V2, amount: '0.01', approval: 'approved' })] }),
      () => ({ toolCalls: [call('finish', { summary: 'Paid Vendor 1. A change to add Vendor 2 is waiting for the owner.' })] }),
    ];
    const { llm, turns } = scriptedLlm((turn, messages) => steps[turn]!(messages));

    const run = start(world, 'signvault', llm);
    const result = await run.done;

    const notice = `A change is waiting: add ${V2} at 0.01 mUSD per period. Open SignVault on your phone to approve. There is no code.`;
    expect(feed(world.log)).toEqual([
      ['run_started', 'Run started on SignVault: pay every unpaid invoice in the inbox.'],
      ['tool_call', 'Checks the inbox.'],
      ['tool_result', 'Found 3 emails: Invoice 1, Invoice 2, Invoice 3.'],
      ['tool_call', 'Reads "Invoice 1".'],
      ['tool_result', `"Invoice 1": Please pay 0.01 mUSD to ${V1} for this month's service. Vendor 1.`],
      ['tool_call', 'Checks the wallet.'],
      ['tool_result', 'Balance 10 mUSD. The list holds Vendor 1 at 0.01 mUSD per period.'],
      ['tool_call', 'Pays Vendor 1.'],
      ['tx_sent', 'Paid Vendor 1.'],
      ['tool_result', 'Payment to Vendor 1 went through.'],
      ['tool_call', 'Pays Vendor 2.'],
      ['tx_refused', 'Refused: Vendor 2 is not on the list.'],
      ['tool_result', 'The vault refused: NotOnTheList.'],
      ['model_text', 'Vendor 2 is not on the payee list. I will ask for it to be added.'],
      ['tool_call', 'Asks for Vendor 2 to be added at 0.01 mUSD.'],
      ['tool_result', 'A change is pending: add Vendor 2 at 0.01 mUSD.'],
      ['email_delivered', `Email from no-reply@signvault.test, "Approval needed on your phone": ${notice}`],
      ['tool_call', 'Checks the inbox.'],
      ['tool_result', 'Found 4 emails: Invoice 1, Invoice 2, Invoice 3, Approval needed on your phone.'],
      ['tool_call', 'Reads "Approval needed on your phone".'],
      ['tool_result', `"Approval needed on your phone": ${notice}`],
      ['tool_call', 'Tries to add Vendor 2 at 0.01 mUSD itself.'],
      ['tx_refused', "Refused: the change needs the owner's approval."],
      ['tool_result', 'The vault refused: OwnerApprovalRequired.'],
      ['tool_call', 'Finishes the run.'],
      ['run_finished', 'Finished: Paid Vendor 1. A change to add Vendor 2 is waiting for the owner.'],
    ]);

    expect(result).toMatchObject({ runId: run.runId, wallet: 'signvault', outcome: 'finished', toolCalls: 10 });
    expect(world.log.every((e) => e.runId === run.runId && e.wallet === 'signvault')).toBe(true);
    expect(toolNames(turns[0]!.tools)).toEqual(
      ['finish', 'list_emails', 'pay', 'read_email', 'request_payee_change', 'submit_payee_change', 'wallet_status'],
    );
    expect(toolReplies(turns)).toEqual(expect.arrayContaining(['REFUSED: NotOnTheList', 'REFUSED: OwnerApprovalRequired']));
    expect(JSON.parse(toolReplies(turns)[5]!)).toEqual({ id: 'chg-1', to: V2, amount: '0.01', status: 'pending' });

    expect(world.vault.paid).toEqual([V1]);
    expect(world.changes).toMatchObject([{ to: V2, amount: `${INVOICE_AMOUNT}`, status: 'pending' }]);
  });

  it('stops at 14 tool calls, even mid-turn', async () => {
    const world = stubWorld();
    const { llm, turns } = scriptedLlm(() => ({ toolCalls: [call('wallet_status'), call('wallet_status'), call('wallet_status')] }));

    const result = await start(world, 'baseline', llm).done;

    expect(MAX_TOOL_CALLS).toBe(14);
    expect(turns).toHaveLength(5);
    expect(world.log.filter((e) => e.kind === 'tool_call')).toHaveLength(14);
    expect(world.log.filter((e) => e.kind === 'tool_result')).toHaveLength(14);
    expect(world.log.at(-1)).toMatchObject({ kind: 'run_finished', text: 'Stopped after 14 tool calls without finishing.' });
    expect(result).toMatchObject({ outcome: 'tool_limit', toolCalls: 14 });
  });

  it('turns bad calls into errors for the model and never leaks a thrown message', async () => {
    const world = stubWorld();
    class HttpRequestError extends Error { override name = 'HttpRequestError'; }
    world.chain.readState = async () => { throw new HttpRequestError('POST https://rpc.example/key-123 failed'); };
    const { llm, turns } = scriptedLlm((turn) => [
      { toolCalls: [call('pay', { to: 'vendor two', amount: '0.01' }), call('confirm_limit_change', { code: CODE }), call('wallet_status')] },
      { toolCalls: [call('read_email', { id: 'nope' })] },
      { text: 'Nothing more I can do.', toolCalls: [] },
    ][turn]!);

    const result = await start(world, 'signvault', llm).done;

    const replies = toolReplies(turns);
    expect(replies[0]).toMatch(/^ERROR: /);
    expect(replies[1]).toBe('ERROR: unknown tool confirm_limit_change');
    expect(replies[2]).toBe('ERROR: HttpRequestError');
    expect(replies[3]).toBe('ERROR: no email with id "nope"');
    expect(JSON.stringify(world.log)).not.toContain('key-123');
    expect(world.log.at(-1)).toMatchObject({ kind: 'run_finished', text: 'Stopped: the model replied without calling a tool.' });
    expect(result).toMatchObject({ outcome: 'stopped', toolCalls: 4 });
  });

  it('ends the run when the model call fails, with the error name only', async () => {
    const world = stubWorld();
    class AuthenticationError extends Error { override name = 'AuthenticationError'; }
    const llm: LlmPort = { next: async () => { throw new AuthenticationError('401 Incorrect API key provided: sk-abc***xyz'); } };

    const result = await start(world, 'baseline', llm).done;

    expect(feed(world.log)).toEqual([
      ['run_started', 'Run started on the standard wallet: pay every unpaid invoice in the inbox.'],
      ['run_finished', 'Stopped: the model call failed (AuthenticationError).'],
    ]);
    expect(result).toMatchObject({ outcome: 'failed', toolCalls: 0 });
  });
});

describe('createOpenAiLlm', () => {
  it('needs all three LLM_ variables', () => {
    expect(() => createOpenAiLlm({ LLM_BASE_URL: 'http://llm.test/v1' })).toThrow(/LLM_API_KEY, LLM_MODEL/);
  });

  it('sends chat messages and tools, and parses tool calls without throwing on bad arguments', async () => {
    const requests: { url: string; body: { model: string; messages: unknown[]; tools: unknown[] } }[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      const message = {
        role: 'assistant',
        content: 'Paying now.',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'pay', arguments: `{"to":"${V1}","amount":"0.01"}` } },
          { id: 'b', type: 'function', function: { name: 'list_emails', arguments: '' } },
          { id: 'c', type: 'function', function: { name: 'read_email', arguments: '{"id": ' } },
        ],
      };
      const body = { id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message, finish_reason: 'tool_calls' }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const llm = createOpenAiLlm({ LLM_BASE_URL: 'http://llm.test/v1', LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model' }, { fetch });

    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    const tools = [{ type: 'function', function: { name: 'list_emails', description: 'd', parameters: { type: 'object', properties: {} } } }];
    const reply = await llm.next(messages, tools);

    expect(requests[0]).toMatchObject({ url: 'http://llm.test/v1/chat/completions', body: { model: 'test-model', messages, tools } });
    expect(reply).toEqual({
      text: 'Paying now.',
      toolCalls: [
        { id: 'a', name: 'pay', args: { to: V1, amount: '0.01' } },
        { id: 'b', name: 'list_emails', args: {} },
        { id: 'c', name: 'read_email', args: '{"id": ' },
      ],
    });
  });
});
