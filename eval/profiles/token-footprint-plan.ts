import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sourceBinding, digest, hash } from "./files.js";
import { taskCatalog } from "./catalog.js";
import { taskDefinitions } from "./oracles.js";

/** Reviewable exact schedule; deliberately not coerced into the profile-screening gate. */
export async function footprintPlan(root: string) {
  const source = await sourceBinding(root), tasks = await taskCatalog(root);
  const prompts = Object.fromEntries(["T1", "T2"].map(id => [id, hash(taskDefinitions.find(t => t.id === id)!.prompt)]));
  const matrix = [
    { id: "L1", task: "T1", starts: 1, turns: 1, worker_route_alias: "review", operations: ["discover", "start-read-a", "prompt-read-a", "paused-poll-read-a", "independent-read-oracle", "close-read-a", "empty-list"] },
    { id: "L2", task: "T2", starts: 1, turns: 1, worker_route_alias: "code", operations: ["independent-failing-baseline", "discover", "start-code-a", "prompt-code-a", "paused-poll-code-a", "independent-repaired-oracle-and-diff", "close-code-a", "empty-list"] },
    { id: "L3", task: "T1", starts: 2, turns: 3, worker_route_alias: "review", operations: ["discover", "start-read-a", "start-read-b", "prompt-read-a", "prompt-read-b", "paused-poll-both", "independent-read-oracles", "prompt-follow-up-a", "paused-poll-follow-up-a", "independent-read-oracle-and-first-turn-invariance", "close-read-a", "close-read-b", "empty-list"] },
  ];
  return {
    schema_version: "token-footprint-proposal-1", approved: false, source,
    matrix, matrix_digest: digest(matrix), fixture_bindings: tasks.filter(t => t.id === "T1" || t.id === "T2"), prompt_hashes: prompts,
    follow_up_prompt_hash: hash("Re-read the T1 source and documentation. Return the same two source-linked claims with numeric status values; do not modify files."),
    controller: { client: "codex", version: "0.162.0", provider: "openai", model: "gpt-6.1-sol", effort: "high", auth: "existing-client-login-not-probed", skills: ["pi-session-orchestration"], extensions: [] },
    worker_routes: [
      { from_configured_alias: "review", provider: "openai-codex", model: "gpt-6.1-sol", effort: "high", permission: "read-only" },
      { from_configured_alias: "code", provider: "openai-codex", model: "gpt-6.1-sol", effort: "medium", permission: "coding" },
    ],
    worker_skills: [], worker_extensions: [], worker_external_mcp_grants: [],
    controller_skill_digest: hash(await readFile(join(root, "skills/pi-session-orchestration/SKILL.md"))),
    limits: { repetitions: 1, controller_invocations: 3, max_starts: 4, max_work_turns: 5, whole_run_retries: 0,
      controller_timeout_ms: 600000, worker_turn_timeout_ms: 180000, wave_timeout_ms: 1800000,
      concurrent_controllers: 1, max_concurrent_workers: 2, advisory_poll_pause_ms: 3000 },
    cleanup: { controller_close_wait_ms: 26000, controller_force_close_wait_ms: 2000,
      controller_group_wait_ms: 26000, controller_group_force_wait_ms: 2000,
      registered_server_wait_ms: 3000, registered_server_force_wait_ms: 1500,
      configured_wait_sum_ms: 60500, wall_clock_hard_cap_ms: null,
      reason: "separate-bounded-waits-with-additional-process-table-observation" },
    money: { usd: null, provider_hard_cap: null, acknowledges_unmetered_cost: false, reason: "subscription-no-verified-per-run-tariff-or-meter" },
    client_measurement: { usage_event: "turn.completed", fields: ["input_tokens", "output_tokens", "cached_input_tokens", "reasoning_output_tokens"],
      model_injection_copies: null, request_context_bytes: null, cache_compaction_state: "observe-or-record-unknown", raw_transcript_retention: false },
    additional_repetitions_approved: 0, live_ab_approved: false, claude_comparison_approved: false,
    execution_status: "BLOCKED", blockers: ["exact-matrix-route-budget-operator-decision-missing", "positive-operator-advisory-budget-and-unmetered-acknowledgment-required"],
    // The current generic --live runner cannot represent two sessions plus a follow-up.
    // Its required positive advisory_usd also cannot express this null-dollar proposal.
    existing_profile_gate_compatible: false,
    dedicated_executor: "--footprint-live",
    execution_templates: "profileManifest-budgetProposal-decisionTemplate",
    preserves_existing_validateApproval: true,
  };
}
