'use client';

import 'viem/window';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppState, TxResult } from '@signvault/shared';
import { chainName, shortAddress } from '@/lib/approve';
import { postRearm, signRearm } from '@/lib/rearm';

type Load = { kind: 'loading' } | { kind: 'ready'; state: AppState } | { kind: 'error'; message: string };
type Step =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'done'; result: TxResult }
  | { kind: 'error'; message: string };

async function fetchState(): Promise<AppState> {
  const res = await fetch('/api/state', { cache: 'no-store' });
  if (!res.ok) throw new Error(`/api/state answered ${res.status}`);
  return res.json();
}

function errorText(err: unknown) {
  if (err && typeof err === 'object' && 'shortMessage' in err) return String(err.shortMessage);
  return err instanceof Error ? err.message : String(err);
}

/** Card T3: the owner's phone re-arms a tripped vault with an EIP-712 Rearm signature, which the contract checks. */
export default function RearmPage() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [step, setStep] = useState<Step>({ kind: 'idle' });

  const reload = useCallback(
    () => fetchState().then((state) => setLoad({ kind: 'ready', state })).catch((err) => setLoad({ kind: 'error', message: errorText(err) })),
    [],
  );
  useEffect(() => {
    reload();
  }, [reload]);

  if (load.kind === 'loading') return <Shell><p className="text-lg text-neutral-600">Loading…</p></Shell>;
  if (load.kind === 'error') return <Shell><p className="text-lg text-red-700">Could not load the vault: {load.message}</p></Shell>;

  const { state } = load;
  const tripwire = state.signvault.tripwire;

  async function rearm() {
    if (!window.ethereum) {
      setStep({ kind: 'error', message: "No wallet found. Open this page in your wallet app's browser." });
      return;
    }
    try {
      // A payee approval may have spent the nonce since this page loaded, so sign over the vault's nonce now.
      setStep({ kind: 'busy', label: 'Checking the vault…' });
      const current = await fetchState();
      setLoad({ kind: 'ready', state: current });
      if (!current.signvault.tripwire?.tripped) {
        setStep({ kind: 'idle' });
        return;
      }
      setStep({ kind: 'busy', label: 'Check your wallet…' });
      const { signature } = await signRearm(window.ethereum, current, current.addresses.owner);
      setStep({ kind: 'busy', label: 'Sending to the vault…' });
      const result = await postRearm(signature);
      setStep({ kind: 'done', result });
      await reload();
    } catch (err) {
      setStep({ kind: 'error', message: errorText(err) });
    }
  }

  return (
    <Shell>
      <p className="text-neutral-600">
        Vault {shortAddress(state.addresses.signVault)} on {chainName(state.chainId)}
      </p>
      {!tripwire && <p className="text-lg">This vault has no tripwire.</p>}
      {tripwire && !tripwire.tripped && step.kind !== 'done' && (
        <p className="text-lg text-green-700">The tripwire is armed. Nothing to re-arm.</p>
      )}
      {tripwire?.tripped && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
          <p className="text-xl font-medium">The tripwire is tripped</p>
          <p className="text-neutral-600">
            The agent moved every T-bill back to cash, and sweeping is locked. Re-arming lets the agent sweep spare cash into T-bills again.
            {tripwire.simulated && ' The price shock that tripped it was simulated.'}
          </p>
          <p className="font-mono text-sm text-neutral-500">nonce {state.signvault.nonce}</p>
          <button
            type="button"
            onClick={rearm}
            disabled={step.kind === 'busy'}
            className="h-14 w-full rounded-xl bg-neutral-900 text-lg font-semibold text-white active:bg-neutral-700 disabled:opacity-60"
          >
            {step.kind === 'busy' ? step.label : 'Re-arm'}
          </button>
        </div>
      )}
      {step.kind === 'done' && <Result result={step.result} explorerUrl={state.explorerUrl} />}
      {step.kind === 'error' && <p className="text-red-700">{step.message}</p>}
    </Shell>
  );
}

function Result({ result, explorerUrl }: { result: TxResult; explorerUrl: string }) {
  const tx = result.txHash && (explorerUrl ? (
    <a className="underline" href={`${explorerUrl}/tx/${result.txHash}`} target="_blank" rel="noreferrer">View the transaction</a>
  ) : (
    <span className="block break-all font-mono text-sm text-neutral-500">{result.txHash}</span>
  ));
  return result.ok
    ? <p className="text-lg text-green-700">Re-armed. The contract checked your signature. {tx}</p>
    : <p className="text-lg text-red-700">Refused: {result.error}. {tx}</p>;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-4 py-8">
      <h1 className="text-2xl font-semibold">Re-arm the tripwire</h1>
      {children}
    </main>
  );
}
