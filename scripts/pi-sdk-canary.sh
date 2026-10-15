#!/usr/bin/env bash
# Pi SDK canary: checks the unchanged Pi Session MCP sources against another published
# Pi SDK version (default: the `latest` dist-tag) without touching the exact pins.
#
# Usage: bash scripts/pi-sdk-canary.sh [version-or-dist-tag]
#
# The SDK and its five sibling packages (pi-ai, pi-mcp, pi-tui, pi-codemode,
# pi-agent-core) move together: the candidate is tested with the highest published
# version of each sibling that satisfies the range the candidate declares, which is
# what a consumer install without our lockfile resolves (#78). All six are installed
# in one `npm install --no-save` call, so only node_modules changes; package.json
# and package-lock.json must stay byte-identical. Run `npm ci` afterwards to return
# to the pinned dependency tree. Provider-free: no model, credentials or network
# access beyond the npm registry.
#
# Exit status: 0 compatible, 1 incompatible (typecheck or SDK-facing tests
# failed), 2 invalid input or the pin guarantee was violated.
set -uo pipefail

package="@earendil-works/pi-coding-agent"
siblings=(pi-ai pi-mcp pi-tui pi-codemode pi-agent-core)
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

# Prints the install specs, one per line: the candidate first, then each sibling at the
# highest published version that satisfies the range the candidate declares.
resolve_specs() {
  PACKAGE="$package" TARGET="$target" SIBLINGS="${siblings[*]}" node --input-type=module -e '
    import { execFileSync } from "node:child_process";
    const view = (spec, field) => {
      const raw = execFileSync("npm", ["view", spec, field, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value : [value];
    };
    const numeric = (version) => version.split(/[-+]/)[0].split(".").map(Number);
    const compare = (a, b) => {
      const x = numeric(a), y = numeric(b);
      for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
      return 0;
    };
    const { PACKAGE, TARGET, SIBLINGS } = process.env;
    const version = view(`${PACKAGE}@${TARGET}`, "version").sort(compare).at(-1);
    const dependencies = view(`${PACKAGE}@${version}`, "dependencies").at(-1) ?? {};
    console.log(`${PACKAGE}@${version}`);
    for (const name of SIBLINGS.split(" ")) {
      const full = `@earendil-works/${name}`;
      const range = dependencies[full];
      if (!range) { console.error(`pi-sdk-canary: ${PACKAGE}@${version} declares no ${name}; keeping the installed one`); continue; }
      const highest = view(`${full}@${range}`, "version").sort(compare).at(-1);
      if (!highest) throw new Error(`no published ${name} satisfies ${range}`);
      console.log(`${full}@${highest}`);
    }
  '
}

if ! resolved="$(resolve_specs)" || [[ -z "$resolved" ]]; then
  echo "pi-sdk-canary: could not resolve the candidate and its sibling versions" >&2
  exit 2
fi
mapfile -t specs <<< "$resolved"
if ! npm install --no-save --no-audit --no-fund "${specs[@]}" > /dev/null; then
  echo "pi-sdk-canary: npm could not install the candidate version" >&2
  exit 2
fi
candidate="$(node -p "require('./node_modules/$package/package.json').version")"
sibling_versions=""
for spec in "${specs[@]:1}"; do
  sibling_versions+="${sibling_versions:+ }${spec#@earendil-works/}"
done
output pinned "$pinned"
output candidate "$candidate"
output siblings "$sibling_versions"

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
