#!/usr/bin/env bash
# Pi SDK canary: checks the unchanged Pi Session MCP sources against another published
# Pi SDK version (default: the `latest` dist-tag) without touching the exact pin.
#
# Usage: bash scripts/pi-sdk-canary.sh [version-or-dist-tag]
#
# The candidate is installed with `--no-save`, so only node_modules changes;
# package.json and package-lock.json must stay byte-identical. Run `npm ci`
# afterwards to return to the pinned dependency tree. Provider-free: no model,
# credentials or network access beyond the npm registry.
#
# Exit status: 0 compatible, 1 incompatible (typecheck or SDK-facing tests
# failed), 2 invalid input or the pin guarantee was violated.
set -uo pipefail

package="@earendil-works/pi-coding-agent"
target="${1:-latest}"
if [[ ! "$target" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$ ]]; then
  echo "pi-sdk-canary: invalid version or dist-tag" >&2
  exit 2
fi

output() {
  echo "$1=$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi
}

manifest_before="$(sha256sum package.json package-lock.json)"
pinned="$(node -p "require('./package.json').dependencies['$package']")"
if ! npm install --no-save --no-audit --no-fund "$package@$target" > /dev/null; then
  echo "pi-sdk-canary: npm could not install the candidate version" >&2
  exit 2
fi
candidate="$(node -p "require('./node_modules/$package/package.json').version")"
output pinned "$pinned"
output candidate "$candidate"

if [[ "$(sha256sum package.json package-lock.json)" != "$manifest_before" ]]; then
  echo "pi-sdk-canary: package.json or package-lock.json changed; the pin must stay untouched" >&2
  exit 2
fi

# Every test that imports the SDK or the SDK adapter exercises the real SDK with a
# scripted model runtime. The list is derived, so new SDK-facing tests join automatically.
mapfile -t sdk_tests < <(grep -lE "@earendil-works/pi-coding-agent|sdk-pi-adapter" test/*.ts | sort)
if [[ ${#sdk_tests[@]} -eq 0 ]]; then
  echo "pi-sdk-canary: no SDK-facing tests found" >&2
  exit 2
fi

typecheck=passed
npm run --silent typecheck || typecheck=failed
tests=passed
# One retry absorbs the known load-sensitive timing tests; a real incompatibility
# fails deterministically on the retry as well.
npx vitest run --retry 1 "${sdk_tests[@]}" || tests=failed
output typecheck "$typecheck"
output tests "$tests"
output test_files "${#sdk_tests[@]}"

if [[ "$typecheck" == passed && "$tests" == passed ]]; then
  echo "pi-sdk-canary: Pi SDK $candidate is compatible (pinned $pinned)"
  exit 0
fi
echo "pi-sdk-canary: Pi SDK $candidate is NOT compatible (pinned $pinned): typecheck $typecheck, SDK-facing tests $tests" >&2
exit 1
