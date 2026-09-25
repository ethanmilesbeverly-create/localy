// id-check.ts — #110: does every `#N` written in a code COMMENT resolve to a real
// roadmap row?
//
// WHY. This project's cross-references run on a convention (#48): a `#N` in a
// comment names roadmap row N forever. Nothing enforced it, and one 2026-07-21
// sweep found THREE sets of shipped mis-stamps (`#99` for item 104, `#101` for
// 105, `#104` for 107). This is the cheap half of #110's fix — option (a):
// report every ID in a comment that has NO matching row in `nahgoo-roadmap.md`.
//
// WHAT IT CANNOT CATCH (stated so nobody over-trusts a clean run): a WRONG-but-
// EXISTING ID. `#104` written where `#107` was meant resolves to a real row and
// passes. Only a human reading the row can catch that. The process rule that
// prevents it is free: ALLOCATE THE ID BY READING THE TABLE BEFORE WRITING THE
// FIRST COMMENT, never after (#110 (c), recorded in the handoff).
//
// SCOPE. Only COMMENT text is scanned — `// …`, `/* … */` and `<!-- … -->` — so CSS
// hex colours (`color:#333`) and HTML entities (`&#123;`) in live code don't read
// as row IDs; inside comments, `~#N` / `#N-region` line pointers and a quoted CSS
// colour (`solid #666`, `:#333`) are skipped too. Both `#N` and the older `item N`
// spelling are checked.
//
// RUN (offline, from the repo root; reads only, writes nothing):
//   deno run --allow-read id-check.ts
//   deno run --allow-read id-check.ts index.html nearby-places_index.js   # specific files
// Exit code 0 = every referenced ID has a row; 1 = at least one doesn't.
//
// KNOWN ROWLESS IDs. An ID that was used on purpose but never got its own row is
// listed in ROWLESS_OK with the reason, so it doesn't re-alarm every run. Add to it
// only with a reason — an unexplained entry here is the mis-stamp this tool exists
// to catch, hidden.

const ROADMAP = "nahgoo-roadmap.md";

const ROWLESS_OK: Record<number, string> = {
  326: "reserved-as-reference (the #327 mis-stamp correction); never a row by decision",
  365: "the #318 Google-Places rung shipped under this ID as pass notes and #318 row text; no standalone row was ever appended",
};

const DEFAULT_FILES = [
  "index.html", "landing.html", "privacy.html",
  "nearby-places_index.js", "index.ts", "review-submissions-index.ts",
  "app-report-index.ts", "capture-verify-index.ts", "seed-resolve.ts",
  "graves-resolve.ts", "gate-tiles.ts", "places-coverage.ts", "grave-coverage.ts",
  "recheck-none-places.ts", "union-records.js",
];

function readText(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

function roadmapIds(text: string): Set<number> {
  const ids = new Set<number>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\| (\d+) \|/);
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

type Ref = { id: number; file: string; line: number; ctx: string };

// Every comment span in the file, with its starting offset.
function commentSpans(text: string): Array<{ start: number; body: string }> {
  const out: Array<{ start: number; body: string }> = [];
  const re = /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(?<![:"'=\w])\/\/[^\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ start: m.index, body: m[0] });
  return out;
}

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function refsIn(file: string, text: string): Ref[] {
  const refs: Ref[] = [];
  for (const span of commentSpans(text)) {
    // Not a row ID: `&#123;` (entity), `~#4090` / `#9078-region` (a LINE-number
    // pointer in index.html's constants table), `solid #666` / `:#333` (a CSS
    // colour quoted inside a comment).
    const re = /(?<![&~:\w])(?<!solid )#(\d{1,4})(?![\w-])|\bitems? (\d{1,4})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(span.body))) {
      const id = Number(m[1] ?? m[2]);
      if (!id) continue;
      const at = span.start + m.index;
      const ln = lineOf(text, at);
      const lineText = text.split("\n")[ln - 1] ?? "";
      refs.push({ id, file, line: ln, ctx: lineText.trim().slice(0, 140) });
    }
  }
  return refs;
}

function main() {
  const rm = readText(ROADMAP);
  if (rm === null) {
    console.error(`id-check: can't read ${ROADMAP} — run from the repo root.`);
    Deno.exit(2);
  }
  const ids = roadmapIds(rm);
  const maxId = Math.max(...ids);
  const files = Deno.args.length ? Deno.args : DEFAULT_FILES;

  let scanned = 0, total = 0;
  const unknown: Ref[] = [];
  const rowless: Record<number, number> = {};
  for (const f of files) {
    const t = readText(f);
    if (t === null) {
      if (Deno.args.length) console.warn(`  (skipped ${f}: not found)`);
      continue;
    }
    scanned++;
    for (const r of refsIn(f, t)) {
      total++;
      if (ids.has(r.id)) continue;
      if (ROWLESS_OK[r.id]) { rowless[r.id] = (rowless[r.id] || 0) + 1; continue; }
      unknown.push(r);
    }
  }

  if (!scanned) {
    console.error("id-check: no files found to scan — run from the repo root, or pass file names.");
    Deno.exit(2);
  }
  console.log(`id-check (#110): ${ROADMAP} has ${ids.size} rows (max #${maxId}); scanned ${scanned} file(s), ${total} comment reference(s).`);
  for (const [id, n] of Object.entries(rowless)) {
    console.log(`  known rowless #${id} × ${n} — ${ROWLESS_OK[Number(id)]}`);
  }
  if (!unknown.length) {
    console.log("  OK — every referenced ID has a roadmap row. (A wrong-but-existing ID still passes; see the header.)");
    Deno.exit(0);
  }
  const byId: Record<number, Ref[]> = {};
  for (const r of unknown) (byId[r.id] ||= []).push(r);
  console.log(`  ${unknown.length} reference(s) to ${Object.keys(byId).length} ID(s) with NO row:`);
  for (const id of Object.keys(byId).map(Number).sort((a, b) => a - b)) {
    const why = id > maxId ? "above the highest row — a guessed/unallocated ID?" : "no row with this ID";
    console.log(`  #${id} (${why}):`);
    for (const r of byId[id].slice(0, 5)) console.log(`     ${r.file}:${r.line}  ${r.ctx}`);
    if (byId[id].length > 5) console.log(`     … and ${byId[id].length - 5} more`);
  }
  Deno.exit(1);
}

main();
