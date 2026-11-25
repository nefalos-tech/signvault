'use client';

import 'viem/window';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppState, Hex, PendingChange } from '@signvault/shared';
import { chainName, describeChange, postApproval, shortAddress, signApproval } from '@/lib/approve';
import { MOCK_CHANGES, MOCK_STATE } from './fixture';

const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; state: AppState; changes: PendingChange[] }
  | { kind: 'error'; message: string };

type Step =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'signed'; account: string; signature: Hex }
  | { kind: 'error'; message: string };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

function errorText(err: unknown) {
  if (err && typeof err === 'object' && 'shortMessage' in err) return String(err.shortMessage);
  return err instanceof Error ? err.message : String(err);
}

export default function ApprovePage() {
  const [load, setLoad] = useState<Load>(
    MOCK ? { kind: 'ready', state: MOCK_STATE, changes: MOCK_CHANGES } : { kind: 'loading' },
  );
  const [steps, setSteps] = useState<Record<string, Step>>({});

  useEffect(() => {
    if (MOCK) return;
    Promise.all([getJson<AppState>('/api/state'), getJson<PendingChange[]>('/api/vault/changes')])
      .then(([state, changes]) => setLoad({ kind: 'ready', state, changes }))
      .catch((err) => setLoad({ kind: 'error', message: errorText(err) }));
  }, []);

  if (load.kind === 'loading') return <Shell><p className="text-lg text-neutral-600">Loading…</p></Shell>;
  if (load.kind === 'error') return <Shell><p className="text-lg text-red-700">Could not load the vault: {load.message}</p></Shell>;

  const { state, changes } = load;
  const setStep = (id: string, step: Step) => setSteps((s) => ({ ...s, [id]: step }));

  async function approve(change: PendingChange) {
    if (!window.ethereum) {
      setStep(change.id, { kind: 'error', message: "No wallet found. Open this page in your wallet app's browser." });
      return;
    }
    try {
      setStep(change.id, { kind: 'busy', label: 'Check your wallet…' });
      const { account, signature } = await signApproval(
        window.ethereum,
        change,
        state,
        MOCK ? undefined : state.addresses.owner,
      );
      if (MOCK) {
        setStep(change.id, { kind: 'signed', account, signature });
        return;
      }
      setStep(change.id, { kind: 'busy', label: 'Sending to the vault…' });
      const updated = await postApproval(change.id, signature);
      setLoad({ kind: 'ready', state, changes: changes.map((c) => (c.id === updated.id ? updated : c)) });
      setStep(change.id, { kind: 'idle' });
    } catch (err) {
      setStep(change.id, { kind: 'error', message: errorText(err) });
    }
  }

  return (
    <Shell>
      {MOCK && (
        <p className="rounded-lg bg-amber-100 px-4 py-3 text-amber-900">
          Mock mode: a sample change. Your wallet signs it, but nothing is sent.
        </p>
      )}
      <p className="text-neutral-600">
        Vault {shortAddress(state.addresses.signVault)} on {chainName(state.chainId)}
      </p>
      {changes.length === 0 && <p className="text-lg">Nothing waiting for your approval.</p>}
      <ul className="flex flex-col gap-4">
        {changes.map((change) => (
          <ChangeCard
            key={change.id}
            change={change}
            text={describeChange(change, state.vendors)}
            explorerUrl={state.explorerUrl}
            step={steps[change.id] ?? { kind: 'idle' }}
            onApprove={() => approve(change)}
          />
        ))}
      </ul>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-4 py-8">
      <h1 className="text-2xl font-semibold">Approve a rule change</h1>
      {children}
    </main>
  );
}

function ChangeCard(props: {
  change: PendingChange;
  text: string;
  explorerUrl: string;
  step: Step;
  onApprove: () => void;
}) {
  const { change, text, explorerUrl, step, onApprove } = props;
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
      <p className="text-xl font-medium">{text}</p>
      <p className="break-all font-mono text-sm text-neutral-500">
        {change.to} · nonce {change.nonce}
      </p>
      {change.status === 'pending' && step.kind !== 'signed' && (
        <button
          type="button"
          onClick={onApprove}
          disabled={step.kind === 'busy'}
          className="h-14 w-full rounded-xl bg-neutral-900 text-lg font-semibold text-white active:bg-neutral-700 disabled:opacity-60"
        >
          {step.kind === 'busy' ? step.label : 'Approve'}
        </button>
      )}
      {change.status === 'applied' && (
        <p className="text-lg text-green-700">
          Approved.{' '}
          {change.txHash &&
            (explorerUrl ? (
              <a className="underline" href={`${explorerUrl}/tx/${change.txHash}`} target="_blank" rel="noreferrer">
                View the transaction
              </a>
            ) : (
              <span className="block break-all font-mono text-sm text-neutral-500">{change.txHash}</span>
            ))}
        </p>
      )}
      {change.status === 'failed' && <p className="text-lg text-red-700">Failed: {change.error ?? 'unknown error'}</p>}
      {step.kind === 'signed' && (
        <div className="text-green-700">
          <p className="text-lg">Signed by {shortAddress(step.account)}. Not sent (mock mode).</p>
          <p data-testid="signature" className="break-all font-mono text-xs text-neutral-500">{step.signature}</p>
        </div>
      )}
      {step.kind === 'error' && <p className="text-red-700">{step.message}</p>}
    </li>
  );
}
