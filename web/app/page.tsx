'use client';

import { useState } from 'react';
import type { AppState, Email } from '@signvault/shared';
import { Icon } from '@/components/icons';
import { FakeEmailPanel, InboxPanel, PendingChangesPanel } from '@/components/Panels';
import { WalletColumn, clock } from '@/components/WalletColumn';
import { chainName } from '@/lib/approve';
import { MOCK, postJson, startRun, useAppState, useRunEvents } from '@/lib/hooks';
import { mockState } from '@/lib/mock-state';
import { baselineStory, runStartedAt, vaultStory } from '@/lib/story';

/** The model is not in AppState or in any event, so it shows only when the person running the demo names it. */
const MODEL = process.env.NEXT_PUBLIC_LLM_MODEL;

export default function Dashboard() {
  const run = useRunEvents();
  const live = useAppState();
  const [actionError, setActionError] = useState<string | null>(null);

  const state: AppState | undefined = MOCK
    ? mockState(run.events)
    : live.kind === 'ready' ? live.value : live.kind === 'error' ? live.last : undefined;
  const explorerUrl = state?.explorerUrl;
  const startedAt = runStartedAt(run.events);

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
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-[1392px] flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex size-8 items-center justify-center rounded-lg bg-ink text-white">
              <Icon name="shield" size={18} strokeWidth={2} />
            </span>
            <span className="text-base font-semibold">SignVault</span>
            <span className="hidden h-5 w-px bg-line sm:block" />
            <span className="text-sm text-muted">Agent wallet security · live comparison</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {state && (
              <span className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[13px] font-medium text-ink-2">
                <span className="block size-2 rounded-full bg-good-500" />
                {chainName(state.chainId)} · chain {state.chainId}
              </span>
            )}
            {MOCK ? (
              <span className="rounded-full border border-wait-200 bg-wait-50 px-2.5 py-1 text-[13px] font-medium text-wait-700">Recorded run</span>
            ) : (
              <ServerStatus stateError={live.kind === 'error' ? live.message : null} />
            )}
            <button type="button" onClick={reset} className="min-h-10 rounded-lg border border-line-2 bg-white px-3.5 text-sm font-semibold text-ink-2 hover:bg-canvas active:bg-chip">
              Reset
            </button>
            <button type="button" onClick={runTask} className="min-h-10 rounded-lg border border-ink bg-ink px-4 text-sm font-semibold text-white active:bg-ink-2">
              Run the task
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1392px] flex-col gap-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-semibold tracking-[-0.01em] sm:text-2xl">Same agent, same task: pay the three invoices in the inbox</h1>
          {(MODEL || startedAt !== undefined) && (
            <span className="text-sm text-faint">
              {[MODEL && `Model ${MODEL}`, startedAt !== undefined && `run started ${clock(startedAt)}`].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        {actionError && <p className="rounded-lg border border-bad-200 bg-bad-50 px-4 py-2 text-sm text-bad-700">{actionError}</p>}

        <div className="grid gap-6 lg:grid-cols-2">
          <WalletColumn
            title="Standard wallet"
            rule="Rule changes: confirm a code sent by email"
            icon="wallet"
            address={state?.addresses.baselineWallet}
            explorerUrl={explorerUrl}
            story={baselineStory(run.events, state)}
            events={run.events.filter((e) => e.wallet === 'baseline')}
          />
          <WalletColumn
            title="SignVault"
            rule="Rule changes: the owner's signature, checked by the contract"
            icon="shield"
            address={state?.addresses.signVault}
            explorerUrl={explorerUrl}
            story={vaultStory(run.events, state)}
            events={run.events.filter((e) => e.wallet === 'signvault')}
          >
            {!MOCK && (
              <button
                type="button"
                onClick={() => act(() => startRun('signvault'))}
                className="min-h-10 self-start rounded-lg border border-line-2 bg-white px-3.5 text-sm font-semibold text-ink-2 hover:bg-canvas active:bg-chip"
              >
                Run again on SignVault
              </button>
            )}
          </WalletColumn>
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <PendingChangesPanel state={state} />
          <InboxPanel
            inbox={state?.inbox ?? []}
            form={
              <FakeEmailPanel
                disabled={MOCK}
                onSend={async (email) => {
                  await postJson<Email>('/api/inbox', email);
                  live.refresh();
                }}
              />
            }
          />
        </div>
      </main>
    </div>
  );
}

function ServerStatus({ stateError }: { stateError: string | null }) {
  const ok = !stateError;
  return (
    <span
      title={stateError ?? undefined}
      className={`rounded-full border px-2.5 py-1 text-[13px] font-medium ${ok ? 'border-good-200 bg-good-50 text-good-700' : 'border-bad-200 bg-bad-50 text-bad-700'}`}
    >
      {ok ? 'Live' : 'Server not reachable'}
    </span>
  );
}
