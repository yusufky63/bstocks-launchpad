#!/usr/bin/env bash
# Read-only check that the B20 precompile on a live network behaves the way StockPairFactory
# relies on. Nothing is deployed and nothing is signed: each probe runs as an eth_call with
# --create, so its constructor executes against the network's state and only the return data
# comes back.
#
#   RPC=<json-rpc url> bash scripts/probe-b20.sh
#
# Passes when
#   - B20RoleProbe returns 0x...7fff: all 15 role expectations of an editable and a frozen
#     launch hold (packages/contracts/script/probes/B20RoleProbe.sol lists them bit by bit);
#   - PredictProbe returns three equal addresses: getB20Address before the create, the token
#     createB20 returned, and getB20Address after, so predictToken is exact.
# Run it on Base Sepolia and on mainnet before a deploy, and again after each network upgrade.
#
# An RPC URL usually carries an API key. This script never echoes it, never runs with xtrace,
# and replaces it with <rpc> in any error text it passes on.
set -euo pipefail
set +x

if [[ -z "${RPC:-}" ]]; then
  echo "usage: RPC=<json-rpc url> bash scripts/probe-b20.sh  (the URL is never printed)" >&2
  exit 2
fi
for tool in forge cast; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done

cd "$(dirname "$0")/../packages/contracts"

scrub() {
  local text="$1"
  printf '%s' "${text//"$RPC"/<rpc>}"
}

# Prints the constructor's return data as 0x-prefixed lowercase hex.
probe() {
  local bytecode out
  bytecode="$(forge inspect "$1" bytecode)"
  if ! out="$(cast call --rpc-url "$RPC" --gas-limit 30000000 --create "$bytecode" 2>&1)"; then
    echo "$1: eth_call failed: $(scrub "$out")" >&2
    return 1
  fi
  printf '%s' "$out" | tr 'A-F' 'a-f'
}

if ! chain="$(cast chain-id --rpc-url "$RPC" 2>&1)"; then
  echo "chain-id failed: $(scrub "$chain")" >&2
  exit 1
fi
echo "chain id: $chain"

status=0

roles="$(probe B20RoleProbe)" || exit 1
if [[ "$roles" =~ ^0x0*7fff$ ]]; then
  echo "B20RoleProbe: 0x7fff, all 15 checks pass"
else
  echo "B20RoleProbe: FAIL, got $roles (expected 0x...7fff; a clear bit is a failed check)"
  status=1
fi

predict="$(probe PredictProbe)" || exit 1
words="${predict#0x}"
if [[ ${#words} -ne 192 ]]; then
  echo "PredictProbe: FAIL, unexpected return data $predict"
  status=1
else
  before="0x${words:24:40}"
  created="0x${words:88:40}"
  after="0x${words:152:40}"
  if [[ "$before" == "$created" && "$after" == "$created" ]]; then
    echo "PredictProbe: getB20Address matches createB20 ($created)"
  else
    echo "PredictProbe: FAIL, predicted $before, created $created, predicted after $after"
    status=1
  fi
fi

exit "$status"
