# Releasing

This document describes how Pi Session MCP is versioned, how its pinned dependencies
are maintained, and how a release is prepared and published. Acceptance levels
are defined in [Acceptance](acceptance.md).

Merging, tagging and publishing are maintainer decisions. Preparing a change
does not authorize any of them.

## Versioning

[ADR 0003](adr/0003-post-mvp-maintenance.md) sets the rule:

- A change that keeps the public MCP contract ships as a patch release
  (for example `0.7.x`). This includes Pi SDK updates.
- A change to the public contract needs a minor release and its own decision.

The public contract is the set of eight tools with their fields, states and
error codes, as defined in the [tool contracts](tool-contracts.md). How the
package version, the MCP tool contract and the setup report's `schemaVersion`
differ is defined under [Versions](tool-contracts.md#versions).

Wherever this document asks for the Level 1 checks, the test step is
`NODE_OPTIONS=--unhandled-rejections=strict npm test`. CI uses the same
setting, so an unhandled promise rejection fails the run locally and in CI.

A release is distributed twice: as the GitHub release with its source archive,
and as the npm package `pi-session-mcp`. The npm package contains the built
files, the executables, the operator documentation and the example
configuration. It contains no implementation plans (`docs/superpowers/`), and
no lockfile, because npm does not ship lockfiles inside packages. A consumer
install therefore resolves every transitive range afresh, which is why the Pi
SDK's own packages are pinned directly (see [Update the Pi SDK](#update-the-pi-sdk)).

## Update the Pi SDK

The Pi SDK is pinned exactly, together with the SDK's internal
`@earendil-works` packages: `pi-ai`, `pi-mcp`, `pi-tui`, `pi-codemode` and
`pi-agent-core`, which the SDK declares, and `pi-telemetry`, which `pi-ai`
declares. Up to `1.2.0` they were declared with caret ranges, and npm does not
ship our lockfile inside the package, so a consumer install resolved those
ranges fresh. A newer family member could then break the pinned SDK, as in
[#78](https://github.com/plagor44-ux/pi-session-mcp/issues/78), where
`pi-codemode` 1.2.0 removed an export that `pi-coding-agent` 1.1.0 imports.
Since `1.3.0` the SDK pins its family exactly. We do not import the family
members; they stay direct, exactly pinned dependencies as a guard, so that a
fresh install resolves to the tested versions even if upstream returns to
ranges.
The SDK and the six packages therefore always move together, each to the
version the canary resolves from the declared ranges.

A nightly canary (`.github/workflows/pi-sdk-canary.yml`) checks the unchanged
sources against the newest published `@earendil-works/pi-coding-agent` together
with the family versions that candidate declares, transitively (a package that
another member declares, such as `pi-telemetry`, is followed too): typecheck plus every test
that touches the SDK, provider-free. It reports each incompatible version once
in an open issue labeled `pi-sdk-canary`. A green canary is a signal that an
update is possible. It is not an update and not an acceptance.

1. Reproduce the canary locally for the target version:

   ```bash
   npm ci
   bash scripts/pi-sdk-canary.sh latest   # or an explicit version
   npm ci                                 # back to the pinned tree
   ```

   Exit status `0` means compatible, `1` incompatible, and `2` invalid input or
   a changed manifest. The script prints the candidate and the family versions it
   resolved from the declared ranges.

2. Read the upstream changelog between the pinned and the target version. It
   ships in the package as
   `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`. Look for changes
   to stop reasons, prompt acceptance, the tools declared to the model,
   provider keys, MCP naming and packaging. For MCP naming, compare the SDK's
   `isMcpToolName` (`dist/core/mcp-servers.js`) with the reserved names in
   `src/session-tools.ts`. That function is not a root export, so no test
   notices when the SDK reserves another name.

3. Move the pins, the SDK and its six family packages in one command:

   ```bash
   npm install --save-exact \
     @earendil-works/pi-coding-agent@<version> @earendil-works/pi-ai@<ai> \
     @earendil-works/pi-mcp@<mcp> @earendil-works/pi-tui@<tui> \
     @earendil-works/pi-codemode@<codemode> @earendil-works/pi-agent-core@<core> \
     @earendil-works/pi-telemetry@<telemetry>
   ```

   Use the versions the canary reported. `package.json` must change in exactly
   seven lines, one per package, and keep an exact version without a range
   prefix. Check with `npm ls` that exactly one copy of each family package
   exists.
   Review the lockfile diff: only the SDK family and their dependencies should
   move, and earlier lockfile-only patches must survive.

4. Update the documents that name the pinned version,
   [architecture](architecture.md) and [tool contracts](tool-contracts.md), and
   add a changelog entry. Record upstream changes that affect operators, for
   example a renamed provider key.

5. Run the [Level 1 checks](acceptance.md#level-1-repository-checks). Before
   the release, the packed-tarball check under
   [Prepare a release](#prepare-a-release) shows whether a consumer install of
   the new pins works.

Three guards protect the SDK boundary. `test/sdk-contract.test.ts` pins the prompt
dispositions, the rejection path and the exact tools declared to the model for
each permission profile. The stop-reason mapping is exhaustive, so a new stop
reason fails the typecheck. `test/sdk-failure-recovery.test.ts` pins the retry
and compaction signals. If one of them fails, the update needs source changes
and its own review of the public contract, not only a new pin.

An updated pin is not live-accepted by these checks. Live acceptance on the new
pin is a separate [Level 3](acceptance.md#level-3-live-two-client-acceptance)
gate.

## Record a client contract

`setup` accepts clients by contract, not by version
([ADR 0004](adr/0004-client-contract-not-version.md)). A new client release
needs no change as long as its public `mcp` command output keeps the expected
format. When `setup` reports `unsupported` for a current client, or before a
release, record the contract again:

1. Capture the client's public outputs in a disposable home and scratch project:
   `--version`, `mcp --help`, `mcp get pi-session-mcp` while absent, and for every
   scope `mcp add`, `mcp get`, `mcp remove` and `mcp get` again, with the exact
   arguments that the adapter issues.
2. Replace local paths with the placeholders `<NODE>`, `<ENTRY>`, `<CONFIG>`,
   `<HOME>` and `<PROJECT>`, and confirm that no local path remains.
3. Compare the recording with the newest one of the same client. If only the
   version line differs, nothing else is needed. Any other difference needs
   adapter work with its own failing test first.
4. Add the recording under `test/fixtures/client-contracts/` and its version to
   the table in `test/client-contracts.test.ts`.
5. Update the versions named in [Installation](installation.md).
6. Run the working-tree
   [Level 2 lifecycle](acceptance.md#level-2-setup-acceptance) with the real
   client for every scope (`scripts/setup-acceptance.mjs`, see
   [Tooling](acceptance.md#tooling)).

## Patch audit advisories

CI does not run `npm audit`. Run it before every release and when updating
dependencies:

```bash
npm audit
npm audit --omit=dev
```

Patch transitive advisories in the lockfile only:

1. Run `npm audit fix` and confirm with `git diff --stat` that only
   `package-lock.json` changed. Direct pins in `package.json` stay untouched.
2. If an advisory remains because a parent package pins an affected version
   exactly, resolve the parent at another version inside the range that its own
   dependent declares. The development-only `concurrently` was resolved this
   way at `9.2.0` until MCP Inspector 2.x stopped depending on it.
3. Run `npm ci`, both audit commands and the Level 1 checks.
4. Name every patched package, its versions, its advisory and whether it is in
   the production install path in the changelog.

## Prepare a release

A release travels in the pull request of the change it ships. That pull
request also carries the version, the changelog heading and the pre-release
acceptance record; there is no separate release pull request. Records that can
only be made after publishing go into the pull request of the next change.

Preconditions:

- The change pull request contains every change of the release, and Level 1
  is green on its head.
- `npm audit` reports 0 vulnerabilities.
- The public contract is unchanged, or a minor release has been decided.
- The acceptance that this release requires is recorded, or its absence is
  stated in the release notes.

Steps:

1. Bring the change branch up to date with `main` if `main` moved. Never reuse
   a branch that predates later merges without that: its lockfile would undo
   later dependency patches.
2. Set the version:

   ```bash
   npm version <x.y.z> --no-git-tag-version
   ```

   This changes `package.json` and both version fields of `package-lock.json`.
   Then change the version by hand in the package version line of `README.md`
   and in the capability example of `docs/tool-contracts.md`.
3. In `CHANGELOG.md`, insert the heading `## <x.y.z> — <date>` directly below
   `## Unreleased`, so that the unreleased entries become the release entries.
4. Run the Level 1 checks. `npm run --silent doctor -- --json` must report the
   new `packageVersion`.
5. Run the working-tree
   [Level 2 acceptance](acceptance.md#tooling) on the release candidate with
   `scripts/setup-acceptance.mjs`, unless the release notes state its absence.
6. Run the packed-tarball Level 2 acceptance on the same candidate. Pack the
   built package, install the tarball into a fresh prefix and point the harness
   at the installed package:

   ```bash
   npm pack
   PREFIX="$(mktemp -d "$HOME/.cache/pi-session-mcp-pack.XXXXXX")"
   npm install -g --prefix "$PREFIX" ./pi-session-mcp-<x.y.z>.tgz
   node scripts/setup-acceptance.mjs \
     --setup "$PREFIX/bin/pi-session-mcp-setup" \
     --build-dir "$PREFIX/lib/node_modules/pi-session-mcp" \
     --label packed-<x.y.z> --out level2-result.json
   rm -rf "$PREFIX" ./pi-session-mcp-<x.y.z>.tgz
   ```

   This is the only acceptance-level pre-release check that resolves
   dependencies like a consumer: the working tree and the CI build use our
   lockfile, which a published package does not carry (#78). The CI install
   smoke also resolves fresh, but it is an early warning, not acceptance. Always
   use a fresh prefix from `mktemp -d`, never a fixed or reused one, and never
   install without `--prefix`. Remove the prefix and the tarball afterwards; the
   tarball is not committed.
7. Record the pre-release acceptance in the status section of
   [Acceptance](acceptance.md) and push it to the change pull request. Name the
   release in the pull request's title and description.

## Publish a release

After the change pull request is merged and CI is green on the merge commit:

```bash
git switch main
git pull --ff-only
git tag -a v<x.y.z> -m "pi-session-mcp v<x.y.z>"
git push origin v<x.y.z>
```

Then publish the npm package from a fresh clone of the tag, so that the
package contains exactly the tagged sources:

```bash
git clone --branch v<x.y.z> --depth 1 https://github.com/plagor44-ux/pi-session-mcp.git /tmp/pi-session-mcp-release
cd /tmp/pi-session-mcp-release
npm ci
npm publish --dry-run     # review the file list: dist/, .pi-session-mcp-cli/, scripts/doctor.mjs, docs/ without docs/superpowers/
npm stage publish         # the prepack script builds the server, setup and Doctor
```

`npm stage publish` (npm 11.15 or later) places the version in the registry's
staging area without a second factor. The maintainer then approves it with the
account's second factor, on npmjs.com under the package's **Staged Packages**
tab or with `npm stage approve <stage-id>`. Staging a package that does not
exist yet also creates the public placeholder version `0.0.0-stage`. A direct
`npm publish` works as well when the second factor can be entered in the
terminal.

After the approval, confirm that the registry serves the staged bytes:

```bash
npm view pi-session-mcp@<x.y.z> version dist.shasum
```

The shasum must equal the one that `npm stage publish` printed. Finally create
the GitHub release:

```bash
gh release create v<x.y.z> --title "pi-session-mcp v<x.y.z>" --notes-file <notes-file>
```

The release notes have three sections:

- **Highlights**: the changes that matter to operators.
- **Verification**: the release source commit, the annotated tag object, the CI
  runs on the merge commit and on the tag, the local Level 1 results, and the
  npm package version and tarball digest.
- **Boundary**: what was not done or not verified, for example that no new live
  acceptance was performed.

After publishing:

1. Run the published-release
   [Level 2 acceptance](acceptance.md#working-tree-and-published-release-variants)
   from a fresh clone of the tag and from the published npm package.
   `scripts/setup-acceptance.mjs` runs both ([Tooling](acceptance.md#tooling)).
2. Upgrade the installation as described in
   [Installation](installation.md#upgrade).
3. Record both in the status section of [Acceptance](acceptance.md) with the
   pull request of the next change, not in a pull request of their own.
