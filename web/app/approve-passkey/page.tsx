'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppState, Hex, PendingChange } from '@signvault/shared';
import { chainName, describeChange, postApproval, shortAddress } from '@/lib/approve';
import { loadSavedPasskey, registerPasskey, savePasskey, signChangeWithPasskey } from '@/lib/passkey';
import type { Passkey } from '@/lib/passkey';
import { MOCK_CHANGES, MOCK_STATE } from '../approve/fixture';

const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';
/** Keeps the nonce on screen current, so a tap can go straight to Face ID with nothing awaited first. */
const REFRESH_MS = 3000;

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; state: AppState; changes: PendingChange[] }
  | { kind: 'error'; message: string };

type Step =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'signed'; approval: Hex }
  | { kind: 'error'; message: string; approval?: Hex };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

async function fetchVault() {
  const [state, changes] = await Promise.all([
    getJson<AppState>('/api/state'),
    getJson<PendingChange[]>('/api/vault/changes'),
  ]);
  return { state, changes };
}

/** The innermost message: viem wraps the browser's NotAllowedError, whose text says what happened. */
function errorText(err: unknown): string {
  let e = err;
  while (e instanceof Error && e.cause instanceof Error) e = e.cause;
  return e instanceof Error ? e.message : String(e);
}

export default function ApprovePasskeyPage() {
  const [load, setLoad] = useState<Load>(
    MOCK ? { kind: 'ready', state: MOCK_STATE, changes: MOCK_CHANGES } : { kind: 'loading' },
  );
  const [passkey, setPasskey] = useState<Passkey>();
  const [host, setHost] = useState<{ name: string; hasPasskeys: boolean }>();
  const [registering, setRegistering] = useState<Step>({ kind: 'idle' });
  const [steps, setSteps] = useState<Record<string, Step>>({});

  useEffect(() => {
    setPasskey(loadSavedPasskey());
    setHost({ name: window.location.hostname, hasPasskeys: Boolean(window.PublicKeyCredential) });
    if (MOCK) return;
    const refresh = () =>
      fetchVault()
        .then((vault) => setLoad({ kind: 'ready', ...vault }))
        .catch((err) => setLoad((l) => (l.kind === 'ready' ? l : { kind: 'error', message: errorText(err) })));
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  async function register() {
    setRegistering({ kind: 'busy', label: 'Follow the Face ID or Touch ID prompt…' });
    try {
      const created = await registerPasskey(window.location.hostname);
      savePasskey(created);
      setPasskey(created);
      setRegistering({ kind: 'idle' });
    } catch (err) {
      setRegistering({ kind: 'error', message: errorText(err) });
    }
  }

  const setStep = (id: string, step: Step) => setSteps((s) => ({ ...s, [id]: step }));

  async function approve(change: PendingChange, state: AppState) {
    setStep(change.id, { kind: 'busy', label: 'Follow the Face ID or Touch ID prompt…' });
    let approval: Hex | undefined;
    try {
      approval = await signChangeWithPasskey({ credentialId: passkey?.id, rpId: window.location.hostname, change, state });
      if (MOCK) {
        setStep(change.id, { kind: 'signed', approval });
        return;
      }
      setStep(change.id, { kind: 'busy', label: 'Sending to the vault…' });
      await postApproval(change.id, approval);
      setLoad({ kind: 'ready', ...(await fetchVault()) });
      setStep(change.id, { kind: 'idle' });
    } catch (err) {
      setStep(change.id, { kind: 'error', message: errorText(err), approval });
    }
  }

  return (
    <Shell>
      {MOCK && (
        <p className="rounded-lg bg-amber-100 px-4 py-3 text-amber-900">
          Mock mode: a sample change. Your passkey signs it, but nothing is sent.
        </p>
      )}
      {host && !host.hasPasskeys && (
        <p className="text-red-700">This browser has no passkeys. Open the page in Safari or Chrome, over HTTPS or on localhost.</p>
      )}
      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
        <h2 className="text-lg font-medium">Your passkey</h2>
        {passkey ? (
          <>
            <p className="text-neutral-600">
              Saved in this browser for {host?.name}. Deploy the vault with this public key:
            </p>
            <pre className="whitespace-pre-wrap break-all rounded-lg bg-neutral-100 p-3 font-mono text-xs">
              {`PASSKEY_X=${passkey.x}\nPASSKEY_Y=${passkey.y}`}
            </pre>
          </>
        ) : (
          <p className="text-neutral-600">
            None saved here. Create one on the device you will approve from. It works only on {host?.name}.
          </p>
        )}
        <button
          type="button"
          onClick={register}
          disabled={registering.kind === 'busy'}
          className="h-12 w-full rounded-xl border border-neutral-900 text-base font-semibold active:bg-neutral-100 disabled:opacity-60"
        >
          {registering.kind === 'busy' ? registering.label : passkey ? 'Replace the passkey' : 'Create a passkey'}
        </button>
        {passkey && <p className="text-sm text-neutral-500">A vault deployed with the old key will refuse the new one.</p>}
        {registering.kind === 'error' && <p className="text-red-700">{registering.message}</p>}
      </section>
      {load.kind === 'loading' && <p className="text-lg text-neutral-600">Loading the vault…</p>}
      {load.kind === 'error' && <p className="text-lg text-red-700">Could not load the vault: {load.message}</p>}
      {load.kind === 'ready' && (
        <>
          <p className="text-neutral-600">
            Vault {shortAddress(load.state.addresses.signVault)} on {chainName(load.state.chainId)}
          </p>
          {load.changes.length === 0 && <p className="text-lg">Nothing waiting for your approval.</p>}
          <ul className="flex flex-col gap-4">
            {load.changes.map((change) => (
              <ChangeCard
                key={change.id}
                change={change}
                text={describeChange(change, load.state.vendors)}
                explorerUrl={load.state.explorerUrl}
                step={steps[change.id] ?? { kind: 'idle' }}
                onApprove={() => approve(change, load.state)}
              />
            ))}
          </ul>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-4 py-8">
      <h1 className="text-2xl font-semibold">Approve with a passkey</h1>
      {children}
    </main>
  );
}

function ChangeCard(props: { change: PendingChange; text: string; explorerUrl: string; step: Step; onApprove: () => void }) {
  const { change, text, explorerUrl, step, onApprove } = props;
  const approval = step.kind === 'signed' || step.kind === 'error' ? step.approval : undefined;
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
      <p className="text-xl font-medium">{text}</p>
      <p className="break-all font-mono text-sm text-neutral-500">
        {change.to} · nonce {change.nonce}
      </p>
      {change.status !== 'applied' && step.kind !== 'signed' && (
        <button
          type="button"
          onClick={onApprove}
          disabled={step.kind === 'busy'}
          className="h-14 w-full rounded-xl bg-neutral-900 text-lg font-semibold text-white active:bg-neutral-700 disabled:opacity-60"
        >
          {step.kind === 'busy' ? step.label : 'Approve with Face ID'}
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
      {change.status === 'failed' && step.kind !== 'busy' && (
        <p className="text-red-700">The vault refused the last approval: {change.error ?? 'unknown error'}. Approve again.</p>
      )}
      {step.kind === 'signed' && <p className="text-lg text-green-700">Signed with your passkey. Not sent (mock mode).</p>}
      {step.kind === 'error' && <p className="text-red-700">{step.message}</p>}
      {approval && (
        <details className="text-sm text-neutral-500">
          <summary>Approval bytes, to relay by hand with setPayee</summary>
          <p data-testid="approval" className="break-all font-mono text-xs">{approval}</p>
        </details>
      )}
    </li>
  );
}
