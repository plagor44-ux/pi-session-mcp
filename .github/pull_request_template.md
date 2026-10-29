<!--
Fill in every section; write "none" where nothing applies. State facts that
were checked, not intentions. Never include credentials, prompts, transcripts,
absolute local paths or raw provider errors.
-->

<!-- One closing keyword per issue, e.g. "Closes #12. Closes #13." -->
Closes #

## Summary

<!--
What changed and why, by observable behaviour and files. With several issues,
use one subsection per issue ("## #12: <title>").
-->

## Verification

<!--
Commands actually run, with their result (exit status, test counts). Name what
was not run. Provider-free tests do not establish live client, model or
container behaviour; give the acceptance level if any live check was done.
-->

- `npm run typecheck`:
- `npm run build` and `npm run build:cli`:
- `NODE_OPTIONS=--unhandled-rejections=strict npm test`:
- `git diff --check`:
- Targeted or live checks:

## Contract and docs

<!--
Public surfaces changed (tool schema, result or error code, configuration
schema, setup or Doctor CLI, bundled skills, writer images) and where they are
documented. Include the CHANGELOG `Unreleased` entry and any ADR.
-->

## Risk and rollback

<!-- What could break, for whom, and how to undo it. -->

## Review and agent involvement

<!--
Authoring agent and model, or "unavailable" if not exposed; "none" for fully
human work. Independent reviews: reviewer, model family and verdict, and which
findings were fixed or declined with a reason. Human review stays with the
maintainer.
-->

- Authored by:
- Independent review:

- [ ] This pull request contains no credentials, prompts, transcripts, absolute local paths or raw provider errors.
