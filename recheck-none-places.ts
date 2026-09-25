// recheck-none-places.ts — re-resolve story-gate-relevant seed/gem pins through the
// deployed nearby-places `resolveWiki` action (which carries the #365 Places external-
// source rung) and write the verdict back to submissions.
//
// TWO row classes, one tool (#367 metros-first backfill):
//   • resolved_source = 'none'  — already CHECKED, no story found → the #344/#367 gate
//                                   HIDES these today. Re-checking can rescue one the day
//                                   a new rung (e.g. #365 Places) can finally source it.
//   • resolved_source IS NULL   — NEVER CHECKED. "Keep-until-resolved": visible today,
//                                   but owes a resolve (the #319/#367 arm). These are the
//                                   un-backfilled metros — a metro that was SEEDED but never
//                                   run through brick-3 (LA is the live example: Griffith
//                                   Observatory / La Brea Tar Pits / Hollywood Bowl all
//                                   resolve to real Wikipedia articles, they were simply
//                                   never resolved). This is #367's "null=keep-until-
//                                   resolved has resolved" for the human/seed layer.
//
// This is the fresh stand-in for backfill-resolved-descriptions.ts --recheck-none
// (that tool wrote the #344 brick-3 backfill but was never committed to the repo).
//
// SAFETY / SEMANTICS:
//   • PROPOSE by default (writes nothing, prints every flip). --commit to persist.
//   • A NULL row that RESOLVES  → written wiki/places/gen — now it has a story (visible,
//     with a real description).
//   • A NULL row that STILL MISSES → LEFT NULL by default (kept visible). We NEVER blind-
//     hide a place on a resolver miss — a famous place missing is a recall gap, not a
//     "no story" verdict (blank-beats-wrong, #101/#178; rescue-don't-blind-hide, #367).
//     The opt-in --nulls-miss-to-none flips a stubborn null miss to 'none' (which HIDES
//     it) — off by default, use only after eyeballing the dry run.
//   • A NONE row that still misses → stays 'none' (already hidden; no write).
//   • Every PATCH is guarded on the row's CURRENT resolved_source (eq.none / is.null), so
//     it is race-safe with the live gate and idempotent (a re-run only fills what is still
//     unresolved).
//
// It needs NO Google key — the key lives in the nearby-places function; this tool only
// CALLS the function. It reads/writes submissions with the service-role key.
//
// RUN (Codespace, secrets injected):
//   deno run --allow-net --allow-env recheck-none-places.ts                    # dry run, NONE rows (default)
//   deno run --allow-net --allow-env recheck-none-places.ts --commit           # persist NONE flips
//   deno run --allow-net --allow-env recheck-none-places.ts --nulls            # dry run, NULL rows (the never-checked)
//   deno run --allow-net --allow-env recheck-none-places.ts --nulls --commit   # persist NULL flips (misses stay null)
//   deno run --allow-net --allow-env recheck-none-places.ts --all              # dry run, BOTH classes
//   deno run --allow-net --allow-env recheck-none-places.ts --all --commit     # persist BOTH (null misses stay null)
//   deno run --allow-net --allow-env recheck-none-places.ts --nulls --commit --nulls-miss-to-none   # ALSO hide stubborn null misses
//
// Env used: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (both devcontainer-injected).
// NEARBY_PLACES_KEY (the function anon/publishable key) is used for the resolveWiki
// call if set; otherwise it falls back to the public publishable key below.

const COMMIT = Deno.args.includes("--commit");
const WANT_NULLS = Deno.args.includes("--nulls") || Deno.args.includes("--all");
const WANT_NONE = Deno.args.includes("--all") || !Deno.args.includes("--nulls"); // default = none only (back-compat)
const NULL_MISS_TO_NONE = Deno.args.includes("--nulls-miss-to-none");

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "https://siacjgpqzaylsfefihyr.supabase.co").replace(/\/+$/, "");
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Public publishable (anon) key — safe fallback for the function call; it is shipped in index.html.
const FN_KEY = Deno.env.get("NEARBY_PLACES_KEY") ?? "sb_publishable_sJkeQ89O2geQLB5z6d__Zw_9G6nxLt_";
const FN_URL = SUPABASE_URL + "/functions/v1/nearby-places";
const REST = SUPABASE_URL + "/rest/v1/submissions";
const PACE_MS = 150;

if (!SERVICE) { console.error("FATAL: SUPABASE_SERVICE_ROLE_KEY not set (needed to read + write submissions)."); Deno.exit(1); }

const svcHeaders = { "apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json" };

// A "mode" is a row class: 'none' (resolved_source='none') or 'null' (resolved_source IS NULL).
// Its REST filter + PATCH guard differ; everything else is shared.
const FILTER = { none: "resolved_source=eq.none", null: "resolved_source=is.null" } as const;
type Mode = keyof typeof FILTER;

// --- read every approved, non-merged row of a class (paged past the 1,000 REST cap) ---
async function fetchRows(mode: Mode) {
  const rows: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const url = REST + `?select=id,name,lat,lng,category&status=eq.approved&merged_into=is.null&${FILTER[mode]}&order=id`;
    const res = await fetch(url, { headers: { ...svcHeaders, "Range-Unit": "items", "Range": `${from}-${from + PAGE - 1}` } });
    if (!res.ok) { console.error(`READ failed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); Deno.exit(1); }
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

async function resolve(name: string, lat: number, lng: number) {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: { "apikey": FN_KEY, "Authorization": "Bearer " + FN_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resolveWiki", name, lat, lng }),
  });
  if (!res.ok) return { err: `HTTP ${res.status}` };
  const j = await res.json();
  return { place: j.place || null };
}

// Write a resolved verdict, guarded on the row's CURRENT source so a verdict written since
// the read is never clobbered (race-safe + idempotent).
async function commitFlip(id: string, mode: Mode, desc: string, source: string) {
  const url = REST + `?id=eq.${encodeURIComponent(id)}&${FILTER[mode]}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...svcHeaders, "Prefer": "return=minimal" },
    body: JSON.stringify({ resolved_description: desc, resolved_source: source }),
  });
  return res.ok;
}

// Opt-in only: convert a stubborn NULL miss to 'none' (which HIDES it). Guarded on is.null.
async function commitNullMissToNone(id: string) {
  const url = REST + `?id=eq.${encodeURIComponent(id)}&${FILTER.null}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...svcHeaders, "Prefer": "return=minimal" },
    body: JSON.stringify({ resolved_description: "", resolved_source: "none" }),
  });
  return res.ok;
}

async function runPass(mode: Mode) {
  const rows = await fetchRows(mode);
  const label = mode === "none" ? "resolved_source='none' (already hidden — recheck to rescue)"
                                : "resolved_source IS NULL (never checked — the un-backfilled backlog)";
  console.log(`\n######## ${mode.toUpperCase()} PASS — ${label} ########`);
  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — ${rows.length} rows\n`);

  let flips = 0, stillUnresolved = 0, errs = 0, wrote = 0, hidNullMiss = 0;
  const bySource: Record<string, number> = {};
  const byCat: Record<string, { flip: number; tot: number }> = {};

  for (const r of rows) {
    byCat[r.category] ??= { flip: 0, tot: 0 };
    byCat[r.category].tot++;
    let out: any;
    try { out = await resolve(r.name, r.lat, r.lng); } catch (e) { out = { err: String(e).slice(0, 80) }; }

    if (out.err) {
      errs++; console.log(`ERR     ${r.name} :: ${out.err}`);
    } else if (!out.place || !out.place.desc || !out.place.source) {
      stillUnresolved++;
      if (mode === "null") {
        if (NULL_MISS_TO_NONE) {
          console.log(`null→none ${r.name}  (still no source — HIDING per --nulls-miss-to-none)`);
          if (COMMIT) { if (await commitNullMissToNone(r.id)) { wrote++; hidNullMiss++; } else console.log(`   ^ WRITE FAILED for ${r.id}`); }
        } else {
          console.log(`keep-null ${r.name}  (still no source — LEFT VISIBLE, not hidden)`);
        }
      } else {
        console.log(`none      ${r.name}  (still no source — stays hidden)`);
      }
    } else {
      flips++;
      bySource[out.place.source] = (bySource[out.place.source] || 0) + 1;
      byCat[r.category].flip++;
      const d = String(out.place.desc).replace(/\s+/g, " ").slice(0, 80);
      console.log(`FLIP → ${out.place.source.padEnd(6)} ${r.name}  ::  "${d}"  (matched "${out.place.name}")`);
      if (COMMIT) { if (await commitFlip(r.id, mode, out.place.desc, out.place.source)) wrote++; else console.log(`   ^ WRITE FAILED for ${r.id}`); }
    }
    await new Promise((res) => setTimeout(res, PACE_MS));
  }

  console.log(`\n---------------- ${mode.toUpperCase()} SUMMARY ----------------`);
  console.log(`considered:       ${rows.length}`);
  console.log(`flips proposed:   ${flips}  ${JSON.stringify(bySource)}`);
  if (mode === "null") {
    console.log(`still null:       ${stillUnresolved}   <-- ${NULL_MISS_TO_NONE ? "flipped to 'none' (HIDDEN) per --nulls-miss-to-none" : "LEFT VISIBLE (rescue/curate, or re-run with --nulls-miss-to-none to hide)"}`);
  } else {
    console.log(`still none:       ${stillUnresolved}   <-- stay hidden (curate or leave)`);
  }
  console.log(`errors:           ${errs}`);
  if (COMMIT) console.log(`ROWS WRITTEN:     ${wrote}${mode === "null" && NULL_MISS_TO_NONE ? `  (of which ${hidNullMiss} null→none hides)` : ""}`);
  console.log(`by category (flip / total):`);
  for (const c of Object.keys(byCat)) console.log(`  ${c}: ${byCat[c].flip}/${byCat[c].tot}`);

  return { rows: rows.length, flips, stillUnresolved, errs, wrote };
}

console.log(`recheck-none-places — mode: ${[WANT_NONE ? "none" : null, WANT_NULLS ? "null" : null].filter(Boolean).join(" + ")}${NULL_MISS_TO_NONE ? "  [--nulls-miss-to-none]" : ""}`);

let totalFlips = 0, totalWrote = 0;
if (WANT_NONE) { const s = await runPass("none"); totalFlips += s.flips; totalWrote += s.wrote; }
if (WANT_NULLS) { const s = await runPass("null"); totalFlips += s.flips; totalWrote += s.wrote; }

console.log("\n================ TOTAL ================");
console.log(`flips proposed across passes: ${totalFlips}`);
if (COMMIT) console.log(`rows written across passes:   ${totalWrote}`);
console.log(COMMIT ? "========== COMMITTED ==========" : "===== DRY RUN — nothing written; re-run with --commit =====");
