import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep, basename } from "node:path";
import { randomBytes } from "node:crypto";
import type { ObsidianExecutor } from "./executor.js";

/**
 * Direct vault filesystem I/O, done inside the MCP server process.
 *
 * Why: the Obsidian CLI takes note content as a `content=<text>` argv string,
 * and Linux caps one argv string at MAX_ARG_STRLEN (128 KiB). Large writes
 * through the CLI fail with `spawn E2BIG`. Reading/writing the vault files
 * directly has no such ceiling; Obsidian's file watcher picks the change up.
 */

/** Resolve a vault-relative path to an absolute path, refusing escapes. */
export async function vaultFile(executor: ObsidianExecutor, relPath: string): Promise<string> {
  const root = resolve(await executor.resolveVaultPath());
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`path escapes the vault: ${relPath}`);
  }
  if (abs === root) throw new Error(`path is the vault root: ${relPath}`);
  return abs;
}

export async function fileExists(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

export async function readText(abs: string): Promise<string> {
  return readFile(abs, "utf8");
}

/**
 * Atomic write: dot-prefixed temp file in the same folder (Obsidian ignores
 * dotfiles), fsync'd by writeFile's close, then rename over the target.
 */
export async function writeTextAtomic(abs: string, content: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.${basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, content, { encoding: "utf8", flush: true });
    await rename(tmp, abs);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
