'use client';

import { useState } from 'react';
import type { AppState, Email } from '@signvault/shared';
import { FakeEmailPanel, InboxPanel, PendingChangesPanel } from '@/components/Panels';
import { BaselineRules, VaultRules, WalletColumn } from '@/components/WalletColumn';
import { MOCK, postJson, startRun, useAppState, useRunEvents } from '@/lib/hooks';
import { mockState } from '@/lib/mock-state';

export default function Dashboard() {
  const run = useRunEvents();
  const live = useAppState();
  const [actionError, setActionError] = useState<string | null>(null);

  const state: AppState | undefined = MOCK
    ? mockState(run.events)
    : live.kind === 'ready' ? live.value : live.kind === 'error' ? live.last : undefined;
  const explorerUrl = state?.explorerUrl;

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
    <main className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">SignVault</h1>
          <p className="text-neutral-600">The same agent, the same task, two wallets. Pay every unpaid invoice in the inbox.</p>
        </div>
        <div className="flex items-center gap-3">
          {MOCK ? (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-900">Recorded run</span>
          ) : (
            <ServerStatus stateError={live.kind === 'error' ? live.message : null} />
          )}
          <button type="button" onClick={runTask} className="h-11 rounded-xl bg-neutral-900 px-5 font-semibold text-white active:bg-neutral-700">
            Run the task
          </button>
          <button type="button" onClick={reset} className="h-11 rounded-xl border border-neutral-300 px-5 font-semibold active:bg-neutral-100">
            Reset
          </button>
        </div>
      </header>
      {actionError && <p className="rounded-lg bg-red-50 px-4 py-2 text-red-700">{actionError}</p>}

      <div className="grid gap-6 md:grid-cols-2">
        <WalletColumn
          title="Standard wallet"
          subtitle="Limit raised with a code sent by email"
          address={state?.addresses.baselineWallet}
          events={run.events.filter((e) => e.wallet === 'baseline')}
          explorerUrl={explorerUrl}
        >
          <BaselineRules baseline={state?.baseline} />
        </WalletColumn>
        <WalletColumn
          title="SignVault"
          subtitle="Rules change only with the owner's signature"
          address={state?.addresses.signVault}
          events={run.events.filter((e) => e.wallet === 'signvault')}
          explorerUrl={explorerUrl}
        >
          <VaultRules state={state} />
          {!MOCK && (
            <button
              type="button"
              onClick={() => act(() => startRun('signvault'))}
              className="h-11 self-start rounded-xl border border-neutral-300 px-5 font-semibold active:bg-neutral-100"
            >
              Run again on SignVault
            </button>
          )}
        </WalletColumn>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <InboxPanel inbox={state?.inbox ?? []} />
        <PendingChangesPanel state={state} />
        <FakeEmailPanel
          disabled={MOCK}
          onSend={async (email) => {
            await postJson<Email>('/api/inbox', email);
            live.refresh();
          }}
        />
      </div>
    </main>
  );
}

function ServerStatus({ stateError }: { stateError: string | null }) {
  const ok = !stateError;
  return (
    <span
      title={stateError ?? undefined}
      className={`rounded-full px-3 py-1 text-sm font-medium ${ok ? 'bg-green-100 text-green-900' : 'bg-red-100 text-red-900'}`}
    >
      {ok ? 'Live' : 'Server not reachable'}
    </span>
  );
}
