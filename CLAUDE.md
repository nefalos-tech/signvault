# SignVault: how agents work in this repo

Read `spec.md` first. It is the source of truth. The work is in `cards.md`, one card per GitHub issue (#1 to #26). The card ID is in the issue title, for example `[K2]`.

This is a security demo that we own end to end: our contracts, our server, a mock token, anvil and BSC testnet. The "attack" re-runs a published study (arXiv 2610.35835) against our own baseline wallet, so that we can show the fix beside it. Nothing here touches anyone else's system.

## Rules for every card

1. One card, one branch (`card/<ID>`, cut from `origin/main`), one worktree, one pull request.
2. Edit only the paths the card owns. `shared/` and `contracts/src/interfaces/` are frozen. If a card needs a frozen path or another card's file changed, do not change it. Open an issue titled `[FREEZE] ...` or `[BUG <ID>] ...` that says what is needed and why, then carry on with what you can. Assign a `[BUG <ID>]` issue to whoever holds card `<ID>`. Leave a `[FREEZE]` issue unassigned, because both people decide it.
3. A card is done when its "Done means" has been run and has passed. Put the command and the end of its output in the pull request. "Should pass" is not evidence.
4. Where "Done means" is a test, write the test first and watch it fail.
5. Add a dependency only when the card cannot be done without it. If `pnpm-lock.yaml` conflicts, take main's copy and run `pnpm install`. If the root `package.json` conflicts, keep both sides' script lines.
6. Keys live in `.env`, which is never committed and never printed. A worktree does not get a copy: load it from the main checkout. On testnet the owner is the phone wallet, and its private key is never in `.env`, a script or a test.
7. Two chains only: anvil (31337) and BSC testnet (97). Never mainnet.
8. Stop what you start. No dev server, anvil or watcher is left running when a card ends.
9. `spec.md` and `cards.md` are the only plans. If the spec is wrong or silent, say so in the pull request. Do not build something else quietly, and do not write a second plan file.

## Lanes

Your lane is the set of issues assigned to you on GitHub. The table is the starting split. To move a card to the other lane, a person reassigns the issue.

| | Lane A: on-chain (fetalos) | Lane B: off-chain (kyusuku) |
|---|---|---|
| Must cards, in graph order | C0 → K1, K2, W2, S5 → K3 → D1 → D2 | X1, S1, S2, S3, S4, W1, D4 → I1 → I2 → D3 |
| Should (label `should`) | H2 | H1 |
| Stretch (label `stretch`), only when a person says so | T1, T2 | T3, T4 |
| The person holds | operator and agent keys, test BNB, the phone wallet | the model key |

- C0 goes first, in lane A. Until it is closed, the only other card anyone may start is X1.
- Q1 and D5 carry the label `by-hand`. They are for people, not agents.
- S5 starts early and finishes late: write it as soon as C0 is closed, keep the pull request as a draft, and gate it after K3 is closed.
- D4 comes in two parts. Merge a README skeleton early, with empty "Deployed addresses" and "Run it on testnet" sections that D1 and D2 fill in (use `Refs #13`, not `Closes`). Finish it after I2.
- I2, D2 and D3 need both people at the keyboard. The lane that holds the card drives it.

## The loop, for the session that drives a lane

You are the driver. You do not write card code yourself, except to settle a rebase conflict. You walk the graph: find the cards that are ready, give each one to a worker, check the result yourself, merge, and look again. Use pstack for the work: `swarm` runs the ready cards as separate slices, and each worker treats its card as a `poteto-mode` task. Work from the main checkout. Nothing is committed to `main` directly.

Before the first pass, check the tools once: `gh auth status`, `pnpm -v`, `forge --version`, `anvil --version`. If one is missing, stop with `NEEDS HUMAN:`.

1. **Read the state. Never work from memory.** Run `git fetch origin`, `gh issue list --state all --limit 100 --json number,title,state,assignees,labels` and `gh pr list --json number,title,headRefName,isDraft`. A card is closed when its issue is closed. A card is ready when it is open, assigned to you, not labelled `by-hand`, and every card on its "Blocked by" line is closed.
2. **Finish before you start.** If your lane has an open pull request, gate it (step 5) before you start new cards.
3. **Start every ready card at once,** one worker and one worktree per card. Give the worker the card text, tell it to read this file and the spec sections the card cites, and ask for this report: the pull request link, the "Done means" command and its output, the files it changed, and anything it had to assume.
4. **Inside a card,** the worker builds, runs "Done means", fixes, and runs it again. After three failed fixes for the same failure, or twice the card's time estimate, it stops and reports what it tried.
5. **Gate. You run it, not the worker.** On the card's branch, rebased on `origin/main`:
   - `git diff --name-only origin/main...HEAD` shows only paths the card owns.
   - The card's "Done means" passes when you run it.
   - The repo checks that exist so far pass: `pnpm -r typecheck`, `pnpm -C server test`, `cd contracts && forge test`.
   - For K2 only: a fresh reviewer, which sees the diff and not the worker's reasoning, tries to refute the contract. In a scratch test file that is not committed, it tries to send mUSD to an address that is not on the list, pay a payee twice in one period, change the list without the owner's signature, replay an approval, and use an approval made for another vault. One success fails the gate.

   Send a failed gate back to the same worker with the failing output. After two failed gates on one card, it needs a person (step 7).
6. **Merge.** Put `Closes #<issue>` in the pull request, run `gh pr merge <n> --squash`, then remove the worktree and the branch. Go back to step 1, because a merge can make new cards ready.
7. **When a card needs a person,** do everything up to that point, comment on the issue with the exact steps that are left, add the label `needs-human`, and carry on with other ready cards. Take the label off when the card moves again. Only a person can: fund a key with test BNB, do anything on a phone, click a wallet in a browser, supply an API key, record the screen, or decide what a `[FREEZE]` issue or a bad X1 result means.
8. **When you are waiting on the other lane** and nothing else is ready, wait 10 minutes and read the state again. After 12 waits in a row, stop.
9. **Stop** when nothing in your lane is ready or running. Begin your last message with `DONE:`, `NEEDS HUMAN:` or `WAITING:`. Paste the issue list, say what is closed and what is stuck, and say who has to do what. Running the same goal again later picks up from the state on GitHub.

If the repo checks fail on `origin/main` itself, that comes before any new card. Find the merge that broke it. Fix it in a small pull request if the file belongs to your lane. If it belongs to the other lane, open a `[BUG <ID>]` issue and say so in your next message.

Order: must cards before should cards. A should card may start only when every must card in your lane is closed or waiting on something you cannot do. After 10:30 on Thursday 26 November, Bangkok time, start nothing new: do only the work that makes the five checks in spec section 2 pass. Read the clock with `TZ=Asia/Bangkok date`.
