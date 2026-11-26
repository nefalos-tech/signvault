import { BaseError, createWalletClient, custom } from 'viem';
import type { Chain, EIP1193Provider, WalletClient } from 'viem';
import { anvil, bscTestnet } from 'viem/chains';
import { rearmTypedData } from '@signvault/shared';
import type { Address, AppState, Hex, TxResult } from '@signvault/shared';
import { shortAddress } from './approve';

/** Card T3: the owner's EIP-712 Rearm over the vault's current nonce, the one SetPayee also spends. */
export function rearmRequest(state: AppState) {
  return rearmTypedData({ chainId: state.chainId, vault: state.addresses.signVault, nonce: BigInt(state.signvault.nonce) });
}

const CHAINS: Partial<Record<number, Chain>> = { [bscTestnet.id]: bscTestnet, [anvil.id]: anvil };

/**
 * Connects the injected wallet, moves it to the vault's chain and asks it to sign the re-arm.
 * Refuses before signing when the connected account is not the vault owner.
 */
export async function signRearm(provider: EIP1193Provider, state: AppState, owner: Address) {
  const wallet = createWalletClient({ transport: custom(provider) });
  const [account] = await wallet.requestAddresses();
  if (account.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`This wallet (${shortAddress(account)}) is not the vault owner (${shortAddress(owner)}). Switch accounts and try again.`);
  }
  await switchToChain(wallet, state.chainId);
  return { account, signature: await wallet.signTypedData({ account, ...rearmRequest(state) }) };
}

/** As on /approve: switch, and add the chain first when the wallet does not know it. */
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

/** The server relays the signature as the operator. A refusal comes back as `{ ok: false, error }`, not a throw. */
export async function postRearm(signature: Hex): Promise<TxResult> {
  const res = await fetch('/api/vault/rearm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signature }),
  });
  if (!res.ok) throw new Error(`The server refused the re-arm (${res.status}): ${await res.text()}`);
  return res.json();
}
