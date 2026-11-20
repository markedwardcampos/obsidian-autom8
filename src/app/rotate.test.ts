import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObsidianExecutor } from "./executor.js";
import {
  parseDaySections,
  planRotation,
  buildArchive,
  buildIndex,
  rotateLogNote,
  splitFrontmatter,
  todayLocal,
  INDEX_HEADING,
  type ArchiveNames,
} from "./rotate.js";

const NAMES: ArchiveNames = {
  livePath: "8 - Meta/The Bridge Log.md",
  archiveFolder: "8 - Meta/Bridge Log Archive",
  indexPath: "8 - Meta/Bridge Log Archive/Bridge Log Archive.md",
  today: "2026-11-20",
};

/** One day section: header + body, followed by a blank line (as in a real log). */
const day = (date: string, body = "- entry", hdr = "#"): string => `${hdr} ${date}\n${body}\n\n`;
const dates = (text: string): string[] => parseDaySections(text).map((s) => s.date);

// ---------------------------------------------------------------------------
describe("parseDaySections", () => {
  it("recognises #, ##, ### date headers", () => {
    const text = "# 2026-11-20\na\n\n## 2026-11-19\nb\n\n### 2026-11-18\nc\n";
    const secs = parseDaySections(text);
    expect(secs.map((s) => s.date)).toEqual(["2026-11-20", "2026-11-19", "2026-11-18"]);
  });

  it("does not treat #### or non-date headers as day headers", () => {
    const text = "#### 2026-11-20\nx\n# Notes\ny\n# 2026-11-19\nz\n# 2026-1-5\nw\n";
    expect(dates(text)).toEqual(["2026-11-19"]);
  });

  it("ignores headers inside ``` fences", () => {
    const text = "# 2026-11-20\n```md\n# 2026-11-19\n```\n# 2026-11-18\nz\n";
    expect(dates(text)).toEqual(["2026-11-20", "2026-11-18"]);
  });

  it("ignores headers inside ~~~ fences", () => {
    const text = "# 2026-11-20\n~~~\n# 2026-11-19\n~~~\n# 2026-11-18\nz\n";
    expect(dates(text)).toEqual(["2026-11-20", "2026-11-18"]);
  });

  it("a ~~~ line inside a ``` fence does not close it, and vice versa", () => {
    const text = "```\n~~~\n# 2026-11-19\n```\n# 2026-11-18\n~~~\n```\n# 2026-11-17\n~~~\n# 2026-11-16\n";
    expect(dates(text)).toEqual(["2026-11-18", "2026-11-16"]);
  });

  it("a shorter fence does not close a longer one", () => {
    const text = "````\n```\n# 2026-11-19\n```\n````\n# 2026-11-18\n";
    expect(dates(text)).toEqual(["2026-11-18"]);
  });

  it("ignores date headers inside frontmatter", () => {
    const text = "---\ntitle: x\n# 2026-11-01\n---\n\n# 2026-11-20\na\n";
    expect(dates(text)).toEqual(["2026-11-20"]);
  });

  it("handles CRLF frontmatter and headers", () => {
    const text = "---\r\ntitle: x\r\n# 2026-11-01\r\n---\r\n\r\n# 2026-11-20\r\na\r\n";
    expect(dates(text)).toEqual(["2026-11-20"]);
  });

  it("a header with trailing text is NOT a day header", () => {
    expect(dates("# 2026-11-20 notes\nx\n")).toEqual([]);
    expect(dates("# 2026-11-20 \nx\n")).toEqual(["2026-11-20"]); // trailing whitespace only is fine
  });

  it("returns [] for empty text and text without headers", () => {
    expect(parseDaySections("")).toEqual([]);
    expect(parseDaySections("just prose\n")).toEqual([]);
  });

  it("section offsets cover the full text after the first header", () => {
    const pre = "> [!note] preamble\n\n";
    const text = pre + "# 2026-11-20\na\n\n## 2026-11-19\nb\n\n### 2026-11-18\nc";
    const secs = parseDaySections(text);
    expect(secs).toHaveLength(3);
    expect(secs[0].start).toBe(pre.length);
    expect(secs[secs.length - 1].end).toBe(text.length);
    for (let i = 0; i < secs.length - 1; i++) expect(secs[i].end).toBe(secs[i + 1].start);
    expect(secs.map((s) => text.slice(s.start, s.end)).join("")).toBe(text.slice(pre.length));
    expect(text.slice(secs[1].start, secs[1].end)).toBe("## 2026-11-19\nb\n\n");
  });
});

// ---------------------------------------------------------------------------
describe("planRotation", () => {
  const pre = "> [!info] The Bridge Log\n> newest first\n\n";

  it("keeps the newest keep_days distinct dates and moves the rest", () => {
    const text = pre + day("2026-11-20") + day("2026-11-19") + day("2026-11-18") + day("2026-11-17");
    const plan = planRotation(text, 2);
    expect(plan.keptDates).toEqual(["2026-11-20", "2026-11-19"]);
    expect(plan.moved.map((m) => m.date)).toEqual(["2026-11-18", "2026-11-17"]);
    expect(plan.head + plan.tail).toBe(text);
    expect(plan.cut).toBe(text.indexOf("# 2026-11-18"));
    expect(plan.tail.startsWith("# 2026-11-18")).toBe(true);
  });

  it("counts distinct dates: duplicate date headers all stay", () => {
    const text =
      day("2026-11-20") + day("2026-11-18", "one") + day("2026-11-18", "two") + day("2026-11-18", "three") + day("2026-11-17");
    const plan = planRotation(text, 2);
    expect(plan.keptDates).toEqual(["2026-11-20", "2026-11-18"]);
    expect(plan.moved.map((m) => m.date)).toEqual(["2026-11-17"]);
    expect(plan.head).toContain("one");
    expect(plan.head).toContain("two");
    expect(plan.head).toContain("three");
    expect(plan.head.match(/^# 2026-11-18$/gm)).toHaveLength(3);
  });

  it("returns cut -1 and the whole text as head when nothing moves", () => {
    const text = pre + day("2026-11-20") + day("2026-11-19");
    for (const keep of [2, 3, 8]) {
      const plan = planRotation(text, keep);
      expect(plan.cut).toBe(-1);
      expect(plan.moved).toEqual([]);
      expect(plan.head).toBe(text);
      expect(plan.tail).toBe("");
    }
  });

  it("handles a note with no day headers", () => {
    const plan = planRotation("just text\n", 3);
    expect(plan.cut).toBe(-1);
    expect(plan.keptDates).toEqual([]);
  });

  it("keeps the preamble (callout above the first header) in head", () => {
    const text = pre + day("2026-11-20") + day("2026-11-19") + day("2026-11-18");
    const plan = planRotation(text, 1);
    expect(plan.head.startsWith(pre)).toBe(true);
    expect(plan.head).toContain("# 2026-11-20");
    expect(plan.head).not.toContain("2026-11-19");
    expect(plan.tail).not.toContain("[!info]");
  });

  it("throws when a kept date appears below an older archived date", () => {
    const text = day("2026-11-20") + day("2026-11-10") + day("2026-11-19") + day("2026-11-18");
    expect(() => planRotation(text, 3)).toThrow(/2026-11-19.*appear below.*2026-11-10/s);
    expect(() => planRotation(text, 3)).toThrow(/not a contiguous tail/);
  });

  it("does not throw when keep_days covers the out-of-order old date too", () => {
    const text = day("2026-11-20") + day("2026-11-10") + day("2026-11-19");
    expect(planRotation(text, 3).cut).toBe(-1);
  });

  it("moved texts are trailing-whitespace-trimmed, newest first (note order), with a month", () => {
    const text =
      day("2026-11-20") + "## 2026-11-02\nbody2  \n\n\n" + "### 2026-10-31\nbody1\n\t\n\n\n" + "# 2026-10-30\nlast";
    const plan = planRotation(text, 1);
    expect(plan.moved).toEqual([
      { date: "2026-11-02", month: "2026-11", text: "## 2026-11-02\nbody2" },
      { date: "2026-10-31", month: "2026-10", text: "### 2026-10-31\nbody1" },
      { date: "2026-10-30", month: "2026-10", text: "# 2026-10-30\nlast" },
    ]);
  });

  it("keep_days larger than the number of dates keeps everything", () => {
    const text = day("2026-11-20") + day("2026-11-19");
    expect(planRotation(text, 100).keptDates).toEqual(["2026-11-20", "2026-11-19"]);
  });
});

// ---------------------------------------------------------------------------
describe("buildArchive", () => {
  const block = "# 2026-11-03\nc\n\n# 2026-11-02\nb";
  const texts = ["# 2026-11-03\nc", "# 2026-11-02\nb"];
  const fm = (updated: string): string =>
    `---\ntitle: Bridge Log Archive 2026-11\ncreated: 2026-11-10\nupdated: ${updated}\nperiod: 2026-11\n---\n\n`;

  it("creates a new note: frontmatter + block + single trailing newline", () => {
    const r = buildArchive(null, "2026-11", texts, NAMES);
    expect(r.created).toBe(true);
    expect(r.alreadyPresent).toBe(false);
    expect(r.content.startsWith("---\n")).toBe(true);
    expect(r.content.endsWith(block + "\n")).toBe(true);
    const { fm: f, body } = splitFrontmatter(r.content);
    expect(body).toBe("\n" + block + "\n"); // body keeps the blank line that followed the frontmatter
    expect(f).toContain("title: Bridge Log Archive 2026-11\n");
    expect(f).toContain("period: 2026-11\n");
    expect(f).toContain("created: 2026-11-20\n");
    expect(f).toContain("updated: 2026-11-20\n");
    expect(f).toContain('up: "[[8 - Meta/Bridge Log Archive/Bridge Log Archive|Bridge Log Archive]]"\n');
    expect(f).toContain('live_log: "[[8 - Meta/The Bridge Log]]"\n');
    expect(f).toContain("tags:\n  - bridge-log\n  - archive\n");
    expect(f).toContain('source_folder: "8 - Meta"\n');
  });

  it("derives tags from the folder name (strips -archive, slugifies, fallback log)", () => {
    const tag = (folder: string): string => {
      const c = buildArchive(null, "2026-11", texts, { ...NAMES, archiveFolder: folder }).content;
      return /tags:\n {2}- (.*)\n/.exec(c)![1];
    };
    expect(tag("8 - Meta/Bridge Log Archive")).toBe("bridge-log");
    expect(tag("Logs/Captain's Journal")).toBe("captain-s-journal");
    expect(tag("Archive")).toBe("archive"); // no "-archive" suffix to strip
    expect(tag("Stuff/!!!")).toBe("log");
  });

  it("existing note: inserts block above the first day header, bumps updated, rest byte-identical", () => {
    const existing = fm("2026-11-10") + "> keep me\n\n# 2026-11-01\nold\n\n# 2026-10-31\nolder\n";
    const r = buildArchive(existing, "2026-11", texts, NAMES);
    expect(r.created).toBe(false);
    expect(r.alreadyPresent).toBe(false);
    const expected = fm("2026-11-20") + "> keep me\n\n" + block + "\n\n# 2026-11-01\nold\n\n# 2026-10-31\nolder\n";
    expect(r.content).toBe(expected);
    // everything except the updated line is byte-identical
    expect(r.content.replace(block + "\n\n", "").replace("updated: 2026-11-20", "updated: 2026-11-10")).toBe(existing);
  });

  it("existing note whose top date is newer than the oldest moved date throws (LIFO)", () => {
    const existing = fm("2026-11-10") + "# 2026-11-05\nnewer\n";
    // moved block spans 11-03..11-02 which are older than the existing top 11-05
    expect(() => buildArchive(existing, "2026-11", texts, NAMES)).toThrow(/would break LIFO order/);
  });

  it("existing top date equal to the oldest moved date is allowed", () => {
    const existing = fm("2026-11-10") + "# 2026-11-02\nsplit day\n";
    const r = buildArchive(existing, "2026-11", ["# 2026-11-03\nc"], NAMES);
    expect(r.content).toContain("# 2026-11-03\nc\n\n# 2026-11-02\nsplit day");
  });

  it("exact block already present: alreadyPresent true and content unchanged", () => {
    const existing = fm("2026-11-10") + block + "\n\n# 2026-11-01\nold\n";
    const r = buildArchive(existing, "2026-11", texts, NAMES);
    expect(r.alreadyPresent).toBe(true);
    expect(r.created).toBe(false);
    expect(r.content).toBe(existing);
  });

  it("a moved section that is only a prefix of a longer archived section is NOT treated as present", () => {
    const existing = fm("2026-11-10") + "# 2026-11-03\nc\n- later extra line\n\n# 2026-11-01\nold\n";
    const r = buildArchive(existing, "2026-11", ["# 2026-11-03\nc"], NAMES);
    expect(r.alreadyPresent).toBe(false);
    expect(r.content).toContain("# 2026-11-03\nc\n\n# 2026-11-03\nc\n- later extra line");
  });

  it("existing note with no day headers: appends after existing body", () => {
    const existing = fm("2026-11-10") + "Some prose.\n\n\n";
    const r = buildArchive(existing, "2026-11", texts, NAMES);
    expect(r.content).toBe(fm("2026-11-20") + "Some prose.\n\n" + block + "\n");
  });

  it("existing note with frontmatter only appends the block", () => {
    const existing = fm("2026-11-10");
    const r = buildArchive(existing, "2026-11", texts, NAMES);
    // NOTE: current behaviour drops the blank line between `---` and the block (cosmetic only; valid markdown)
    expect(r.content).toBe(fm("2026-11-20").replace(/\n+$/, "\n") + block + "\n");
  });

  it("existing note without frontmatter: inserts above first header, nothing bumped", () => {
    const existing = "# 2026-11-01\nold\n";
    const r = buildArchive(existing, "2026-11", texts, NAMES);
    expect(r.content).toBe(block + "\n\n" + existing);
  });

  it("day header inside a code fence in the existing note is not the insertion point", () => {
    const existing = fm("2026-11-10") + "```\n# 2026-11-30\n```\n\n# 2026-11-01\nold\n";
    const r = buildArchive(existing, "2026-11", texts, NAMES);
    expect(r.content).toBe(fm("2026-11-20") + "```\n# 2026-11-30\n```\n\n" + block + "\n\n# 2026-11-01\nold\n");
  });
});

// ---------------------------------------------------------------------------
describe("buildIndex", () => {
  const folder = "8 - Meta/Bridge Log Archive";
  const line = (m: string): string => `- [[${folder}/${m}|${m}]]`;
  const listLines = (c: string): string[] => c.split("\n").filter((l) => l.startsWith("- [["));
  const base = (lines: string[], trailing = "\n"): string =>
    `---\ntitle: Bridge Log Archive\nupdated: 2026-11-01\n---\n\n# Bridge Log Archive\n\n${INDEX_HEADING}\n\n${lines.join("\n")}${trailing}`;

  it("creates the scaffold with the heading and link lines when missing", () => {
    const r = buildIndex(null, ["2026-10", "2026-11"], NAMES);
    expect(r.created).toBe(true);
    expect(r.added).toEqual(["2026-10", "2026-11"]);
    expect(r.content).toContain("title: Bridge Log Archive\n");
    expect(r.content).toContain("type: hub\n");
    expect(r.content).toContain("# Bridge Log Archive\n");
    expect(r.content).toContain("[[8 - Meta/The Bridge Log]]");
    expect(r.content).toContain(`\n${INDEX_HEADING}\n\n`);
    expect(listLines(r.content)).toEqual([line("2026-11"), line("2026-10")]);
    expect(r.content.endsWith(line("2026-10") + "\n")).toBe(true);
  });

  it("inserts a newer month above existing lines", () => {
    const r = buildIndex(base([line("2026-11"), line("2026-10")]), ["2026-12"], NAMES);
    expect(r.created).toBe(false);
    expect(r.added).toEqual(["2026-12"]);
    expect(listLines(r.content)).toEqual([line("2026-12"), line("2026-11"), line("2026-10")]);
  });

  it("appends an older month below existing lines", () => {
    const r = buildIndex(base([line("2026-11"), line("2026-10")]), ["2026-09"], NAMES);
    expect(listLines(r.content)).toEqual([line("2026-11"), line("2026-10"), line("2026-09")]);
    expect(r.content.endsWith(line("2026-09") + "\n")).toBe(true);
  });

  it("inserts a middle month in the right place", () => {
    const r = buildIndex(base([line("2026-11"), line("2026-09")]), ["2026-10"], NAMES);
    expect(listLines(r.content)).toEqual([line("2026-11"), line("2026-10"), line("2026-09")]);
  });

  it("works when the existing index has no trailing newline (Obsidian CLI trims)", () => {
    const older = buildIndex(base([line("2026-11")], ""), ["2026-10"], NAMES);
    expect(listLines(older.content)).toEqual([line("2026-11"), line("2026-10")]);
    const newer = buildIndex(base([line("2026-11")], ""), ["2026-12"], NAMES);
    expect(listLines(newer.content)).toEqual([line("2026-12"), line("2026-11")]);
    const middle = buildIndex(base([line("2026-11"), line("2026-09")], ""), ["2026-10"], NAMES);
    expect(listLines(middle.content)).toEqual([line("2026-11"), line("2026-10"), line("2026-09")]);
    // no stray joined lines
    for (const r of [older, newer, middle]) expect(r.content).not.toMatch(/\]\]- \[\[/);
  });

  it("handles several new months at once, interleaved with existing", () => {
    const r = buildIndex(base([line("2026-10")], ""), ["2026-08", "2026-12", "2026-11", "2026-09"], NAMES);
    expect(listLines(r.content)).toEqual(["2026-12", "2026-11", "2026-10", "2026-09", "2026-08"].map(line));
    expect(r.added.sort()).toEqual(["2026-08", "2026-09", "2026-11", "2026-12"]);
  });

  it("skips months already linked (piped or bare), never duplicates", () => {
    const existing = base([line("2026-11"), `- [[${folder}/2026-10]]`]);
    const r = buildIndex(existing, ["2026-11", "2026-10"], NAMES);
    expect(r.added).toEqual([]);
    expect(r.content).toBe(existing);
    const again = buildIndex(buildIndex(base([line("2026-11")]), ["2026-10"], NAMES).content, ["2026-10"], NAMES);
    expect(again.added).toEqual([]);
    expect(listLines(again.content)).toEqual([line("2026-11"), line("2026-10")]);
  });

  it("bumps updated: in an existing index only when something was added", () => {
    const added = buildIndex(base([line("2026-10")]), ["2026-11"], NAMES);
    expect(added.content).toContain("updated: 2026-11-20\n");
    const untouched = buildIndex(base([line("2026-10")]), ["2026-10"], NAMES);
    expect(untouched.content).toContain("updated: 2026-11-01\n");
  });

  it("adds the heading when an existing index lacks it", () => {
    const r = buildIndex("# Bridge Log Archive\n\nintro", ["2026-11"], NAMES);
    expect(r.content).toBe(`# Bridge Log Archive\n\nintro\n\n${INDEX_HEADING}\n\n${line("2026-11")}\n`);
  });

  it("puts the first link under an empty heading and keeps text below it", () => {
    const r = buildIndex(`${INDEX_HEADING}\n\n## Notes\nhello\n`, ["2026-11"], NAMES);
    expect(r.content).toBe(`${INDEX_HEADING}\n\n${line("2026-11")}\n\n## Notes\nhello\n`);
  });
});

// ---------------------------------------------------------------------------
describe("rotateLogNote (filesystem)", () => {
  const LIVE = "8 - Meta/The Bridge Log.md";
  const FOLDER = "8 - Meta/Bridge Log Archive";
  const INDEX = `${FOLDER}/Bridge Log Archive.md`;
  const PREAMBLE = "> [!info] The Bridge Log\n> Newest day first. Older days live in the archive.\n\n";

  let root: string;
  let executor: ObsidianExecutor;
  const abs = (rel: string): string => join(root, rel);

  beforeEach(async () => {
    root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "rotate-test-"));
    await mkdir(abs("8 - Meta"), { recursive: true });
    executor = {
      resolveVaultPath: async () => root,
      enqueue: <T>(fn: () => Promise<T>) => fn(),
    } as unknown as ObsidianExecutor;
  });

  afterEach(async () => {
    await chmod(abs(FOLDER), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  /** Deterministic ~6 KB filler so each day is large. */
  const filler = (tag: string): string =>
    Array.from({ length: 60 }, (_, i) => `- ${tag} line ${i}: ${"lorem ipsum dolor sit amet ".repeat(3).trim()}`).join("\n");

  interface Gen {
    live: string;
    sections: { date: string; hdr: string; text: string }[]; // note order, trimmed text
  }

  /**
   * 20 distinct dates: 2026-11-12 .. 2026-11-01 (12) and 2026-10-31 .. 2026-10-24 (8),
   * newest first, with duplicate headers for 11-12 (x3, kept) and 11-03 (x2, moved).
   */
  function generateLog(): Gen {
    const ds: string[] = [];
    for (let d = 12; d >= 1; d--) ds.push(`2026-11-${String(d).padStart(2, "0")}`);
    for (let d = 31; d >= 24; d--) ds.push(`2026-10-${d}`);
    const order: string[] = [];
    for (const d of ds) {
      order.push(d);
      if (d === "2026-11-12") order.push(d, d);
      if (d === "2026-11-03") order.push(d);
    }
    const hdrs = ["#", "##", "###"];
    const sections = order.map((date, i) => {
      const hdr = hdrs[i % 3];
      const text = `${hdr} ${date}\n\nentry #${i} "${date}"\n\n${filler(`s${i}`)}\n\`\`\`md\n# 2099-01-01\n\`\`\``;
      return { date, hdr, text };
    });
    const live = PREAMBLE + sections.map((s) => s.text + "\n\n").join("");
    return { live, sections };
  }

  const EXISTING_ARCHIVE_OCT =
    "---\ntitle: Bridge Log Archive 2026-10\ntype: note\ncreated: 2026-10-20\nupdated: 2026-10-20\nperiod: 2026-10\n---\n\n" +
    "# 2026-10-20\nolder entry A\n\n# 2026-10-10\nolder entry B\n";

  const idxLine = (m: string): string => `- [[${FOLDER}/${m}|${m}]]`;
  const EXISTING_INDEX = `---\ntitle: Bridge Log Archive\nupdated: 2026-10-20\n---\n\n# Bridge Log Archive\n\n${INDEX_HEADING}\n\n${idxLine("2026-09")}`; // no trailing newline

  async function seed(): Promise<Gen> {
    const g = generateLog();
    await writeFile(abs(LIVE), g.live);
    await mkdir(abs(FOLDER), { recursive: true });
    await writeFile(abs(`${FOLDER}/2026-10.md`), EXISTING_ARCHIVE_OCT);
    await writeFile(abs(INDEX), EXISTING_INDEX);
    return g;
  }

  async function snapshot(): Promise<Record<string, { content: string; mtimeMs: number }>> {
    const out: Record<string, { content: string; mtimeMs: number }> = {};
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else out[p.slice(root.length)] = { content: await readFile(p, "utf8"), mtimeMs: (await stat(p)).mtimeMs };
      }
    };
    await walk(root);
    return out;
  }

  const input = (over: Record<string, unknown> = {}) => ({
    path: LIVE,
    archive_folder: FOLDER,
    keep_days: 8,
    ...over,
  });

  it("synthetic log is > 130 KB with 20 distinct dates", async () => {
    const g = await seed();
    expect(Buffer.byteLength(g.live)).toBeGreaterThan(130_000);
    expect(new Set(dates(g.live)).size).toBe(20);
    expect(dates(g.live)).toHaveLength(23); // + 2 dup 11-12, + 1 dup 11-03
  });

  it("dry_run (explicit and default) writes nothing", async () => {
    await seed();
    const before = await snapshot();
    for (const over of [{ dry_run: true }, {}]) {
      const r = await rotateLogNote(executor, input(over));
      expect(r.dry_run).toBe(true);
      expect(r.sections_moved).toBe(13); // 11-04..11-01 (+dup 11-03) = 5, 10-31..10-24 = 8
      expect(r.kept_dates).toHaveLength(8);
      expect(r.verification).toMatchObject({ archives_ok: null, live_ok: null, sections_checked: 0 });
      expect(r.bytes_after).toBeLessThan(r.bytes_before);
      expect(r.archives.map((a) => [a.path, a.created])).toEqual([
        [`${FOLDER}/2026-11.md`, true],
        [`${FOLDER}/2026-10.md`, false],
      ]);
      expect(r.index).toEqual({ path: INDEX, created: false, added_months: ["2026-10", "2026-11"] });
      expect(await snapshot()).toEqual(before); // contents AND mtimes identical, no new files
    }
  });

  it("moves the right sections, verifies, updates the index; second run is a no-op", async () => {
    const g = await seed();
    const liveBefore = g.live;
    const r = await rotateLogNote(executor, input({ dry_run: false }));

    const keptDates = new Set(g.sections.slice(0, 10).map((s) => s.date)); // 11-12 x3 .. 11-05
    expect(keptDates.size).toBe(8);
    const keptSecs = g.sections.filter((s) => keptDates.has(s.date));
    const movedSecs = g.sections.filter((s) => !keptDates.has(s.date));
    expect(movedSecs).toHaveLength(13);

    expect(r.dry_run).toBe(false);
    expect(r.sections_moved).toBe(13);
    expect(r.kept_dates).toEqual([...keptDates].sort().reverse());
    expect(r.verification).toMatchObject({ archives_ok: true, live_ok: true, missing: [], sections_checked: 13 });
    expect(r.bytes_before).toBe(Buffer.byteLength(liveBefore));
    expect(r.bytes_after).toBeLessThan(r.bytes_before);
    expect(r.warnings).toEqual([]);

    // live note: preamble + kept sections only, single trailing newline
    const live = await readFile(abs(LIVE), "utf8");
    expect(Buffer.byteLength(live)).toBe(r.bytes_after);
    expect(live.startsWith(PREAMBLE)).toBe(true);
    expect(live.endsWith("\n")).toBe(true);
    expect(live.endsWith("\n\n")).toBe(false);
    expect(live).toBe(PREAMBLE + keptSecs.map((s) => s.text).join("\n\n") + "\n");
    expect(new Set(dates(live))).toEqual(keptDates);
    expect(dates(live)).toHaveLength(10);
    // fenced fake header inside sections did not confuse the parser
    expect(live).toContain("# 2099-01-01");

    // every moved section is verbatim in the right month archive
    const nov = await readFile(abs(`${FOLDER}/2026-11.md`), "utf8");
    const oct = await readFile(abs(`${FOLDER}/2026-10.md`), "utf8");
    for (const s of movedSecs) {
      const arc = s.date.startsWith("2026-11") ? nov : oct;
      expect(arc, s.date).toContain(s.text);
      expect(s.date.startsWith("2026-11") ? oct : nov).not.toContain(s.text);
    }
    // new November archive: frontmatter + sections in note order
    const novMoved = movedSecs.filter((s) => s.date.startsWith("2026-11"));
    expect(novMoved).toHaveLength(5);
    expect(splitFrontmatter(nov).body).toBe("\n" + novMoved.map((s) => s.text).join("\n\n") + "\n");
    expect(nov).toContain("title: Bridge Log Archive 2026-11\n");
    expect(nov).toContain("period: 2026-11\n");
    // October archive: new block above old days, old content intact, updated bumped
    const octMoved = movedSecs.filter((s) => s.date.startsWith("2026-10"));
    const today = todayLocal();
    expect(oct).toBe(
      EXISTING_ARCHIVE_OCT.replace("updated: 2026-10-20", `updated: ${today}`).replace(
        "# 2026-10-20\n",
        octMoved.map((s) => s.text).join("\n\n") + "\n\n# 2026-10-20\n",
      ),
    );
    expect(dates(oct)).toEqual([...octMoved.map((s) => s.date), "2026-10-20", "2026-10-10"]);

    // index: both months linked, newest first, old one preserved
    const idx = await readFile(abs(INDEX), "utf8");
    expect(idx.split("\n").filter((l) => l.startsWith("- [["))).toEqual([idxLine("2026-11"), idxLine("2026-10"), idxLine("2026-09")]);
    expect(r.index).toEqual({ path: INDEX, created: false, added_months: ["2026-10", "2026-11"] });

    // no temp files left behind
    for (const dir of [abs("8 - Meta"), abs(FOLDER)]) {
      expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    }

    // second run: nothing to move, nothing changes
    const snap = await snapshot();
    const r2 = await rotateLogNote(executor, input({ dry_run: false }));
    expect(r2.sections_moved).toBe(0);
    expect(r2.moved).toEqual([]);
    expect(r2.archives).toEqual([]);
    expect(r2.index).toBeNull();
    expect(r2.bytes_after).toBe(r2.bytes_before);
    expect(await snapshot()).toEqual(snap);
  });

  it("creates archive folder, month notes and index when none exist", async () => {
    const g = generateLog();
    await writeFile(abs(LIVE), g.live);
    const r = await rotateLogNote(executor, input({ dry_run: false, keep_days: 12 }));
    expect(r.sections_moved).toBe(8); // 10-31..10-24
    expect(r.archives).toHaveLength(1);
    expect(r.archives[0]).toMatchObject({ path: `${FOLDER}/2026-10.md`, created: true });
    expect(r.index).toMatchObject({ created: true, added_months: ["2026-10"] });
    const idx = await readFile(abs(INDEX), "utf8");
    expect(idx).toContain(INDEX_HEADING);
    expect(idx).toContain(idxLine("2026-10"));
    expect(r.verification).toMatchObject({ archives_ok: true, live_ok: true });
  });

  it("honours a custom index_note and warns when still over max_bytes", async () => {
    const g = generateLog();
    await writeFile(abs(LIVE), g.live);
    const r = await rotateLogNote(executor, input({ dry_run: false, max_bytes: 1000, index_note: "8 - Meta/Bridge Index.md" }));
    expect(r.index?.path).toBe("8 - Meta/Bridge Index.md");
    expect(r.warnings.some((w) => /max_bytes 1000/.test(w))).toBe(true);
    expect(await readFile(abs("8 - Meta/Bridge Index.md"), "utf8")).toContain("[[8 - Meta/Bridge Log Archive/2026-11|2026-11]]");
  });

  it("is a no-op with a warning when nothing is old enough but the note is too big", async () => {
    const g = generateLog();
    await writeFile(abs(LIVE), g.live);
    const r = await rotateLogNote(executor, input({ dry_run: false, keep_days: 50, max_bytes: 1000 }));
    expect(r.sections_moved).toBe(0);
    expect(r.warnings).toHaveLength(1);
    expect(await readFile(abs(LIVE), "utf8")).toBe(g.live);
  });

  it("throws when the live note does not exist or the path escapes the vault", async () => {
    await expect(rotateLogNote(executor, input({ path: "8 - Meta/nope.md" }))).rejects.toThrow(/note not found/);
    await expect(rotateLogNote(executor, input({ path: "../outside.md" }))).rejects.toThrow(/escapes the vault/);
  });

  // root ignores directory permission bits, so this can't fail there
  it.skipIf(process.getuid?.() === 0)("an unwritable archive folder throws and leaves the live note byte-identical", async () => {
    const g = generateLog();
    await writeFile(abs(LIVE), g.live);
    await mkdir(abs(FOLDER), { recursive: true });
    await chmod(abs(FOLDER), 0o500);
    const liveBefore = await readFile(abs(LIVE));
    const mtimeBefore = (await stat(abs(LIVE))).mtimeMs;

    await expect(rotateLogNote(executor, input({ dry_run: false }))).rejects.toThrow(/write failed.*live note NOT touched/s);

    expect((await readFile(abs(LIVE))).equals(liveBefore)).toBe(true);
    expect((await stat(abs(LIVE))).mtimeMs).toBe(mtimeBefore);
    expect(await readdir(abs(FOLDER))).toEqual([]);

    // dry run on the same setup still works (it never writes)
    await chmod(abs(FOLDER), 0o700);
    const r = await rotateLogNote(executor, input({ dry_run: true }));
    expect(r.sections_moved).toBeGreaterThan(0);
  });

  it("a LIFO violation in an existing archive throws before touching anything", async () => {
    const g = generateLog();
    await writeFile(abs(LIVE), g.live);
    await mkdir(abs(FOLDER), { recursive: true });
    // existing October archive already has a day newer than the oldest day to be moved
    const bad = EXISTING_ARCHIVE_OCT.replace("# 2026-10-20", "# 2026-10-28");
    await writeFile(abs(`${FOLDER}/2026-10.md`), bad);
    const snap = await snapshot();
    await expect(rotateLogNote(executor, input({ dry_run: false }))).rejects.toThrow(/LIFO/);
    expect(await snapshot()).toEqual(snap);
  });
});
