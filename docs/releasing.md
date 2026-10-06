# Releasing

This document describes how Pi Session MCP is versioned, how its pinned dependencies
are maintained, and how a release is prepared and published. Acceptance levels
are defined in [Acceptance](acceptance.md).

Merging, tagging and publishing are maintainer decisions. Preparing a change
does not authorize any of them.

## Versioning

[ADR 0003](adr/0003-post-mvp-maintenance.md) sets the rule:

- A change that keeps the public MCP contract ships as a patch release
  (`0.6.x`). This includes Pi SDK updates.
- A change to the public contract needs a minor release and its own decision.

The public contract is the set of eight tools with their fields, states and
error codes, as defined in the [tool contracts](tool-contracts.md).

A release is distributed twice: as the GitHub release with its source archive,
and as the npm package `pi-session-mcp`. The npm package contains the built
files, the executables, the documentation and the example configuration, but
no lockfile, because npm does not ship lockfiles inside packages.

## Update the Pi SDK

The Pi SDK is pinned exactly. A nightly canary
(`.github/workflows/pi-sdk-canary.yml`) checks the unchanged sources against the
newest published `@earendil-works/pi-coding-agent`: typecheck plus every test
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
   a changed manifest.

2. Read the upstream changelog between the pinned and the target version. It
   ships in the package as
   `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`. Look for changes
   to stop reasons, prompt acceptance, the tools declared to the model,
   provider keys, MCP naming and packaging.

3. Move the pin:

   ```bash
   npm install --save-exact @earendil-works/pi-coding-agent@<version>
   ```

   `package.json` must change in exactly one line and keep an exact version
   without a range prefix. Review the lockfile diff: only the SDK's own packages
   and their dependencies should move, and earlier lockfile-only patches must
   survive.

4. Update the documents that name the pinned version,
   [architecture](architecture.md) and [tool contracts](tool-contracts.md), and
   add a changelog entry. Record upstream changes that affect operators, for
   example a renamed provider key.

5. Run the [Level 1 checks](acceptance.md#level-1-repository-checks).

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
   client for every scope.

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
   dependent declares. The development-only `concurrently` is resolved this way
   at `9.2.0`.
3. Run `npm ci`, both audit commands and the Level 1 checks.
4. Name every patched package, its versions, its advisory and whether it is in
   the production install path in the changelog.

## Prepare a release

Preconditions:

- `main` contains every change of the release, and Level 1 is green on `main`.
- `npm audit` reports 0 vulnerabilities.
- The public contract is unchanged, or a minor release has been decided.
- The acceptance that this release requires is recorded, or its absence is
  stated in the release notes.

Steps:

1. Create a release branch from the current `main`. Never reuse a release branch
   that predates later merges: its lockfile would undo later dependency patches.
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
5. Open one pull request named `chore: prepare v<x.y.z> release`.

## Publish a release

After the release pull request is merged and CI is green on the merge commit:

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
npm pack --dry-run        # review the file list: dist/, .pi-session-mcp-cli/, scripts/doctor.mjs, docs/
npm publish --otp=<code>  # the prepack script builds the server, setup and Doctor
npm view pi-session-mcp@<x.y.z> version dist.tarball
```

Publishing needs the npm account of the maintainer with two-factor
authentication; `--otp` takes the current one-time code. Finally create the
GitHub release:

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
   from a fresh clone of the tag and from the published npm package, and
   record it.
2. Upgrade the installation as described in
   [Installation](installation.md#upgrade).
3. Update the status section in [Acceptance](acceptance.md).
