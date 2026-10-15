#!/usr/bin/env bash
# Pi SDK canary: checks the unchanged Pi Session MCP sources against another published
# Pi SDK version (default: the `latest` dist-tag) without touching the exact pins.
#
# Usage: bash scripts/pi-sdk-canary.sh [version-or-dist-tag]
#
# The SDK and the @earendil-works packages it pulls in (today pi-ai, pi-mcp, pi-tui,
# pi-codemode, pi-agent-core and, declared by pi-ai, pi-telemetry) move together. The
# family is resolved transitively: the candidate's declared @earendil-works/*
# dependencies, then the declared @earendil-works/* dependencies of each resolved
# member, and so on until the set is stable. Each member gets the highest published
# version that satisfies every range declared for it; when no version satisfies all
# of them, the script exits with 2. Prereleases are skipped unless the candidate is
# itself a prerelease. This is what a consumer install without our lockfile
# resolves (#78). The candidate and the family are installed in one
# `npm install --no-save` call, so only node_modules changes; package.json and
# package-lock.json must stay byte-identical. Run `npm ci` afterwards to return to
# the pinned dependency tree. Provider-free: no model, credentials or network
# access beyond the npm registry.
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

# Prints the install specs, one per line: the candidate first, then every resolved
# family member (sorted by name) at the highest published version that satisfies all
# ranges declared for it by the candidate and by the other members.
resolve_specs() {
  PACKAGE="$package" TARGET="$target" node --input-type=module - <<'JS'
import { execFileSync } from "node:child_process";

const SCOPE = "@earendil-works/";
const { PACKAGE, TARGET } = process.env;
process.on("uncaughtException", (error) => {
  console.error(`pi-sdk-canary: ${error.message}`);
  process.exit(1);
});

// Runs `npm view <spec> <field> --json`; a registry "no match" (E404) is an empty result.
const cache = new Map();
function view(spec, field) {
  const key = `${spec}\0${field}`;
  if (cache.has(key)) return cache.get(key);
  let raw;
  try {
    raw = execFileSync("npm", ["view", spec, field, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    let code;
    try { code = JSON.parse(String(error.stdout ?? "")).error?.code; } catch { code = undefined; }
    if (code !== "E404") throw new Error(`npm view ${spec} ${field} failed`);
    cache.set(key, []);
    return [];
  }
  const value = raw.trim() === "" ? [] : JSON.parse(raw);
  const result = Array.isArray(value) ? value : [value];
  cache.set(key, result);
  return result;
}

function compare(a, b) {
  const [coreA, preA] = a.split("+")[0].split(/-(.*)/s);
  const [coreB, preB] = b.split("+")[0].split(/-(.*)/s);
  const x = coreA.split(".").map(Number), y = coreB.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const p = preA.split("."), q = preB.split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i += 1) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const numeric = /^\d+$/.test(p[i]) && /^\d+$/.test(q[i]);
    if (p[i] === q[i]) continue;
    if (numeric) return Number(p[i]) - Number(q[i]);
    return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

function declared(name, version) {
  const out = {};
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const entry of view(`${name}@${version}`, field)) {
      for (const [dependency, range] of Object.entries(entry ?? {})) {
        if (dependency.startsWith(SCOPE)) (out[dependency] ??= new Set()).add(range);
      }
    }
  }
  return out;
}

const candidate = view(`${PACKAGE}@${TARGET}`, "version").sort(compare).at(-1);
if (!candidate) throw new Error(`no published ${PACKAGE} matches ${TARGET}`);
const allowPrerelease = TARGET.includes("-") || candidate.includes("-");

// Highest version satisfying every range, or undefined when the intersection is empty.
function highest(name, ranges) {
  let common;
  for (const range of ranges) {
    const matching = new Set(view(`${name}@${range}`, "version").filter((version) => allowPrerelease || !version.includes("-")));
    common = common === undefined ? matching : new Set([...common].filter((version) => matching.has(version)));
  }
  return [...common ?? []].sort(compare).at(-1);
}

// Fixpoint: the family and its ranges are recomputed from the current members until stable.
let family = new Map();
for (let round = 0; ; round += 1) {
  if (round >= 10) throw new Error("the family does not converge");
  const members = [[PACKAGE, candidate], ...family];
  const constraints = new Map();
  for (const [name, version] of members) {
    for (const [dependency, ranges] of Object.entries(declared(name, version))) {
      if (!constraints.has(dependency)) constraints.set(dependency, new Set());
      for (const range of ranges) constraints.get(dependency).add(range);
    }
  }
  const next = new Map();
  for (const [name, ranges] of constraints) {
    if (name === PACKAGE) {
      const fits = [...ranges].every((range) => view(`${name}@${range}`, "version").includes(candidate));
      if (!fits) throw new Error(`${PACKAGE}@${candidate} does not satisfy ${[...ranges].join(" and ")}`);
      continue;
    }
    const version = highest(name, ranges);
    if (!version) throw new Error(`no published ${name} satisfies all of: ${[...ranges].join(", ")}`);
    next.set(name, version);
  }
  const same = next.size === family.size && [...next].every(([name, version]) => family.get(name) === version);
  family = next;
  if (same) break;
}

console.log(`${PACKAGE}@${candidate}`);
for (const [name, version] of [...family].sort(([a], [b]) => (a < b ? -1 : 1))) console.log(`${name}@${version}`);
JS
}

if ! resolved="$(resolve_specs)" || [[ -z "$resolved" ]]; then
  echo "pi-sdk-canary: could not resolve the candidate and its family versions" >&2
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
output siblings "$sibling_versions"  # every resolved family member besides the candidate

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
