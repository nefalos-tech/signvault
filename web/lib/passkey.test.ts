import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { bytesToHex, decodeAbiParameters, hashTypedData, hexToBytes } from 'viem';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { VENDORS } from '@signvault/shared';
import type { PendingChange } from '@signvault/shared';
import { MOCK_CHANGES, MOCK_STATE } from '../app/approve/fixture';
import { changeTypedData } from './approve';
import { changeDigest, registerPasskey, signChangeWithPasskey } from './passkey';

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const CREDENTIAL_ID = 'c2lnbnZhdWx0LXRlc3Q';
const RP_ID = 'localhost';
const APPROVAL_PARAMS = [
  { type: 'bytes32' },
  { type: 'bytes32' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'bytes' },
  { type: 'string' },
] as const;

const sha256 = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());
const buffer = (bytes: Uint8Array) => bytes.slice().buffer;

/** Stands in for Face ID: a P-256 key in memory that answers create and get the way a browser does. */
function softwareAuthenticator(keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })) {
  const requests: { create: any[]; get: any[] } = { create: [], get: [] };
  const createFn = async (options: any) => {
    requests.create.push(options);
    const spki = new Uint8Array(keys.publicKey.export({ type: 'spki', format: 'der' }));
    return {
      id: CREDENTIAL_ID,
      type: 'public-key',
      response: { attestationObject: new ArrayBuffer(0), clientDataJSON: new ArrayBuffer(0), getPublicKey: () => buffer(spki) },
    } as any;
  };
  const getFn = async (options: any) => {
    requests.get.push(options);
    const { challenge, rpId } = options.publicKey;
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: Buffer.from(challenge).toString('base64url'),
        origin: `http://${rpId}:3000`,
        crossOrigin: false,
      }),
    );
    const authenticatorData = new Uint8Array([...sha256(new TextEncoder().encode(rpId)), 0x05, 0, 0, 0, 0]);
    const signed = new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]);
    const signature = new Uint8Array(sign('sha256', signed, { key: keys.privateKey, dsaEncoding: 'der' }));
    return {
      id: CREDENTIAL_ID,
      type: 'public-key',
      response: { clientDataJSON: buffer(clientDataJSON), authenticatorData: buffer(authenticatorData), signature: buffer(signature) },
    } as any;
  };
  return { publicKey: keys.publicKey, createFn, getFn, requests };
}

/** What PasskeyApproval.sol checks, done in Node: the challenge, the type, a low s and the P-256 signature. */
function checkLikeTheContract(approval: Hex, digest: Hex, publicKey: KeyObject) {
  const [r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON] = decodeAbiParameters(APPROVAL_PARAMS, approval);
  const challenge = Buffer.from(hexToBytes(digest)).toString('base64url');
  expect(clientDataJSON.slice(Number(challengeIndex))).toMatch(new RegExp(`^"challenge":"${challenge}"`));
  expect(clientDataJSON.slice(Number(typeIndex))).toMatch(/^"type":"webauthn\.get"/);
  expect(hexToBytes(authenticatorData)[32]! & 0x05).toBe(0x05);
  expect(BigInt(s)).toBeLessThanOrEqual(P256_N / 2n);
  const signed = new Uint8Array([...hexToBytes(authenticatorData), ...sha256(new TextEncoder().encode(clientDataJSON))]);
  const rs = hexToBytes(`${r}${s.slice(2)}`);
  expect(verify('sha256', signed, { key: publicKey, dsaEncoding: 'ieee-p1363' }, rs)).toBe(true);
}

const addVendor2: PendingChange = MOCK_CHANGES[0]!;

/**
 * One assertion for the mock change, signed with a high s by the P-256 key
 * uint256(keccak256("signvault.test.owner-passkey")). test_TheBrowserEncodersApprovalAddsAPayee in
 * contracts/test/PasskeySignVault.t.sol sends `approval` to a vault and expects PayeeSet.
 * The flags byte 0x1d is user present, user verified, backup eligible and backed up, as an iCloud passkey sends.
 */
const GOLDEN = {
  digest: '0x1a71a0398d3dee1429a97f63f3d923aa8f0cd42292bcb637929dd34e4509a34e',
  clientDataJSON:
    '{"type":"webauthn.get","challenge":"GnGgOY097hQpqX9j89kjqo8M1CKSvLY3kp3TTkUJo04","origin":"http://localhost:3000","crossOrigin":false,"other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"}',
  authenticatorData: '0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97631d00000000',
  derSignature:
    '0x3046022100ed36a36bed5c46707e8fe8e2e0e8dde3b763c44ef3390d2fbd0c75297980e89c022100aaa73eda3235735c1fe62204829e016d95c309466ca89037168d42a7e2f54206',
  approval:
    '0xed36a36bed5c46707e8fe8e2e0e8dde3b763c44ef3390d2fbd0c75297980e89c5558c124cdca8ca4e019ddfb7d61fe922723f1673a6f0e4ddd2c881b196de34b0000000000000000000000000000000000000000000000000000000000000017000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000002549960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97631d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f37b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a22476e47674f593039376851707158396a38396b6a716f384d31434b53764c59336b703354546b554a6f3034222c226f726967696e223a22687474703a2f2f6c6f63616c686f73743a33303030222c2263726f73734f726967696e223a66616c73652c226f746865725f6b6579735f63616e5f62655f61646465645f68657265223a22646f206e6f7420636f6d7061726520636c69656e74446174614a534f4e20616761696e737420612074656d706c6174652e205365652068747470733a2f2f676f6f2e676c2f796162506578227d00000000000000000000000000',
} as const;

describe('registerPasskey', () => {
  it('asks for an ES256 passkey with user verification and returns its public key for the deploy', async () => {
    const authenticator = softwareAuthenticator();

    const passkey = await registerPasskey(RP_ID, authenticator.createFn);

    const { publicKey } = authenticator.requests.create[0];
    expect(publicKey.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
    expect(publicKey.authenticatorSelection.userVerification).toBe('required');
    expect(publicKey.rp.id).toBe(RP_ID);
    // A shared user handle would let the platform overwrite the passkey a deployed vault holds.
    await registerPasskey(RP_ID, authenticator.createFn);
    const [first, second] = authenticator.requests.create.map((o) => bytesToHex(new Uint8Array(o.publicKey.user.id)));
    expect(first).toHaveLength(2 + 2 * 32);
    expect(first).not.toBe(second);
    const jwk = authenticator.publicKey.export({ format: 'jwk' });
    expect(passkey).toEqual({
      id: CREDENTIAL_ID,
      x: bytesToHex(Buffer.from(jwk.x!, 'base64url')),
      y: bytesToHex(Buffer.from(jwk.y!, 'base64url')),
    });
  });
});

describe('changeDigest', () => {
  it('is the EIP-712 hash of the SetPayee typed data the wallet path signs', () => {
    expect(changeDigest(addVendor2, MOCK_STATE)).toBe(hashTypedData(changeTypedData(addVendor2, MOCK_STATE)));
  });
});

describe('signChangeWithPasskey', () => {
  it('signs the digest as the challenge with user verification, and encodes what PasskeyApproval.sol decodes', async () => {
    const authenticator = softwareAuthenticator();
    const digest = changeDigest(addVendor2, MOCK_STATE);

    const approval = await signChangeWithPasskey({ credentialId: CREDENTIAL_ID, rpId: RP_ID, change: addVendor2, state: MOCK_STATE, getFn: authenticator.getFn });

    const { publicKey } = authenticator.requests.get[0];
    expect(bytesToHex(publicKey.challenge)).toBe(digest);
    expect(publicKey.userVerification).toBe('required');
    expect(publicKey.rpId).toBe(RP_ID);
    expect(publicKey.allowCredentials).toHaveLength(1);
    expect(Buffer.from(publicKey.allowCredentials[0].id).toString('base64url')).toBe(CREDENTIAL_ID);
    // Six flat parameters, so the first word is r and not a tuple offset.
    const [r] = decodeAbiParameters(APPROVAL_PARAMS, approval);
    expect(approval.slice(0, 66)).toBe(r);
    checkLikeTheContract(approval, digest, authenticator.publicKey);
  });

  it('gives a low s the contract accepts, whatever s the authenticator signed with', async () => {
    const authenticator = softwareAuthenticator();
    for (let nonce = 0; nonce < 64; nonce++) {
      const change = { ...addVendor2, nonce: String(nonce), to: VENDORS[nonce % 3]!.address };
      const approval = await signChangeWithPasskey({ rpId: RP_ID, change, state: MOCK_STATE, getFn: authenticator.getFn });
      checkLikeTheContract(approval, changeDigest(change, MOCK_STATE), authenticator.publicKey);
    }
  });

  it('encodes a fixed assertion to the bytes PasskeySignVault.t.sol proves on chain', async () => {
    const fixed = {
      id: CREDENTIAL_ID,
      type: 'public-key',
      response: {
        clientDataJSON: buffer(new TextEncoder().encode(GOLDEN.clientDataJSON)),
        authenticatorData: buffer(hexToBytes(GOLDEN.authenticatorData)),
        signature: buffer(hexToBytes(GOLDEN.derSignature)),
      },
    } as any;

    expect(changeDigest(addVendor2, MOCK_STATE)).toBe(GOLDEN.digest);
    const approval = await signChangeWithPasskey({ rpId: RP_ID, change: addVendor2, state: MOCK_STATE, getFn: async () => fixed });
    expect(approval).toBe(GOLDEN.approval);
  });

  it('leaves the passkey choice to the browser when no credential is saved', async () => {
    const authenticator = softwareAuthenticator();
    await signChangeWithPasskey({ rpId: RP_ID, change: addVendor2, state: MOCK_STATE, getFn: authenticator.getFn });
    expect(authenticator.requests.get[0].publicKey.allowCredentials).toBeUndefined();
  });
});
