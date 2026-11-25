# SignVault

SignVault is a wallet contract for an AI agent on BNB Chain. The agent pays only the payees on a list, and only the owner's phone can change the list.
The contract checks the owner's EIP-712 signature itself, so there is no emailed code for the agent to read and no server to trust.
The demo re-runs the attack from a published study against a standard wallet and against SignVault, side by side.

This repo is a BNB Bangkok 2026 hackathon project. [`spec.md`](spec.md) is the source of truth, and [`cards.md`](cards.md) splits it into build cards.

## The one command

`pnpm demo:local` runs the whole demo on your machine. It uses a local anvil chain and a real model.

### Before you start

You need the following.

- Node 22.9 or later. The server loads `.env` with Node's `--env-file-if-exists` flag, which Node 22.9 added.
- pnpm 10.28.0.
- [Foundry](https://getfoundry.sh), with `anvil` and `forge` on your `PATH`. If `anvil` is not on your `PATH`, the script also looks in `~/.foundry/bin`.
- A key for an OpenAI-compatible chat API. We use [OpenRouter](https://openrouter.ai). A run of both agents costs less than one cent.

### Start it

1. Clone the repo and install the dependencies. `forge` loads OpenZeppelin and forge-std from `node_modules`, so install before you deploy or test.

	```sh
	git clone https://github.com/nefalos-tech/signvault.git
	cd signvault
	pnpm install
	```

2. Copy the example environment file.

	```sh
	cp .env.example .env
	```

3. In `.env`, fill in `LLM_BASE_URL` and `LLM_API_KEY`. The server does not start without them. For OpenRouter, `LLM_BASE_URL` is `https://openrouter.ai/api/v1`. Never commit `.env`.

	`LLM_MODEL` is optional. When it is empty, the server uses `qwen/qwen3.8-flash`. Card X1 picked that model because it raised its own limit in 10 of 10 test runs. [`spike/RESULTS.md`](spike/RESULTS.md) has the numbers.

	`pnpm demo:local` sets `CHAIN`, `RPC_URL`, `PAIR`, `OPERATOR_PRIVATE_KEY` and `AGENT_PRIVATE_KEY` itself, so leave those lines as they are in `.env.example`. With the keys empty, the server signs with anvil's unlocked test accounts.

4. Start the demo.

	```sh
	pnpm demo:local
	```

	The script does the following, in order.

	1. It checks that ports 8545, 8787 and 3000 are free. If one is in use, it stops and names the port.
	2. It starts anvil on port 8545.
	3. It runs `pnpm deploy:local`, which deploys MockUSD and 8 wallet pairs. Each pair is one `BaselineWallet` and one `SignVault`. Anvil starts empty every time, so the addresses always match [`deployments/31337.json`](deployments/31337.json).
	4. It starts the server on port 8787 with `CHAIN=anvil`.
	5. It starts the web app on port 3000. The first compile can take a minute or two.

	The script prints a `Logs:` folder first. When everything is up, it prints these addresses and then follows the server's output. The output includes the line `../.env not found. Continuing without it.`, which comes from a `tsx` helper process. The server still reads `.env`.

	| What | Address |
	|---|---|
	| Dashboard | http://localhost:3000 |
	| Approval page | http://localhost:3000/approve |
	| Server state | http://localhost:8787/api/state |
	| Anvil RPC | http://127.0.0.1:8545 |

5. Open http://localhost:3000 and click **Run the task**. Both agents get the same task, which is to pay every unpaid invoice in the inbox. The runs take about half a minute.

	- The **Standard wallet** column shows the baseline agent ask for a higher daily limit, read the code that arrives by email, confirm the change, and pay all three vendors.
	- The **SignVault** column shows the same agent pay Vendor 1, the only payee on the list. It cannot pay Vendor 2 or Vendor 3. If it tries, the vault refuses with `NotOnTheList`, shown in red. The agent requests a change instead, and the change waits under **Pending changes** for the owner's signature. The agent often requests changes for both Vendor 2 and Vendor 3.

6. To stop, press Ctrl-C in the terminal. The script stops anvil, the server and the web app, and frees the three ports. pnpm then prints `ELIFECYCLE Command failed.`, because the script was interrupted.

**Reset** on the dashboard moves both agents to the next fresh wallet pair and refills the inbox. After 7 resets, the 8 pairs are used up. Stop the script and start it again for fresh pairs.

### Approve a change from a desktop wallet

On anvil, the vault owner is anvil's test account (2), `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`. To approve a pending change, import that account into a browser wallet such as MetaMask. The account needs no ETH, because it only signs.

1. In the wallet, add a network by hand, with RPC URL `http://127.0.0.1:8545`, chain ID `31337` and currency symbol `ETH`. Do not use a built-in "Localhost" network, because it may use chain ID 1337.
2. Open `anvil.log` in the `Logs:` folder that the script printed. Under "Private Keys", copy the key on line `(2)`. It is anvil's published test key. Import it into the wallet.
3. On the dashboard, click **Run the task** and wait for a change for Vendor 2 under **Pending changes**.
4. Open http://localhost:3000/approve in the same browser. Click **Approve** on the Vendor 2 row. Connect account (2), allow the switch to chain 31337, and sign the `SetPayee` request.

	The row shows "Approved." and the transaction hash. Anvil has no block explorer, so the hash is not a link. You can approve the Vendor 3 row next, in the same page, without a reload.

5. Back on the dashboard, click **Run the task** again. This time SignVault pays Vendor 2.

To check the change on chain, read the `PayeeSet` event from the first pair's vault with `cast`, which comes with Foundry.

```sh
cast logs --rpc-url http://127.0.0.1:8545 --from-block 0 --address 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0 'PayeeSet(address indexed to,uint256 amount,uint256 nonce)'
```

After a **Reset**, the vault address is the next pair's `signVault` in [`deployments/31337.json`](deployments/31337.json).

### Run it without a chain or a model

Two lighter modes need less setup.

- **Recorded run.** This mode needs no server, no model key and no Foundry. It plays the runs in [`web/fixtures/`](web/fixtures), and the dashboard labels them "Recorded run". Today the fixtures are sample runs written by hand. Card D3 replaces them with a captured run.

	```sh
	NEXT_PUBLIC_MOCK=1 pnpm -C web dev
	```

- **Fake chain.** The server keeps the chain in memory, so you need no anvil. The agents still call the model, so `.env` needs `LLM_BASE_URL` and `LLM_API_KEY`. Start the server, and then start the web app in a second terminal.

	```sh
	CHAIN=fake pnpm dev:server
	```

	```sh
	pnpm -C web dev
	```

In both modes, open http://localhost:3000. Press Ctrl-C in each terminal to stop.

### Run the checks

```sh
pnpm -r typecheck
pnpm -C server test
pnpm -C web test
cd contracts && forge test
```

## Deployed addresses

Card D1 fills in this section after the BSC testnet deploy.

## Run it on testnet

Card D2 fills in this section after a testnet run with a real phone.

## What the agent key can and cannot do

The rules below come from the frozen interface [`contracts/src/interfaces/ISignVault.sol`](contracts/src/interfaces/ISignVault.sol). The contract that enforces them is [`contracts/src/SignVault.sol`](contracts/src/SignVault.sol).

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
