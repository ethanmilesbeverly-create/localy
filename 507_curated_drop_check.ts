// 507_curated_drop_check.ts — READ-ONLY. Did a gate-tiles commit remove an OSM
// pin whose story lives in `curated_descriptions`?
//
// WHY (#507, 2026-10-04). `gate-tiles.ts` decides what to drop from the STORED
// tile row, where a curated pin still carries its filler line — the curated story
// is applied later, at serve time (#362). The gate has no idea curated rows exist,
// so it drops those pins, and once a pin is gone from the row the serve path has
// nothing to put the story on. Measured in Chicago's dry run: Al Capone's House
// (an OSM pin whose only story is a curated row, no gem behind it) was on the
// gate's drop list. #497 (2026-10-02, 17 metros) and #482 (Queens-Nassau)
// COMMITTED gate results with this blind spot. This tool measures the damage.
//
// WHAT IT DOES. Reads every gate records file you pass (gate_tiles_records.json
// shape), reads all of `curated_descriptions` (service role, paged past the
// 1,000-row cap), and matches each DROPPED pin to a curated row by name_clean
// (lowercase a–z0–9, the same normalisation the curated rung keys on) within
// MATCH_KM of the tile centre. For each match it asks the live `nearby-places`
// whether that pin is served right now:
//   LOST     — curated story, dropped by a gate, NOT on the map now  → restore
//   ON MAP   — still served (a gem carries it, or the row has since rebuilt)
// It writes NOTHING to the database. Output: a table, then 507_curated_drops.json.
//
// RUN (from ~/roaminator, which has the secrets):
//   deno run -A 507_curated_drop_check.ts ~/roaminator-497/*.records.json gate_tiles_records.json
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (curated is service-role only).
// NEARBY_PLACES_KEY is optional (falls back to the public publishable key).
//
// Every fetch carries a deadline (handoff §5, #504/#506).

const BUILD = "507_curated_drop_check 2026.10.04a (#507 — read-only; gate drops × curated_descriptions × live serve)";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PUBLIC_KEY = "sb_publishable_sJkeQ89O2geQLB5z6d__Zw_9G6nxLt_";
const NKEY = Deno.env.get("NEARBY_PLACES_KEY")?.trim() || PUBLIC_KEY;
const NEARBY_URL = (Deno.env.get("NEARBY_PLACES_URL")?.trim() || `${SUPABASE_URL}/functions/v1/nearby-places`).replace(/\/+$/, "");
const TILE_DEG = 0.05;                                                          // must mirror the function's REAL_TILE_DEG
const MATCH_KM = Number(Deno.env.get("CHECK_MATCH_KM") ?? 5);                   // tile fetch radius is 4.2 km from the centre; a little slack
const DB_TIMEOUT_MS = Number(Deno.env.get("CHECK_DB_TIMEOUT_MS") ?? 60000);
const FN_TIMEOUT_MS = Number(Deno.env.get("CHECK_FN_TIMEOUT_MS") ?? 180000);    // a cold tile can build for minutes
const OUT_FILE = "507_curated_drops.json";

type Curated = { name: string; lat: number; lng: number; nc: string };
type Rec = { tile: string; metro?: string; lat?: number; lng?: number; committed?: boolean; dropped?: { name: string; category?: string; desc?: string }[] };
type Hit = {
  status: "LOST" | "ON MAP" | "UNKNOWN";
  name: string; category: string; tile: string; metro: string; committedFlag: boolean | null;
  curatedName: string; curatedLat: number; curatedLng: number; distKm: number; files: string[];
};

const nameClean = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR, dLng = (bLng - aLng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function tileCentre(rec: Rec): { lat: number; lng: number } {
  if (typeof rec.lat === "number" && typeof rec.lng === "number") return { lat: rec.lat, lng: rec.lng };
  const [a, b] = rec.tile.split("_").map(Number);
  return { lat: a * TILE_DEG, lng: b * TILE_DEG };
}

async function readCurated(): Promise<Curated[]> {
  const out: Curated[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const url = `${SUPABASE_URL}/rest/v1/curated_descriptions?select=name,lat,lng&order=name&limit=${PAGE}&offset=${offset}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(DB_TIMEOUT_MS), headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
    } catch (e) {
      throw new Error(`curated_descriptions read ${(e as any)?.name === "TimeoutError" ? `timed out after ${DB_TIMEOUT_MS / 1000} s` : `failed: ${e}`} at offset ${offset}`);
    }
    if (!res.ok) throw new Error(`curated_descriptions read HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("curated_descriptions read: response was not an array");
    for (const r of rows) {
      const lat = Number(r?.lat), lng = Number(r?.lng);
      if (r?.name && Number.isFinite(lat) && Number.isFinite(lng)) out.push({ name: String(r.name), lat, lng, nc: nameClean(r.name) });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

// The names the live map serves for a tile right now (null = could not read).
const servedMemo = new Map<string, Set<string> | null>();
async function servedNames(tile: string, lat: number, lng: number): Promise<Set<string> | null> {
  if (servedMemo.has(tile)) return servedMemo.get(tile)!;
  let names: Set<string> | null = null;
  for (let attempt = 0; attempt < 2 && names === null; attempt++) {
    try {
      const res = await fetch(NEARBY_URL, {
        signal: AbortSignal.timeout(FN_TIMEOUT_MS),
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: NKEY, Authorization: `Bearer ${NKEY}` },
        body: JSON.stringify({ lat, lng }),
      });
      if (res.ok) {
        const d = await res.json();
        if (Array.isArray(d?.places)) names = new Set(d.places.map((p: any) => nameClean(p?.name)));
      } else {
        await res.body?.cancel().catch(() => {});
      }
    } catch (_e) { /* timeout or network — retried once, then UNKNOWN */ }
    if (names === null && attempt === 0) await new Promise((r) => setTimeout(r, 3000));
  }
  servedMemo.set(tile, names);
  return names;
}

async function main() {
  console.log(BUILD);
  const files = Deno.args.filter((a) => !a.startsWith("--"));
  if (!files.length) {
    console.error("Usage: deno run -A 507_curated_drop_check.ts <records.json> [more records.json …]\n  e.g. ~/roaminator-497/*.records.json gate_tiles_records.json");
    Deno.exit(1);
  }
  if (!SUPABASE_URL || !SRK) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (curated_descriptions is service-role only). Nothing was read.");
    Deno.exit(1);
  }

  // 1) Every dropped pin, per (tile, name), remembering which files listed it.
  const drops = new Map<string, { rec: Rec; name: string; category: string; files: Set<string> }>();
  let recCount = 0, dropCount = 0, committedRecs = 0, unmarkedRecs = 0;
  for (const f of files) {
    let recs: Rec[];
    try {
      recs = JSON.parse(await Deno.readTextFile(f));
    } catch (e) {
      console.error(`  skipped ${f}: could not read/parse (${e})`);
      continue;
    }
    if (!Array.isArray(recs)) { console.error(`  skipped ${f}: not a records array`); continue; }
    for (const rec of recs) {
      if (!rec?.tile || !Array.isArray(rec.dropped)) continue;
      recCount++;
      if (rec.committed === true) committedRecs++; else unmarkedRecs++;
      for (const d of rec.dropped) {
        if (!d?.name) continue;
        dropCount++;
        const key = `${rec.tile}|${nameClean(d.name)}`;
        const cur = drops.get(key) ?? { rec, name: d.name, category: String(d.category ?? ""), files: new Set<string>() };
        cur.files.add(f);
        if (rec.committed === true) cur.rec = rec; // prefer the committed record's flag
        drops.set(key, cur);
      }
    }
  }
  console.log(`Read ${files.length} file(s): ${recCount} tile record(s) (${committedRecs} marked committed, ${unmarkedRecs} not marked — a dry-run file carries no flag), ${dropCount} dropped pin(s), ${drops.size} distinct by tile+name.`);

  // 2) Curated rows, indexed by name_clean.
  let curated: Curated[];
  try {
    curated = await readCurated();
  } catch (e) {
    console.error(`\n${(e as Error).message}. Check SUPABASE_SERVICE_ROLE_KEY (a 401 means the key is wrong or missing). Nothing was written.`);
    Deno.exit(1);
  }
  const byName = new Map<string, Curated[]>();
  for (const c of curated) { const a = byName.get(c.nc) ?? []; a.push(c); byName.set(c.nc, a); }
  console.log(`curated_descriptions: ${curated.length} row(s), ${byName.size} distinct names.`);

  // 3) Match, then check the live map.
  const hits: Hit[] = [];
  for (const { rec, name, category, files: fs } of drops.values()) {
    const cands = byName.get(nameClean(name));
    if (!cands) continue;
    const { lat, lng } = tileCentre(rec);
    let best: Curated | null = null, bestKm = Infinity;
    for (const c of cands) { const km = haversineKm(lat, lng, c.lat, c.lng); if (km < bestKm) { best = c; bestKm = km; } }
    if (!best || bestKm > MATCH_KM) continue;
    const served = await servedNames(rec.tile, lat, lng);
    const status: Hit["status"] = served === null ? "UNKNOWN" : served.has(nameClean(name)) ? "ON MAP" : "LOST";
    hits.push({
      status, name, category, tile: rec.tile, metro: rec.metro ?? "?", committedFlag: rec.committed === true ? true : null,
      curatedName: best.name, curatedLat: best.lat, curatedLng: best.lng, distKm: Math.round(bestKm * 100) / 100, files: [...fs],
    });
  }

  // 4) Report.
  const order = { LOST: 0, UNKNOWN: 1, "ON MAP": 2 } as const;
  hits.sort((a, b) => order[a.status] - order[b.status] || a.metro.localeCompare(b.metro) || a.name.localeCompare(b.name));
  const n = (s: Hit["status"]) => hits.filter((h) => h.status === s).length;
  console.log(`\nDropped pins with a curated story: ${hits.length} — LOST ${n("LOST")} · ON MAP ${n("ON MAP")} · UNKNOWN ${n("UNKNOWN")}`);
  for (const h of hits) {
    console.log(`  ${h.status.padEnd(7)} ${h.metro.padEnd(16)} ${h.tile.padEnd(11)} ${h.name}${h.curatedName !== h.name ? `  (curated: "${h.curatedName}")` : ""}  [${h.category}, ${h.distKm} km from tile centre${h.committedFlag ? ", committed" : ""}]`);
  }
  const lostTiles = [...new Set(hits.filter((h) => h.status === "LOST").map((h) => h.tile))].sort();
  if (lostTiles.length) {
    console.log(`\nTiles holding a LOST curated pin: ${lostTiles.length} → ${lostTiles.join(" ")}`);
    console.log("Nothing has been changed. The restore (delete those tile rows so the live path rebuilds them, then warm each one) is the next step, delivered separately once these are reviewed.");
  } else if (hits.length) {
    console.log("\nNo curated pin is missing from the live map right now.");
  } else {
    console.log("\nNo dropped pin matches a curated story.");
  }
  if (n("UNKNOWN")) console.log(`${n("UNKNOWN")} pin(s) UNKNOWN: nearby-places did not answer for their tile — re-run to settle them.`);
  await Deno.writeTextFile(OUT_FILE, JSON.stringify({ build: BUILD, files, recCount, dropCount, curatedRows: curated.length, hits }, null, 2));
  console.log(`\nwrote ${OUT_FILE}. NOTHING was written to the database.`);
}

if (import.meta.main) main();
