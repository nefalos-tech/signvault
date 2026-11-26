import { encodeAbiParameters, getAddress, hexToBigInt, hexToNumber, isHex, keccak256, size, slice, toHex, verifyTypedData, zeroAddress } from 'viem';
import {
  BASELINE_DAILY_CAP, INVOICE_AMOUNT, labelAddress, PERIOD_SECONDS, rearmTypedData, setPayeeTypedData, STARTING_BALANCE,
  type Address, type AppState, type ChainPort, type Hex, type TxResult,
} from '@signvault/shared';
import { loadDeployment } from '@signvault/shared/deployments';

const DAY = 86_400n;
const ONE_SHARE = 10n ** 18n;
/** deployments/fake.json has no treasury, so the fake's MockUSDY gets an address of its own. */
export const FAKE_MOCK_USDY = labelAddress('signvault.fake.mockUsdy');
/** OpenZeppelin ECDSA refuses an `s` above half the secp256k1 order. */
const MAX_S = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** The Solidity custom error a refused call reverts with: spec 6.2, 6.3, and OpenZeppelin ERC20 for MockUSD. */
type Refusal =
  | 'DailyCapExceeded' | 'NotOnTheList' | 'AlreadyPaidThisPeriod' | 'OwnerApprovalRequired'
  | 'ERC20InsufficientBalance' | 'ERC20InvalidReceiver'
  | 'SweepDipsIntoPayroll' | 'SweepLocked' | 'ERC4626ExceededMaxRedeem';

/** Cards T2 and T3: the vault's MockUSDY shares, the pool behind them (OpenZeppelin ERC4626), and TripwireVault's flag. */
interface Treasury { shares: bigint; pool: { assets: bigint; supply: bigint }; tripped: boolean }

/** One BaselineWallet and SignVault pair, holding what the contracts store. */
interface Pair {
  baseline: { address: Address; balance: bigint; dailyCap: bigint; spent: { day: bigint; amount: bigint } };
  vault: { address: Address; balance: bigint; nonce: bigint; payees: Map<Address, bigint>; lastPaidPeriod: Map<Address, bigint> };
  treasury?: Treasury;
}

export interface FakeChainOptions {
  /** `block.timestamp` in unix seconds. Defaults to the wall clock. */
  now?: () => bigint;
  /** Each vault is a TripwireVault over a MockUSDY (cards T2 and T3), as a treasury deployment has. */
  treasury?: boolean;
}

/** An in-memory ChainPort over `deployments/fake.json` that refuses exactly what the contracts refuse. */
export class FakeChain implements ChainPort {
  private readonly d = loadDeployment('fake');
  private readonly now: () => bigint;
  private readonly startTime: bigint;
  private readonly treasury: boolean;
  private pairIndex = 0;
  private pair: Pair;
  private txCount = 0n;

  constructor({ now = () => BigInt(Math.floor(Date.now() / 1000)), treasury = false }: FakeChainOptions = {}) {
    this.now = now;
    this.treasury = treasury;
    this.startTime = now(); // Deploy.s.sol deploys every pair at once.
    this.pair = this.deployPair(0);
  }

  async readState(): Promise<Pick<AppState, 'chainId' | 'explorerUrl' | 'addresses' | 'vendors' | 'baseline' | 'signvault'>> {
    const { baseline, vault, treasury } = this.pair;
    const period = this.currentPeriod();
    const addresses = { mockUsd: this.d.mockUsd, baselineWallet: baseline.address, signVault: vault.address, owner: this.d.owner, agent: this.d.agent };
    const signvault = {
      balance: String(vault.balance),
      nonce: String(vault.nonce),
      payees: [...vault.payees].map(([to, amount]) => ({ to, amount: String(amount), paidThisPeriod: vault.lastPaidPeriod.get(to) === period })),
    };
    return {
      chainId: this.d.chainId,
      explorerUrl: this.d.explorerUrl,
      addresses: treasury ? { ...addresses, mockUsdy: FAKE_MOCK_USDY } : addresses,
      vendors: this.d.vendors,
      baseline: { balance: String(baseline.balance), dailyCap: String(baseline.dailyCap), spentToday: String(this.spentToday()) },
      signvault: treasury
        ? {
          ...signvault,
          tbillShares: String(treasury.shares),
          tbillValue: String(toAssets(treasury.pool, treasury.shares)),
          owedThisPeriod: String(this.owedThisPeriod()),
          // The chain knows no market price: the server's price feed fills usdyPrice and simulated.
          tripwire: { tripped: treasury.tripped, usdyPrice: null, redemptionValue: String(toAssets(treasury.pool, ONE_SHARE)), simulated: false },
        }
        : signvault,
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
      if (amount === 0n) vault.payees = removeSwapAndPop(vault.payees, payee);
      else vault.payees.set(payee, amount);
      vault.nonce += 1n;
    });
  }

  /** TBillSignVault.sweep, with TripwireVault's lock: never below what listed payees are still owed this period. */
  async vaultSweep(assets: bigint): Promise<TxResult> {
    abiUint256(assets);
    return this.withTreasury((t) => this.send(() => {
      if (t.tripped) return 'SweepLocked';
      const vault = this.pair.vault;
      if (assets > vault.balance || vault.balance - assets < this.owedThisPeriod()) return 'SweepDipsIntoPayroll';
      const shares = mulDiv(assets, t.pool.supply + 1n, t.pool.assets + 1n);
      vault.balance -= assets;
      t.pool.assets += assets;
      t.pool.supply += shares;
      t.shares += shares;
    }));
  }

  async vaultRedeem(shares: bigint): Promise<TxResult> {
    abiUint256(shares);
    return this.withTreasury((t) => this.send(() => {
      if (shares > t.shares) return 'ERC4626ExceededMaxRedeem';
      redeem(this.pair.vault, t, shares);
    }));
  }

  /** TripwireVault.trip: every share back to cash, and sweeping locked until the owner re-arms. */
  async vaultTrip(): Promise<TxResult> {
    return this.withTreasury((t) => this.send(() => {
      redeem(this.pair.vault, t, t.shares);
      t.tripped = true;
    }));
  }

  /** TripwireVault.rearm: the owner's Rearm(nonce) on the vault's domain, over the nonce SetPayee also uses. */
  async vaultRearm(approval: Hex): Promise<TxResult> {
    if (!this.pair.treasury) return NO_TREASURY;
    const vault = this.pair.vault;
    const nonce = vault.nonce;
    const signed = await this.ownerSignedRearm(vault.address, nonce, approval);
    return this.withTreasury((t) => this.send(() => {
      if (!signed || vault.nonce !== nonce) return 'OwnerApprovalRequired';
      vault.nonce += 1n;
      t.tripped = false;
    }));
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
      ...(this.treasury && { treasury: { shares: 0n, pool: { assets: 0n, supply: 0n }, tripped: false } }),
    };
  }

  private withTreasury(tx: (t: Treasury) => TxResult): TxResult {
    return this.pair.treasury ? tx(this.pair.treasury) : NO_TREASURY;
  }

  /** TBillSignVault.owedThisPeriod: the listed amounts not yet paid this period. */
  private owedThisPeriod(): bigint {
    const { payees, lastPaidPeriod } = this.pair.vault;
    const period = this.currentPeriod();
    return [...payees].reduce((sum, [to, amount]) => (lastPaidPeriod.get(to) === period ? sum : sum + amount), 0n);
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

  private async ownerSignedRearm(vault: Address, nonce: bigint, approval: Hex): Promise<boolean> {
    try {
      if (!acceptedByTryRecover(approval)) return false;
      return await verifyTypedData({ address: this.d.owner, signature: approval, ...rearmTypedData({ chainId: this.d.chainId, vault, nonce }) });
    } catch {
      return false;
    }
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

const NO_TREASURY: TxResult = { ok: false, error: 'NoTreasury' };

/** OpenZeppelin ERC4626 with no decimals offset, rounding down as `deposit`, `redeem` and `convertToAssets` do. */
function mulDiv(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y) / d;
}

function toAssets(pool: Treasury['pool'], shares: bigint): bigint {
  return mulDiv(shares, pool.assets + 1n, pool.supply + 1n);
}

function redeem(vault: { balance: bigint }, t: Treasury, shares: bigint): void {
  const assets = toAssets(t.pool, shares);
  t.shares -= shares;
  t.pool.supply -= shares;
  t.pool.assets -= assets;
  vault.balance += assets;
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

/** OpenZeppelin `EnumerableMap.remove` moves the last entry into the removed slot, and `payees()` shows that order. */
function removeSwapAndPop(payees: Map<Address, bigint>, to: Address): Map<Address, bigint> {
  const entries = [...payees];
  const i = entries.findIndex(([a]) => a === to);
  if (i === -1) return payees;
  entries[i] = entries[entries.length - 1];
  entries.pop();
  return new Map(entries);
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
