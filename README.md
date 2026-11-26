# SignVault

SignVault is a rule-based vault for companies on BNB Chain. An AI agent runs payroll and parks spare cash in tokenized T-bills, but it can't rewrite four rules:

1. Payroll goes only to listed payees, once per period.
2. A rule change needs the owner's EIP-712 signature from a phone.
3. A sweep into T-bills can't leave less cash than the payroll still owed this period.
4. If USDY's live CoinMarketCap price splits from its redemption value by more than 1%, the agent trips a tripwire. The tripwire moves everything back to cash and locks sweeping until the owner re-arms it.

The contract enforces rules 1 to 3 and the lock in rule 4. The 1% check is the agent's own instruction, because the contract does not read the price.
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

	The script prints a `Logs:` folder first. When everything is up, it prints these addresses and then follows the server's output. The output includes the line `../.env not found. Continuing without it.` The line is harmless. The server still reads `.env`.

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

### Two lighter ways to run it

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

The contracts are on BSC testnet (chain 97). `contracts/script/Deploy.s.sol` deployed them, and [`deployments/97.json`](deployments/97.json) has the full list.

| Role | Address |
|---|---|
| MockUSD (mUSD) | [`0x7B6562e1E8cde2AF559e9f33C92c812e149cA7A8`](https://testnet.bscscan.com/address/0x7B6562e1E8cde2AF559e9f33C92c812e149cA7A8) |
| Operator | [`0x144B7220eBB6b2E22C330b453A434A1728b13912`](https://testnet.bscscan.com/address/0x144B7220eBB6b2E22C330b453A434A1728b13912) |
| Agent | [`0x681854A983AD381706aa7304951b175270640043`](https://testnet.bscscan.com/address/0x681854A983AD381706aa7304951b175270640043) |
| Owner (the phone wallet) | [`0xCFccC57E3Ec82227CAeb906eD74D0999281E024E`](https://testnet.bscscan.com/address/0xCFccC57E3Ec82227CAeb906eD74D0999281E024E) |

| Pair | BaselineWallet | SignVault |
|---|---|---|
| 0 (a fresh server run uses this first) | [`0x07f80832c32D320ca0E31F4E02132Fc23170384B`](https://testnet.bscscan.com/address/0x07f80832c32D320ca0E31F4E02132Fc23170384B) | [`0x3c80cBBae3f394c960F1333750D8565d35FE91D1`](https://testnet.bscscan.com/address/0x3c80cBBae3f394c960F1333750D8565d35FE91D1) |
| 1 | [`0x5cb5624da787b0D746a00673720130Ac5196D620`](https://testnet.bscscan.com/address/0x5cb5624da787b0D746a00673720130Ac5196D620) | [`0xf05Ad19CfbC8D75874A20B4b13B0F4e43b518870`](https://testnet.bscscan.com/address/0xf05Ad19CfbC8D75874A20B4b13B0F4e43b518870) |
| 2 | [`0x7D2b5Cd9BE8aC7baA08105821a077C6e53f56aEB`](https://testnet.bscscan.com/address/0x7D2b5Cd9BE8aC7baA08105821a077C6e53f56aEB) | [`0xeF50B2059B372aE0022B1D967C6e5383647ACaCE`](https://testnet.bscscan.com/address/0xeF50B2059B372aE0022B1D967C6e5383647ACaCE) |
| 3 | [`0xEbe601902232647294D8ef3781957578139752a2`](https://testnet.bscscan.com/address/0xEbe601902232647294D8ef3781957578139752a2) | [`0x23C63e0101263D8718E0f75930C105CE213db210`](https://testnet.bscscan.com/address/0x23C63e0101263D8718E0f75930C105CE213db210) |
| 4 | [`0x7744da5ba00d9ee133C804C0ecA61D39C7A2d50e`](https://testnet.bscscan.com/address/0x7744da5ba00d9ee133C804C0ecA61D39C7A2d50e) | [`0xbF5A50E565433caB8852d645A64aA57367bb56Ed`](https://testnet.bscscan.com/address/0xbF5A50E565433caB8852d645A64aA57367bb56Ed) |
| 5 | [`0x3e69E5f998A8f1188385E97E443378cd649148AF`](https://testnet.bscscan.com/address/0x3e69E5f998A8f1188385E97E443378cd649148AF) | [`0xFC65C1639490F16A22b42675f243a92d2150E7B5`](https://testnet.bscscan.com/address/0xFC65C1639490F16A22b42675f243a92d2150E7B5) |
| 6 | [`0x0676Bac1f99edF54A5d06061fa376F08bfe882Ff`](https://testnet.bscscan.com/address/0x0676Bac1f99edF54A5d06061fa376F08bfe882Ff) | [`0xeF68900dBEcfD099815b411373e3ebce9f68cE52`](https://testnet.bscscan.com/address/0xeF68900dBEcfD099815b411373e3ebce9f68cE52) |
| 7 | [`0x825e75354B7caBe3cC0e524Bb63ACffa093F6F45`](https://testnet.bscscan.com/address/0x825e75354B7caBe3cC0e524Bb63ACffa093F6F45) | [`0x3d1De63954180370700dD8C5461266b8cba9077A`](https://testnet.bscscan.com/address/0x3d1De63954180370700dD8C5461266b8cba9077A) |

Each wallet starts with 10 mUSD. Each BaselineWallet has a daily cap of 0.01 mUSD, and each SignVault lists Vendor 1 at 0.01 mUSD per day.

## Run it on testnet

This runs the demo on the BSC testnet contracts above, and a real phone approves the change. Card D2 ran it on 26 November 2026. Its transactions are listed at the end of this section.

### What you need

- The operator and agent keys that `Deploy.s.sol` used. The contracts store those two addresses, so any other key is refused. Each key needs a little tBNB for gas. About 0.003 tBNB lasts many runs.
- The model key from "Before you start".
- A phone with the MetaMask app and the owner wallet in it.
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), which gives the phone an HTTPS address. On a Mac, run `brew install cloudflared`.

### Run it

1. Put `OPERATOR_PRIVATE_KEY`, `AGENT_PRIVATE_KEY` and `LLM_API_KEY` in `.env` at the repo root.
2. Start the server on a pair that hasn't been run yet. A run moves the baseline's money and changes SignVault's list, and neither can be undone, so each pair runs the demo once. A pair is unused while both of its wallets still hold 10 mUSD. Change `PAIR` to match.

	```sh
	CHAIN=bsctest RPC_URL=https://bsc-testnet-rpc.publicnode.com PAIR=5 pnpm dev:server
	```

3. Build and start the web app. We used the production build, which serves the phone through the tunnel with no extra settings.

	```sh
	NEXT_PUBLIC_MOCK=0 pnpm -C web build && pnpm -C web start
	```

4. Give the phone an address. This prints an `https://….trycloudflare.com` address.

	```sh
	cloudflared tunnel --url http://localhost:3000
	```

5. Open http://localhost:3000 and press **Run the task**. Wait until both columns finish.
6. On the phone, open the MetaMask app, go to its **Browser** tab and open `<that address>/approve`.
	- Select the owner account, and make sure the site is on **BNB Smart Chain Testnet**.
	- Tap **Approve** on "Add Vendor 2 at 0.01 mUSD per day".
	- Under **Message**, check `to` (Vendor 2's address), `amount` (`10000000000000000`) and `nonce`, then sign.
7. When the dashboard shows `PayeeSet`, press **Run again on SignVault**. It pays Vendor 2.

### If the phone gets stuck

- **"Invalid parameters were provided to the RPC method."** MetaMask picks the network per site. Disconnect the site in MetaMask, reload the page, and connect again with the owner account on BNB Smart Chain Testnet.
- **"High-risk request."** MetaMask flags typed-data signatures for contracts it doesn't know, coming from a trycloudflare.com address. This signature can only add that one payee to that one vault. Check the Message fields, then continue.
- **The approval failed.** Tap **Approve** again on the same change.
- **The pair is already used.** Restart the server with another `PAIR`. The dashboard's **Reset** moves the server to the next pair without touching the chain, and it stops after pair 7.

### One full run on testnet

This is D2's run on pair 3, with the same model and the same task on both wallets:

- BaselineWallet: [`0xEbe601902232647294D8ef3781957578139752a2`](https://testnet.bscscan.com/address/0xEbe601902232647294D8ef3781957578139752a2)
- SignVault: [`0x23C63e0101263D8718E0f75930C105CE213db210`](https://testnet.bscscan.com/address/0x23C63e0101263D8718E0f75930C105CE213db210)

| Step | Transaction |
|---|---|
| The baseline agent confirms the code the wallet emailed it and raises its own daily limit from 0.01 to 0.03 mUSD | [`0x0a764c48…38b6`](https://testnet.bscscan.com/tx/0x0a764c480aa7717eea7f200e255fb9ab08ad145d9ab92eb4a4eea11fe06638b6) |
| The baseline pays Vendor 1 | [`0xe40b0231…233a`](https://testnet.bscscan.com/tx/0xe40b02314ee14ce6f41e69ba6d177d6f34e5da8672ea2d986c844f2ce692233a) |
| The baseline pays Vendor 2 | [`0x818213f9…f38c`](https://testnet.bscscan.com/tx/0x818213f96e644f54ce2ac152152ca0fd9e57e30b40a232aa5c839c6e5c9ef38c) |
| The baseline pays Vendor 3 | [`0xc2deacab…428c`](https://testnet.bscscan.com/tx/0xc2deacab5ca461884e3655db09de1c40798986724e97d024be1eeec34b48428c) |
| SignVault pays Vendor 1, its only listed payee. The agent asks the owner to add Vendors 2 and 3 | [`0xe930f8c6…b1f1`](https://testnet.bscscan.com/tx/0xe930f8c6dc02218a31a34d7ffbc16db60950e2fa8d9aab97971d0fcd8559b1f1) |
| The owner approves "Add Vendor 2 at 0.01 mUSD per day" on the phone, and the vault emits `PayeeSet` | [`0xc5266ec9…a493`](https://testnet.bscscan.com/tx/0xc5266ec91b2ff254c1ddbf6cb7815f548139023c1ca408bd3b54ecc28f8fa493) |
| SignVault's second run pays Vendor 2 | [`0x52d0e06d…e64f`](https://testnet.bscscan.com/tx/0x52d0e06ddddbacd4a638f6b4c95e16d8ebca8495864895797c801d78d0a3e64f) |

At the end of the run:
- The baseline holds 9.97 mUSD, with a 0.03 mUSD daily limit.
- SignVault holds 9.98 mUSD, its nonce is 1, and it lists Vendor 1 and Vendor 2.
- Nobody approved Vendor 3's change, so Vendor 3 was not paid.

## The treasury and CoinMarketCap

The treasury vault is SignVault with a T-bill sleeve and a tripwire. The agent keeps this period's payroll in cash and moves the rest into T-bills. It checks USDY's live price on CoinMarketCap before every sweep.

### What it does

- [`contracts/src/TBillSignVault.sol`](contracts/src/TBillSignVault.sol) adds the sleeve. The agent calls `sweep(assets)` to move cash into mUSDY and `redeem(shares)` to move it back. Both name the vault as receiver and owner, so the money only moves between the vault's cash and its own T-bills. `owedThisPeriod()` is what listed payees are still owed this period. A sweep that would leave less cash than that reverts with `SweepDipsIntoPayroll`.
- [`contracts/src/TripwireVault.sol`](contracts/src/TripwireVault.sol) adds the tripwire. The agent calls `trip()`, which redeems every T-bill share back to cash and sets `tripped`. While `tripped` is true, `sweep` reverts with `SweepLocked`. Only `rearm(approval)` clears it, and only with the owner's EIP-712 signature over `Rearm(uint256 nonce)`. It spends the same nonce as `setPayee`, so each owner approval is used once.
- [`contracts/src/MockUSDY.sol`](contracts/src/MockUSDY.sol) is the T-bill, an ERC-4626 vault over mUSD. Its redemption value is `convertToAssets(1e18)`, the mUSD that one mUSDY redeems for.
- The payee list, `pay` and `setPayee` are unchanged from [`contracts/src/interfaces/ISignVault.sol`](contracts/src/interfaces/ISignVault.sol).

The agent's tripwire rule is in [`server/src/agent/treasury.ts`](server/src/agent/treasury.ts). Before a sweep, the agent calls `check_usdy_price`. If the price and the redemption value are more than 1% apart (`TRIP_PERCENT`), it calls `trip` and does not sweep. The contract does not read the price. It enforces what comes after the trip.

### The CoinMarketCap call

[`server/src/price/cmc.ts`](server/src/price/cmc.ts) makes this call:

```
GET https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=29256
X-CMC_PRO_API_KEY: <CMC_API_KEY>
```

- 29256 is USDY (Ondo US Dollar Yield). The code asks by id, because the symbol USDY also matches an inactive token.
- `livePriceFeed` in [`server/src/main.ts`](server/src/main.ts) wires the call into the server. The server keeps each answer for 60 seconds.
- Why this feed: the agent compares USDY's market price with the redemption value of the T-bills it holds. When the two split, the market no longer values the token at what it redeems for, so the agent moves the money back to cash instead of sweeping more in.
- The key stays on the server. It goes only in the request header. It is never logged, never put in an event, and never sent to the web.
- Without `CMC_API_KEY`, the server prints a warning and falls back to CoinMarketCap's keyless public API, `/public-api/v3/cryptocurrency/quotes/latest?id=29256`. That is not the Pro API, and the call is not tied to a key.

### Set it up

1. Follow "Before you start" above.
2. Add a `CMC_API_KEY=` line to `.env`, with your CoinMarketCap API key after the `=`. The line is not in `.env.example`. The server asks CoinMarketCap at most once a minute.

### Run it on your machine

The fake chain needs no anvil and no chain keys. It still makes the real CoinMarketCap call. Start the server, and then start the web app in a second terminal.

```sh
CHAIN=fake DEPLOYMENT=fake-treasury pnpm dev:server
```

```sh
pnpm -C web dev
```

The **Treasury** card shows only when the vault has a T-bill sleeve, so `DEPLOYMENT=fake-treasury` is required.

1. Open http://localhost:3000 and click **Run the treasury task**. The agent checks the treasury, checks USDY's price, and then sweeps or trips.
2. The fake vault's redemption value is 1 mUSD, and USDY trades above 1 USD, so on the fake chain the split is more than 1% and the agent trips the wire on the live price. For a sweep, run it on testnet.

### Run it on BSC testnet

You need the operator and agent keys from "Run it on testnet", the model key, `CMC_API_KEY`, and the phone wallet to re-arm.

1. Start the server on an unused treasury pair. Pairs 0 to 2 are used, and the demo video ran pair 2, so start at 3. A pair is unused while both of its wallets still hold 10 mUSD.

	```sh
	CHAIN=bsctest RPC_URL=https://bsc-testnet-rpc.publicnode.com DEPLOYMENT=97-treasury PAIR=3 pnpm dev:server
	```

2. Build and start the web app, and open the tunnel, as in steps 3 and 4 of "Run it on testnet".
3. Open http://localhost:3000 and click **Run the treasury task**. While USDY's live price is within 1% of the redemption value, the agent sweeps the spare cash into T-bills and keeps the payroll still owed in cash. The testnet MockUSDY's redemption value is 1.1541 mUSD, set at deploy from USDY's value then. If USDY has moved more than 1% since, the agent trips on the live price instead.
4. Switch on **Simulate a price shock** and click **Run the treasury task** again. The agent sees a price 10% under the live price, labelled "simulated price shock", and trips the wire. Every T-bill goes back to cash, and sweeping is locked.
5. To re-arm, open `<that address>/rearm` in the MetaMask app's **Browser** tab on the phone. Tap **Re-arm** and sign the `Rearm` request with the owner account.

### The treasury deployment

`contracts/script/DeployTreasury.s.sol` deployed MockUSDY over the same MockUSD, and 8 pairs of one `BaselineWallet` and one `TripwireVault`. [`deployments/97-treasury.json`](deployments/97-treasury.json) has the full list. The operator, agent, owner and vendors are the same as in "Deployed addresses".

| Role | Address |
|---|---|
| MockUSDY (mUSDY) | [`0x778c4A14155Ce8c46cAB4Bcf074d37555822b411`](https://testnet.bscscan.com/address/0x778c4A14155Ce8c46cAB4Bcf074d37555822b411) |

| Pair | BaselineWallet | TripwireVault |
|---|---|---|
| 0 | [`0xfE563d2A62B9999B4a1E9c8B0335BA7382a9B5b8`](https://testnet.bscscan.com/address/0xfE563d2A62B9999B4a1E9c8B0335BA7382a9B5b8) | [`0x2F14D17076BD2A087E02BbCd5B057c9deb8c4F4A`](https://testnet.bscscan.com/address/0x2F14D17076BD2A087E02BbCd5B057c9deb8c4F4A) |
| 1 | [`0x84C415a5914A30850F09DDE78eA92a9880571C1d`](https://testnet.bscscan.com/address/0x84C415a5914A30850F09DDE78eA92a9880571C1d) | [`0xaC9dc71F2bC81f2b9B63122bEB925166762FA09F`](https://testnet.bscscan.com/address/0xaC9dc71F2bC81f2b9B63122bEB925166762FA09F) |
| 2 (the demo video ran this pair) | [`0x62937d619Fb3f0aeD484C1c0CA69B27EB07eD1BD`](https://testnet.bscscan.com/address/0x62937d619Fb3f0aeD484C1c0CA69B27EB07eD1BD) | [`0xBf6ABCCa41C45AF3c96F89a7f1c1e932cd5fD78C`](https://testnet.bscscan.com/address/0xBf6ABCCa41C45AF3c96F89a7f1c1e932cd5fD78C) |
| 3 | [`0x42C618206442Dd81A73AE754f62bFE1a6aCdFe06`](https://testnet.bscscan.com/address/0x42C618206442Dd81A73AE754f62bFE1a6aCdFe06) | [`0xA78B53bc429801002a20d6c6191629d913EE1175`](https://testnet.bscscan.com/address/0xA78B53bc429801002a20d6c6191629d913EE1175) |
| 4 | [`0xe91a8E57b2aC0b86C7583EB40488F9f5d4328573`](https://testnet.bscscan.com/address/0xe91a8E57b2aC0b86C7583EB40488F9f5d4328573) | [`0x815D1C42b83f395883B5ef995661867d046a41C6`](https://testnet.bscscan.com/address/0x815D1C42b83f395883B5ef995661867d046a41C6) |
| 5 | [`0xE53737fc1Ce929540F1287553FA591e8C2C432c5`](https://testnet.bscscan.com/address/0xE53737fc1Ce929540F1287553FA591e8C2C432c5) | [`0xD8B95fa364cF2AbCCBFe167390B94000D6596413`](https://testnet.bscscan.com/address/0xD8B95fa364cF2AbCCBFe167390B94000D6596413) |
| 6 | [`0x6c30Ae7ACE0FE1326a8e27Dc867fAdc2329EfDe1`](https://testnet.bscscan.com/address/0x6c30Ae7ACE0FE1326a8e27Dc867fAdc2329EfDe1) | [`0x5Ca41649d7E29665A8B1C10187E37439B88c8Fb8`](https://testnet.bscscan.com/address/0x5Ca41649d7E29665A8B1C10187E37439B88c8Fb8) |
| 7 | [`0x9eA379474F83FEfA7BB5A1f0DfDA8d256Dc871c0`](https://testnet.bscscan.com/address/0x9eA379474F83FEfA7BB5A1f0DfDA8d256Dc871c0) | [`0x6C4044DCa3592EE4E88A83FA8BDabC3E8DdC0F75`](https://testnet.bscscan.com/address/0x6C4044DCa3592EE4E88A83FA8BDabC3E8DdC0F75) |

Each wallet starts with 10 mUSD. Each BaselineWallet has a daily cap of 0.01 mUSD, and each TripwireVault lists Vendor 1 at 0.01 mUSD per day.

### The demo video's run, on treasury pair 2

| Step | Transaction |
|---|---|
| The baseline agent confirms the code the wallet emailed it, and its daily limit goes up | [`0x8a1574de…806c`](https://testnet.bscscan.com/tx/0x8a1574deda7444e8cecbc48fb5ece3f221d18f73a3296f7cc978bbf2f44a806c) |
| The owner approves adding Vendor 2 on the phone, the operator relays the approval, and the vault emits `PayeeSet` | [`0x27c7c279…8c63`](https://testnet.bscscan.com/tx/0x27c7c279900740aa807393463435643273fa06dfceadae5cd2420cc5657c8c63) |
| SignVault pays Vendor 2 | [`0xb704d6b3…2f68`](https://testnet.bscscan.com/tx/0xb704d6b350a9c97149fd2443f9a1860927233a6278a64cdb57f2f441e5592f68) |
| On a live CoinMarketCap price, the agent sweeps 9.98 mUSD into T-bills | [`0x44b34ea6…ef37`](https://testnet.bscscan.com/tx/0x44b34ea6f330961d572e6942ad85d855a53a75803ea91d9cc6381f6c28acef37) |
| With the simulated price shock on, the agent trips the wire, and every T-bill goes back to cash | [`0x94a1d174…2219`](https://testnet.bscscan.com/tx/0x94a1d1740d78f07c55feabe2c8c945258b331686f020b03be7128e24953f2219) |

Nobody re-armed the vault, so the trip is still in effect. Sweeping stays locked, and the vault's nonce is 1.

### Verify the CoinMarketCap usage

1. **The run feed.** Each `check_usdy_price` line on the dashboard names its source, `CoinMarketCap Pro API, USDY id 29256`, then gives the price in USD and CoinMarketCap's `last_updated` time. Without a key, the source reads `CoinMarketCap keyless public API, USDY id 29256`. A shocked price reads `simulated price shock`. Click **View raw treasury events** for the raw lines.
2. **The API logs.** Every Pro API call carries the team's key, so it shows in that key's usage in the CoinMarketCap developer portal.
3. **On chain.** The chain does not store the price, but it shows what the agent did with it: the sweep and the trip above. The trip emits `Tripped(shares, assets)`, and the vault still reports it.

	```sh
	cast call --rpc-url https://bsc-testnet-rpc.publicnode.com 0xBf6ABCCa41C45AF3c96F89a7f1c1e932cd5fD78C 'tripped()(bool)'
	```

	It prints `true`.

## What the agent key can and cannot do

The rules below come from the frozen interface [`contracts/src/interfaces/ISignVault.sol`](contracts/src/interfaces/ISignVault.sol). The contract that enforces them is [`contracts/src/SignVault.sol`](contracts/src/SignVault.sol).

The agent key can call `pay(to)`. The call sends the amount that the list sets for `to`. The agent cannot choose the amount. A payee that is not on the list reverts with `NotOnTheList`. A second payment to the same payee in one period reverts with `AlreadyPaidThisPeriod`. In the demo, a period is one day.

The agent key can also send `setPayee`, because anyone may relay an approval. The call applies only with an EIP-712 signature from the owner over `SetPayee(address to,uint256 amount,uint256 nonce)`. Without that signature, it reverts with `OwnerApprovalRequired`. The nonce goes up by one on every applied change, so an approval cannot be replayed.

The agent key cannot do any of the following.

- Add, change, or remove a payee without the owner's signature.
- Withdraw funds or make a general transfer. SignVault has no function for either.
- Change `owner` or `agent`. No function sets them after the constructor.
- Re-arm a tripped vault without the owner's signature.
- Move T-bills or their cash anywhere but the vault itself.

On a treasury vault, [`contracts/src/TripwireVault.sol`](contracts/src/TripwireVault.sol), the agent key can also call `sweep(assets)`, `redeem(shares)` and `trip()`. Any other caller gets `OnlyAgent`. A sweep that would leave less cash than `owedThisPeriod()` reverts with `SweepDipsIntoPayroll`, and a sweep after a trip reverts with `SweepLocked`. Anyone may relay `rearm(approval)`, but it applies only with the owner's EIP-712 signature over `Rearm(uint256 nonce)`. Without that signature, it reverts with `OwnerApprovalRequired`. It spends the same nonce as `setPayee`.

`setPayee` and `rearm` are the only ways to change a rule, and both need the owner's signature. The owner key lives in the phone wallet, never on the server.

For comparison, the agent on `BaselineWallet` can pay anyone up to `dailyCap`. The operator raises the cap after the agent confirms a code that arrives by email, in an inbox the agent can read.

## What is real and what is mocked

The demo uses this split, from section 13 of [`spec.md`](spec.md).

- Real: the contracts on BSC testnet, every transaction and refusal, the owner's signature and its on-chain check, and the model's decisions in a live run. USDY's price from CoinMarketCap is real and live.
- Mocked: the token (mUSD has no value), the inbox (it lives in our server), the vendors, and the "wallet provider" for the baseline. The baseline provider is our own contract and server, written to mirror the study's setup. It is not Circle's product.
- Mocked: mUSDY, which stands in for a tokenized T-bill such as Ondo's USDY. Its yield is simulated: `accrue` mints mUSD into the pool, and the deploy script calls it once to set the redemption value. The demo earned no yield.
- Simulated: the price shock. It sets the price 10% under the live price, or 10% under the redemption value when there is no live price (`SHOCK_PERCENT` in [`server/src/price/feed.ts`](server/src/price/feed.ts)). The dashboard and the agent's feed label it simulated.
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
