# SignVault

SignVault is a wallet contract for an AI agent on BNB Chain. The agent pays only the payees on a list, and only the owner's phone can change the list.
The contract checks the owner's EIP-712 signature itself, so there is no emailed code for the agent to read and no server to trust.
The demo re-runs the attack from a published study against a standard wallet and against SignVault, side by side.

This repo is a BNB Bangkok 2026 hackathon project. [`spec.md`](spec.md) is the source of truth, and [`cards.md`](cards.md) splits it into build cards.

## The one command

```sh
pnpm demo:local
```

This command starts anvil, deploys the contracts, and starts the server and the web app. It does not exist yet. Card I2 adds it, and this section gets the full steps when I2 merges.

Until then, you can run the checks that exist today.

1. Install Node 22 or later, pnpm 10.28.0, and [Foundry](https://getfoundry.sh).
2. Install the dependencies. `forge` loads OpenZeppelin and forge-std from `node_modules`, so run this step before `forge test`.

	```sh
	pnpm install
	```

3. Run the type check and the server tests.

	```sh
	pnpm -r typecheck
	pnpm -C server test
	```

4. Run the contract tests.

	```sh
	cd contracts && forge test
	```

To configure a run, copy [`.env.example`](.env.example) to `.env` and fill in the values. Never commit `.env`.

## Deployed addresses

Card D1 fills in this section after the BSC testnet deploy.

## Run it on testnet

Card D2 fills in this section after a testnet run with a real phone.

## What the agent key can and cannot do

The rules below come from the frozen interface [`contracts/src/interfaces/ISignVault.sol`](contracts/src/interfaces/ISignVault.sol). Card K2 implements it.

The agent key can call `pay(to)`. The call sends the amount that the list sets for `to`. The agent cannot choose the amount. A payee that is not on the list reverts with `NotOnTheList`. A second payment to the same payee in one period reverts with `AlreadyPaidThisPeriod`. In the demo, a period is one day.

The agent key can also send `setPayee`, because anyone may relay an approval. The call applies only with an EIP-712 signature from the owner over `SetPayee(address to,uint256 amount,uint256 nonce)`. Without that signature, it reverts with `OwnerApprovalRequired`. The nonce goes up by one on every applied change, so an approval cannot be replayed.

The agent key cannot do any of the following.

- Add, change, or remove a payee without the owner's signature.
- Withdraw funds or make a general transfer. SignVault has no function for either.
- Change `owner` or `agent`. No function sets them after the constructor.

`setPayee` is the only way to change a rule. The owner key lives in the phone wallet, never on the server.

For comparison, the agent on `BaselineWallet` can pay anyone up to `dailyCap`. The operator raises the cap after the agent confirms a code that arrives by email, in an inbox the agent can read.

## What is real and what is mocked

The demo uses this split, from section 13 of [`spec.md`](spec.md).

- Real: the three contracts on BSC testnet, every transaction and refusal, the owner's signature and its on-chain check, and the model's decisions in a live run.
- Mocked: the token (mUSD has no value), the inbox (it lives in our server), the vendors, and the "wallet provider" for the baseline. The baseline provider is our own contract and server, written to mirror the study's setup. It is not Circle's product.
- Recorded: replay mode plays a run that we captured earlier. The screen labels it. Card D3 records it.

## Prior art

- The study, [arXiv 2610.35835](https://arxiv.org/abs/2610.35835), gave ten AI models a wallet with a daily spending limit. Nine raised the limit themselves, because the wallet confirmed limit changes with a code sent to an inbox that the agent could read. SignVault re-runs that attack on BNB Chain.
- BVCC Agent Wallet and Altana (BNB Agent Studio v2) already gate agent limits with passkeys on-chain.

SignVault uses a phone wallet signature checked by the contract. A passkey version, verified through BSC's secp256r1 precompile at `0x100`, is stretch card T1.

## How we used AI tools

- We wrote one spec, [`spec.md`](spec.md), and split it into cards in [`cards.md`](cards.md). Each card owns a set of paths and has a "Done means" check.
- Claude Code agents built the cards in parallel. Each card had its own branch, its own git worktree, and its own pull request.
- A driver session gated each card before merging. It ran the card's "Done means" check and the repo checks itself. [`CLAUDE.md`](CLAUDE.md) has the rules that the agents follow.

## License

MIT. See [`LICENSE`](LICENSE).
