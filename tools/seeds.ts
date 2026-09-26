/**
 * The smoke harness over many seeds at once: how often each check held, with
 * your change and without it.
 *
 *   npm run smoke:seeds -- --groups theOrcComesAfterYouThroughTheAir --against HEAD
 *
 * One seed is one roll of the dice. A rule (`check` in smoke.ts) has to hold on
 * every seed there is, and one that fails on any of them is a bug. A tendency
 * (`tendency`) is something the AI does often enough -- a rate, a count, an
 * order -- and even a sound one misses on the odd seed: what matters is whether
 * it misses more often with a change than without one.
 *
 *   --groups a,b    the groups to run, by function name (see GROUPS); all of them
 *                   if left out
 *   --seeds 1-10    which seeds: "1-10", "3,7,9", "1-5,20"; 1 to 10 if left out
 *   --against REF   also run the same seeds on REF (HEAD, a branch, a commit),
 *                   taken out of git into a scratch folder, and set the two side
 *                   by side
 *   --git DIR       the repository REF is taken from: this tree's, if left out
 *                   (a copy of the tree, as the smoke-tester runs, has none)
 *   --jobs N        how many runs at once; one a core if left out
 *   --logs DIR      keep every run's log there, as here-<seed>.log and
 *                   against-<seed>.log, to read the numbers behind a verdict
 *
 * It exits 1 when a rule fails on a seed where, on REF, it held (on any seed
 * at all without --against); when a tendency misses on at least two seeds, and
 * two more than it does on REF; or when a run crashes. Otherwise 0.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

type Kind = "rule" | "tendency";

interface Result {
  kind: Kind;
  held: boolean;
  detail: string;
}

interface Run {
  seed: number;
  /** Keyed by the check's name, with " [#2]" and so on for a name printed again. */
  results: Map<string, Result>;
  crashed: boolean;
  output: string;
}

interface Options {
  groups: string[];
  seeds: number[];
  against: string | null;
  git: string;
  jobs: number;
  logs: string | null;
}

function options(): Options {
  const out: Options = { groups: [], seeds: seedList("1-10"), against: null, git: ROOT, jobs: availableParallelism(), logs: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--groups": out.groups = value().split(",").map((g) => g.trim()).filter(Boolean); break;
      case "--seeds": out.seeds = seedList(value()); break;
      case "--against": out.against = value(); break;
      case "--git": out.git = value(); break;
      case "--logs": out.logs = value(); break;
      case "--jobs": out.jobs = Math.max(1, Math.floor(Number(value())) || 1); break;
      default: throw new Error(`no such option ${flag}: see the top of tools/seeds.ts`);
    }
  }
  return out;
}

function seedList(spec: string): number[] {
  const seeds: number[] = [];
  for (const part of spec.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) throw new Error(`--seeds wants something like "1-10" or "3,7,9", not "${spec}"`);
    for (let s = Number(m[1]); s <= Number(m[2] ?? m[1]); s++) seeds.push(s);
  }
  return seeds;
}

/** The group names in a tree's GROUPS, in order. */
function groupsOf(tree: string): string[] {
  const src = readFileSync(join(tree, "tools", "smoke.ts"), "utf8");
  const m = /const GROUPS: \(\(\) => Promise<void>\)\[\] = \[\n([\s\S]*?)\n\];/.exec(src);
  if (!m) throw new Error("can't find GROUPS in tools/smoke.ts");
  return m[1].split("\n").map((l) => l.trim().replace(/,$/, "")).filter(Boolean);
}

/** REF's harness and game, out of git into a scratch folder that shares our node_modules. */
function checkOut(git: string, ref: string): string {
  const dir = mkdtempSync(join(tmpdir(), "smoke-against-"));
  const tar = execFileSync("git", ["archive", "--format=tar", ref, "src", "tools", "package.json", "tsconfig.json"],
    { cwd: git, maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

// A check's line: its verdict, "~ " before a tendency's name, then the name and
// the detail, told apart by their colours.
const LINE = /  \x1b\[3\dm(PASS|FAIL|MISS)\x1b\[0m  (~ )?(.*?)  \x1b\[(?:90|33)m([\s\S]*?)\x1b\[0m\n/g;

function parse(output: string): Map<string, Result> {
  const results = new Map<string, Result>();
  const seen = new Map<string, number>();
  for (const [, verdict, tilde, name, detail] of output.matchAll(LINE)) {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    results.set(n === 1 ? name : `${name} [#${n}]`, {
      kind: tilde || verdict === "MISS" ? "tendency" : "rule",
      held: verdict === "PASS",
      detail,
    });
  }
  return results;
}

function runOnce(tree: string, seed: number, groups: string[]): Promise<Run> {
  return new Promise((done) => {
    const env = { ...process.env, SMOKE_SEED: String(seed), SMOKE_ONLY: groups.join(",") };
    const child = spawn(TSX, ["tools/smoke.ts"], { cwd: tree, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (b: Buffer) => { output += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { output += b.toString(); });
    child.on("close", () => {
      done({ seed, results: parse(output), crashed: !/\d+\/\d+ checks passed/.test(output), output });
    });
  });
}

async function inTurn<T>(tasks: (() => Promise<T>)[], jobs: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  return out;
}

const seedsOf = (runs: Run[], key: string, held: boolean): number[] =>
  runs.filter((r) => r.results.get(key)?.held === held).map((r) => r.seed);

async function main(): Promise<void> {
  const o = options();
  const known = groupsOf(ROOT);
  const unknown = o.groups.filter((g) => !known.includes(g));
  if (unknown.length) throw new Error(`no such group: ${unknown.join(", ")}. The groups are the functions in GROUPS in tools/smoke.ts.`);
  const against = o.against === null ? null
    : execFileSync("git", ["rev-parse", "--short", o.against], { cwd: o.git, encoding: "utf8" }).trim();
  const other = o.against === null ? null : checkOut(o.git, o.against);
  const started = Date.now();
  let failed = false;
  try {
    const tasks: (() => Promise<Run>)[] = [];
    for (const seed of o.seeds) tasks.push(() => runOnce(ROOT, seed, o.groups));
    if (other !== null) for (const seed of o.seeds) tasks.push(() => runOnce(other, seed, o.groups));
    console.log(`${o.groups.length ? o.groups.join(", ") : "every group"}: seeds ${o.seeds.join(",")}` +
      (against ? `, against ${o.against} (${against})` : "") + `, ${o.jobs} at a time`);
    const runs = await inTurn(tasks, o.jobs);
    const mine = runs.slice(0, o.seeds.length);
    const theirs = other === null ? null : runs.slice(o.seeds.length);
    if (o.logs !== null) {
      mkdirSync(o.logs, { recursive: true });
      for (const [side, list] of [["here", mine], ["against", theirs ?? []]] as const) {
        for (const r of list) writeFileSync(join(o.logs, `${side}-${r.seed}.log`), r.output);
      }
    }
    console.log(`took ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
    failed = report(mine, theirs, against);
  } finally {
    if (other !== null) rmSync(other, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

/** Prints how each check did; true if any of it should stop a push. */
function report(mine: Run[], theirs: Run[] | null, against: string | null): boolean {
  const crashed = [...mine.map((r) => ({ r, where: "this tree" })),
    ...(theirs ?? []).map((r) => ({ r, where: against ?? "" }))].filter(({ r }) => r.crashed);
  for (const { r, where } of crashed) {
    console.log(`\x1b[31mcrashed\x1b[0m: ${where}, seed ${r.seed}\n${r.output.trimEnd().split("\n").slice(-15).join("\n")}\n`);
  }
  const keys: string[] = [];
  for (const r of mine) for (const k of r.results.keys()) if (!keys.includes(k)) keys.push(k);
  const tally = (runs: Run[], key: string): string =>
    `${seedsOf(runs, key, true).length}/${runs.length}`.padStart(7);
  console.log(`          ${"here".padStart(7)}${theirs ? `  ${(against ?? "").padStart(7)}` : ""}`);
  let bad = 0;
  for (const key of keys) {
    const kind = mine.find((r) => r.results.has(key))!.results.get(key)!.kind;
    const failed = seedsOf(mine, key, false);
    let note = "";
    let stops = false;
    if (kind === "rule" && failed.length) {
      // Broken by the change if it held on that seed without it, or wasn't there.
      const fresh = theirs === null ? failed
        : failed.filter((s) => theirs.find((r) => r.seed === s)?.results.get(key)?.held !== false);
      stops = fresh.length > 0;
      note = stops
        ? `fails on ${fresh.join(", ")}${theirs ? ", where it held without the change" : ""}`
        : `fails on ${failed.join(", ")}, as it does without the change`;
    } else if (kind === "tendency" && failed.length) {
      const before = theirs === null ? null : seedsOf(theirs, key, false).length;
      stops = before !== null && failed.length >= 2 && failed.length >= before + 2;
      note = `misses on ${failed.join(", ")}${stops ? ": more often than without the change" : ""}`;
    }
    const row = `${kind.padEnd(8)}  ${tally(mine, key)}${theirs ? `  ${tally(theirs, key)}` : ""}  ${key}` +
      (note ? `   ${note}` : "");
    if (stops) bad++;
    console.log(stops ? `\x1b[31m${row}\x1b[0m` : row);
  }
  console.log(bad || crashed.length
    ? `\n\x1b[31m${bad + crashed.length} to look at\x1b[0m: a rule that fails is a bug, and so is a tendency` +
      " missing this much more often than it did"
    : `\n\x1b[32mnothing to look at\x1b[0m${theirs ? ": nothing does worse than without the change" : ""}`);
  return bad > 0 || crashed.length > 0;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
