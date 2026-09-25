// =============================================================================
// prewarm-tiles.ts — #292 cold-tile FIRST-VISITOR latency, lever (a): PRE-WARM.
// Build 2026.09.24a. OFFLINE TOOL at the repo root — NOT a deploy target.
// Changes no index.html / function / APP_VERSION / CACHE_VERSION.
//
// WHAT IT DOES
//   Walks every ~5.5 km map tile covering the 21 launch metros and POSTs each tile
//   centre to the DEPLOYED `nearby-places`. A cold tile makes the function do its own
//   Overpass + Wikipedia build and write the cache row (`places:<CACHE_VERSION>:<tile>`),
//   so a real user arriving later gets the instant warm path instead of the ~15 s
//   Overpass wait. A warm tile returns instantly and costs nothing; an expired tile is
//   served stale and background-refreshed by #394 SWR. So a RE-RUN only pays Overpass
//   on tiles that failed or were never warmed — the re-run IS the retry.
//
// WHY A FRESH BUILD: the August 2026 prewarm-tiles.ts was delivered (#292) but never
//   committed to the repo. This one is rebuilt on gate-tiles.ts's roster, tile math
//   and warm call (the project copy), NOT reconstructed from memory.
//
// MIRRORS (change together or tiles drift):
//   - TILE_DEG = nearby-places REAL_TILE_DEG (0.05); tile key = round(coord/0.05).
//   - METROS + enumerateTiles = gate-tiles.ts (same 21 metros, same bbox half-size).
//   The function snaps every request to the tile centre (#27 fetch-anchor), and this
//   tool posts the exact centre, so a warm lands on the tile the key names.
//
// ENV (same names as gate-tiles.ts, so the Mac env you already use works):
//   NEARBY_PLACES_KEY   the function's anon/publishable key (fallback: SUPABASE_ANON_KEY)
//   NEARBY_PLACES_URL   full function URL (fallback: NEARBY_FN_URL,
//                       else SUPABASE_URL + /functions/v1/nearby-places)
// KNOBS:
//   PREWARM_CONCURRENCY  default 2 — each cold tile is a public-Overpass fetch plus up to
//                        12 Wikipedia resolves; Overpass 429s and Wikimedia rate-limits
//                        under burst. Raise to 3–4 only if a run is clean.
//   PREWARM_METRO_KM     default 15 — bbox half-size per metro (gate-tiles' GATE_METRO_KM).
//   PREWARM_METRO        only warm metros whose name contains this text (e.g. "Chicago").
//   PREWARM_PACE_MS      default 1000 — gap each worker waits after a COLD build.
//   PREWARM_TIMEOUT_MS   default 90000 — per-request timeout.
//   PREWARM_DRY_RUN=1    enumerate + estimate, POST nothing.
// FLAGS:
//   --retry-failed       only re-POST the tiles listed in prewarm_failed.json.
//
// RUN (repo root):
//   PREWARM_DRY_RUN=1 deno run -A prewarm-tiles.ts
//   deno run -A prewarm-tiles.ts
//   deno run -A prewarm-tiles.ts --retry-failed      (or just re-run the full pass)
//
// OUTCOMES per tile:
//   warm      served from cache (cached:true, fresh)
//   stale     served from an expired row; the function refreshes it in the background
//   built     cold build, cache row WRITTEN (cacheWritten:true) — the tile is now warm.
//             Since #399 this includes healthy-EMPTY tiles (open water, lake, bay): the
//             function caches them as a 3-day osmEmpty row; the detail says "healthy-empty".
//   water     cold build, Overpass answered 200 with 0 OSM places, NOT cached — the
//             pre-#399 function (or a tile whose older row had OSM places, which #399
//             refuses to overwrite with an empty answer). A real answer, not a failure,
//             so it is NOT re-queued (#399: re-queuing water tiles forever was the bug).
//   empty     no places at all and the function reported no cache field (pre-#399 path 4)
//   failed    Overpass error / partial build not cached / HTTP error / timeout → retry
// Failed tiles (and only those) are written to prewarm_failed.json.
//
// #399 (2026.09.24a): adds the `water` outcome and reads the function's
// `emptyTileVersion` / `osmEmpty` fields. Tile math, roster and warm call unchanged.
// =============================================================================

type Metro = { name: string; lat: number; lng: number };
type TileRef = { tile: string; lat: number; lng: number; metro: string };
type Outcome = "warm" | "stale" | "built" | "water" | "empty" | "failed";

const BUILD = "2026.09.24a";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/+$/, "");
const NEARBY_URL = (env("NEARBY_PLACES_URL") || env("NEARBY_FN_URL") ||
  (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/nearby-places` : "")).replace(/\/+$/, "");
const NKEY = env("NEARBY_PLACES_KEY") || env("SUPABASE_ANON_KEY");

const TILE_DEG = 0.05; // MUST mirror nearby-places REAL_TILE_DEG
const METRO_KM = Number(env("PREWARM_METRO_KM") || 15);
const CONCURRENCY = Math.max(1, Number(env("PREWARM_CONCURRENCY") || 2));
const PACE_MS = Number(env("PREWARM_PACE_MS") || 1000);
const TIMEOUT_MS = Number(env("PREWARM_TIMEOUT_MS") || 90000);
const METRO_FILTER = env("PREWARM_METRO").toLowerCase();
const DRY_RUN = env("PREWARM_DRY_RUN") === "1";
const RETRY_FAILED = Deno.args.includes("--retry-failed");
const FAILED_FILE = "prewarm_failed.json";

// Same roster as gate-tiles.ts (21 launch metros).
const METROS: Metro[] = [
  { name: "Chicago", lat: 41.8781, lng: -87.6298 },
  { name: "New York", lat: 40.7128, lng: -74.0060 },
  { name: "San Francisco", lat: 37.7749, lng: -122.4194 },
  { name: "Seattle", lat: 47.6062, lng: -122.3321 },
  { name: "Portland", lat: 45.5152, lng: -122.6784 },
  { name: "Denver", lat: 39.7392, lng: -104.9903 },
  { name: "Boston", lat: 42.3601, lng: -71.0589 },
  { name: "Washington, D.C.", lat: 38.9072, lng: -77.0369 },
  { name: "Philadelphia", lat: 39.9526, lng: -75.1652 },
  { name: "Atlanta", lat: 33.7490, lng: -84.3880 },
  { name: "Houston", lat: 29.7604, lng: -95.3698 },
  { name: "Austin", lat: 30.2672, lng: -97.7431 },
  { name: "Dallas", lat: 32.7767, lng: -96.7970 },
  { name: "Fort Worth", lat: 32.7555, lng: -97.3308 },
  { name: "Nashville", lat: 36.1627, lng: -86.7816 },
  { name: "New Orleans", lat: 29.9511, lng: -90.0715 },
  { name: "Miami", lat: 25.7617, lng: -80.1918 },
  { name: "San Diego", lat: 32.7157, lng: -117.1611 },
  { name: "Phoenix", lat: 33.4484, lng: -112.0740 },
  { name: "Minneapolis", lat: 44.9778, lng: -93.2650 },
  { name: "St. Paul", lat: 44.9537, lng: -93.0900 },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tileKeyOf(lat: number, lng: number): string {
  return Math.round(lat / TILE_DEG) + "_" + Math.round(lng / TILE_DEG);
}

// Same enumeration as gate-tiles.ts: a METRO_KM half-size bbox per metro, deduped
// globally by tile key (Dallas/Fort Worth and Minneapolis/St. Paul overlap).
function enumerateTiles(metros: Metro[]): TileRef[] {
  const seen = new Set<string>();
  const out: TileRef[] = [];
  const kmPerDegLat = 111.0;
  for (const m of metros) {
    const dLat = METRO_KM / kmPerDegLat;
    const dLng = METRO_KM / (kmPerDegLat * Math.max(0.1, Math.cos((m.lat * Math.PI) / 180)));
    for (let lat = m.lat - dLat; lat <= m.lat + dLat + 1e-9; lat += TILE_DEG) {
      for (let lng = m.lng - dLng; lng <= m.lng + dLng + 1e-9; lng += TILE_DEG) {
        const key = tileKeyOf(lat, lng);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          tile: key,
          lat: Math.round(lat / TILE_DEG) * TILE_DEG,
          lng: Math.round(lng / TILE_DEG) * TILE_DEG,
          metro: m.name,
        });
      }
    }
  }
  return out;
}

type Result = { t: TileRef; outcome: Outcome; ms: number; detail: string; cacheVersion?: string; swrVersion?: string; emptyTileVersion?: string };

async function warmTile(t: TileRef): Promise<Result> {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(NEARBY_URL, {
      method: "POST",
      headers: { apikey: NKEY, Authorization: `Bearer ${NKEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ lat: t.lat, lng: t.lng }),
      signal: ctl.signal,
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { t, outcome: "failed", ms, detail: `HTTP ${res.status} ${body.slice(0, 120)}` };
    }
    const j: any = await res.json().catch(() => null);
    if (!j) return { t, outcome: "failed", ms, detail: "unparseable response" };
    if (j.error) return { t, outcome: "failed", ms, detail: `function error: ${String(j.error).slice(0, 120)}` };
    const n = Array.isArray(j.places) ? j.places.length : 0;
    const base = { t, ms, cacheVersion: j.cacheVersion, swrVersion: j.swrVersion, emptyTileVersion: j.emptyTileVersion };
    const emptyTag = j.osmEmpty === true ? ", healthy-empty 3-day row" : "";
    if (j.cached === true && j.stale) {
      return { ...base, outcome: "stale", detail: `${n} pins${emptyTag}, refresh=${j.refresh ?? j.refreshing ?? "?"}` };
    }
    if (j.cached === true) return { ...base, outcome: "warm", detail: `${n} pins${emptyTag}` };
    if (j.cacheWritten === true) return { ...base, outcome: "built", detail: `${n} pins shown, osm=${j.osmCount ?? "?"}${emptyTag}` };
    if (j.overpassError) return { ...base, outcome: "failed", detail: `overpass: ${String(j.overpassError).slice(0, 100)}` };
    // #399 — Overpass answered cleanly with nothing and the function didn't cache it:
    // a real (water) answer, not a failure, so it stays out of the retry file.
    if (j.overpassStatus === 200 && j.osmCount === 0 && j.cacheWritten === false) {
      return { ...base, outcome: "water", detail: `osm=0, overpassStatus=200, not cached (${n} wiki pins) — deploy #399 to cache these` };
    }
    if (n === 0 && !("cacheWritten" in j)) return { ...base, outcome: "empty", detail: "no places" };
    return { ...base, outcome: "failed", detail: `built but NOT cached (osm=${j.osmCount ?? "?"}, overpassStatus=${j.overpassStatus ?? "?"})` };
  } catch (e) {
    const ms = Date.now() - started;
    const msg = (e as Error)?.name === "AbortError" ? `timeout after ${TIMEOUT_MS} ms` : String((e as Error)?.message || e);
    return { t, outcome: "failed", ms, detail: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`;
}

async function main() {
  console.log(`[prewarm-tiles] build ${BUILD} — #292 lever (a): warm every launch-metro tile ahead of users.`);

  let tiles: TileRef[];
  if (RETRY_FAILED) {
    try {
      tiles = JSON.parse(await Deno.readTextFile(FAILED_FILE));
    } catch (_e) {
      console.error(`FATAL: --retry-failed needs ${FAILED_FILE} from a previous run.`);
      Deno.exit(1);
    }
    console.log(`[prewarm-tiles] --retry-failed: ${tiles.length} tiles from ${FAILED_FILE}`);
  } else {
    const metros = METRO_FILTER ? METROS.filter((m) => m.name.toLowerCase().includes(METRO_FILTER)) : METROS;
    if (!metros.length) {
      console.error(`FATAL: PREWARM_METRO="${METRO_FILTER}" matches no metro.`);
      Deno.exit(1);
    }
    tiles = enumerateTiles(metros);
    console.log(`[prewarm-tiles] ${metros.length} metro(s) → ${tiles.length} unique tiles (metroKm=${METRO_KM}, tileDeg=${TILE_DEG})`);
    const perMetro = new Map<string, number>();
    for (const t of tiles) perMetro.set(t.metro, (perMetro.get(t.metro) ?? 0) + 1);
    console.log("  " + [...perMetro].map(([k, v]) => `${k} ${v}`).join(" · "));
  }

  // Rough worst case: every tile cold at ~16 s each (Overpass ~15 s + pacing).
  const worst = (tiles.length * (16000 + PACE_MS)) / CONCURRENCY;
  console.log(`[prewarm-tiles] concurrency=${CONCURRENCY} → worst case (all cold) ≈ ${fmtDur(worst)}; a re-run over warm tiles takes minutes.`);

  if (DRY_RUN) {
    console.log("[prewarm-tiles] DRY RUN — nothing posted. Unset PREWARM_DRY_RUN to warm.");
    return;
  }
  if (!NEARBY_URL || !NKEY) {
    console.error("FATAL: set NEARBY_PLACES_KEY (or SUPABASE_ANON_KEY) and NEARBY_PLACES_URL (or NEARBY_FN_URL, or SUPABASE_URL).");
    Deno.exit(1);
  }
  console.log(`[prewarm-tiles] target ${NEARBY_URL}`);

  const counts: Record<Outcome, number> = { warm: 0, stale: 0, built: 0, water: 0, empty: 0, failed: 0 };
  const failed: TileRef[] = [];
  const failNotes: string[] = [];
  const versions = new Set<string>();
  const t0 = Date.now();
  let next = 0, done = 0;
  const logEvery = tiles.length <= 60 ? 1 : 10;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tiles.length) return;
      const r = await warmTile(tiles[i]);
      counts[r.outcome]++;
      done++;
      if (r.cacheVersion) versions.add(`${r.cacheVersion}${r.swrVersion ? " / " + r.swrVersion : ""}${r.emptyTileVersion ? " / " + r.emptyTileVersion : ""}`);
      if (r.outcome === "failed") {
        failed.push(r.t);
        if (failNotes.length < 25) failNotes.push(`${r.t.metro} ${r.t.tile}: ${r.detail}`);
      }
      if (done % logEvery === 0 || done === tiles.length || r.outcome === "failed") {
        const elapsed = Date.now() - t0;
        const eta = done ? (elapsed / done) * (tiles.length - done) : 0;
        console.log(`[prewarm-tiles] ${done}/${tiles.length} ${r.t.metro} ${r.t.tile} ${r.outcome} (${fmtDur(r.ms)}; ${r.detail}) — elapsed ${fmtDur(elapsed)}, eta ${fmtDur(eta)}`);
      }
      // Only pace after real work; warm/stale answers are instant and cost Overpass nothing.
      if (r.outcome === "built" || r.outcome === "water" || r.outcome === "empty" || r.outcome === "failed") await sleep(PACE_MS);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tiles.length) }, () => worker()));

  await Deno.writeTextFile(FAILED_FILE, JSON.stringify(failed, null, 2));

  console.log("");
  console.log(`[prewarm-tiles] DONE in ${fmtDur(Date.now() - t0)} — ${tiles.length} tiles`);
  console.log(`  warm ${counts.warm} · stale ${counts.stale} · built ${counts.built} · water ${counts.water} · empty ${counts.empty} · failed ${counts.failed}`);
  if (counts.water) console.log(`  ${counts.water} water tile(s) answered empty but were NOT cached — expected only before #399 is deployed (the function should report emptyTileVersion).`);
  if (versions.size) console.log(`  function reported: ${[...versions].join(", ")}`);
  if (failed.length) {
    console.log(`  ${failed.length} failed tile(s) written to ${FAILED_FILE} — re-run with --retry-failed (or re-run the full pass).`);
    for (const n of failNotes) console.log(`    ${n}`);
    if (failed.length > failNotes.length) console.log(`    … and ${failed.length - failNotes.length} more`);
  } else {
    console.log(`  no failures (${FAILED_FILE} cleared).`);
  }
}

if (import.meta.main) await main();
