// grave-coverage.ts — the #356 measurement tool.
// =============================================================================
// WHY THIS TOOL EXISTS.
//   #344's story gate (gate-tiles.ts) DROPS an OSM `historic=tomb` filler pin
//   because a live resolve of the person's name fails the #316 coordinate gate
//   by design — the person's Wikipedia article sits at their biography, not at
//   their plot (Jesse Owens, Enrico Fermi, Junior Wells …). #356 asks whether
//   those dropped graves should instead PROMOTE a stored description (brick-3
//   style), and — critically — to first "determine whether they're un-seeded or
//   seeded-but-mis-sourced." That determination decides the whole fix:
//
//     * SEEDED already   → the `seed:wikidata-grave` row already renders the
//                          grave's story on the map, so the dropped OSM filler
//                          pin was a near-DUPLICATE that #344 correctly removed.
//                          Promoting a description back onto it would RE-CREATE
//                          the dup. For these, the drop is right; do nothing.
//     * UN-SEEDED        → the grave VANISHES (no seed carries it). This is the
//                          real regression. The fix is to SEED it (graves-resolve
//                          / #335) or give the gate an identity-based resolve —
//                          NOT a promote, because there is nothing stored to
//                          promote FROM.
//
//   So the right first move is to MEASURE the split, not to code a promote path
//   blind. This tool does exactly that, and nothing else.
//
// WHAT IT DOES.
//   1. Reads gate_tiles_records.json (the artifact a gate-tiles.ts run writes —
//      dry-run or commit both produce it). Collects every DROPPED pin that looks
//      grave-class (name/desc mentions grave/tomb/mausoleum/crypt/burial …).
//   2. Reads every source='seed:wikidata-grave' row from `submissions` (paged
//      past PostgREST's 1,000-row cap — there are >1,600 grave rows, #338),
//      selecting name, description, lat, lng, city. Builds a person-name index.
//   3. For each dropped grave-class pin, looks up a matching seed by PERSON name
//      (strip the "Grave of"/"Tomb of"/… affix on both sides, compare distinctive
//      tokens; exact key first, then a subset fallback). Classifies it:
//        SEEDED_WITH_DESC · SEEDED_BLANK · UNSEEDED.
//   4. Writes grave_coverage.json + prints a summary with counts, per-metro
//      breakdown, and samples of each class. WRITES NOTHING TO THE DB.
//
// WHAT IT DOES NOT DO (honest scope).
//   * It does NOT check the COORDINATE — the "seeded-but-MIS-sourced" sub-case
//     (a seed exists but at the wrong/cemetery-centroid coordinate vs the OSM
//     plot) needs each dropped pin's lat/lng, which gate-tiles' dropped records
//     do NOT currently carry ({name,category,desc} only). Adding coords to those
//     records + a coordinate delta is the natural follow-up once we know the
//     seeded/un-seeded split is worth acting on. Flagged, not silently skipped.
//   * It writes nothing and touches no deploy target — a pure read + report.
//
// RUN (offline Deno tool at the repo root — a sibling of gate-tiles.ts):
//   export SUPABASE_URL=…  SUPABASE_SERVICE_ROLE_KEY=…
//   # after a gate-tiles.ts run has produced gate_tiles_records.json:
//   deno run --allow-net --allow-env --allow-read --allow-write grave-coverage.ts
//   # point at a different records file:
//   GRAVE_RECORDS_FILE=some_other_records.json deno run … grave-coverage.ts
//
// CONFIG OUTSIDE THE FILE: reuses the SAME Codespaces/Mac secrets the other
//   offline tools use — SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. The submissions
//   read uses the SERVICE ROLE key (mirrors graves-resolve.ts) so it always sees
//   `description` regardless of the #276 client-read column allowlist. NOT a
//   deploy target; changes no index.html / function / APP_VERSION / CACHE_VERSION.
// =============================================================================

const BUILD = "grave-coverage 2026.09.15a (#356 seeded-vs-unseeded measurement)";

// ---- config ----
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RECORDS_FILE = Deno.env.get("GRAVE_RECORDS_FILE")?.trim() || "gate_tiles_records.json";
const OUT_FILE = Deno.env.get("GRAVE_COVERAGE_OUT")?.trim() || "grave_coverage.json";
const SOURCE_TAG = Deno.env.get("GRAVE_SOURCE_TAG")?.trim() || "seed:wikidata-grave";
const SAMPLE = Number(Deno.env.get("GRAVE_COVERAGE_SAMPLE") ?? 25); // per-class sample size in the printed summary

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- name normalisation (mirrors gate-tiles.ts fold/tokens/coreName intent) ----
function fold(s: string): string {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
// Leading relational affixes that wrap a person's name into a grave label, on
// BOTH the seed ("Grave of Emma Goldman") and any OSM tomb pin variant.
const AFFIX_LEAD = /^(grave|tomb|crypt|mausoleum|burial|resting\s*place|sepulchre|sepulcher|memorial\s*to|final\s*resting\s*place)\s+(of|to|for)\s+/i;
const AFFIX_TRAIL = /\s+(grave|tomb|gravesite|mausoleum|memorial|monument|headstone|gravestone)$/i;
function personName(raw: string): string {
  let n = String(raw || "").trim();
  n = n.replace(AFFIX_LEAD, "");
  n = n.replace(AFFIX_TRAIL, "");
  return n.trim() || String(raw || "").trim();
}
// Stop/generic words that shouldn't decide a person match.
const GENERIC = new Set([
  "the", "and", "for", "los", "las", "san", "old", "new", "of", "to", "at", "on",
  "grave", "tomb", "mausoleum", "crypt", "burial", "memorial", "monument", "site",
  "sir", "dr", "mr", "mrs", "ms", "st", "saint", "gen", "col", "capt", "rev",
]);
function distinctiveTokens(s: string): string[] {
  return fold(personName(s))
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && t.length > 1 && !GENERIC.has(t));
}
// A stable person key: sorted distinctive tokens joined. "Grave of Al Capone" and
// "Al Capone" and "Capone, Al" all collapse to the same key.
function personKey(s: string): string {
  return distinctiveTokens(s).slice().sort().join(" ");
}

// ---- is a dropped pin grave-class? (name OR desc mentions a grave concept) ----
const GRAVE_HINT = /\b(grave|tomb|mausoleum|crypt|burial|gravesite|headstone|gravestone|sepulchre|sepulcher|interred|resting\s*place)\b/i;
function isGraveClass(d: { name?: string; category?: string; desc?: string }): boolean {
  const name = String(d?.name || "");
  const desc = String(d?.desc || "");
  if (GRAVE_HINT.test(name)) return true;
  // A history-category drop whose FILLER desc reads as a memorial/tomb template.
  if (String(d?.category || "") === "history" && GRAVE_HINT.test(desc)) return true;
  return false;
}

// ---- read every grave seed from submissions (paged, service role, #338 cap) ----
type Seed = { name: string; description: string; hasDesc: boolean; lat: number; lng: number; city: string };
async function fetchGraveSeeds(): Promise<Seed[]> {
  const seeds: Seed[] = [];
  const PAGE = 1000;
  let offset = 0, read = 0;
  for (;;) {
    const url =
      `${SUPABASE_URL}/rest/v1/submissions?source=eq.${encodeURIComponent(SOURCE_TAG)}` +
      `&select=name,description,lat,lng,city&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { apikey: SRK, Authorization: "Bearer " + SRK, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`submissions read HTTP ${res.status} ${body.slice(0, 200)} — check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("submissions read: response was not an array");
    for (const r of rows) {
      const desc = String(r?.description ?? "").trim();
      seeds.push({
        name: String(r?.name ?? ""),
        description: desc,
        hasDesc: desc.length > 0,
        lat: Number(r?.lat),
        lng: Number(r?.lng),
        city: String(r?.city ?? ""),
      });
    }
    read += rows.length;
    if (rows.length < PAGE) break;
    offset += PAGE;
    await sleep(150);
  }
  console.log(`Read ${read} '${SOURCE_TAG}' seed row(s) from submissions (paged).`);
  return seeds;
}

// ---- load the gate-tiles dropped records ----
type Dropped = { name: string; category: string; desc: string; metro: string };
async function loadDrops(): Promise<Dropped[]> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(RECORDS_FILE);
  } catch (_e) {
    throw new Error(
      `Could not read ${RECORDS_FILE}. Run gate-tiles.ts first (a dry run is enough — it writes ${RECORDS_FILE}), ` +
      `or set GRAVE_RECORDS_FILE to the path of an existing records file.`,
    );
  }
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error(`${RECORDS_FILE} is not a records array.`);
  const out: Dropped[] = [];
  for (const rec of records) {
    const metro = String(rec?.metro || "");
    for (const d of (rec?.dropped || [])) {
      out.push({ name: String(d?.name || ""), category: String(d?.category || ""), desc: String(d?.desc || ""), metro });
    }
  }
  return out;
}

// ---- match a dropped grave-class pin to a seed by person name ----
type Match = { seed: Seed; how: "exact" | "subset" } | null;
function buildSeedIndex(seeds: Seed[]) {
  const byKey = new Map<string, Seed[]>();
  const tokenList: { key: string; tokens: Set<string>; seed: Seed }[] = [];
  for (const s of seeds) {
    const key = personKey(s.name);
    if (!key) continue;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(s);
    tokenList.push({ key, tokens: new Set(distinctiveTokens(s.name)), seed: s });
  }
  return { byKey, tokenList };
}
function matchDrop(drop: Dropped, idx: ReturnType<typeof buildSeedIndex>): Match {
  const key = personKey(drop.name);
  if (!key) return null;
  const exact = idx.byKey.get(key);
  if (exact && exact.length) {
    // Prefer a seed that carries a description when several share the key.
    const withDesc = exact.find((s) => s.hasDesc) ?? exact[0];
    return { seed: withDesc, how: "exact" };
  }
  // Subset fallback: the drop's distinctive tokens are all present in a seed's
  // (or vice-versa) — catches "Grave of J. Dillinger" vs "John Dillinger" style
  // variance. Requires ≥1 shared distinctive token and full containment one way.
  const dropToks = new Set(distinctiveTokens(drop.name));
  if (!dropToks.size) return null;
  let best: { seed: Seed; hasDesc: boolean } | null = null;
  for (const t of idx.tokenList) {
    const a = dropToks, b = t.tokens;
    const subset =
      ([...a].every((x) => b.has(x)) || [...b].every((x) => a.has(x))) &&
      [...a].some((x) => b.has(x));
    if (subset) {
      if (!best || (t.seed.hasDesc && !best.hasDesc)) best = { seed: t.seed, hasDesc: t.seed.hasDesc };
      if (best.hasDesc) break; // good enough
    }
  }
  return best ? { seed: best.seed, how: "subset" } : null;
}

// ---- main ----
async function main() {
  console.log(`[grave-coverage] ${BUILD}`);
  if (!SUPABASE_URL || !SRK) {
    console.error("FATAL: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the same secrets the other offline tools use).");
    Deno.exit(1);
  }

  const drops = await loadDrops();
  const graveDrops = drops.filter(isGraveClass);
  console.log(`Loaded ${drops.length} total dropped pin(s) from ${RECORDS_FILE}; ${graveDrops.length} look grave-class.`);
  if (!graveDrops.length) {
    console.log("No grave-class drops found — either the gate dropped no tomb pins, or the records file is from a non-grave run. Nothing to measure.");
  }

  const seeds = await fetchGraveSeeds();
  const seedsWithDesc = seeds.filter((s) => s.hasDesc).length;
  const idx = buildSeedIndex(seeds);

  const classified = graveDrops.map((d) => {
    const m = matchDrop(d, idx);
    let cls: "SEEDED_WITH_DESC" | "SEEDED_BLANK" | "UNSEEDED";
    if (!m) cls = "UNSEEDED";
    else if (m.seed.hasDesc) cls = "SEEDED_WITH_DESC";
    else cls = "SEEDED_BLANK";
    return {
      drop: d,
      cls,
      matchedSeedName: m ? m.seed.name : null,
      matchHow: m ? m.how : null,
      matchedSeedCity: m ? m.seed.city : null,
    };
  });

  const counts = { SEEDED_WITH_DESC: 0, SEEDED_BLANK: 0, UNSEEDED: 0 };
  const perMetro: Record<string, { SEEDED_WITH_DESC: number; SEEDED_BLANK: number; UNSEEDED: number }> = {};
  for (const c of classified) {
    counts[c.cls]++;
    const m = (perMetro[c.drop.metro] ||= { SEEDED_WITH_DESC: 0, SEEDED_BLANK: 0, UNSEEDED: 0 });
    m[c.cls]++;
  }

  const sampleOf = (cls: string) =>
    classified.filter((c) => c.cls === cls).slice(0, SAMPLE).map((c) => ({
      dropped: c.drop.name, metro: c.drop.metro, matched_seed: c.matchedSeedName, via: c.matchHow,
    }));

  const report = {
    build: BUILD,
    recordsFile: RECORDS_FILE,
    sourceTag: SOURCE_TAG,
    totals: {
      droppedTotal: drops.length,
      graveClassDropped: graveDrops.length,
      graveSeeds: seeds.length,
      graveSeedsWithDescription: seedsWithDesc,
    },
    counts,
    perMetro,
    note:
      "SEEDED_* = a `seed:wikidata-grave` row exists for this person, so the map already renders the grave via the seed and the OSM tomb drop was a de-dup (do nothing). " +
      "UNSEEDED = no seed carries this person, so the gate drop makes the grave VANISH — this is the set #356 must act on (seed it via graves-resolve/#335, or an identity-based resolve). " +
      "Coordinate (seeded-but-mis-sourced) is NOT checked here — gate-tiles' dropped records carry no lat/lng; that is the follow-up.",
    samples: {
      SEEDED_WITH_DESC: sampleOf("SEEDED_WITH_DESC"),
      SEEDED_BLANK: sampleOf("SEEDED_BLANK"),
      UNSEEDED: sampleOf("UNSEEDED"),
    },
  };
  await Deno.writeTextFile(OUT_FILE, JSON.stringify(report, null, 2));

  console.log("\n=== grave-coverage summary ===");
  console.log(`grave seeds in submissions: ${seeds.length} (${seedsWithDesc} with a description)`);
  console.log(`grave-class pins dropped by the gate: ${graveDrops.length}`);
  console.log(`  SEEDED_WITH_DESC : ${counts.SEEDED_WITH_DESC}  (already told via the seed — drop is a de-dup, do nothing)`);
  console.log(`  SEEDED_BLANK     : ${counts.SEEDED_BLANK}  (seed exists but its description is empty — a #313/#279 fill, not a promote)`);
  console.log(`  UNSEEDED         : ${counts.UNSEEDED}  (** the grave VANISHES — this is what #356 must act on **)`);
  console.log("\nper metro:");
  for (const [m, c] of Object.entries(perMetro)) {
    console.log(`  ${m}: seeded+desc=${c.SEEDED_WITH_DESC} seeded-blank=${c.SEEDED_BLANK} unseeded=${c.UNSEEDED}`);
  }
  if (counts.UNSEEDED) {
    console.log(`\nsample UNSEEDED (up to ${SAMPLE}):`);
    for (const s of sampleOf("UNSEEDED")) console.log(`  - ${s.dropped}  [${s.metro}]`);
  }
  console.log(`\nfull report → ${OUT_FILE}  (WROTE NOTHING to the DB — measurement only)`);
}

if (import.meta.main) main();
