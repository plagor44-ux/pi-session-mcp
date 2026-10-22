# Extension ablation repeat: pi-lens on `code` with replicates

**Goal:** Settle the indicative `pl-code` result of the 2026-10-21 wave (A 2/3, B 2/3, "enable" decided by one timeout) with three runs per task and arm.

**Spec:** [`docs/superpowers/specs/2026-10-19-extension-ablation-design.md`](../specs/2026-10-19-extension-ablation-design.md), amended with R90 (replicates). Everything not changed here holds as amended: tasks, oracles, sandbox, budget rules, stop rules, evidence handling.

**Scope:** pairing `pl-code` only (`--pairings pl-code`): the three pre-registered implementation tasks (`i-go-app-dms`, `i-pyng-authz`, `i-pyng-pdf` from `docs/evaluation/extension-ablation-2026-10-20/tasks.json`), arm A (no extension) against arm B (`pi-lens@4.4.3`), profile `code` (openai gpt-6.1-sol, OAuth refreshed on the host, R86). No review pairing, no pi-cache-optimizer, no Hindsight.

**Budget and projection:** USD 10 hard cap with a new ledger. 3 tasks × 2 arms × 3 replicates = 18 runs; observed `code` runs cost USD 0.06–0.91 (mean ≈ 0.43), so ≈ USD 8 plus preflights. The wave's budget stop applies as before.

## Global constraints

Unchanged from the 2026-10-20 plan (product sources unchanged, no new dependency, exact pins, tracked evidence without credentials, prompts, texts or absolute paths; English docs; one branch `eval/extension-ablation-repeat`, one PR).

## Task 1: Replicates in the harness (R90)

- `--plan --replicates <N>` (integer 1–9, default 1). The canonical matrix (R58) is built once per replicate and concatenated replicate by replicate; ordinals run over the whole list; the run id gains `-r<k>` for every replicate (also r1) when N > 1 and stays as today when N = 1. Within each replicate the A/B order per task alternates as today, and flips between consecutive replicates.
- The slot key is (task, profile, arm, replicate); `RunSpec` gets `replicate` (1-based; optional in the schema so existing approvals and evidence still parse, read as 1).
- The approval records `replicates` (optional, default 1); `validateApproval`/`runsAreCanonical`, `--exclude-wave`, resume and the G1 guard use it.
- The report pairs arm A and arm B per (task, replicate) and applies the pre-registered rule to those units; the summary also gives per task the accepted count per arm (`k of N`) and the per-arm totals. Merge keys include the replicate.
- Tests for N = 1 (unchanged ids and behaviour), N = 3 (ids, order, alternation, canonical check, exclusion, report units), and old evidence parsing.
- Spec amendment R90; this plan.

## Task 2: Setup and dry load (operator gate: network for npm)

`EVAL=~/.cache/pi-session-mcp/extension-ablation-repeat/<date>`. Re-install the template (`pi-lens@4.4.3`, `pi-cache-optimizer@2.9.3`, `--ignore-scripts --save-exact`); rebuild the two base-lock venvs for `i-pyng-authz` and `i-pyng-pdf` offline from the uv cache (R68 layout); `--dry-load --pairings` is not available, so run the dry load with the tasks file as in 2026-10-21 (its pairings cover `pl-code`). Record in `docs/evaluation/extension-ablation-repeat-2026-10-21/setup.md`.

## Task 3: Plan, approval, preflight (operator gate: live spend)

`--plan --tasks … --ledger $EVAL/ledger.json --pairings pl-code --replicates 3` creates the ledger; the operator approves the 18-run list with the USD 10 budget; preflight for the `code` route.

## Task 4: Wave

`--wave … --pairings` is implied by the approval; run in chunks (`--max-runs 9`, then `--resume`) to stay below the 4-hour limit per invocation. Audit stops are handled as before (diagnostics, fix, review, re-plan; the operator's standing authorization of 2026-10-21 covers re-approval after an evidenced, reviewed harness false positive).

## Task 5: Report, write-up, PR

`--report --wave … --ledger … --evidence docs/evaluation/extension-ablation-repeat-2026-10-21/evidence`; README with per-task `k of 3` per arm, the rule applied to the 9 paired units, cost and cache-read share per arm, network activity, and a plain statement of what the repeat changes about the 2026-10-21 indication. Gate, final review, one PR.
