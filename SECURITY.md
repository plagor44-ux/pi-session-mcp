# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability
reporting: open the **Security** tab of this repository and choose **Report a
vulnerability**. Do not open a public issue for a suspected vulnerability.

Include the Pi Session MCP version, the client and its version, the shape of the
configuration without any real values, and the steps to reproduce. Never
include credentials, prompts, transcripts or absolute local paths.

## What counts

Pi Session MCP promises a narrow boundary, described in the
[threat model](docs/threat-model.md). Reports about a broken promise are in
scope, for example:

- a path, credential, prompt, provider error or authentication location in a
  public tool result, a `doctor` report or a `setup` report;
- a client reaching a directory, model, provider or permission level that the
  configuration does not offer through an alias;
- a session receiving a tool that its execution profile does not grant;
- `setup` changing or removing a registration that it does not own.

## What does not count

- A `coding` profile is an application-level tool allowlist. It is not an
  operating-system sandbox, and this is a documented limit, not a defect.
- Vulnerabilities in Pi, in the MCP clients, in model providers or in other
  dependencies belong to those projects. A dependency advisory that affects Pi
  Control's own use of the dependency is in scope.
- The server trusts its one local MCP peer and the operator's configuration.
