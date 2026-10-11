/** An exactly pinned Pi extension package, as configured on an execution profile. */
export interface ExtensionSpec {
  /** The configured text, for example `npm:pi-cursor-sdk@0.5.3`. Path-free and secret-free. */
  readonly spec: string;
  readonly name: string;
  readonly version: string;
}

export const MAX_PROFILE_EXTENSIONS = 8;
const MAX_SPEC_LENGTH = 256;
/** `npm:<name>@<exact semver>`; the name may be scoped. Ranges, tags, git sources and paths never match. */
const EXTENSION_SPEC_PATTERN = /^npm:((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

export function parseExtensionSpec(spec: string): ExtensionSpec | undefined {
  if (spec.length > MAX_SPEC_LENGTH) return undefined;
  const match = EXTENSION_SPEC_PATTERN.exec(spec);
  if (!match) return undefined;
  return Object.freeze({ spec, name: match[1]!, version: match[2]! });
}

export type PiExtensionErrorCode = "extension_not_installed" | "extension_version_mismatch" | "extension_load_failed";

/** A classified extension resolution failure. It never carries a path or extension text. */
export class PiExtensionError extends Error {
  readonly code: PiExtensionErrorCode;
  constructor(code: PiExtensionErrorCode) {
    super("Pi extension resolution failed");
    this.name = "PiExtensionError";
    this.code = code;
  }
}
