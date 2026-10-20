import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_LOG_BYTES = 256 * 1024 * 1024;

/**
 * Reads a file a worker could have replaced (R39): opened with O_NOFOLLOW and O_NONBLOCK so a symlink is refused and a FIFO cannot
 * block, then `fstat`ed on the open descriptor and read only when it is a regular file within `maxBytes`.
 * Throws `unsafe_read` for a symlink, a non-regular file or an oversize file; other errors (ENOENT) pass through.
 */
export async function readRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENXIO" || code === "EACCES" || code === "EISDIR") throw new Error("unsafe_read");
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("unsafe_read");
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== buffer.length) throw new Error("unsafe_read");
    return buffer;
  } finally {
    await handle.close();
  }
}
