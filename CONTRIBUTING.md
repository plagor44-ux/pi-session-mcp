# Contributing

Pi Session MCP is in maintenance mode: defects and upstream drift get focused
fixes, and no new feature phase is planned. The reasons and the conditions for
revisiting that decision are in
[ADR 0003](docs/adr/0003-post-mvp-maintenance.md). Please open an issue before
working on anything.

## Development setup

Linux or macOS and Node.js 22.19.0 or newer:

```bash
npm ci
npm run typecheck
npm run build:cli
NODE_OPTIONS=--unhandled-rejections=strict npm test
npm run build
```

The strict option makes an unhandled promise rejection fail the test run, and
CI runs the tests with the same setting. Tests use a fake Pi adapter or a
scripted model. They need no provider credentials and no network access beyond
the npm registry.

## Rules

The binding project rules are in [AGENTS.md](AGENTS.md). The most important
ones:

- TypeScript strict mode, ESM, and `.js` suffixes in relative imports.
- Pin every direct dependency exactly. Do not use range prefixes.
- Stdout carries MCP frames only. Diagnostics go to stderr and contain neither
  secrets nor complete prompts.
- Workspaces are reached only through configured aliases. No tool argument may
  accept an arbitrary working directory.
- Use only documented exports of the Pi SDK package root.
- Write documentation in English.

## Pull requests

Pull requests are limited to collaborators. If you are not a collaborator and
want to contribute a fix, open an issue that describes it.

Issues use the forms in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/):
bug report, change proposal or maintenance task. Each asks for acceptance
criteria and a way to verify them, so that a person or a coding agent can carry
the issue out and a reviewer can check it. Pull requests use
[`.github/pull_request_template.md`](.github/pull_request_template.md).

- Keep a pull request to one focused change, and name every issue it addresses
  with its own closing keyword (`Closes #12. Closes #13.`).
- Run the checks above and `npm audit` before opening it.
- Describe what you verified and how. State only what was run: provider-free
  tests do not establish live client or model behavior.
- Never put credentials, prompts, transcripts, absolute local paths or raw
  provider errors into issues, pull requests, tests or logs.

Updating the Pi SDK pin, recording a client contract and patching audit
advisories each have a procedure in [Releasing](docs/releasing.md). The
acceptance levels are defined in [Acceptance](docs/acceptance.md).

## Security

Do not report vulnerabilities in public issues. See the
[security policy](SECURITY.md).
