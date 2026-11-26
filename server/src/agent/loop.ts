import { randomUUID } from 'node:crypto';
import type { EventsPort, LlmPort, RunEvent, WalletKind } from '@signvault/shared';
import { KICKOFF, SYSTEM_PROMPT } from './prompt';
import { ArgError, TOOLS, type Tool, type ToolContext, type ToolOutcome, type ToolReply } from './tools';

/**
 * Spec 7.4 says 14. Live runs on the shared inbox need up to 16 (each run also reads the other's emails),
 * and spec 4's refused pay adds one more, so the cap is 20.
 */
export const MAX_TOOL_CALLS = 20;

/** What a run is for. A run with no task is the payroll run of spec 7.4. */
export interface AgentTask {
  /** The runId prefix: `<name>-<8 hex>`. */
  name: string;
  system: string;
  tools: Tool[];
  /** The run_started line. */
  started: string;
}

export interface AgentDeps extends ToolContext {
  llm: LlmPort;
  events: EventsPort;
  task?: AgentTask;
}

export type RunOutcome = 'finished' | 'tool_limit' | 'stopped' | 'failed';

export interface RunResult {
  runId: string;
  wallet: WalletKind;
  outcome: RunOutcome;
  toolCalls: number;
  summary?: string;   // the model's finish summary
}

type Emit = (e: Omit<RunEvent, 'id' | 'ts' | 'runId' | 'wallet'>) => void;
type ToolCall = Awaited<ReturnType<LlmPort['next']>>['toolCalls'][number];
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const WALLET_NAME: Record<WalletKind, string> = { baseline: 'the standard wallet', signvault: 'SignVault' };

/**
 * Starts one run and returns at once with its id, so a caller can answer `POST /api/runs` while the run goes on.
 * Every step goes to `events`. `done` resolves when the run ends: a failing model or port ends it as an outcome, not a rejection.
 */
export function runAgent(deps: AgentDeps): { runId: string; done: Promise<RunResult> } {
  const task = deps.task ?? payrollTask(deps.wallet);
  const runId = `${task.name}-${randomUUID().slice(0, 8)}`;
  const emit: Emit = (e) => { deps.events.emit({ ...e, runId, wallet: deps.wallet }); };
  emit({ kind: 'run_started', text: task.started });
  const done = drive(deps, task, emit).then((r) => ({ runId, wallet: deps.wallet, ...r }));
  return { runId, done };
}

function payrollTask(wallet: WalletKind): AgentTask {
  return { name: wallet, system: SYSTEM_PROMPT, tools: TOOLS[wallet], started: `Run started on ${WALLET_NAME[wallet]}: pay every unpaid invoice in the inbox.` };
}

async function drive(deps: AgentDeps, { system, tools }: AgentTask, emit: Emit): Promise<Omit<RunResult, 'runId' | 'wallet'>> {
  const schemas = tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));
  const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: KICKOFF }];
  let toolCalls = 0;
  const end = (outcome: RunOutcome, text: string, summary?: string) => {
    emit({ kind: 'run_finished', text });
    return { outcome, toolCalls, ...(summary !== undefined && { summary }) };
  };

  for (;;) {
    let reply: Awaited<ReturnType<LlmPort['next']>>;
    try {
      reply = await deps.llm.next(messages, schemas);
    } catch (err) {
      return end('failed', `Stopped: the model call failed (${errorName(err)}).`);
    }
    const text = reply.text?.trim();
    if (text) emit({ kind: 'model_text', text });
    if (reply.toolCalls.length === 0) return end('stopped', 'Stopped: the model replied without calling a tool.');

    messages.push({
      role: 'assistant',
      content: reply.text ?? null,
      tool_calls: reply.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
    });
    for (const call of reply.toolCalls) {
      toolCalls++;
      const outcome = await callTool(tools, call, deps, emit);
      if ('finish' in outcome) return end('finished', outcome.finish ? `Finished: ${outcome.finish}` : 'Finished.', outcome.finish);
      const content = typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result);
      messages.push({ role: 'tool', tool_call_id: call.id, content });
      if (toolCalls === MAX_TOOL_CALLS) return end('tool_limit', `Stopped after ${MAX_TOOL_CALLS} tool calls without finishing.`);
    }
  }
}

/** Emits tool_call, then the tx line, tool_result and any email_delivered lines. A bad call becomes an error reply. */
async function callTool(tools: Tool[], { name, args }: ToolCall, ctx: ToolContext, emit: Emit): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    emit({ kind: 'tool_call', tool: name, args, text: `Calls ${name}, a tool this wallet does not have.` });
    return report(emit, name, { result: `ERROR: unknown tool ${name}`, text: `This wallet has no ${name} tool.` });
  }
  let step: ReturnType<Tool['prepare']>;
  try {
    step = tool.prepare(args, ctx);
  } catch (err) {
    emit({ kind: 'tool_call', tool: name, args, text: `Calls ${name} with arguments it cannot use.` });
    return report(emit, name, failure(err));
  }
  emit({ kind: 'tool_call', tool: name, args, text: step.text });
  let outcome: ToolOutcome;
  try {
    outcome = await step.run();
  } catch (err) {
    outcome = failure(err);
  }
  return 'finish' in outcome ? outcome : report(emit, name, outcome);
}

function report(emit: Emit, tool: string, r: ToolReply): ToolReply {
  if (r.tx) emit(r.tx);
  emit({
    kind: 'tool_result', tool, result: r.result, text: r.text,
    ...(r.tx?.txHash && { txHash: r.tx.txHash }), ...(r.tx?.error && { error: r.tx.error }),
  });
  for (const e of r.emails ?? []) emit({ kind: 'email_delivered', text: `Email from ${e.from}, "${e.subject}": ${e.body}` });
  return r;
}

/** Our ArgError messages go back to the model. Any other error gives only its name: viem and LLM client messages can hold an RPC URL or a key. */
function failure(err: unknown): ToolReply {
  const reason = err instanceof ArgError ? err.message : errorName(err);
  return { result: `ERROR: ${reason}`, text: `The call failed: ${reason}.` };
}

function errorName(err: unknown): string {
  if (!(err instanceof Error)) return 'Error';
  return err.name !== 'Error' ? err.name : err.constructor.name;
}
