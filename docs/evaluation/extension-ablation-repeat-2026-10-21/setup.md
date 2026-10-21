# Extension ablation repeat: setup and dry load — 2026-10-21

This record covers Task 2 of the repeat plan
(`docs/superpowers/plans/2026-10-21-extension-ablation-repeat.md`): the
extension template, the dependency directories and the provider-free dry load.
No model turn, provider call or spend took place.
`$EVAL` stands for `~/.cache/pi-session-mcp/extension-ablation-repeat/2026-10-21`;
the template, the dependencies and the dry-load output live there and are not
tracked.

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
| `package-lock.json` SHA-256 | `01457bdb42de901522818ae2150edb7e172dd637b7f88b097cbc728b00036d07` |

The top-level versions equal those of the first wave (2026-10-21), but the lock hash
differs from the first wave's `12493eaf…`: npm re-resolved transitive packages
within their declared ranges. Only arm B of `pl-code` loads the template, so
the repeat measures `pi-lens` 4.4.3 with this transitive set.

Host: Node v26.11.1, npm 12.2.1, Linux, codegraph v1.6.2; `prlimit`, `strace`
and `bwrap` present.

## Dependencies

`i-spng-authz` and `i-spng-pdf` declare `backend/.venv` with lockfile
`backend/uv.lock` (ruling R68). Both directories under `$EVAL/deps/` were
rebuilt with the R68 layout, offline from the local uv cache with
`uv sync --frozen --offline --no-install-project`, from temporary checkouts at
the respective base commits that were removed afterwards:

| Task | Lock copy SHA-256 | Git blob id |
| --- | --- | --- |
| `i-spng-authz` | `b436e02f3e4de9ace1016a66b9997630fb7042d5ca071b2db6d307080f2737ca` | `66e4439f6a5ee8d4adc09eafae26478b730740da` |
| `i-spng-pdf` | `b436e02f3e4de9ace1016a66b9997630fb7042d5ca071b2db6d307080f2737ca` | `66e4439f6a5ee8d4adc09eafae26478b730740da` |

Both equal the base commits' lockfile and the first wave's (2026-10-21) lock copies.
`runtime/` holds the copy of uv's CPython that the venv's interpreter link
points to.

## Dry load

Commit 75a0136 (replicates), with the tasks file of the first wave (2026-10-21)
(`docs/evaluation/extension-ablation-2026-10-20/tasks.json`); `--dry-load` has
no `--pairings` filter, so it loads all six pairings, `pl-code` among them.

- Every pairing ok, granted tools present.
- Connects 0, unexpected connects 0, outside writes 0, unresolved writes 0,
  denied write attempts 0, unresolved egress 0, `io_uring` setups 0.
- No file was created in any scratch clone.
- `pl-code` arm B has the 16 tools of the first wave (2026-10-21): `bash`, `edit`,
  `effective_config`, `find`, `grep`, `lens_diagnostics`, `ls`,
  `mcp_codegraph_explore`, `module_report`, `pi_lens_activate_tools`,
  `project_report`, `read`, `read_enclosing`, `read_symbol`, `symbol_search`,
  `write`.

The dry load loads `i-thoth-dms` for implementation pairings, which declares no
dependencies; the venv mounts are checked before the wave runs and again in
every run of the two spng tasks.
