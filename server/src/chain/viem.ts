import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Account,
} from 'viem';
import { anvil, bscTestnet } from 'viem/chains';
import {
  baselineWalletAbi,
  mockUsdAbi,
  signVaultAbi,
  type Address,
  type ChainPort,
  type TxResult,
} from '@signvault/shared';
import type { Deployment } from '@signvault/shared/deployments';

/** Gas for a call that simulation says will revert, so it still lands on chain with an explorer link (spec 7.2). */
const REFUSED_GAS = 200_000n;

const CHAINS = { [anvil.id]: anvil, [bscTestnet.id]: bscTestnet } as const;

// The wallets call MockUSD, so its ERC-20 errors can bubble up through them.
const tokenErrors = mockUsdAbi.filter((item) => item.type === 'error');
const baselineAbi = [...baselineWalletAbi, ...tokenErrors] as const;
const vaultAbi = [...signVaultAbi, ...tokenErrors] as const;

export interface ViemChainOptions {
  rpcUrl: string;
  deployment: Deployment;
  /** A private-key Account signs locally. A plain address is a JSON-RPC account the node signs for (anvil). */
  agent: Account | Address;
  operator: Account | Address;
  /** Index into `deployment.pairs` to start on. Defaults to 0. */
  pair?: number;
}

export function createViemChain({ rpcUrl, deployment, agent, operator, pair = 0 }: ViemChainOptions): ChainPort {
  const chain = CHAINS[deployment.chainId as keyof typeof CHAINS];
  if (chain === undefined) throw new Error(`chainId ${deployment.chainId} is not anvil (31337) or BSC testnet (97)`);
  if (deployment.pairs[pair] === undefined) throw new Error(`no wallet pair ${pair}: the deployment has ${deployment.pairs.length}`);

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl) });
  let current = pair;

  async function send(account: Account | Address, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<TxResult> {
    let error: string | undefined;
    try {
      await publicClient.simulateContract({ account, address, abi, functionName, args });
    } catch (e) {
      error = revertName(e);
    }
    const txHash = await walletClient.writeContract({
      account, address, abi, functionName, args, chain,
      ...(error === undefined ? {} : { gas: REFUSED_GAS }),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status === 'success') return { ok: true, txHash };
    return { ok: false, error: error ?? 'Reverted', txHash };
  }

  function wallets() {
    return deployment.pairs[current]!;
  }

  return {
    async readState() {
      const { baselineWallet, signVault } = wallets();
      const read = publicClient.readContract;
      const [baselineBalance, dailyCap, spentToday, vaultBalance, nonce, payees, period] = await Promise.all([
        read({ address: deployment.mockUsd, abi: mockUsdAbi, functionName: 'balanceOf', args: [baselineWallet] }),
        read({ address: baselineWallet, abi: baselineWalletAbi, functionName: 'dailyCap' }),
        read({ address: baselineWallet, abi: baselineWalletAbi, functionName: 'spentToday' }),
        read({ address: deployment.mockUsd, abi: mockUsdAbi, functionName: 'balanceOf', args: [signVault] }),
        read({ address: signVault, abi: signVaultAbi, functionName: 'nonce' }),
        read({ address: signVault, abi: signVaultAbi, functionName: 'payees' }),
        read({ address: signVault, abi: signVaultAbi, functionName: 'currentPeriod' }),
      ]);
      const paid = await Promise.all(
        payees.map((p) => read({ address: signVault, abi: signVaultAbi, functionName: 'paidInPeriod', args: [p.to, period] })),
      );
      return {
        chainId: deployment.chainId,
        explorerUrl: deployment.explorerUrl,
        addresses: { mockUsd: deployment.mockUsd, baselineWallet, signVault, owner: deployment.owner, agent: deployment.agent },
        vendors: deployment.vendors,
        baseline: { balance: baselineBalance.toString(), dailyCap: dailyCap.toString(), spentToday: spentToday.toString() },
        signvault: {
          balance: vaultBalance.toString(),
          nonce: nonce.toString(),
          payees: payees.map((p, i) => ({ to: p.to, amount: p.amount.toString(), paidThisPeriod: paid[i]! })),
        },
      };
    },

    baselinePay: (to, amount) => send(agent, wallets().baselineWallet, baselineAbi, 'pay', [to, amount]),
    baselineSetDailyCap: (newCap) => send(operator, wallets().baselineWallet, baselineAbi, 'setDailyCap', [newCap]),
    vaultPay: (to) => send(agent, wallets().signVault, vaultAbi, 'pay', [to]),
    vaultSetPayee: (to, amount, approval, as) =>
      send(as === 'agent' ? agent : operator, wallets().signVault, vaultAbi, 'setPayee', [to, amount, approval]),

    async nextPair() {
      if (current + 1 >= deployment.pairs.length) {
        throw new Error(`all ${deployment.pairs.length} wallet pairs are used: deploy again for fresh ones`);
      }
      current += 1;
    },
  };
}

/** The Solidity error name from a failed simulation. Anything that is not a revert (RPC down, bad input) is rethrown. */
function revertName(e: unknown): string {
  const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
  if (!(revert instanceof ContractFunctionRevertedError)) throw e;
  return revert.data?.errorName ?? revert.reason ?? revert.signature ?? 'Reverted';
}
