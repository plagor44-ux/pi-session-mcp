# Extension ablation setup and dry load — 2026-10-21

This record covers plan Task 9 Steps 3 and 4: the extension template install and
the provider-free dry load. No model turn, provider call or spend took place.
`$EVAL` stands for `~/.cache/pi-session-mcp/extension-ablation/2026-10-21`; the
template and the dry-load output live there and are not tracked.

## Template

Installed with:

```text
npm install --prefix $EVAL/template/npm --ignore-scripts --no-audit --no-fund --save-exact pi-lens@4.4.3 pi-cache-optimizer@2.9.3
```

| Item | Value |
| --- | --- |
| Top-level versions | `pi-lens` 4.4.3, `pi-cache-optimizer` 2.9.3 |
| Packages installed | 130 |
| Entries in `package-lock.json` `packages` | 145 |
| `package-lock.json` SHA-256 | `12493eaf8bdf77128a6c1786e67cc3966f322e6dc4095c4a9873242c87b999a1` |

Host: Node v26.11.1, npm 12.2.1, Linux. `prlimit`, `strace` and `bwrap` are
present, Yama `ptrace_scope` is 1, and codegraph is v1.6.2.

## Dry load

Command:

```text
npm run eval:extensions -- --dry-load --tasks <provisional tasks> --template $EVAL/template --out $EVAL/dry-load
```

Task 10 has not curated tasks yet (ruling R63). The dry load therefore used two
provisional tasks, one review and one implementation, on the `pi-session-mcp`
workspace alias. They are untracked under `eval/results/`. Task 10 re-runs the
dry load with the final tasks file and fixes `scopeIgnore` from that run before
approval.

### First run (commit f791878): every pairing failed

Root causes and fixes, all in commit 02cffa3 (spec Amendments 2026-10-21):

1. codegraph's MCP server ran its update check against GitHub from every fresh
   sandbox home, which produced unexpected connects in both arms. Fix:
   `DO_NOT_TRACK=1`, `CODEGRAPH_NO_UPDATE_CHECK=1` and `CODEGRAPH_TELEMETRY=0`
   in the scope environment, passed to MCP servers through `envFrom` (R65). A
   direct probe confirmed it: without the variable one connect to github.com,
   with it none.
2. `pi-lens` 4.4.3 keeps `ast_grep_search` and `ast_grep_outline` inactive until
   `pi_lens_activate_tools` runs (situational tools), so review sessions failed
   with `extension_tool_missing`. Fix: review profiles are granted the five
   always-active read tools (R66).
3. The `io_uring` counter took an injected `ENOSYS` that `strace` split into
   unfinished and resumed halves for a successful setup (R67).

### Second run (commit 02cffa3): every pairing ok

- `extension_tool_missing` did not occur.
- Inet connects 0, unexpected connects 0, outside writes 0, unresolved writes 0,
  denied write attempts 0, unresolved egress 0, `io_uring` setups 0.
- No file was created in any scratch clone, so no `scopeIgnore` entry is needed
  for this repository.

Active tools per pairing (sorted, from the private report):

| Pairing | Profile | Active tools |
| --- | --- | --- |
| `pl-code-deepseek` | `code-deepseek` | `bash`, `edit`, `effective_config`, `find`, `grep`, `lens_diagnostics`, `ls`, `mcp_codegraph_explore`, `module_report`, `pi_lens_activate_tools`, `project_report`, `read`, `read_enclosing`, `read_symbol`, `symbol_search`, `write` |
| `pl-code` | `code` | `bash`, `edit`, `effective_config`, `find`, `grep`, `lens_diagnostics`, `ls`, `mcp_codegraph_explore`, `module_report`, `pi_lens_activate_tools`, `project_report`, `read`, `read_enclosing`, `read_symbol`, `symbol_search`, `write` |
| `pl-review-grok` | `review-grok` | `find`, `grep`, `ls`, `mcp_codegraph_explore`, `module_report`, `project_report`, `read`, `read_enclosing`, `read_symbol`, `symbol_search` |
| `pl-review` | `review` | `find`, `grep`, `ls`, `mcp_codegraph_explore`, `module_report`, `project_report`, `read`, `read_enclosing`, `read_symbol`, `symbol_search` |
| `co-code` | `code` | `bash`, `edit`, `find`, `grep`, `ls`, `mcp_codegraph_explore`, `read`, `write` |
| `co-review` | `review` | `find`, `grep`, `ls`, `mcp_codegraph_explore`, `read` |

## Observations for the analysis

- `pi-cache-optimizer` registers no tools, so its arm B has the same tool list
  as arm A.
- On the coding profiles `pi_lens_activate_tools` is active, so coding arm B can
  activate the AST tools mid-session. Review arm B cannot.
