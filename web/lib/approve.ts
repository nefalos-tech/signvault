import { BaseError, createWalletClient, custom, formatUnits } from 'viem';
import type { Chain, EIP1193Provider, WalletClient } from 'viem';
import { anvil, bscTestnet } from 'viem/chains';
import { MUSD_DECIMALS, setPayeeTypedData } from '@signvault/shared';
import type { Address, AppState, Hex, PendingChange } from '@signvault/shared';

/** The EIP-712 SetPayee approval (spec 6.3) the owner signs for `change`. */
export function changeTypedData(change: PendingChange, state: AppState) {
  return setPayeeTypedData({
    chainId: state.chainId,
    vault: state.addresses.signVault,
    to: change.to,
    amount: BigInt(change.amount),
    nonce: BigInt(change.nonce),
  });
}

/** The owner may sign a pending change, and sign again after a relay failed. An applied change is final. */
export function canApprove(status: PendingChange['status']) {
  return status !== 'applied';
}

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** "Add Vendor 2 at 0.01 mUSD per day", or "Remove Vendor 2" when the amount is 0. */
export function describeChange(change: PendingChange, vendors: AppState['vendors']) {
  const vendor = vendors.find((v) => v.address.toLowerCase() === change.to.toLowerCase());
  const who = vendor?.name ?? shortAddress(change.to);
  const amount = BigInt(change.amount);
  if (amount === 0n) return `Remove ${who}`;
  return `Add ${who} at ${formatUnits(amount, MUSD_DECIMALS)} mUSD per day`;
}

const CHAINS: Partial<Record<number, Chain>> = { [bscTestnet.id]: bscTestnet, [anvil.id]: anvil };

export function chainName(chainId: number) {
  return CHAINS[chainId]?.name ?? `chain ${chainId}`;
}

/**
 * Connects the injected wallet, moves it to the vault's chain and asks it to sign the approval.
 * With `owner` set, refuses before signing when the connected account is someone else.
 */
export async function signApproval(
  provider: EIP1193Provider,
  change: PendingChange,
  state: AppState,
  owner: Address | undefined,
) {
  const wallet = createWalletClient({ transport: custom(provider) });
  const [account] = await wallet.requestAddresses();
  if (owner && account.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`This wallet (${shortAddress(account)}) is not the vault owner (${shortAddress(owner)}). Switch accounts and try again.`);
  }
  await switchToChain(wallet, state.chainId);
  const signature = await wallet.signTypedData({ account, ...changeTypedData(change, state) });
  return { account, signature };
}

async function switchToChain(wallet: WalletClient, chainId: number) {
  try {
    await wallet.switchChain({ id: chainId });
  } catch (err) {
    const unknownChain = err instanceof BaseError && err.walk((e) => (e as { code?: number }).code === 4902);
    const chain = CHAINS[chainId];
    if (!unknownChain || !chain) throw err;
    await wallet.addChain({ chain });
    await wallet.switchChain({ id: chainId });
  }
}

export async function postApproval(id: string, signature: Hex): Promise<PendingChange> {
  const res = await fetch(`/api/vault/changes/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signature }),
  });
  if (!res.ok) throw new Error(`The server refused the approval (${res.status}): ${await res.text()}`);
  return res.json();
}
