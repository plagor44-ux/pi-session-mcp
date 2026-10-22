import { createHash, randomUUID } from "node:crypto";
import { wrapperDigest } from "./writer-wrapper.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PACKAGE_VERSION } from "./package-metadata.js";
import { ALIAS_PATTERN } from "./execution-profile.js";

export const WRITER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}-w([1-9]|1[0-6])$/;

export class WriterStateError extends Error {
  constructor(readonly code: "writer_state_invalid" | "writer_state_unreadable") {
    super(code);
    this.name = "WriterStateError";
  }
}

const aliasSchema = z.string().regex(ALIAS_PATTERN);
const indexSchema = z.number().int().min(1).max(16);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const writerStateSchema = z.object({
  schemaVersion: z.literal(1),
  alias: aliasSchema,
  index: indexSchema,
  phase: z.enum(["provisioning", "ready", "not_ready"]),
  lifecycle: z.enum(["persistent", "ephemeral"]),
  profiles: z.array(aliasSchema).min(1).readonly(),
  providers: z.array(z.object({
    provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    model: z.string().min(1).max(200),
  }).strict()).refine((providers) => new Set(providers.map(({ provider }) => provider)).size === providers.length).readonly(),
  network: z.enum(["pasta", "none"]),
  cache: z.enum(["none", "go"]),
  imageId: hex64,
  base: z.object({ ref: z.string(), commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }).strict(),
  acceptance: z.object({
    fingerprint: z.string(), verdict: z.literal("pass"), network: z.enum(["limited", "not_limited"]), at: z.string(),
  }).strict().optional(),
  collected: z.object({ digest: z.string(), at: z.string() }).strict().optional(),
}).strict();

export type WriterState = z.infer<typeof writerStateSchema>;

export function writerName(alias: string, index: number): string {
  if (!aliasSchema.safeParse(alias).success || !indexSchema.safeParse(index).success) {
    throw new WriterStateError("writer_state_invalid");
  }
  return `${alias}-w${index}`;
}

function validateName(name: string): void {
  if (!WRITER_NAME_PATTERN.test(name)) throw new WriterStateError("writer_state_invalid");
}

export function writerRegistrationName(name: string): string {
  validateName(name);
  return `pi-coding-${name}`;
}

export function writersRoot(home: string): string {
  return join(home, ".local", "state", "pi-session-mcp", "writers");
}

export function writerPaths(home: string, name: string) {
  validateName(name);
  const root = join(writersRoot(home), name);
  return {
    root, clone: join(root, "clone"), agent: join(root, "agent"), bundles: join(root, "bundles"),
    config: join(root, "config"), events: join(root, "events"), go: join(root, "go"), wrapper: join(root, "wrapper.sh"), state: join(root, "state.json"),
  };
}

function validateState(raw: unknown, name: string): WriterState {
  const parsed = writerStateSchema.safeParse(raw);
  if (!parsed.success || writerName(parsed.data.alias, parsed.data.index) !== name) {
    throw new WriterStateError("writer_state_invalid");
  }
  return parsed.data;
}

export async function readWriterState(home: string, name: string): Promise<WriterState | undefined> {
  const path = writerPaths(home, name).state;
  let stat;
  try { stat = await lstat(path); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new WriterStateError("writer_state_unreadable");
  }
  if (!stat.isFile()) throw new WriterStateError("writer_state_invalid");
  try {
    // Recheck the opened file and do not follow a symlink swapped in after lstat.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new WriterStateError("writer_state_invalid");
      return validateState(JSON.parse(await handle.readFile("utf8")) as unknown, name);
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof WriterStateError) throw error;
    if (error instanceof SyntaxError) throw new WriterStateError("writer_state_invalid");
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT") return undefined;
      if (error.code === "ELOOP") throw new WriterStateError("writer_state_invalid");
    }
    throw new WriterStateError("writer_state_unreadable");
  }
}

export async function writeWriterState(home: string, name: string, state: WriterState): Promise<void> {
  const paths = writerPaths(home, name);
  const validated = validateState(state, name);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const temporary = join(paths.root, `.state-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, paths.state);
    const directory = await open(paths.root, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (created) await unlink(temporary).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}

/**
 * Whether the writer's own server configuration (the one mounted at /pi/config) enables event delivery.
 * Anything unreadable or unexpected counts as disabled, so a doubtful configuration never adds the spool mount.
 */
export async function writerEventDeliveryEnabled(configDirectory: string): Promise<boolean> {
  try {
    const handle = await open(join(configDirectory, "pi-session-mcp.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return false;
      const config: unknown = JSON.parse(await handle.readFile("utf8"));
      if (config === null || typeof config !== "object" || Array.isArray(config)) return false;
      const events = (config as Record<string, unknown>).events;
      return events !== null && typeof events === "object" && !Array.isArray(events)
        && Object.keys(events).length === 1 && (events as Record<string, unknown>).delivery === "spool";
    } finally { await handle.close(); }
  } catch { return false; }
}

/**
 * The writer's own configuration sits next to its wrapper (`<root>/config`), so acceptance, launch
 * and Doctor all read event delivery from the same place. Delivery is part of the fingerprint only
 * when it is enabled: an accepted writer without delivery keeps its fingerprint, and enabling
 * delivery (a new spool mount in the boundary) needs a new acceptance.
 */
export async function currentAcceptanceFingerprint(wrapper: string, state: WriterState, podmanVersion: string): Promise<string> {
  const eventDelivery = await writerEventDeliveryEnabled(join(dirname(wrapper), "config"));
  return acceptanceFingerprint({ wrapperDigest: wrapperDigest(await readFile(wrapper, "utf8")), packageVersion: PACKAGE_VERSION,
    imageId: state.imageId, podmanVersion, network: state.network, cache: state.cache, ...(eventDelivery ? { eventDelivery } : {}) });
}

export function acceptanceFingerprint(input: {
  wrapperDigest: string;
  packageVersion: string;
  imageId: string;
  podmanVersion: string;
  network: string;
  cache: string;
  /** Present only for an enabled delivery; an absent value must not change the canonical text of earlier fingerprints. */
  eventDelivery?: boolean;
}): string {
  const canonical = JSON.stringify({
    cache: input.cache, ...(input.eventDelivery ? { eventDelivery: true } : {}), imageId: input.imageId, network: input.network,
    packageVersion: input.packageVersion, podmanVersion: input.podmanVersion, wrapperDigest: input.wrapperDigest,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
