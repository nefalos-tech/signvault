import { encodeAbiParameters, getAddress, hexToBigInt, hexToNumber, isHex, keccak256, size, slice, toHex, verifyTypedData, zeroAddress } from 'viem';
import {
  BASELINE_DAILY_CAP, INVOICE_AMOUNT, PERIOD_SECONDS, setPayeeTypedData, STARTING_BALANCE,
  type Address, type AppState, type ChainPort, type Hex, type TxResult,
} from '@signvault/shared';
import { loadDeployment } from '@signvault/shared/deployments';

const DAY = 86_400n;
/** OpenZeppelin ECDSA refuses an `s` above half the secp256k1 order. */
const MAX_S = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** The Solidity custom error a refused call reverts with: spec 6.2, 6.3, and OpenZeppelin ERC20 for MockUSD. */
type Refusal =
  | 'DailyCapExceeded' | 'NotOnTheList' | 'AlreadyPaidThisPeriod' | 'OwnerApprovalRequired'
  | 'ERC20InsufficientBalance' | 'ERC20InvalidReceiver';

/** One BaselineWallet and SignVault pair, holding what the contracts store. */
interface Pair {
  baseline: { address: Address; balance: bigint; dailyCap: bigint; spent: { day: bigint; amount: bigint } };
  vault: { address: Address; balance: bigint; nonce: bigint; payees: Map<Address, bigint>; lastPaidPeriod: Map<Address, bigint> };
}

export interface FakeChainOptions {
  /** `block.timestamp` in unix seconds. Defaults to the wall clock. */
  now?: () => bigint;
}

/** An in-memory ChainPort over `deployments/fake.json` that refuses exactly what the contracts refuse. */
export class FakeChain implements ChainPort {
  private readonly d = loadDeployment('fake');
  private readonly now: () => bigint;
  private readonly startTime: bigint;
  private pairIndex = 0;
  private pair: Pair;
  private txCount = 0n;

  constructor({ now = () => BigInt(Math.floor(Date.now() / 1000)) }: FakeChainOptions = {}) {
    this.now = now;
    this.startTime = now(); // Deploy.s.sol deploys every pair at once.
    this.pair = this.deployPair(0);
  }

  async readState(): Promise<Pick<AppState, 'chainId' | 'explorerUrl' | 'addresses' | 'vendors' | 'baseline' | 'signvault'>> {
    const { baseline, vault } = this.pair;
    const period = this.currentPeriod();
    return {
      chainId: this.d.chainId,
      explorerUrl: this.d.explorerUrl,
      addresses: { mockUsd: this.d.mockUsd, baselineWallet: baseline.address, signVault: vault.address, owner: this.d.owner, agent: this.d.agent },
      vendors: this.d.vendors,
      baseline: { balance: String(baseline.balance), dailyCap: String(baseline.dailyCap), spentToday: String(this.spentToday()) },
      signvault: {
        balance: String(vault.balance),
        nonce: String(vault.nonce),
        payees: [...vault.payees].map(([to, amount]) => ({ to, amount: String(amount), paidThisPeriod: vault.lastPaidPeriod.get(to) === period })),
      },
    };
  }

  async baselinePay(to: Address, amount: bigint): Promise<TxResult> {
    const payee = abiAddress(to);
    abiUint256(amount);
    return this.send(() => {
      const wallet = this.pair.baseline;
      const wouldSpend = this.spentToday() + amount;
      if (wouldSpend > wallet.dailyCap) return 'DailyCapExceeded';
      const refused = transfer(wallet, payee, amount);
      if (refused) return refused;
      wallet.spent = { day: this.now() / DAY, amount: wouldSpend };
    });
  }

  async baselineSetDailyCap(newCap: bigint): Promise<TxResult> {
    abiUint256(newCap);
    return this.send(() => {
      this.pair.baseline.dailyCap = newCap;
    });
  }

  async vaultPay(to: Address): Promise<TxResult> {
    const payee = abiAddress(to);
    return this.send(() => {
      const vault = this.pair.vault;
      const amount = vault.payees.get(payee) ?? 0n;
      if (amount === 0n) return 'NotOnTheList';
      const period = this.currentPeriod();
      if (vault.lastPaidPeriod.get(payee) === period) return 'AlreadyPaidThisPeriod';
      const refused = transfer(vault, payee, amount);
      if (refused) return refused;
      vault.lastPaidPeriod.set(payee, period);
    });
  }

  /** Anyone may relay the owner's approval (spec 6.3), so `_as` changes nothing. */
  async vaultSetPayee(to: Address, amount: bigint, approval: Hex, _as: 'agent' | 'operator'): Promise<TxResult> {
    const payee = abiAddress(to);
    abiUint256(amount);
    const vault = this.pair.vault;
    const nonce = vault.nonce;
    const signed = await this.ownerSigned(vault.address, payee, amount, nonce, approval);
    return this.send(() => {
      // Another change may have landed during the await. The chain checks the approval against the nonce at execution.
      if (!signed || vault.nonce !== nonce) return 'OwnerApprovalRequired';
      if (amount === 0n) vault.payees.delete(payee);
      else vault.payees.set(payee, amount);
      vault.nonce += 1n;
    });
  }

  async nextPair(): Promise<void> {
    // The fake can redeploy, so it wraps after the last pair instead of running out.
    this.pairIndex = (this.pairIndex + 1) % this.d.pairs.length;
    this.pair = this.deployPair(this.pairIndex);
  }

  private deployPair(i: number): Pair {
    const { baselineWallet, signVault } = this.d.pairs[i];
    return {
      baseline: { address: baselineWallet, balance: STARTING_BALANCE, dailyCap: BASELINE_DAILY_CAP, spent: { day: 0n, amount: 0n } },
      vault: {
        address: signVault,
        balance: STARTING_BALANCE,
        nonce: 0n,
        payees: new Map([[getAddress(this.d.vendors[0].address), INVOICE_AMOUNT]]),
        lastPaidPeriod: new Map(),
      },
    };
  }

  /** Runs one transaction. A refusal is still a sent transaction with a hash, as on the real port (spec 7.2). */
  private send(tx: () => Refusal | void): TxResult {
    this.txCount += 1n;
    const txHash = keccak256(toHex(`fake-tx-${this.txCount}`));
    const error = tx();
    return error ? { ok: false, error, txHash } : { ok: true, txHash };
  }

  private spentToday(): bigint {
    const { spent } = this.pair.baseline;
    return spent.day === this.now() / DAY ? spent.amount : 0n;
  }

  private currentPeriod(): bigint {
    return (this.now() - this.startTime) / PERIOD_SECONDS;
  }

  private async ownerSigned(vault: Address, to: Address, amount: bigint, nonce: bigint, approval: Hex): Promise<boolean> {
    try {
      if (!acceptedByTryRecover(approval)) return false;
      const typedData = setPayeeTypedData({ chainId: this.d.chainId, vault, to, amount, nonce });
      return await verifyTypedData({ address: this.d.owner, signature: approval, ...typedData });
    } catch {
      return false;
    }
  }
}

/**
 * OpenZeppelin `ECDSA.tryRecover` takes only 65 bytes with `v` of 27 or 28 and a low `s`.
 * viem also accepts `v` of 0 or 1 and a high `s`, which the contract refuses.
 */
function acceptedByTryRecover(signature: Hex): boolean {
  if (!isHex(signature, { strict: true }) || size(signature) !== 65) return false;
  const v = hexToNumber(slice(signature, 64));
  return (v === 27 || v === 28) && hexToBigInt(slice(signature, 32, 64)) <= MAX_S;
}

/** MockUSD `transfer` (OpenZeppelin ERC20). The wallet calls it after its own checks and before its own writes. */
function transfer(from: { balance: bigint }, to: Address, amount: bigint): Refusal | void {
  if (to === zeroAddress) return 'ERC20InvalidReceiver';
  if (from.balance < amount) return 'ERC20InsufficientBalance';
  from.balance -= amount;
}

/** Throws viem's own encoder error for an address the real port could not send, and returns it checksummed. */
function abiAddress(a: Address): Address {
  encodeAbiParameters([{ type: 'address' }], [a]);
  return getAddress(a);
}

/** Throws viem's own encoder error for an amount outside uint256. */
function abiUint256(n: bigint): void {
  encodeAbiParameters([{ type: 'uint256' }], [n]);
}
