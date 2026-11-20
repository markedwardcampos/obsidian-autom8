import { z } from "zod";
import { basename, dirname } from "node:path";
import type { ObsidianExecutor } from "./executor.js";
import { fileExists, readText, vaultFile, writeTextAtomic } from "./vaultfs.js";

/**
 * rotate_log_note: move old day sections of a LIFO log note (e.g. The Bridge Log)
 * into monthly archive notes. All I/O is done on the vault filesystem inside this
 * process, never through a CLI argv string, so it works on notes of any size.
 */

export const rotateLogNoteSchema = z.object({
  path: z.string().describe("Vault-relative path of the live log note, e.g. `8 - Meta/The Bridge Log.md`"),
  archive_folder: z
    .string()
    .describe("Vault-relative folder for monthly archives, e.g. `8 - Meta/Bridge Log Archive`"),
  keep_days: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Distinct dates to keep in the live note (newest first). Default 8."),
  max_bytes: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Size the live note should stay under. Does not change what moves (keep_days decides); a warning is returned if the note is still larger after rotation. Default 80000.",
    ),
  dry_run: z.boolean().optional().describe("Plan only, write nothing. Default true."),
  index_note: z
    .string()
    .optional()
    .describe("Archive index note. Default `<archive_folder>/<folder name>.md`."),
});
export type RotateLogNoteInput = z.infer<typeof rotateLogNoteSchema>;

export interface DaySection {
  date: string;
  start: number;
  end: number;
}

const DAY_HDR = /^#{1,3}[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
export const INDEX_HEADING = "## Months (newest first)";

/** Day sections (`#`/`##`/`###` YYYY-MM-DD headers) in note order. Ignores fenced code and frontmatter. */
export function parseDaySections(text: string): DaySection[] {
  const heads: { date: string; start: number }[] = [];
  let pos = 0;
  let fence: string | null = null;
  let inFrontmatter = text.startsWith("---\n") || text.startsWith("---\r\n");
  let lineNo = 0;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd).replace(/\r$/, "");
    if (inFrontmatter) {
      if (lineNo > 0 && (line === "---" || line === "...")) inFrontmatter = false;
    } else {
      const f = FENCE.exec(line);
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      } else if (f) {
        fence = f[1];
      } else {
        const m = DAY_HDR.exec(line);
        if (m) heads.push({ date: m[1], start: pos });
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  return heads.map((h, i) => ({
    date: h.date,
    start: h.start,
    end: i + 1 < heads.length ? heads[i + 1].start : text.length,
  }));
}

export interface RotationPlan {
  keptDates: string[];
  /** Offset where the archived tail starts; -1 when nothing moves. */
  cut: number;
  head: string;
  tail: string;
  moved: { date: string; month: string; text: string }[];
}

/** Decide what moves. Throws if the old sections are not a contiguous tail. */
export function planRotation(text: string, keepDays: number): RotationPlan {
  const secs = parseDaySections(text);
  const distinct = [...new Set(secs.map((s) => s.date))].sort().reverse();
  const keptDates = distinct.slice(0, keepDays);
  const kept = new Set(keptDates);
  const firstOld = secs.findIndex((s) => !kept.has(s.date));
  if (firstOld === -1) return { keptDates, cut: -1, head: text, tail: "", moved: [] };
  const strays = secs.slice(firstOld).filter((s) => kept.has(s.date));
  if (strays.length) {
    throw new Error(
      `rotate_log_note: kept date(s) ${[...new Set(strays.map((s) => s.date))].join(", ")} appear below ` +
        `archived date ${secs[firstOld].date}; the old sections are not a contiguous tail. Fix the note order first.`,
    );
  }
  const cut = secs[firstOld].start;
  const moved = secs.slice(firstOld).map((s) => ({
    date: s.date,
    month: s.date.slice(0, 7),
    text: text.slice(s.start, s.end).replace(/\s+$/, ""),
  }));
  return { keptDates, cut, head: text.slice(0, cut), tail: text.slice(cut), moved };
}

/** Split `---` frontmatter from body. fm includes the closing `---\n` (or is ""). */
export function splitFrontmatter(text: string): { fm: string; body: string } {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return { fm: "", body: text };
  return { fm: m[0], body: text.slice(m[0].length) };
}

function bumpUpdated(fm: string, today: string): string {
  return fm.replace(/^updated:[ \t]*.*$/m, `updated: ${today}`);
}

function linkTarget(p: string): string {
  return p.replace(/\.md$/i, "");
}

export function todayLocal(): string {
  // en-CA formats as YYYY-MM-DD in the process TZ (container sets TZ).
  return new Date().toLocaleDateString("en-CA");
}

export interface ArchiveNames {
  livePath: string;
  archiveFolder: string;
  indexPath: string;
  today: string;
}

function tagBase(archiveFolder: string): string {
  const slug = basename(archiveFolder)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.replace(/-archive$/, "") || "log";
}

function sourceFolder(livePath: string): string {
  const d = dirname(livePath);
  return d === "." ? "" : d.split("/")[0];
}

export function monthFrontmatter(month: string, n: ArchiveNames): string {
  const title = `${basename(n.archiveFolder)} ${month}`;
  return (
    `---\ntitle: ${title}\ntype: note\nstatus: archived\ncreated: ${n.today}\nupdated: ${n.today}\n` +
    `tags:\n  - ${tagBase(n.archiveFolder)}\n  - archive\nscope: personal\nperiod: ${month}\n` +
    `up: "[[${linkTarget(n.indexPath)}|${basename(linkTarget(n.indexPath))}]]"\n` +
    `live_log: "[[${linkTarget(n.livePath)}]]"\n` +
    `piper_meta:\n  rag_indexed: false\n  last_audit: ${n.today}\n  source_folder: "${sourceFolder(n.livePath)}"\n---\n\n`
  );
}

export interface ArchiveUpdate {
  content: string;
  created: boolean;
  alreadyPresent: boolean;
}

/** `block` occurs in `text` starting at a line and ending at a day-header boundary (or EOF). */
function blockPresent(text: string, block: string): boolean {
  const boundary = /^\s*(?:$|#{1,3}[ \t]+\d{4}-\d{2}-\d{2}[ \t]*(?:\r?\n|$))/;
  for (let i = text.indexOf(block); i !== -1; i = text.indexOf(block, i + 1)) {
    if ((i === 0 || text[i - 1] === "\n") && boundary.test(text.slice(i + block.length))) return true;
  }
  return false;
}

/**
 * New content of a monthly archive with `sectionTexts` (note order, newest first)
 * inserted above the existing archived days. Throws on a LIFO violation.
 */
export function buildArchive(
  existing: string | null,
  month: string,
  sectionTexts: string[],
  n: ArchiveNames,
): ArchiveUpdate {
  const block = sectionTexts.join("\n\n");
  if (existing === null) {
    return { content: monthFrontmatter(month, n) + block + "\n", created: true, alreadyPresent: false };
  }
  if (blockPresent(existing, block)) return { content: existing, created: false, alreadyPresent: true };
  const { fm, body } = splitFrontmatter(existing);
  const secs = parseDaySections(body);
  let newBody: string;
  if (secs.length) {
    const top = secs[0].date;
    const oldestMoved = sectionTexts
      .map((t) => DAY_HDR.exec(t.split("\n", 1)[0])![1])
      .sort()[0];
    if (oldestMoved < top) {
      throw new Error(
        `rotate_log_note: archive for ${month} already starts at ${top}; inserting ${oldestMoved} above it would break LIFO order`,
      );
    }
    newBody = body.slice(0, secs[0].start) + block + "\n\n" + body.slice(secs[0].start);
  } else {
    const trimmed = body.replace(/\s+$/, "");
    newBody = (trimmed ? trimmed + "\n\n" : "") + block + "\n";
  }
  if (fm && !/\n$/.test(fm)) newBody = "\n" + newBody;
  return { content: bumpUpdated(fm, n.today) + newBody, created: false, alreadyPresent: false };
}

function indexScaffold(n: ArchiveNames): string {
  const title = basename(linkTarget(n.indexPath));
  return (
    `---\ntitle: ${title}\ntype: hub\nstatus: active\ncreated: ${n.today}\nupdated: ${n.today}\n` +
    `tags:\n  - ${tagBase(n.archiveFolder)}\n  - archive\n  - hub\nscope: personal\n` +
    `piper_meta:\n  rag_indexed: false\n  last_audit: ${n.today}\n  source_folder: "${sourceFolder(n.livePath)}"\n---\n\n` +
    `# ${title}\n\nOlder day sections of [[${linkTarget(n.livePath)}]], one LIFO note per month. ` +
    `Written by the obsidian-autom8 \`rotate_log_note\` tool.\n\n${INDEX_HEADING}\n`
  );
}

/** Index note content with a `- [[folder/YYYY-MM|YYYY-MM]]` line for every month, newest first. */
export function buildIndex(
  existing: string | null,
  months: string[],
  n: ArchiveNames,
): { content: string; created: boolean; added: string[] } {
  let text = existing ?? indexScaffold(n);
  const created = existing === null;
  const added: string[] = [];
  const folder = linkTarget(n.archiveFolder).replace(/\/$/, "");
  for (const month of [...months].sort()) {
    const target = `${folder}/${month}`;
    if (text.includes(`[[${target}|`) || text.includes(`[[${target}]]`)) continue;
    const line = `- [[${target}|${month}]]`;
    let h = text.indexOf(INDEX_HEADING);
    if (h === -1) {
      text = text.replace(/\s*$/, "") + `\n\n${INDEX_HEADING}\n`;
      h = text.indexOf(INDEX_HEADING);
    }
    // walk the list lines below the heading; insert before the first older month
    const after = text.indexOf("\n", h);
    let pos = after === -1 ? text.length : after + 1;
    let insertAt = -1;
    let lastListEnd = -1;
    while (pos < text.length) {
      const nl = text.indexOf("\n", pos);
      const end = nl === -1 ? text.length : nl;
      const ln = text.slice(pos, end);
      if (ln.trim() === "") {
        if (lastListEnd !== -1) break;
        pos = end + 1;
        continue;
      }
      const m = /^- \[\[[^\]|]*?(\d{4}-\d{2})(?:\|[^\]]*)?\]\]/.exec(ln);
      if (!m) break;
      if (m[1] < month) {
        insertAt = pos;
        break;
      }
      lastListEnd = end;
      pos = end + 1;
    }
    if (insertAt !== -1) {
      text = text.slice(0, insertAt) + line + "\n" + text.slice(insertAt);
    } else if (lastListEnd !== -1) {
      text = text.slice(0, lastListEnd) + "\n" + line + text.slice(lastListEnd);
    } else {
      // empty list: put it right under the heading with one blank line
      const headEnd = after === -1 ? text.length : after;
      const rest = text.slice(headEnd).replace(/^\n*/, "");
      text = text.slice(0, headEnd) + "\n\n" + line + "\n" + (rest ? "\n" + rest : "");
    }
    added.push(month);
  }
  if (!created && added.length) {
    const { fm, body } = splitFrontmatter(text);
    text = bumpUpdated(fm, n.today) + body;
  }
  return { content: text, created, added };
}

export interface RotateResult {
  dry_run: boolean;
  path: string;
  bytes_before: number;
  bytes_after: number;
  kept_dates: string[];
  sections_moved: number;
  moved: { date: string; month: string; bytes: number }[];
  archives: {
    path: string;
    created: boolean;
    already_present: boolean;
    sections: number;
    bytes_before: number;
    bytes_after: number;
  }[];
  index: { path: string; created: boolean; added_months: string[] } | null;
  verification: {
    archives_ok: boolean | null;
    sections_checked: number;
    missing: string[];
    live_ok: boolean | null;
  };
  warnings: string[];
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

export async function rotateLogNote(
  executor: ObsidianExecutor,
  input: RotateLogNoteInput,
): Promise<RotateResult> {
  const keepDays = input.keep_days ?? 8;
  const maxBytes = input.max_bytes ?? 80_000;
  const dryRun = input.dry_run ?? true;
  const archiveFolder = input.archive_folder.replace(/\/+$/, "");
  const indexPath = input.index_note ?? `${archiveFolder}/${basename(archiveFolder)}.md`;
  const n: ArchiveNames = { livePath: input.path, archiveFolder, indexPath, today: todayLocal() };

  // resolve paths before entering the queue (resolveVaultPath may call the CLI)
  const liveAbs = await vaultFile(executor, input.path);
  const indexAbs = await vaultFile(executor, indexPath);
  await vaultFile(executor, `${archiveFolder}/x.md`);

  return executor.enqueue(async () => {
    if (!(await fileExists(liveAbs))) throw new Error(`rotate_log_note: note not found: ${input.path}`);
    const live = await readText(liveAbs);
    const plan = planRotation(live, keepDays);
    const warnings: string[] = [];
    const result: RotateResult = {
      dry_run: dryRun,
      path: input.path,
      bytes_before: bytes(live),
      bytes_after: bytes(live),
      kept_dates: plan.keptDates,
      sections_moved: plan.moved.length,
      moved: plan.moved.map((m) => ({ date: m.date, month: m.month, bytes: bytes(m.text) })),
      archives: [],
      index: null,
      verification: { archives_ok: null, sections_checked: 0, missing: [], live_ok: null },
      warnings,
    };
    if (!plan.moved.length) {
      if (result.bytes_before > maxBytes)
        warnings.push(`nothing older than ${keepDays} dates, but the note is ${result.bytes_before} B > max_bytes ${maxBytes}; lower keep_days`);
      return result;
    }
    const newLive = plan.head.replace(/\s+$/, "") + "\n";
    result.bytes_after = bytes(newLive);
    if (result.bytes_after > maxBytes)
      warnings.push(`live note would still be ${result.bytes_after} B > max_bytes ${maxBytes}; lower keep_days`);

    // ---- plan every write before doing any
    const byMonth = new Map<string, string[]>();
    for (const m of plan.moved) {
      if (!byMonth.has(m.month)) byMonth.set(m.month, []);
      byMonth.get(m.month)!.push(m.text);
    }
    const writes: { rel: string; abs: string; content: string }[] = [];
    for (const [month, texts] of [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
      const rel = `${archiveFolder}/${month}.md`;
      const abs = await vaultFile(executor, rel);
      const existing = (await fileExists(abs)) ? await readText(abs) : null;
      const upd = buildArchive(existing, month, texts, n);
      result.archives.push({
        path: rel,
        created: upd.created,
        already_present: upd.alreadyPresent,
        sections: texts.length,
        bytes_before: existing === null ? 0 : bytes(existing),
        bytes_after: bytes(upd.content),
      });
      if (!upd.alreadyPresent) writes.push({ rel, abs, content: upd.content });
    }
    const indexExisting = (await fileExists(indexAbs)) ? await readText(indexAbs) : null;
    const idx = buildIndex(indexExisting, [...byMonth.keys()], n);
    result.index = { path: indexPath, created: idx.created, added_months: idx.added };
    if (idx.created || idx.added.length) writes.push({ rel: indexPath, abs: indexAbs, content: idx.content });

    if (dryRun) return result;

    // ---- 1) archives + index, then verify. Any failure aborts before the live note is touched.
    for (const w of writes) {
      try {
        await writeTextAtomic(w.abs, w.content);
      } catch (err) {
        throw new Error(`rotate_log_note: write failed for ${w.rel}; live note NOT touched: ${String(err)}`);
      }
    }
    const archiveText = new Map<string, string>();
    for (const a of result.archives) archiveText.set(a.path, await readText(await vaultFile(executor, a.path)));
    for (const m of plan.moved) {
      result.verification.sections_checked++;
      if (!archiveText.get(`${archiveFolder}/${m.month}.md`)!.includes(m.text)) result.verification.missing.push(m.date);
    }
    result.verification.archives_ok = result.verification.missing.length === 0;
    if (!result.verification.archives_ok) {
      throw new Error(
        `rotate_log_note: verification failed, sections not found verbatim in archives: ${result.verification.missing.join(", ")}; live note NOT touched`,
      );
    }

    // ---- 2) cut the tail. Re-read: entries added at the top meanwhile must survive.
    const current = await readText(liveAbs);
    const tailTrim = plan.tail.replace(/\s+$/, "");
    const curTrim = current.replace(/\s+$/, "");
    if (!curTrim.endsWith(tailTrim)) {
      throw new Error(
        "rotate_log_note: the live note changed below the cut point after planning; archives are written and verified, live note NOT touched. Re-run to finish.",
      );
    }
    const cutLive = curTrim.slice(0, curTrim.length - tailTrim.length).replace(/\s+$/, "") + "\n";
    await writeTextAtomic(liveAbs, cutLive);
    const after = await readText(liveAbs);
    const movedDates = new Set(plan.moved.map((m) => m.date));
    const leftover = parseDaySections(after).filter((s) => movedDates.has(s.date));
    result.verification.live_ok = after === cutLive && leftover.length === 0;
    result.bytes_after = bytes(after);
    if (!result.verification.live_ok) warnings.push("live note re-read did not match what was written");
    return result;
  });
}
