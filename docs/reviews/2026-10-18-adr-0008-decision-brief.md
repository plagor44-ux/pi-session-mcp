# Decision brief: ADR 0008 (#79), state on 2026-10-18

For the maintainer. ADR 0008 stays **Proposed**; this brief prepares the decision
and changes nothing at runtime. Base main `612fbcb`. First draft by a read-only
agy/Gemini pass over the repository; every statement below was rechecked against
the cited files by the integrator.

## What changed since the ADR was written

- **Stale, corrected in this sprint:** the ADR said macOS live acceptance (R10,
  R11) was open. It passed for Claude Code on 2026-10-16 with release 0.8.3 on a
  real Mac: Level 1, R10 setup (117/117 checks), R11 smoke and a one-client live
  check ([Acceptance](../acceptance.md#macos-acceptance-on-real-hardware-2026-10-16)).
  Not established there: Codex on macOS, the two-client Level 3 cycle, lock
  contention and interruption.
- **Still not proven anywhere:** containment on macOS. No VM or container setup
  was tried or accepted; the R10/R11 evidence covers setup and smoke, not
  isolation. The live check's diff restriction was model compliance, not an OS
  boundary.
- **#81 delivered as advice:** Doctor now warns (`workspace_gitfile`) when a
  workspace has a `.git` gitfile and a coding profile exists. This is
  implemented and unreleased; it detects a *possible* linked worktree
  conservatively and enforces nothing.
- Unchanged and current: the threats T1–T6, the coding tool grant, the
  one-process-per-client union boundary and the shared-hook risk of linked
  worktrees.

## Recommendation as a decision template (option 1, wrapped registration)

| Element | Proposed rule |
| --- | --- |
| Boundary | One rootless Podman container (Linux) or separate OS user per **writer**; the host registration stays read-only |
| Repository | A full clone per writer inside the boundary, never a linked worktree |
| Git metadata | Hooks and config not writable from inside, or the host never runs Git in the writer's clone |
| Review | Fetch the writer's branch into the host repository and review it there before anything leaves |
| Authentication | Only that boundary's credentials; whether Pi's auth refresh needs a writable agent directory is an open question |
| External MCP / `envFrom` | Explicit allowlist per coding registration; no ambient host secrets (`SSH_AUTH_SOCK`, tokens) |
| Cursor-backed coding | Off non-disposable repositories until accepted inside the boundary |
| macOS | Keeps the Sprint 4 interim rules until a VM-based setup (Lima or Podman machine) is accepted |

## Decisions and evidence needed to accept the ADR

1. **Accept option 1 as the direction** (or choose another option). Maintainer decision; no evidence beyond the ADR's comparison.
2. **Auth refresh policy.** Evidence: a provider-free or approved test inside the boundary showing whether refresh writes Pi's agent directory, and that only the boundary's credentials are present.
3. **External MCP and `envFrom` allowlist** for coding registrations. Evidence: process inspection showing only allowlisted variables reach children.
4. **Linux acceptance run** of the synthetic isolated-write test defined in the ADR (`edit`, `write`, `bash`, writes outside the workspace and through symlinks, credential absence, process cleanup). Evidence: a sanitized acceptance record.
5. **macOS policy.** Decide whether macOS keeps the interim rules open-ended or gets a VM runbook; record the decision in the roadmap.
6. **A decision date or review point**, because the interim period is open-ended today.

## Out of scope now

No Podman, VM or sandbox build; no move away from the embedded SDK (ADR 0002);
no runtime or MCP contract change; no session refusal on gitfile workspaces.
