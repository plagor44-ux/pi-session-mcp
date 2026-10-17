# Isolated Pi extension headless follow-up

Date: 2026-10-17. The four exact pins were installed by the parent run into a disposable prefix with lifecycle scripts disabled. The recorded install evidence identifies Node 24.22.0, Pi coding-agent 1.2.0, Pi TUI 1.2.0, TypeBox 1.3.27, and matching registry integrity values in [isolated-install.json](isolated-install.json). No global or production installation was made.

The probe uses the repository's real `SdkPiSessionAdapter` with a local in-memory fixture provider, an empty skills selection, no prompts, no candidate tool calls, and cache warming disabled. Each run uses a fresh HOME, agent directory, data/cache/config directories, and synthetic workspace. Network APIs and child-process creation are denied at process start; the supervisor enforces a 35-second timeout, checks process-group cleanup, and removes each scope. Node syntax checks passed for the probe and supervisor.

| Candidate | Read-only | Coding | Observed result |
|---|---|---|---|
| `pi-lens@4.4.3` | PASS | PASS | Loads and registers extension tools; read-only active tools remained the four built-ins. Coding profile's active tools stayed within the composed allowlist. No denied network or child-process attempts. |
| `pi-cache-optimizer@2.9.3` | PASS | PASS | Loads and binds in both profiles. Read-only active tools remained the four built-ins; coding tools stayed within the composed allowlist. No denied network or child-process attempts. Cache warming was disabled, so no warming behavior was evaluated. |
| `@gotgenes/pi-permission-system@40.3.0` | PASS | PASS | Loads and binds in both profiles. No candidate tools registered; active tool sets followed the adapter profile. This only verifies load/bind, not policy enforcement. |
| `context-mode@1.0.169` | PASS | PASS | After a denied-only diagnostic identified `execFileSync("git", ["-C", projectDir, "rev-parse", "--show-toplevel"])` at `build/session/db.js:253`, the probe allowed only this exact read-only query via fixed `/usr/bin/git`, with cwd and `-C` bound to the fresh synthetic workspace, 1.5-second timeout, no system/global Git config, and optional locks disabled. It returned nonzero because the synthetic workspace is not a Git repository; context-mode handled that and completed load/bind/disposal. No other child-process or network attempts occurred. |

The final runtime receipts resolve the Pi coding-agent/TUI/TypeBox peers to 1.2.0/1.2.0/1.3.27 from the host SDK dependency tree for the packages that completed peer diagnostics; the install evidence records the same peer resolution for all four candidates. Context-mode runtime startup completed with no tools registered. No provider calls, prompts, candidate tool invocations, or network attempts were observed. The only child process allowed was the bounded Git metadata query described above. All completed probe scopes passed process cleanup and removal.

Earlier attempts are retained in the result directory and are not treated as candidate verdicts: one supervisor version lost its sanitized receipt, one resolver configuration pointed at the wrong isolated prefix, and one harness revision had a missing `readFile` import and an overly strict tool-set assertion. The context-mode denied-only diagnostic receipt is retained to show the exact child-process metadata and source frame; it is superseded by the two final component receipts with the single metadata-only command allowance. A separate `pi-lens` read-only diagnostic run used the repository root as cwd and is explicitly excluded from the verdict; the final read-only run below used a fresh synthetic workspace. Final pi-lens coding and all cache/permission/context-mode verdict runs also used the synthetic workspace. No candidate tool was invoked in any run.

These checks establish only headless loading, extension tool discovery, active-tool allowlist composition, hook/lifecycle setup and disposal. They do not establish feature efficacy, permission-policy correctness, context-mode functionality, cache behavior, UI operation, or provider compatibility beyond adapter startup with the fixture provider.

## Evidence files and SHA-256

- `isolated-extensions-results-2026-10-17T09-23-42-291Z-f4af1e12-844e-4b2d-a090-9068e7626dd5.json` — final pi-lens read-only synthetic-workspace run; `e14a0e901e17fe97d80e2dc399b6e778da1995e61f9a5cbd0e440f97df83a255`.
- `isolated-extensions-results-2026-10-17T09-21-44-636Z-488698ad-f8bf-4d7e-b85a-615275c32e5d.json` — superseded pi-lens read-only diagnostic run (repository-root cwd); `fba85adbd6ded8558251c963d589fd7f8b452f6376a65fc1ee70686298bcef9b`.
- `isolated-extensions-results-2026-10-17T09-22-05-375Z-16f5d77c-32a2-4d0a-905a-e080b392316f.json` — pi-lens coding; `f968512477e27c1a16866eb879de27a269b47cf3d4ba4b39126e05fa42f2f995`.
- `isolated-extensions-results-2026-10-17T09-22-17-638Z-45ec386d-3429-4a7c-a10e-8673c03861f0.json` — context-mode blocked child-process attempts; `f51d68c164e8f12ab4200398b2c2c4b4fc737b3d3d3b4650ea86dfca2a065e2d`.
- `isolated-extensions-results-2026-10-17T09-22-22-485Z-1b08e134-667c-4416-8372-cb233939c48b.json` — pi-cache-optimizer; `cef6e34007097c9741d377e081a078934a894190fd039363b1d08039ab35cb49`.
- `isolated-extensions-results-2026-10-17T09-22-25-490Z-223fd05e-52f9-4996-88d7-3ec43a6ecdd9.json` — pi-permission-system; `f139734d7bf96730e20a77f6438d96f2f015681f2b87c8c9ff9e7943550bf1b2`.
- `isolated-extensions-results-2026-10-17T09-25-15-842Z-798946f5-b9a5-4810-8a0c-35be6f40abb3.json` — final context-mode read-only; `b5d99d87765528cd1af3558fa7121b5b2bf530fbc2c1cbf4c6c07af2e7febb03`.
- `isolated-extensions-results-2026-10-17T09-25-19-099Z-89bd000d-bb51-4e3a-b713-51ff1ff4e38b.json` — final context-mode coding; `a310c804338b4d48c2236f42f70c2e476209e918bc6db9650280a1174e650a8a`.
- `isolated-extensions-results-2026-10-17T09-24-36-866Z-30770d13-c7ae-4309-921b-5c1b43050adb.json` — denied-only context-mode diagnostic with method, sanitized argv pattern and candidate-relative stack frame; retained as diagnostic, not final verdict.
- Probe source SHA-256: `989f83e9e3cf13981ce55806b536f5879159f7a6787b3a413dfc084f8dac6f22`.
- Supervisor source SHA-256: `694946fc1ed43c170bc73a243c45aaf16696568c21308a220087bc0a7489706a`.
- Denied-only context-mode diagnostic SHA-256: `00ea68401be8a93d1ddc217032dd172ebc4c963e4c1c3bedc34c6fc8e0f88d3c`.

Package identity, license, package metadata, lifecycle scripts, peer declarations, and static security/data-flow observations are recorded in the prior static audit at `docs/evaluation/extension-audit-2026-10-17/permission-cache-report.md` and its JSON evidence. Registry/source links and package hashes are included there.
