import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

/** File name of Pi's persisted model catalog overlay, next to `auth.json` in an agent directory. */
export const MODELS_STORE_FILE = "models-store.json";

/** Upper bound for the copied catalog; a larger file is skipped rather than read into memory. */
export const MODELS_STORE_MAX_BYTES = 32 * 1024 * 1024;

/** The host's persisted catalog overlay, resolved like the host `auth.json` the launcher reads. */
export const hostModelsStorePath = (home: string): string => join(home, ".pi", "agent", MODELS_STORE_FILE);

/**
 * Copies the host's persisted Pi model catalog into a writer's private agent directory, so the writer's Pi resolves the
 * same models as the host (#199). The file holds model catalog data, not credentials, and is copied byte for byte: it is
 * neither parsed nor printed. A missing, non-regular, symbolic-link or oversized source is skipped, and so is any failure:
 * the destination is then removed, so neither a stale copy nor a file left by a worker in the writable agent directory
 * survives, and the writer keeps the static model list shipped with the SDK. The destination is replaced by an atomic
 * rename of a 0600 temporary file, so a link at the destination path is replaced, never followed. Returns whether a copy
 * was made.
 */
export async function copyModelsStore(source: string, agentDir: string): Promise<boolean> {
  const copied = await copy(source, agentDir);
  if (!copied) await unlink(join(agentDir, MODELS_STORE_FILE)).catch(() => undefined);
  return copied;
}

async function copy(source: string, agentDir: string): Promise<boolean> {
  let temporary: string | undefined;
  try {
    // O_NOFOLLOW refuses a symbolic link at the source path; the opened file is checked again after open.
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let content: Buffer;
    try {
      const stat = await input.stat();
      if (!stat.isFile() || stat.size > MODELS_STORE_MAX_BYTES) return false;
      content = await input.readFile();
    } finally { await input.close(); }
    if (content.length > MODELS_STORE_MAX_BYTES) return false;
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    temporary = join(agentDir, `.${MODELS_STORE_FILE}-${randomUUID()}.tmp`);
    const output = await open(temporary, "wx", 0o600);
    try {
      await output.writeFile(content);
      await output.sync();
    } finally { await output.close(); }
    await rename(temporary, join(agentDir, MODELS_STORE_FILE));
    temporary = undefined;
    return true;
  } catch { return false; } finally {
    if (temporary !== undefined) await unlink(temporary).catch(() => undefined);
  }
}
