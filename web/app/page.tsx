'use client';

import { useState } from 'react';
import type { AppState, Email } from '@signvault/shared';
import { GateColumn } from '@/components/GateColumn';
import { FakeEmailForm, InboxPanel, PendingChangesPanel } from '@/components/Panels';
import { TreasuryPanel } from '@/components/TreasuryPanel';
import { Icon, buttonClass, clock } from '@/components/ui';
import { chainName } from '@/lib/approve';
import { MOCK, postJson, startRun, useAppState, useRunEvents } from '@/lib/hooks';
import { mockState } from '@/lib/mock-state';
import { baselineStory, runStartedAt, vaultStory } from '@/lib/story';
import { isTreasuryEvent, treasuryView } from '@/lib/treasury';

/** The model is not in AppState or in any event, so it shows only when the person running the demo names it. */
const MODEL = process.env.NEXT_PUBLIC_LLM_MODEL;

/** The board's short names for our two chains. viem's name for 97 is "BNB Smart Chain Testnet". */
const CHAIN_LABEL: Partial<Record<number, string>> = { 97: 'BSC testnet', 31337: 'Anvil' };
const chainLabel = (chainId: number) => CHAIN_LABEL[chainId] ?? chainName(chainId);

export default function Dashboard() {
  const run = useRunEvents();
  const live = useAppState();
  const [actionError, setActionError] = useState<string | null>(null);

  const state: AppState | undefined = MOCK
    ? mockState(run.events)
    : live.kind === 'ready' ? live.value : live.kind === 'error' ? live.last : undefined;
  const explorerUrl = state?.explorerUrl;
  // The treasury run is SignVault's too, but it is not the payroll story the two cards compare.
  const payroll = run.events.filter((e) => !isTreasuryEvent(e));
  const treasury = treasuryView(run.events, state);
  const startedAt = runStartedAt(payroll);
  const baseline = baselineStory(payroll, state);
  const vault = vaultStory(payroll, state);
  const gateOpened = baseline.flow.nodes.some((n) => n.tone === 'breach');
  const meta = startedAt !== undefined
    ? `Run started ${clock(startedAt)}${MODEL ? `, model ${MODEL}` : ''}`
    : MODEL && `Model ${MODEL}`;

  async function act(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
      live.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  const runTask = () => (MOCK ? run.replay() : act(() => postJson('/api/runs', { wallet: 'both' })));
  const reset = () => {
    run.clear();
    if (!MOCK) act(() => postJson('/api/admin/reset', {}));
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-[1392px] flex-wrap items-center justify-between gap-4 px-4 py-3 min-[560px]:px-6">
          <div className="flex flex-wrap items-center gap-3.5">
            <span className="flex items-center gap-2.5">
              <Icon name="logo" size={34} />
              <span className="font-display text-[21px] font-bold tracking-[-0.02em]">SignVault</span>
            </span>
            <span className="hidden h-5 w-px bg-border min-[560px]:block" />
            <span className="text-sm text-muted-foreground">Agent wallet security</span>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <StatusChip
              status={MOCK ? 'recorded' : live.kind === 'error' ? 'down' : 'live'}
              detail={live.kind === 'error' ? live.message : undefined}
              chain={state && `${chainLabel(state.chainId)}, chain ${state.chainId}`}
            />
            <button type="button" onClick={reset} className={buttonClass('outline')}>Reset</button>
            <button type="button" onClick={runTask} className={buttonClass()}>Run the task</button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1392px] flex-col gap-6 px-4 pt-8 pb-10 min-[560px]:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex max-w-[700px] flex-col gap-1.5">
            <h1 className="font-display text-[30px] leading-[1.08] font-[650] tracking-[-0.025em] text-balance min-[560px]:text-[38px]">
              {gateOpened ? 'One gate let the agent through' : 'Same agent, same task: pay the three invoices in the inbox'}
            </h1>
            <p className="text-[17px] leading-normal text-pretty text-secondary-foreground">
              Each wallet puts one gate between the agent and more spending. The standard wallet&apos;s gate opens for anyone
              who can read the inbox. SignVault&apos;s opens only for the owner&apos;s key.
            </p>
          </div>
          {meta && <span className="text-sm text-muted-foreground">{meta}</span>}
        </div>
        {actionError && (
          <p className="rounded-2xl border border-destructive-border bg-destructive-tint px-4 py-2 text-sm text-destructive-deep">{actionError}</p>
        )}

        <div className="grid gap-5 min-[1040px]:grid-cols-2">
          <GateColumn
            wallet="baseline"
            story={baseline}
            events={payroll.filter((e) => e.wallet === 'baseline')}
            address={state?.addresses.baselineWallet}
            explorerUrl={explorerUrl}
          />
          <GateColumn
            wallet="signvault"
            story={vault}
            events={payroll.filter((e) => e.wallet === 'signvault')}
            address={state?.addresses.signVault}
            explorerUrl={explorerUrl}
            action={!MOCK && (
              <button type="button" onClick={() => act(() => startRun('signvault'))} className={buttonClass('outline', 'sm')}>
                Run again on SignVault
              </button>
            )}
          />
        </div>

        <div className="grid items-stretch gap-5 min-[1040px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <PendingChangesPanel state={state} />
          <InboxPanel
            inbox={state?.inbox ?? []}
            form={
              <FakeEmailForm
                disabled={MOCK}
                onSend={async (email) => {
                  await postJson<Email>('/api/inbox', email);
                  live.refresh();
                }}
              />
            }
          />
        </div>

        {treasury && (
          <TreasuryPanel
            view={treasury}
            events={run.events.filter(isTreasuryEvent)}
            explorerUrl={explorerUrl}
            disabled={MOCK}
            onRun={() => act(() => postJson('/api/runs', { wallet: 'signvault', task: 'treasury' }))}
            onShock={(on) => act(() => postJson('/api/admin/price-shock', { on }))}
          />
        )}
      </main>
    </div>
  );
}

const STATUS = {
  live: { text: 'Live', dot: 'bg-success' },
  down: { text: 'Server not reachable', dot: 'bg-destructive' },
  recorded: { text: 'Recorded run', dot: 'bg-pending' },
};

function StatusChip({ status, detail, chain }: { status: keyof typeof STATUS; detail?: string; chain: string | undefined }) {
  return (
    <span
      title={detail}
      className="inline-flex min-h-8 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-2xl border border-border px-3 py-1 text-sm font-medium whitespace-nowrap text-secondary-foreground min-[560px]:rounded-full"
    >
      <span className="inline-flex items-center gap-2">
        <span className={`block size-2 rounded-full ${STATUS[status].dot}`} />
        {STATUS[status].text}
      </span>
      {chain && <span className="font-normal text-subtle-foreground">{chain}</span>}
    </span>
  );
}
