#!/usr/bin/env bash
# pnpm demo:local: the whole demo on anvil (spec 11).
# Starts anvil on 8545, deploys with `pnpm deploy:local`, then the server (CHAIN=anvil) on 8787 and
# the web app on 3000. Ctrl-C stops everything it started. Anvil keeps no state, so every start
# deploys to the same addresses as deployments/31337.json.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v anvil >/dev/null || PATH="$HOME/.foundry/bin:$PATH"
for tool in anvil forge curl; do
  command -v "$tool" >/dev/null || { echo "demo:local needs $tool on PATH." >&2; exit 1; }
done

PORTS="8545 8787 3000"
LOGS="$(mktemp -d "${TMPDIR:-/tmp}/signvault-demo.XXXXXX")"
PIDS=""

listening() {
  if command -v lsof >/dev/null; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}

for port in $PORTS; do
  if listening "$port"; then
    echo "Port $port is in use. Stop whatever holds it (lsof -iTCP:$port -sTCP:LISTEN) and run again." >&2
    exit 1
  fi
done

# The process and every descendant, children first, so pnpm and next leave no node behind.
tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do tree "$child"; done
  echo "$1"
}

STOPPED=0
cleanup() {
  [ "$STOPPED" = 1 ] && return
  STOPPED=1
  # pnpm may send TERM or close our output while we clean up. Neither may cut the cleanup short.
  trap '' INT TERM PIPE
  trap - EXIT
  set +e
  echo
  echo "Stopping anvil, the server and the web app..."
  local all="" pid
  for pid in $PIDS; do all="$all $(tree "$pid")"; done
  [ -n "${all// }" ] && kill $all 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    alive=""
    for pid in $all; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
    [ -z "$alive" ] && break
    sleep 0.5
  done
  [ -n "${alive:-}" ] && kill -9 $alive 2>/dev/null || true
  # The ports were free at start, so anything still listening on them is ours.
  if command -v lsof >/dev/null; then
    for port in $PORTS; do
      lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
    done
  fi
  echo "Stopped. Logs are in $LOGS"
}
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap cleanup EXIT

# start NAME CMD...: runs CMD in the background with its output in $LOGS/NAME.log.
start() {
  local name="$1"; shift
  "$@" >"$LOGS/$name.log" 2>&1 &
  PIDS="$PIDS $!"
  LAST_PID=$!
}

# wait_for NAME PID SECONDS CHECK...: polls CHECK until it passes, failing early if PID dies.
wait_for() {
  local name="$1" pid="$2" limit="$3"; shift 3
  local waited=0
  until "$@" >/dev/null 2>&1; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name exited before it was ready. The end of $LOGS/$name.log:" >&2
      tail -n 30 "$LOGS/$name.log" >&2
      exit 1
    fi
    if [ "$waited" -ge "$limit" ]; then
      echo "$name was not ready after ${limit}s. The end of $LOGS/$name.log:" >&2
      tail -n 30 "$LOGS/$name.log" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

rpc_up() {
  curl -fsS -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545
}

if [ ! -f .env ]; then
  echo "No .env here. The server needs LLM_BASE_URL, LLM_API_KEY and LLM_MODEL (spec 10)." >&2
fi

echo "Logs: $LOGS"
echo "Starting anvil on 8545..."
start anvil anvil --port 8545
ANVIL_PID=$LAST_PID
wait_for anvil "$ANVIL_PID" 30 rpc_up

echo "Deploying MockUSD and 8 wallet pairs..."
pnpm deploy:local >"$LOGS/deploy.log" 2>&1 || {
  echo "pnpm deploy:local failed. The end of $LOGS/deploy.log:" >&2
  tail -n 30 "$LOGS/deploy.log" >&2
  exit 1
}

echo "Starting the server on 8787 (CHAIN=anvil)..."
# Set here, these win over .env. Empty keys make the server sign with anvil's unlocked accounts.
start server env CHAIN=anvil RPC_URL=http://127.0.0.1:8545 PAIR=0 OPERATOR_PRIVATE_KEY= AGENT_PRIVATE_KEY= \
  pnpm dev:server
SERVER_PID=$LAST_PID
wait_for server "$SERVER_PID" 60 curl -fsS http://localhost:8787/api/state

echo "Starting the web app on 3000 (the first compile takes a while)..."
start web env NEXT_PUBLIC_MOCK=0 API_URL=http://localhost:8787 pnpm -C web dev
WEB_PID=$LAST_PID
wait_for web "$WEB_PID" 180 curl -fsS http://localhost:3000/

cat <<EOF

SignVault is running on anvil (chain 31337).
  Dashboard  http://localhost:3000
  Approve    http://localhost:3000/approve
  API        http://localhost:8787/api/state
  RPC        http://127.0.0.1:8545
To approve from a desktop wallet, import anvil account (2), the vault owner
0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC, and add a network with RPC
http://127.0.0.1:8545 and chain ID 31337.
Server output follows. Press Ctrl-C to stop everything.

EOF

tail -n +1 -f "$LOGS/server.log" &
PIDS="$PIDS $!"

while kill -0 "$ANVIL_PID" 2>/dev/null && kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 1
done
echo "A process stopped on its own. Its log is in $LOGS." >&2
exit 1
