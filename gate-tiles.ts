// gate-tiles.ts — the OFFLINE story gate for the tile cache (#344 brick 4).
// =============================================================================
// WHY THIS TOOL EXISTS (the v34/v35 gravestone):
//   Brick 4 was first built INSIDE `nearby-places` — the tile-build request
//   resolved each facts pin's story by name and gated on the spot. It shipped
//   twice and was reverted twice: v34 DROPPED documented places (Millennium Park,
//   Cloud Gate, Grant Park …) because a Wikipedia 429 read as a miss under a burst
//   of ~58 sequential resolves; v35 made the resolve throttle-aware but then the
//   backoff blew the 150 s Edge Function wall on real tiles (HTTP 546/504, empty
//   map). The lesson, now load-bearing: you CANNOT do dozens of throttle-resilient
//   network resolves inside one 150 s function invocation. So the resolution moves
//   OFF the request path into this offline tool — paced, throttle-resilient, no
//   wall limit — exactly like every other data job (seed-resolve / graves-resolve /
//   backfill-resolved-descriptions). The function stays on its fast, ungated build
//   (v33); this tool bakes the gate into the tile cache row it already serves. That
//   honours #344 option (A) — "a render gate baked into the tile, NOT a new
//   per-OSM-id store" — the store IS the tile; only the resolver moved.
//
// WHAT IT DOES, per tile:
//   1. Read the tile's cache row from `shared_kv` (key `places:<VER>:<tile>`,
//      value `{ts, places}` — the exact shape writeCacheRow persists). If the row
//      is missing, WARM it (POST the tile centre to the deployed function, which
//      builds + caches it) and re-read.
//   2. GATE the places: a pin is KEPT iff it carries a real, SOURCED description —
//      a Wikipedia-feed pin (source !== "osm", already gated upstream), an OSM pin
//      whose desc is NOT an osmDesc filler TEMPLATE (i.e. it already carries a human
//      description/inscription tag or an own-`wikipedia=` intro the function baked),
//      or an OSM FACTS pin (history/park/trail/art) whose NAME resolves a
//      coordinate-gated Wikipedia article HERE (bake that intro onto the pin). A
//      facts pin left on a filler template with no resolvable article is DROPPED —
//      the map becomes exactly "things with a story" (the #308 pivot, made literal).
//   3. Write the gated row back (with ts=now, so the tile stays fresh 21 days and
//      the function serves the gated set instead of rebuilding it ungated).
//
// FALSE-HIDE DEFENSE (#101/#178, the bricks-1–3 discipline): a pin is dropped ONLY
// when it was CHECKED and cleanly missed. A resolve that THROTTLES (Wikipedia 429
// after backoff) is NOT a miss — the whole TILE is marked `throttled`, kept intact,
// NOT committed, and parked in the held file to re-run when Wikipedia is healthy.
// So a throttle can never bake a false hide. Unknown/未recognised desc shapes are
// KEPT (over-show), never dropped — the safe direction if osmDesc ever adds a filler.
//
// PROPOSE-THEN-COMMIT (#266): a plain run WRITES NOTHING — it emits
// gate_tiles_records.json / _report.json / _held.json and stops. Eyeball the report
// (every DROP is listed by name + its filler desc), then re-run with --commit.
//
// WRONG-ATTACH GATE (#316 / blank-beats-wrong): a resolved article is accepted only
// when its OWN coordinate sits within GATE_COORD_KM of the pin (or, for a strong
// title match, within GATE_SUBSET_KM — the long-linear-feature allowance), AND the
// title covers the name OR the coordinate is essentially ON the pin. A same-named
// place in another city (Parthenon → Athens) is thousands of km away and fails.
//
// COST: the default resolve path is Wikipedia-by-name ONLY — NO Gemini, NO cost.
// The function's `resolveWiki` action (which fires the Gemini alias-recall rung on a
// miss) is used ONLY with --gen, and ONLY for pins the free Wikipedia pass missed.
// Keep --gen off for a zero-cost run; turn it on to rescue extra long-tail pins.
//
// DECAY / MAINTENANCE: the function still rebuilds a tile ungated on a cold miss or
// a 21-day-stale SWR refresh, so the gate is not permanent — it is a SWEEP you re-run
// on a cadence (#319). Writing ts=now maximises how long each gated tile stays fresh.
// A user hitting a not-yet-gated cell over-shows (never false-hides) until the sweep
// reaches it. Run during low traffic: a concurrent user rebuild can re-ungate a tile
// mid-run (rare; the next sweep re-gates it).
//
// RUN (dry-run → eyeball → commit), Codespace, Deno:
//   export SUPABASE_URL=…  SUPABASE_SERVICE_ROLE_KEY=…  NEARBY_PLACES_KEY=<anon key>
//   deno run --allow-net --allow-env --allow-read --allow-write gate-tiles.ts            # single metro dry-run (SEED_CITY_* or default Chicago)
//   deno run --allow-net --allow-env --allow-read --allow-write gate-tiles.ts --all      # all metros dry-run
//   deno run --allow-net --allow-env --allow-read --allow-write gate-tiles.ts --all --commit
//   deno run --allow-net --allow-env --allow-read --allow-write gate-tiles.ts --held --commit    # re-run only throttled tiles
//   deno run --allow-net --allow-env --allow-read --allow-write gate-tiles.ts --from-records --commit  # commit the on-disk records with no re-crawl
//   # --gen adds the function's Gemini/Wikidata recall for pins the free wiki pass missed (costs Gemini).
//
// VERIFY (REST): the committed rows are ordinary cache rows —
//   curl "$SUPABASE_URL/rest/v1/shared_kv?key=eq.places:<VER>:<tile>&select=value" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
// BACK-OUT: delete the gated rows; the function rebuilds them ungated on next hit:
//   delete from shared_kv where key like 'places:<VER>:%';   -- (or wait out the 21-day TTL)
//
// CONFIG OUTSIDE THE FILE: reuses the SAME Codespaces secrets seed-resolve.ts uses
// (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). NEARBY_PLACES_KEY is the function's
// ANON key (the public `sb_publishable_…` used to warm tiles / call resolveWiki).
// GEMINI is the FUNCTION's env only (used solely under --gen); this tool never holds
// a Gemini key. NOT a deploy target; changes no `index.html`/function/APP_VERSION.
// =============================================================================

// ---- config ----
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const NEARBY_URL = (Deno.env.get("NEARBY_PLACES_URL") ?? `${SUPABASE_URL}/functions/v1/nearby-places`).replace(/\/+$/, "");
const NKEY = Deno.env.get("NEARBY_PLACES_KEY") ?? "";

const TILE_DEG = Number(Deno.env.get("GATE_TILE_DEG") ?? 0.05);   // MUST mirror the function's REAL_TILE_DEG (tileKey = round(coord/TILE_DEG))
const METRO_KM = Number(Deno.env.get("GATE_METRO_KM") ?? 15);     // bbox half-size per metro; sprawly metros can add a second roster row
const COORD_KM = Number(Deno.env.get("GATE_COORD_KM") ?? 1.0);    // tight anti-wrong-attach: article's own coord must sit this close to the pin…
const SUBSET_KM = Number(Deno.env.get("GATE_SUBSET_KM") ?? 25.0); // …unless the title strongly matches the name (long linear features, #54/#316)
const PACE_MS = Number(Deno.env.get("GATE_PACE_MS") ?? 250);      // gap between resolves — throttle politeness
const WIKI_TIMEOUT_MS = Number(Deno.env.get("GATE_WIKI_TIMEOUT_MS") ?? 12000);
const NAME_MIN = Number(Deno.env.get("GATE_NAME_MIN") ?? 0.5);    // title must cover ≥ half the name's distinctive tokens (#54 floor)
const UA = Deno.env.get("GATE_UA") ?? "NahgooGateTiles/1.0 (offline story-gate sweep; contact via app)";

const COMMIT = Deno.args.includes("--commit");
const ALL_METROS = Deno.args.includes("--all") || Deno.env.get("GATE_ALL") === "1";
const HELD_ONLY = Deno.args.includes("--held");
const FROM_RECORDS = Deno.args.includes("--from-records");
const USE_GEN = Deno.args.includes("--gen") || Deno.env.get("GATE_GEN") === "1";

const RECORDS_FILE = "gate_tiles_records.json";
const REPORT_FILE = "gate_tiles_report.json";
const HELD_FILE = "gate_tiles_held.json";

// The categories that resolve a real Wikipedia "what it is" by NAME — mirror the
// function's/client's REAL_DESC_FACTS_CATS (#329/#334). Only these OSM pins are gated.
const FACTS_CATS = new Set(["history", "park", "trail", "art"]);

// ---- the 21-metro launch roster (mirror of the graves-resolve roster) ----
type Metro = { name: string; lat: number; lng: number };
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

// ---- geometry (MIRRORS the function's tileKey/tileCenter) ----
function tileKeyOf(lat: number, lng: number): string {
  return Math.round(lat / TILE_DEG) + "_" + Math.round(lng / TILE_DEG);
}
function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

type TileRef = { tile: string; lat: number; lng: number; metro: string };
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
        // Snap to the tile centre exactly as the function does, so a warm-POST lands
        // on the same tile the key names (no edge drift).
        out.push({ tile: key, lat: Math.round(lat / TILE_DEG) * TILE_DEG, lng: Math.round(lng / TILE_DEG) * TILE_DEG, metro: m.name });
      }
    }
  }
  return out;
}

// ---- filler detection (the osmDesc fallback templates) ----
// A pin whose desc matches one of these is on a TEMPLATE (no story) and must resolve
// a real article to survive. Anything NOT matched is treated as a real description
// (human tag / baked wiki intro) and KEPT without resolving — so if osmDesc ever adds
// a new fallback string, the worst case is an over-shown pin, NEVER a false drop.
// Kept in sync with nearby-places' osmDesc(); commercial fallbacks are omitted because
// commercial is never a FACTS category (post-#309 it does not reach a tile at all).
const FILLER_EXACT = new Set<string>([
  // park
  "A local green space to wander.", "A local garden to wander.", "A protected local nature area.",
  // trail
  "A trailhead — the start of a marked trail.", "A marked hiking route.", "A marked mountain-bike route.",
  "An unpaved track worth a walk.", "A walking trail nearby.",
  // art
  "A piece of public art.",
  // history
  "A local memorial.", "A war memorial.", "A local museum.",
  // generic
  "A local spot worth a look.",
]);
const FILLER_RE: RegExp[] = [
  /^A hiking trail \(.+\)\.$/,       // trail sac_scale
  /^A public .+\.$/,                 // art "A public sculpture." / "A public statue." …
  /^A .+ by .+\.$/,                  // art "A sculpture by X."
  /^A local landmark \(.+\)\.$/,     // history subtype
  /^A local memorial \(.+\)\.$/,     // history memorial subtype
  /^A local .*museum\.$/,            // history museum ("A local art museum.")
];
function isFillerDesc(desc: unknown): boolean {
  const d = String(desc ?? "").trim();
  if (d === "") return true;                 // empty = no story
  if (FILLER_EXACT.has(d)) return true;
  return FILLER_RE.some((re) => re.test(d));
}

// ---- name/title scoring (token overlap, #54 shape) ----
function tokens(s: string): string[] {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t && t.length > 2);
}
const STOP = new Set(["the", "and", "for", "los", "las", "san", "old", "new"]);
function nameScore(name: string, title: string): number {
  const nT = tokens(name).filter((t) => !STOP.has(t));
  const tT = new Set(tokens(title));
  if (!nT.length) return 0;
  let hit = 0;
  for (const t of nT) if (tT.has(t)) hit++;
  return hit / nT.length;
}

// ---- throttle-aware Wikipedia fetch (the v35 discriminator, ported offline) ----
// Retries a 429/5xx/network/timeout with backoff; only when retries are EXHAUSTED
// does it report throttled=true (the caller then KEEPS the pin, never drops it).
async function wikiFetchTA(url: string): Promise<{ throttled: boolean; json: any }> {
  const backoffs = [0, 1500, 4000, 9000, 15000];
  for (let i = 0; i < backoffs.length; i++) {
    if (backoffs[i]) await sleep(backoffs[i]);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WIKI_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA } });
      if (res.status === 429 || res.status >= 500) {
        const ra = parseInt(res.headers.get("retry-after") || "", 10);
        if (ra && !Number.isNaN(ra)) await sleep(Math.min(ra * 1000, 20000));
        continue;
      }
      if (!res.ok) return { throttled: false, json: null };  // clean non-throttle error = real miss
      return { throttled: false, json: await res.json().catch(() => null) };
    } catch (_e) {
      continue;                                              // network/timeout/abort → retry
    } finally { clearTimeout(timer); }
  }
  return { throttled: true, json: null };                    // exhausted → throttled (KEEP)
}

// ---- the coordinate gate (compact #316) ----
function gateOk(name: string, lat: number, lng: number, pg: any): boolean {
  const raw = String(pg?.extract || "").trim();
  if (!raw) return false;                                    // #101 — nothing to show beats an invented line
  if (/\bmay refer to\b/i.test(raw) || /\(disambiguation\)/i.test(String(pg?.title || ""))) return false;
  const co = (pg?.coordinates && pg.coordinates[0]) || null;
  if (!co || typeof co.lat !== "number" || typeof co.lon !== "number") return false; // require a coordinate — the honest anti-wrong-attach anchor
  const km = haversine(lat, lng, co.lat, co.lon) / 1000;
  const nameOk = nameScore(name, String(pg.title || "")) >= NAME_MIN;
  const coordIdentity = km <= 0.15;                          // article sits essentially ON the pin
  // Location: within the tight radius, OR within the wider radius for a strong title
  // match (long linear features — a trail's article centroid sits km from the pin).
  if (km > COORD_KM && !(nameOk && km <= SUBSET_KM)) return false;
  // Context: the title must cover the name, OR the coordinate identifies it.
  if (!nameOk && !coordIdentity) return false;
  return true;
}

// ---- resolve a pin's story: Wikipedia-by-name only, throttle-aware, NO Gemini ----
// Returns {desc,title} on a gate-passing article, null on a CLEAN miss, "throttled".
async function resolveStory(name: string, lat: number, lng: number): Promise<{ desc: string; title: string } | null | "throttled"> {
  if (!name || typeof lat !== "number" || typeof lng !== "number") return null;
  const sUrl = "https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*" +
    "&generator=search&gsrsearch=" + encodeURIComponent(name) + "&gsrlimit=5&gsrnamespace=0" +
    "&prop=coordinates%7Cextracts&exintro=1&explaintext=1&exlimit=20&colimit=max";
  const s = await wikiFetchTA(sUrl);
  if (s.throttled) return "throttled";
  const pages: any[] = s.json ? Object.values(((s.json.query || {}).pages) || {}) : [];
  const scored = pages
    .filter((p) => p && p.title)
    .map((p) => ({ p, score: nameScore(name, p.title) }))
    .filter((x) => x.score >= NAME_MIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  for (const { p } of scored) {
    // Hydrate for a reliable coordinate + full intro (the combined search drops
    // coordinates / truncates extracts). A hydrate throttle keeps the pin.
    const hUrl = "https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1" +
      "&titles=" + encodeURIComponent(p.title) +
      "&prop=coordinates%7Cextracts&coprimary=all&colimit=max&exintro=1&explaintext=1";
    const h = await wikiFetchTA(hUrl);
    if (h.throttled) return "throttled";
    const pg = h.json ? Object.values(((h.json.query || {}).pages) || {})[0] : null;
    const cand = (pg && (pg as any).missing === undefined && (pg as any).title) ? pg : p;
    if (gateOk(name, lat, lng, cand)) {
      const desc = String((cand as any).extract || "").trim();
      if (desc) return { desc, title: String((cand as any).title || "") };
    }
  }
  return null;
}

// ---- optional --gen rescue: the function's resolveWiki (Gemini/Wikidata recall) ----
async function resolveViaFunction(name: string, lat: number, lng: number): Promise<{ desc: string } | null> {
  try {
    const res = await fetch(NEARBY_URL, {
      method: "POST",
      headers: { apikey: NKEY, Authorization: `Bearer ${NKEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resolveWiki", name, lat, lng }),
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const d = j && j.place && j.place.desc ? String(j.place.desc).trim() : "";
    return d ? { desc: d } : null;
  } catch (_e) { return null; }
}

// ---- shared_kv REST (service role) ----
async function kvRead(key: string): Promise<{ ts: number; places: any[] } | null> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/shared_kv?key=eq.${encodeURIComponent(key)}&select=value`;
    const res = await fetch(url, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    if (!Array.isArray(rows) || !rows.length || !rows[0]?.value) return null;
    const obj = JSON.parse(rows[0].value);
    if (!obj || !Array.isArray(obj.places)) return null;
    return obj;
  } catch (_e) { return null; }
}
async function kvWrite(key: string, obj: { ts: number; places: any[] }): Promise<boolean> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/shared_kv?on_conflict=key`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }),
    });
    return res.ok;
  } catch (_e) { return false; }
}

// ---- warm a tile via the function (build + cache it), returns its cacheVersion ----
async function warmTile(lat: number, lng: number): Promise<any> {
  try {
    const res = await fetch(NEARBY_URL, {
      method: "POST",
      headers: { apikey: NKEY, Authorization: `Bearer ${NKEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lng }),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch (_e) { return null; }
}

// ---- gate one tile's places ----
type GateResult = {
  gated: any[];
  kept: number;
  resolved: number;
  dropped: { name: string; category: string; desc: string }[];
  throttled: boolean;
  genUsed: number;
};
async function gateTile(places: any[]): Promise<GateResult> {
  const gated: any[] = [];
  const dropped: { name: string; category: string; desc: string }[] = [];
  let resolved = 0, genUsed = 0, throttled = false;

  for (const p of places) {
    if (!p) continue;
    // Storied-by-source: keep without resolving.
    if (p.source !== "osm") { gated.push(p); continue; }
    if (!FACTS_CATS.has(p.category)) { gated.push(p); continue; }   // non-facts OSM: not gated
    if (!isFillerDesc(p.desc)) { gated.push(p); continue; }         // already has a real (human/own-tag) desc

    if (throttled) { gated.push(p); continue; }                     // tile already throttled: keep the rest unchecked

    const r = await resolveStory(p.name, p.lat, p.lng);
    if (r === "throttled") { throttled = true; gated.push(p); continue; } // KEEP, mark tile incomplete
    if (PACE_MS) await sleep(PACE_MS);

    if (r && r.desc) { p.desc = r.desc; gated.push(p); resolved++; continue; }

    // Clean miss on the free wiki pass. Optionally try the function's recall (Gemini/Wikidata).
    if (USE_GEN) {
      const g = await resolveViaFunction(p.name, p.lat, p.lng);
      if (PACE_MS) await sleep(PACE_MS);
      if (g && g.desc) { p.desc = g.desc; gated.push(p); resolved++; genUsed++; continue; }
    }
    // Confirmed story-less → drop.
    dropped.push({ name: String(p.name || ""), category: String(p.category || ""), desc: String(p.desc || "") });
  }
  return { gated, kept: gated.length, resolved, dropped, throttled, genUsed };
}

// ---- main ----
type TileRecord = {
  tile: string; metro: string; lat: number; lng: number;
  inCount: number; outCount: number; resolved: number; droppedCount: number;
  dropped: { name: string; category: string; desc: string }[];
  throttled: boolean; warmed: boolean; skipped?: string; committed?: boolean;
};

async function main() {
  if (!SUPABASE_URL || !SRK) { console.error("FATAL: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required."); Deno.exit(1); }
  if (!NKEY) { console.error("FATAL: NEARBY_PLACES_KEY (the function anon key) required to warm tiles."); Deno.exit(1); }

  // Sync the cache-key version to whatever the function currently serves — read it
  // from a live build so the tool can never write to the wrong version's key.
  const probe = await warmTile(40.0, -100.0);
  const VER = probe && typeof probe.cacheVersion === "string" ? probe.cacheVersion : "";
  if (!VER) { console.error("FATAL: could not read cacheVersion from the function (is it deployed / reachable?)."); Deno.exit(1); }
  console.log(`[gate-tiles] function cacheVersion=${VER}  commit=${COMMIT}  gen=${USE_GEN}  metros=${ALL_METROS ? "ALL" : "single"}`);

  // Determine the tile set.
  let tiles: TileRef[];
  let priorRecords: TileRecord[] = [];
  if (FROM_RECORDS || HELD_ONLY) {
    const file = HELD_ONLY ? HELD_FILE : RECORDS_FILE;
    try { priorRecords = JSON.parse(await Deno.readTextFile(file)); } catch (_e) {
      console.error(`FATAL: --${HELD_ONLY ? "held" : "from-records"} needs ${file} on disk.`); Deno.exit(1);
    }
    tiles = priorRecords.map((r) => ({ tile: r.tile, lat: r.lat, lng: r.lng, metro: r.metro }));
    console.log(`[gate-tiles] ${HELD_ONLY ? "--held" : "--from-records"}: ${tiles.length} tiles from ${file}`);
  } else {
    const metros = ALL_METROS
      ? METROS
      : [{ name: Deno.env.get("SEED_CITY_NAME")?.trim() || "Chicago", lat: Number(Deno.env.get("SEED_CITY_LAT") ?? 41.8781), lng: Number(Deno.env.get("SEED_CITY_LNG") ?? -87.6298) }];
    tiles = enumerateTiles(metros);
    console.log(`[gate-tiles] ${metros.length} metro(s) → ${tiles.length} unique tiles (metroKm=${METRO_KM}, tileDeg=${TILE_DEG})`);
  }

  const records: TileRecord[] = [];
  const held: TileRecord[] = [];
  let tRead = 0, tWarmed = 0, tSkipped = 0, tCommitted = 0, tThrottled = 0, totalDropped = 0, totalResolved = 0;

  // --from-records commits already-computed records with NO re-crawl (resume path).
  if (FROM_RECORDS && !HELD_ONLY) {
    for (const rec of priorRecords) {
      if (COMMIT && !rec.throttled && !rec.skipped && typeof rec.outCount === "number") {
        // Re-read the current row, re-apply the recorded drops by name, write back.
        const row = await kvRead(`places:${VER}:${rec.tile}`);
        if (!row) { rec.committed = false; records.push(rec); continue; }
        const dropNames = new Set(rec.dropped.map((d) => d.name));
        const gated = row.places.filter((p: any) => !(p && p.source === "osm" && FACTS_CATS.has(p.category) && isFillerDesc(p.desc) && dropNames.has(String(p.name || ""))));
        rec.committed = gated.length ? await kvWrite(`places:${VER}:${rec.tile}`, { ts: Date.now(), places: gated }) : false;
        if (rec.committed) tCommitted++;
      }
      records.push(rec);
    }
    await Deno.writeTextFile(RECORDS_FILE, JSON.stringify(records, null, 2));
    console.log(`[gate-tiles] --from-records done: committed=${tCommitted}`);
    return;
  }

  let idx = 0;
  for (const t of tiles) {
    idx++;
    let row = await kvRead(`places:${VER}:${t.tile}`);
    let warmed = false;
    if (!row || !row.places.length) {
      // Cold tile — warm it via the function (fast v33 build), then re-read the raw row.
      await warmTile(t.lat, t.lng);
      warmed = true; tWarmed++;
      row = await kvRead(`places:${VER}:${t.tile}`);
    } else { tRead++; }

    if (!row || !row.places.length) {
      const rec: TileRecord = { tile: t.tile, metro: t.metro, lat: t.lat, lng: t.lng, inCount: 0, outCount: 0, resolved: 0, droppedCount: 0, dropped: [], throttled: false, warmed, skipped: "no-row" };
      records.push(rec); tSkipped++;
      if (idx % 25 === 0) console.log(`[gate-tiles] ${idx}/${tiles.length} … (skip ${t.tile})`);
      continue;
    }

    const g = await gateTile(row.places);
    const rec: TileRecord = {
      tile: t.tile, metro: t.metro, lat: t.lat, lng: t.lng,
      inCount: row.places.length, outCount: g.gated.length, resolved: g.resolved,
      droppedCount: g.dropped.length, dropped: g.dropped, throttled: g.throttled, warmed,
    };
    totalDropped += g.dropped.length; totalResolved += g.resolved;

    if (g.throttled) { rec.skipped = "throttled"; held.push(rec); tThrottled++; }
    else if (COMMIT) {
      // Only commit a NON-empty gated set: an empty cache row can't be served (the
      // function rebuilds it ungated), so writing empty is pointless. Never drop the
      // whole tile to nothing.
      if (g.gated.length) { rec.committed = await kvWrite(`places:${VER}:${t.tile}`, { ts: Date.now(), places: g.gated }); if (rec.committed) tCommitted++; }
      else rec.skipped = "empty-after-gate";
    }
    records.push(rec);
    if (idx % 25 === 0 || idx === tiles.length) {
      console.log(`[gate-tiles] ${idx}/${tiles.length}  tile=${t.tile} in=${rec.inCount} out=${rec.outCount} resolved=${rec.resolved} dropped=${rec.droppedCount}${g.throttled ? " THROTTLED" : ""}${rec.committed ? " committed" : ""}`);
    }
  }

  await Deno.writeTextFile(RECORDS_FILE, JSON.stringify(records, null, 2));
  await Deno.writeTextFile(HELD_FILE, JSON.stringify(held, null, 2));

  const perMetro: Record<string, { tiles: number; dropped: number; resolved: number; throttled: number }> = {};
  for (const r of records) {
    const m = (perMetro[r.metro] ||= { tiles: 0, dropped: 0, resolved: 0, throttled: 0 });
    m.tiles++; m.dropped += r.droppedCount; m.resolved += r.resolved; if (r.throttled) m.throttled++;
  }
  const report = {
    cacheVersion: VER, commit: COMMIT, gen: USE_GEN,
    tiles: tiles.length, read: tRead, warmed: tWarmed, skipped: tSkipped,
    committed: tCommitted, throttledTiles: tThrottled,
    totalResolved, totalDropped, perMetro,
    note: COMMIT
      ? "Committed gated rows (ts=now). Re-run --held --commit when Wikipedia is healthy to finish throttled tiles."
      : "DRY RUN — nothing written. Eyeball the `dropped` lists in gate_tiles_records.json, then re-run with --commit.",
  };
  await Deno.writeTextFile(REPORT_FILE, JSON.stringify(report, null, 2));

  console.log("\n=== gate-tiles summary ===");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nrecords → ${RECORDS_FILE}   held → ${HELD_FILE}   report → ${REPORT_FILE}`);
  if (!COMMIT) console.log("DRY RUN: eyeball the dropped lists, then re-run with --commit.");
  if (tThrottled) console.log(`${tThrottled} tile(s) THROTTLED and left uncommitted — re-run: deno run … gate-tiles.ts --held --commit (when Wikipedia is healthy).`);
}

if (import.meta.main) main();
