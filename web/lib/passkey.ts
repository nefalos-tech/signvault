import { bytesToHex, encodeAbiParameters, hashTypedData, slice } from 'viem';
import type { Hex } from 'viem';
import { createWebAuthnCredential, toWebAuthnAccount } from 'viem/account-abstraction';
import type {
  CreateWebAuthnCredentialParameters,
  ToWebAuthnAccountParameters,
  WebAuthnSignReturnType,
} from 'viem/account-abstraction';
import type { AppState, PendingChange } from '@signvault/shared';
import { changeTypedData } from './approve';

/** The owner's passkey: the id the browser knows it by, and the P-256 public key PasskeySignVault stores. */
export interface Passkey {
  id: string;
  x: Hex;
  y: Hex;
}

/** `navigator.credentials.create` and `.get` by default. Tests pass a software key. */
export type CreateFn = CreateWebAuthnCredentialParameters['createFn'];
export type GetFn = ToWebAuthnAccountParameters['getFn'];

/** abi.encode(r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON): what PasskeyApproval.sol decodes. */
const APPROVAL_PARAMS = [
  { type: 'bytes32' },
  { type: 'bytes32' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'bytes' },
  { type: 'bytes' },
] as const;

/**
 * Creates an ES256 passkey that needs Face ID, Touch ID or a PIN. It belongs to `rpId`, the site's hostname,
 * and works only there. Each one gets its own random user handle, so a new passkey never overwrites one a
 * deployed vault still holds.
 */
export async function registerPasskey(rpId: string, createFn?: CreateFn): Promise<Passkey> {
  const user = { id: crypto.getRandomValues(new Uint8Array(32)), name: 'SignVault owner', displayName: 'SignVault owner' };
  const credential = await createWebAuthnCredential({ name: user.name, user, rp: { id: rpId, name: 'SignVault' }, createFn });
  return { id: credential.id, x: slice(credential.publicKey, 0, 32), y: slice(credential.publicKey, 32, 64) };
}

/** The SetPayee EIP-712 digest (spec 6.3). The wallet signs it as typed data, and the passkey signs it as its challenge. */
export function changeDigest(change: PendingChange, state: AppState): Hex {
  return hashTypedData(changeTypedData(change, state));
}

/**
 * Asks the passkey to sign `change` and returns the approval bytes for `setPayee`. Without `credentialId`
 * the browser offers every passkey it has for this site.
 */
export async function signChangeWithPasskey(args: {
  credentialId?: string;
  rpId: string;
  change: PendingChange;
  state: AppState;
  getFn?: GetFn;
}): Promise<Hex> {
  const { credentialId = '', rpId, change, state, getFn } = args;
  // sign() uses only the credential id. The vault holds the public key.
  const account = toWebAuthnAccount({ credential: { id: credentialId, publicKey: '0x' }, rpId, getFn });
  const { signature, webauthn } = await account.sign({ hash: changeDigest(change, state) });
  return encodeApproval(signature, webauthn);
}

/** `signature` is r and s with s already at most n/2 (viem normalizes it), which OpenZeppelin's P256 requires. */
function encodeApproval(signature: Hex, webauthn: WebAuthnSignReturnType['webauthn']): Hex {
  const { challengeIndex = -1, typeIndex = -1 } = webauthn;
  if (challengeIndex < 0 || typeIndex < 0) throw new Error('The passkey answered without a challenge or type in its clientDataJSON.');
  return encodeAbiParameters(APPROVAL_PARAMS, [
    slice(signature, 0, 32),
    slice(signature, 32, 64),
    BigInt(challengeIndex),
    BigInt(typeIndex),
    webauthn.authenticatorData,
    // viem gives clientDataJSON one character per byte, and the indices count those bytes.
    bytesToHex(Uint8Array.from(webauthn.clientDataJSON, (c) => c.charCodeAt(0))),
  ]);
}

const STORAGE_KEY = 'signvault.passkey';

/** The passkey this browser made, if it saved one. Storage can be missing or blocked, which reads as none. */
export function loadSavedPasskey(): Passkey | undefined {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    return saved && typeof saved.id === 'string' && typeof saved.x === 'string' && typeof saved.y === 'string' ? saved : undefined;
  } catch {
    return undefined;
  }
}

export function savePasskey(passkey: Passkey) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(passkey));
  } catch {
    // Without storage the page still works: approving then lets the browser pick the passkey.
  }
}
