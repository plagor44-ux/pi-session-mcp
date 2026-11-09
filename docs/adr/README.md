# Architecture decision records

Each record states one decision, its context and its consequences. A later
record can narrow or extend an earlier one; the record itself says so.

| ADR | Decision |
| --- | --- |
| [0001](0001-stdio-first.md) | stdio first |
| [0002](0002-embedded-pi-sdk.md) | Embedded Pi SDK |
| [0003](0003-post-mvp-maintenance.md) | No new feature phase after the MVP |
| [0004](0004-client-contract-not-version.md) | Setup accepts clients by contract, not by version |
| [0005](0005-macos-setup-platform.md) | Setup supports macOS with the same fence as on Linux |
| [0006](0006-pi-extension-allowlist.md) | Execution profiles may load pinned Pi extensions |
| [0007](0007-profile-skill-selection.md) | Execution profiles select Pi skills from an operator catalog |
| [0008](0008-coding-profile-isolation.md) | Isolation for coding profiles on non-disposable repositories |
| [0009](0009-execution-modes.md) | Per-repository execution modes |
| [0010](0010-read-only-extension-tools.md) | Granted extension tools in read-only profiles |
| [0011](0011-turn-events-and-controller-wake.md) | Turn events and controller wake |
| [0012](0012-leased-writer-pool.md) | One registration with a leased writer pool |
| [0013](0013-hardened-read-only-profiles.md) | Hardened read-only profiles |
| [0014](0014-profile-probe-and-model-catalog.md) | Profile probe and offline model catalog |
| [0015](0015-review-snapshots.md) | Verified read-only review snapshots |
| [0016](0016-writer-recovery-export.md) | Recovery export for a writer with an unmerged index |
| [0017](0017-turn-duration-limit.md) | Per-profile maximum turn duration |
| [0018](0018-sandbox-go-module-cache.md) | Read-only Go module cache in the sandboxed shell |
| [0019](0019-opt-in-session-history.md) | Opt-in session history |
| [0020](0020-tier-routing.md) | Tier routing |
