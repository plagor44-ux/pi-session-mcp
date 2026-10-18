# Bounded orchestrator token-footprint evaluation

Date: 2026-10-17. Base: `d6f360926e26629f7b382583c077016daeb954ca`
(PR #84), package 0.8.3, Pi SDK 1.2.0, MCP SDK 2.3.1. The explicit user
assignment requests this development-only measurement. Maintenance continues;
the isolation decision (#79, ADR 0008 Proposed) remains the next investment.
No production optimization, registration, profile, credential, release or public
contract change is authorized. #81 is unrelated and remains untouched.

## Questions and hypotheses fixed before measurements

- Measure discovery/schema, delegation, running-status and final-report UTF-8
  bytes at the MCP boundary. Hypothesis: large final reports and repeated terminal
  retrieval can dominate payload, but no savings target is assumed.
- Count controller tool invocations per accepted task and worker turn, including
  running polls, first terminal consumption and repeated terminal consumption.
  Hypothesis: consuming a terminal result once removes duplicate bytes without
  changing the independently verified task.
- Distinguish transport duplication from actual client projection. Hypothesis:
  `content` and `structuredContent` overlap on the wire; whether either client
  injects both into the model is unknown until directly observed.
- Characterize structured thinking, tool arguments/results, streaming, mixed
  finals, late events, two sessions, errors, abort and timeout. Ordinary final
  text echoing tool content or `<think>` tags is expected to pass the text filter.
- Separate SDK `length` from registry truncation at 64 KiB. A compact 4 KiB report
  is a candidate, not a token limit or secrecy boundary. Reject malformed,
  truncated or incomplete reports even if the turn is technically completed.
- Model usage and money stay null unless supported events expose reliable values
  with documented semantics. Never infer tokens from bytes, treat missing usage
  as zero, subtract cache indiscriminately, or sum overlapping usage fields.

## Matrix and measurement boundaries

M0 is provider-free: at least five repetitions of each deterministic case. Reuse
the existing profile fixtures/oracles, owned temporary scopes and public MCP/SDK
seams. Cover a short read, independently failing/repaired T2, two sessions and
one follow-up, immediate/delayed/long turns, normal paused polling, a separately
labelled repeated terminal fetch, Unicode around 64 KiB, domain error, provider
error, abort, timeout and cleanup. No artificial polling storm is a baseline.

Layer 1 observes complete newline-delimited JSON-RPC UTF-8 frames by direction,
tool, state and monotonic time, and separately measures `content`,
`structuredContent`, prompt, schema and final-text sizes. The whole frame is its
own metric; component sizes are not added as a token count. Layer 2 requires a
supported actual-client request/context boundary; UI or tool events alone do
not prove injection. Layer 3 records available controller usage separately from
worker usage and separates newly added context, request size and cumulative
input usage. Unknowns include a reason and no invented tokenizer estimate.

Freeze baseline evidence before testing two one-factor candidates: compact
reports and consume-terminal-once polling. Compare payload, counts, runtime and
independent task/report acceptance. Preserve status, changes, failed checks,
blockers, risks and relative evidence references. Include adverse reports and
oracle-negative controls; worker assertions never replace verification.

M1 prepares L1 (one read), L2 (one T2 repair) and L3 (two reads plus one follow-up):
four starts and five turns per repetition. First prepare one technical pilot;
up to two additional repetitions need explicit current approval. Record exact
available routes, effort, tools, skills, extensions, client versions, source and
fixture/prompt/build digests, time/start/turn limits and unmetered cost decision.
Fresh controller invocations per arm; alternate paired order for a subsequently
approved A/B comparison (aim for three pairs). Historical approvals cannot apply.

## Quality and completion gates

### Additional provider-free client boundary calibration

Before the final current-source measurements, add one bounded synthetic Codex
client calibration. Declare a new **test-only loopback Responses provider**,
without authentication, with fresh empty disposable HOME/CODEX_HOME, ignored user
configuration, ephemeral sessions, no inherited credential/proxy variables and
only the fake MCP fixture server. This is not a production model switch or a
real provider run. First validate a single technical pilot; if it works, run five
repetitions each for normal, domain-error and registry-truncated MCP replies.
Bound every subprocess and request count, preserve failed attempts, close all
scripted sessions and remove owned raw client state.

Hypothesis (no assumed answer): inspect the next actual Codex HTTP request to
determine whether synthetic result markers occur in one or two projected
representations, including client truncation. Export only request/item byte sizes,
marker counts/hits, safe labels/hashes and cleanup/authorization-header booleans.
No body, transcript, prompt, tool data or header value persists. Any usage emitted
by the scripted endpoint is synthetic and cannot count as model usage. Conclusions
apply only to the observed Codex version and declared synthetic route; real cloud
projection, token billing, cache behavior and general egress containment remain
unestablished. Do not infer network isolation merely from a loopback listener.

Persist field allowlists only: opaque IDs, hashes, approved version/alias labels,
sizes, counters, times, exit codes, marker booleans and relative evidence links.
No raw transcripts, paths, prompts, thinking, tool data or provider errors.
Retain failed and blocked attempts. Bind uncommitted measurement sources and
the build actually launched; do not transfer historical qualifications.

Pass independent read invariance, T2 failing-baseline and repaired assertions,
report rejection controls, channel filters and owned-session/process cleanup.
Run targeted tests/typecheck and one relevant broad suite. Record native review
and measurement/verification overhead outside the benchmark counts.

## Status

Current-source M0 passed 80 actual-stdio cases, 50 filter cases and ten adverse
report controls, with five repetitions per deterministic case and a frozen
baseline before candidates. The separate actual Codex client probe passed one
pilot plus five repetitions each of success, domain error and registry truncation
on its declared provider-free loopback route. It observed one selected marker
occurrence per response despite two equal server representations. Large results
were further shortened; completed/truncated metadata remained decodable.

See the [dated report](../evaluation/token-footprint-2026-10-17/README.md) for exact
bindings, whole/component/request sizes, independent acceptance, filter/plaintext
limits, cleanup, failed attempts and measurement overhead. Earlier calibrations
remain unchanged under their own bindings. The full suite passed 1,495 tests with
six skipped; subsequent cleanup-plan metadata correction was separately verified
and remeasured, without repeating the broad suite or transferring its binding.

The dedicated fresh-controller M1 adapter is implemented and independently
reviewed. It preserves the existing profile gate and requires an additional exact
four-start/five-turn decision. The concrete current-source
[approval package](../evaluation/token-footprint-2026-10-17/live-package.json) is
ready for the operator: one pilot, declared routes, bounded work/case/wave times,
separate cleanup observation phases and unknown model costs. Existing gates
require an operator-selected positive advisory amount and acknowledgment of
unmetered cost; all approval flags remain false and no amount was invented.
On 2026-10-18 the operator approved the M1 pilot (10 USD advisory,
unmetered use acknowledged). Two attempts failed on harness defects
(controller SIGTERM forwarding; L2 coding default), both fixed with tests; the
third [passed](../evaluation/token-footprint-2026-10-17/m1-pilot/README.md)
with 4 starts, 5 turns and 0 retries. No live A/B, Claude comparison, token
saving or Level-3 qualification is claimed. Production and maintenance/isolation priorities remain
unchanged.
