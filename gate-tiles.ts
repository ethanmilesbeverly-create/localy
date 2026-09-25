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
// THROTTLE ROOT-CAUSE FIX (2026-09-11): the resolve was landing in Wikimedia's
// "unidentified" API bucket (~10 req/min) rolled out globally in 2026, so a few
// pins' worth of search+hydrate calls tripped a 429 from EVERY network — an IP-
// INDEPENDENT throttle we long misread as an egress-IP cooldown (two 4-hour waits,
// an overnight, a fresh Codespace, and a residential run ALL throttled identically).
// Two request-shape mistakes put us in that bucket: (1) the Wikipedia URLs carried
// `&origin=*`, a BROWSER/CORS parameter that has no business on a server-side call
// and pushes the request out of the compliant-bot lane; (2) the User-Agent's
// "contact via app" didn't meet the compliant-UA bar (Wikimedia wants a real contact
// URL/email), so the request read as unidentified. FIX: `origin=*` removed from both
// wiki URLs (a server call needs no CORS; the JSON is identical), and the default UA
// now carries a real contact URL — moving the tool into the 200 req/min compliant-UA
// bucket. NOTE: the SAME `origin=*` + no-UA pattern is ALSO in `nearby-places`' four
// Wikipedia calls — a SEPARATE fix (the likely REAL cause of the v34/v35 "throttle"
// above, and of thin/empty LIVE descriptions today).
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
// GRAVE-IDENTITY RUNG (#356): a grave-class OSM `historic=tomb` plot pin (type
// 'grave', or a "Grave of X" name) whose person does NOT coordinate-resolve — the
// person's biography article sits at their life, not their plot (Jesse Owens, Ernie
// Banks, Mies van der Rohe) — is rescued by an IDENTITY resolve: the person's intro
// by NAME, baked onto the plot, accepted WITHOUT the coordinate gate. This is the
// same #163 sitelink-identity basis graves-resolve already uses. It is a DELIBERATE,
// bounded relaxation of the coordinate gate for graves ONLY, guarded three ways so a
// namesake can't wrong-attach: (1) a real FULL name (≥2 distinctive person tokens
// after stripping "Grave of" and collective words like Family/Society/Mausoleum, so
// "Staples Family" never resolves), (2) the article title covers the name
// (graveNameScore ≥ GRAVE_NAME_MIN AND ≥2 tokens matched), (3) the intro READS LIKE
// A PERSON (a life-date / born-died signal). A weak match on any leaves the pin
// dropped — blank-beats-wrong still holds; only a confident full-name person hit
// relaxes the gate. NOTE (residual): the single most-famous person per cemetery is
// ALSO a graves-resolve centroid seed, so that ONE person may show twice (centroid
// seed + real plot) until the centroid seed is retired or the client dedups — a
// small follow-up; everyone else is pure gain.
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
//   # --rewarm: DELETE each target tile's cached row first, so the function rebuilds it UNGATED on the warm — brings back notable graves a PRIOR gate run dropped, to be re-gated by the #356 grave rung. A rebuild MUTATES (the tile over-shows until the gated write lands). Recommended flow: `--rewarm` (dry — rebuilds + proposes) → eyeball gate_tiles_records.json → `--from-records --commit`; or `--rewarm --commit` to rebuild+gate+commit in one pass.
//   # --resume: checkpoint every tile; on restart SKIP finished tiles (survives a throttle bail / a kill / a Codespace suspend). Add it to any run you might have to restart.
//   # --gen adds the function's Gemini/Wikidata recall for pins the free wiki pass missed (costs Gemini).
//
// --prime-graves (#363) — PRIME THE GRAVE BANK, THEN REWARM BAKES THE PINS.
//   Some dense-cemetery notables (the Oak Woods cluster — Jesse Owens, Enrico Fermi,
//   Big Jim Colosimo, John H. Johnson, Big Bill Thompson, Arthur Brazier, William
//   Rainey Harper) resolve cleanly PACED but FLAKE inside the metro warmer: the tile
//   pass re-resolves the same grave across overlapping tiles and competes with the
//   whole metro against Wikipedia's identity-keyed rate limit, so they throttle → HELD
//   → never banked. --prime-graves resolves a SHORT, supplied list ONCE, slowly, out of
//   band — each name through the SAME resolveGraveIdentity the tile pass uses (bank-read-
//   first, the three #356 guards, multi-query recall), writing every confident hit to the
//   monotonic gravebank. A later `--rewarm --commit` then reads the bank DETERMINISTICALLY
//   and bakes each bio onto the pin's REAL OSM plot coordinate — no per-tile fight, no
//   stacking (the plot coord comes from OSM, never the cemetery centroid). It touches ONLY
//   gravebank:<VER>:* — never a tile, never a delete — and it is MONOTONIC, so a re-run only
//   ADDS and already-banked names skip instantly. It needs SUPABASE_URL + SUPABASE_SERVICE_
//   ROLE_KEY (the bank is service-role) and Wikipedia; it does NOT need the function reachable
//   or NEARBY_PLACES_KEY. Names come from --names="A|B|C", the GRAVE_PRIME_NAMES env, a
//   graves-prime.txt file (one per line, # comments), or the built-in Oak Woods default.
//   A name must equal the OSM pin's label (after coreName+fold) for the tile pass to hit the
//   bank, AND token-match its article for the guards to accept — usually the same string; a
//   nickname pin may MISS (re-prime it with the article-matching label). GATE_PRIME_PACE_MS
//   (default 4000) paces between names; GATE_PRIME_RETRY (default 5) retries a throttled name
//   with a long, growing breather.
//   deno run --allow-net --allow-env --allow-read --allow-write gate-tiles.ts --prime-graves            # DRY: resolve + report, writes NOTHING to the bank
//   deno run --allow-net --allow-env --allow-read --allow-write gate-tiles.ts --prime-graves --commit   # write every confident hit into gravebank:<VER>:*
//   # then bake onto the real plots (deterministic, no rate-limit fight):
//   SEED_CITY_NAME=Chicago SEED_CITY_LAT=41.8781 SEED_CITY_LNG=-87.6298 GATE_METRO_KM=15 \
//     deno run --allow-net --allow-env --allow-read --allow-write gate-tiles.ts --rewarm --commit
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
// a Gemini key. GATE_UA overrides the default compliant User-Agent — keep a REAL
// contact URL/email in it, or Wikimedia drops you back to the ~10 req/min unidentified
// bucket and the throttle returns. NOT a deploy target; changes no
// `index.html`/function/APP_VERSION.
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
const PACE_MS = Number(Deno.env.get("GATE_PACE_MS") ?? 500);     // gap between resolves — throttle politeness (raised from 250 to be gentler on the IP by default)
// #355 v3 — breather before a single retry of a creator-art recall that came back a
// (possibly masked-throttle) miss under a sweep burst. Long enough to clear a momentary
// upstream rate-limit; see the retry in gateTile. Set 0 to disable retries entirely.
const RETRY_MS = Number(Deno.env.get("GATE_RETRY_MS") ?? 1500);
const WIKI_TIMEOUT_MS = Number(Deno.env.get("GATE_WIKI_TIMEOUT_MS") ?? 12000);
const NAME_MIN = Number(Deno.env.get("GATE_NAME_MIN") ?? 0.5);    // title must cover ≥ half the name's distinctive tokens (#54 floor)
// #356 — the grave-identity rung's name floor. HIGHER than NAME_MIN because this
// rung accepts an article WITHOUT the coordinate gate (identity, #163), so the
// name match is the ONLY anti-wrong-attach guard left (plus the person-signal +
// the ≥2-distinctive-token requirement). Keep it tight.
const GRAVE_NAME_MIN = Number(Deno.env.get("GATE_GRAVE_NAME_MIN") ?? 0.6);
// Compliant Wikimedia User-Agent (2026 rate-limit fix): a real contact URL earns the
// 200 req/min identified-bot bucket instead of the ~10 req/min unidentified one.
// Swap the URL for the app domain or a contact email if preferred — just keep a REAL
// contact in it. Override with GATE_UA.
const UA = Deno.env.get("GATE_UA") ?? "NahgooGateTiles/1.0 (+https://github.com/ethanmilesbeverly-create/localy; offline story-gate sweep)";

const COMMIT = Deno.args.includes("--commit");
const ALL_METROS = Deno.args.includes("--all") || Deno.env.get("GATE_ALL") === "1";
const HELD_ONLY = Deno.args.includes("--held");
const FROM_RECORDS = Deno.args.includes("--from-records");
const USE_GEN = Deno.args.includes("--gen") || Deno.env.get("GATE_GEN") === "1";
// --resume: checkpoint every completed tile to PROGRESS_FILE and, on restart, SKIP the
// tiles already done — so a run killed or throttled partway picks up where it left off
// instead of re-crawling from zero. THROTTLE_BAIL: if this many tiles throttle in a row,
// the IP is clearly rate-limited, so STOP fast (saving progress) rather than grinding
// every remaining tile through backoff. Between them, throttle stops being a long stall:
// a run makes steady forward progress across short attempts and you finish in pieces.
const RESUME = Deno.args.includes("--resume");
// #356 --rewarm: force a fresh UNGATED rebuild of each target tile before gating,
// so notable graves a PRIOR gate run already DROPPED (removed from the committed
// row, not sitting as filler) come back to be re-gated by the grave-identity rung.
// It DELETEs the tile's cache row → the function rebuilds it ungated on the warm →
// this tool re-reads + gates. A rebuild is a mutation (the tile serves ungated /
// over-shows until the gated write lands — the SAFE direction, never a false hide).
const REWARM = Deno.args.includes("--rewarm");
// #363 --prime-graves: resolve a SHORT supplied list of grave-class person names ONCE,
// paced, out of band, and write each confident hit into the monotonic gravebank — so a
// later --rewarm bakes them onto their real OSM plots deterministically (no per-tile
// rate-limit fight). Touches ONLY gravebank:*, never a tile. See the header RUN note.
const PRIME_GRAVES = Deno.args.includes("--prime-graves");
const PRIME_PACE_MS = Number(Deno.env.get("GATE_PRIME_PACE_MS") ?? 4000);   // gap between names — paced to stay under the identity-keyed rate limit
const PRIME_MAX_THROTTLE_RETRY = Number(Deno.env.get("GATE_PRIME_RETRY") ?? 5); // retry a throttled name this many times (0 = give up on first throttle)
const PRIME_THROTTLE_WAITS = [15000, 30000, 45000, 60000, 90000]; // growing breather per throttle retry (last value repeats)
const PRIME_FILE = "graves-prime.txt";          // optional input: one name per line, # comments
const PRIME_FILE_OUT = "gate_tiles_prime.json";  // the prime run's report
// DRY prime = resolve + report but do NOT write the bank; --commit persists it. The bank
// write (writeGraveBank) honours this so a dry run is truly read-only against gravebank:*.
const BANK_DRY = PRIME_GRAVES && !COMMIT;
// The #363 default prime list — the dense Oak Woods (Chicago) notables the metro warmer
// can't hold. Override with --names="A|B|C" / GRAVE_PRIME_NAMES / graves-prime.txt.
// The #363 default prime list — the dense Oak Woods (Chicago) notables the metro warmer
// can't hold. These are the EXACT OSM tomb-pin labels (from the tile's dropped list), so
// each banked key matches what the tile pass looks up (graveBankKey = coreName+fold, which
// strips the quotes/affixes). Override with --names="A|B|C" / GRAVE_PRIME_NAMES / graves-
// prime.txt. DRY-first and eyeball the titles: a nickname like "Big Bill" can resolve to a
// NAMESAKE, so each was verified to land on the right person's article.
const OAK_WOODS_PRIME = [
  "Jesse Owens",
  "Enrico Fermi",
  'James "Big Jim" Colosimo',
  "John Harold Johnson",
  'William Hale "Big Bill" Thompson',
  "Arthur M. Brazier",
  "William Rainey Harper",
];
const THROTTLE_BAIL = Number(Deno.env.get("GATE_THROTTLE_BAIL") ?? 3);
const THROTTLE_COOLDOWN_MS = Number(Deno.env.get("GATE_THROTTLE_COOLDOWN_MS") ?? 8000); // breather after a throttled tile before the next

const RECORDS_FILE = "gate_tiles_records.json";
const REPORT_FILE = "gate_tiles_report.json";
const HELD_FILE = "gate_tiles_held.json";
const PROGRESS_FILE = "gate_tiles_progress.json"; // per-tile checkpoint for --resume (tile → record)

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

// ---- name/title scoring (#54 shape, #345-broadened) ----
// #345: documented pins were falling through the gate as "filler" because the NAME
// match was too brittle — accents ("Girėnas" ≠ "Girenas") and generic words
// ("Memorial", "Monument") dragged the token score below the 0.5 bar. Broadening the
// NAME match is safe because the COORDINATE gate (#316, gateOk) stays strict: a
// looser name match can raise recall but can NEVER attach a far-away namesake, which
// the coordinate check rejects regardless. So: fold accents, treat generic type words
// as non-distinctive, and strip "Grave of"/"Site of"/… prefixes for the search query.
function fold(s: string): string {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); // strip diacritics
}
// Generic descriptor words that shouldn't decide a name match (a "Memorial" matching
// a "Memorial" tells us nothing; the distinctive tokens do). Also classic stop words.
const GENERIC = new Set([
  "the", "and", "for", "los", "las", "san", "old", "new", "of", "to", "at", "on",
  "memorial", "monument", "statue", "bust", "sculpture", "artwork", "mural", "plaque",
  "marker", "fountain", "park", "garden", "gardens", "square", "plaza", "site", "grave",
  "tomb", "cemetery", "house", "building", "hall", "trail", "path", "greenway", "field",
]);
function tokens(s: string): string[] {
  return fold(s).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t && t.length > 2);
}
// Distinctive tokens = folded tokens minus generic descriptors (what actually names the place).
function distinctive(s: string): string[] {
  return tokens(s).filter((t) => !GENERIC.has(t));
}
// nameScore: fraction of the NAME's distinctive tokens present in the TITLE. If the
// name is ALL generic (e.g. bare "Memorial"), there's nothing distinctive to match on
// → 0 (gateOk then requires coordinate identity instead).
function nameScore(name: string, title: string): number {
  const nT = distinctive(name);
  if (!nT.length) return 0;
  const tT = new Set(tokens(title)); // title keeps generics so "Lincoln Park" still contains "park"
  let hit = 0;
  for (const t of nT) if (tT.has(t)) hit++;
  return hit / nT.length;
}
// Strip leading relational prefixes and a trailing generic type, so a search on a pin
// named "Grave of Emma Goldman" / "Darius and Girėnas Memorial" queries the real
// subject ("Emma Goldman" / "Darius and Girėnas"), the #345 rescue for the ~documented-
// but-unmatched pins (Jimi Hendrix Memorial, graves, memorials, birthplaces).
function coreName(name: string): string {
  let n = String(name || "").trim();
  n = n.replace(/^(grave|site|home|birthplace|statue|bust|memorial|monument|tomb|resting place|burial)\s+(of|to|for)\s+/i, "");
  n = n.replace(/\s+(memorial|monument|statue|bust|sculpture|plaque|marker|fountain|gravesite|grave)$/i, "");
  return n.trim() || String(name || "").trim(); // never return empty
}

// ---- throttle-aware Wikipedia fetch (the v35 discriminator, ported offline) ----
// Retries a 429/5xx/network/timeout with backoff; only when retries are EXHAUSTED
// does it report throttled=true (the caller then KEEPS the pin, never drops it).
async function wikiFetchTA(url: string): Promise<{ throttled: boolean; json: any }> {
  // Short ladder: a throttled probe gives up in ~4 s (was ~30 s). Under a SUSTAINED
  // IP throttle we don't want to wait long per call — the run's THROTTLE_BAIL stops
  // the whole run fast instead, and --resume continues it later. A transient blip is
  // still absorbed (a Retry-After is still honoured up to 20 s).
  const backoffs = [0, 1000, 3000];
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
// #345: searches the STRIPPED core name first ("Grave of X" → "X"), and if that finds
// nothing gate-passing, falls back to the raw name — ≤2 searches, so recall improves
// without a call explosion. gateOk still coordinate-gates every candidate (#316).
async function searchGate(query: string, name: string, lat: number, lng: number): Promise<{ desc: string; title: string } | null | "throttled"> {
  const sUrl = "https://en.wikipedia.org/w/api.php?action=query&format=json" +
    "&generator=search&gsrsearch=" + encodeURIComponent(query) + "&gsrlimit=5&gsrnamespace=0" +
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
    const hUrl = "https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1" +
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
async function resolveStory(name: string, lat: number, lng: number): Promise<{ desc: string; title: string } | null | "throttled"> {
  if (!name || typeof lat !== "number" || typeof lng !== "number") return null;
  const core = coreName(name);
  const first = await searchGate(core, name, lat, lng);
  if (first === "throttled" || first) return first;           // throttled, or a hit
  // Fallback: if the stripped-core search found nothing and it differs from the raw
  // name, try the raw name once (e.g. the generic word WAS part of the article title).
  if (fold(core) !== fold(name)) return await searchGate(name, name, lat, lng);
  return null;
}

// ---- #356: the grave-identity rung (identity, NOT coordinate-gated) ---------
// See the GRAVE-IDENTITY RUNG note in the file header for the why + the three
// guards. Collective/structure words that, on TOP of the shared GENERIC set,
// must not count as a person token — so a family plot or a society mausoleum
// can never clear the ≥2-full-name-tokens bar.
const GRAVE_STOP = new Set([
  "family", "families", "society", "association", "assoc", "mutual", "aid", "club",
  "lodge", "order", "mausoleum", "chapel", "vault", "crypt", "plot", "section",
  "monument", "memorial", "cemetery", "graveyard", "columbarium",
]);
// A grave-class pin: the v33 two-axis KIND (historic=tomb → type 'grave'), or a
// "Grave of X" / "Tomb of X" name for older tiles / seed-style names.
function isGraveClass(p: any): boolean {
  if (p && p.type === "grave") return true;
  const n = String(p?.name || "");
  if (/^grave\s+of\b/i.test(n) || /^tomb\s+of\b/i.test(n)) return true;
  // #363 — some cemeteries tag notable burials as historic=memorial with a GRAVE
  // subtype (not historic=tomb), so the function files them under history with the
  // "(grave)" filler but WITHOUT type='grave' AND with a plain person name (no
  // "Grave of" prefix) — the whole Oak Woods cluster (Jesse Owens, Enrico Fermi, …)
  // lands here and, before this, never reached the identity rung. Treat the grave-
  // subtype filler as grave-class too. This only widens WHICH pins the rung TRIES;
  // the rung's own guards (≥2 person tokens, title-covers-name, life-date signal)
  // still reject a non-person, so blank-beats-wrong holds and a namesake can't attach
  // on a weak match.
  const d = String(p?.desc || "").trim();
  if (/^A local memorial \((?:grave|gravestone)\)\.$/i.test(d)) return true;
  return false;
}
// Person tokens = distinctive tokens (coreName strips the "Grave of" affix) minus
// the collective/structure words. ≥2 of these is the "real full name" bar.
function personTokens(name: string): string[] {
  return distinctive(coreName(name)).filter((t) => !GRAVE_STOP.has(t));
}
// Fraction of the person's tokens present in the title, and how many matched.
function graveNameMatch(name: string, title: string): { score: number; matched: number } {
  const pT = personTokens(name);
  if (!pT.length) return { score: 0, matched: 0 };
  const tT = new Set(tokens(title));
  let hit = 0;
  for (const t of pT) if (tT.has(t)) hit++;
  return { score: hit / pT.length, matched: hit };
}
// #356 — a title is "covered by" the name when EVERY distinctive title token (minus
// collective words) appears in the pin name. A fully-contained title with ≥2
// distinctive tokens is a strong identity even when the pin name carries EXTRA
// tokens the article omits — the nickname-packed case: "Amos Blakemore (Junior
// Wells)" → the "Junior Wells" article (the pin's birth name drags the token score
// below GRAVE_NAME_MIN, but the title itself is unambiguously the person).
function titleCoveredByName(name: string, title: string): boolean {
  const tT = distinctive(title).filter((t) => !GRAVE_STOP.has(t));
  if (tT.length < 2) return false;
  const nSet = new Set(tokens(name));
  return tT.every((t) => nSet.has(t));
}
// #356 wrong-attach guard: wider recall pulls in things NAMED AFTER the person — a
// power station, a log house, a school, an award. A person's own article title never
// carries a facility/structure word the person's name doesn't ("Enrico Fermi", not
// "Enrico Fermi Nuclear Generating Station"). So reject a candidate whose title has a
// STRUCTURE token that is NOT part of the pin name — still allowing a genuine surname
// like "Son House" (the token is in the name) while killing "… Log House".
const STRUCTURE_TOK = new Set([
  "station", "generating", "plant", "nuclear", "powerplant", "reactor", "house",
  "building", "hall", "school", "college", "university", "academy", "institute",
  "hospital", "clinic", "bridge", "center", "centre", "library", "airport",
  "company", "corporation", "foundation", "award", "prize", "trophy", "medal",
  "stadium", "arena", "theatre", "theater", "museum", "church", "cathedral",
  "temple", "synagogue", "tower", "dam", "reservoir", "highway", "road", "street",
  "avenue", "boulevard", "expressway", "laboratory", "observatory", "terminal",
  "factory", "mill", "works", "district", "campus", "auditorium", "fieldhouse",
]);
function titleIsStructureNotPerson(name: string, title: string): boolean {
  const nSet = new Set(tokens(name));
  return tokens(title).some((t) => STRUCTURE_TOK.has(t) && !nSet.has(t));
}
// #356 — the MONOTONIC GRAVE BANK (the #357 lesson, applied to the identity rung).
// Wikipedia's `generator=search` is NONDETERMINISTIC under load: a call for "Jesse
// Owens" returns the person one run and only "The Jesse Owens Story" the next, so a
// single gate pass rescues a random subset and committing it would bake only that
// lucky roll. So the FIRST time a grave resolves we BANK the verified line here,
// keyed by the person name, and every later run reads the bank FIRST and returns it
// DETERMINISTICALLY. A miss never overwrites a hit → the bank is MONOTONIC: re-runs
// only ADD graves, so a few `--rewarm --resume` passes converge to full coverage and
// the committed set is COMPLETE, not one roll. Own `gravebank:` prefix, OUTSIDE the
// #126 `places:%` tilecache sweep (permanent, like the #357 `resolve:` bank), and
// INDEPENDENT of it — a tile-cache rebuild never re-rolls banked graves. Service-role
// read+write (same path as the tile cache): no migration, no RLS, nothing in the
// dashboard.
const GRAVEBANK_VERSION = "g1";
function graveBankKey(name: string): string {
  const k = fold(coreName(name)).replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "_");
  return "gravebank:" + GRAVEBANK_VERSION + ":" + k;
}
async function readGraveBank(name: string): Promise<{ desc: string; title: string } | null> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/shared_kv?key=eq.${encodeURIComponent(graveBankKey(name))}&select=value`;
    const res = await fetch(url, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, Accept: "application/json" } });
    if (!res.ok) return null;
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows) || !rows.length) return null;
    const v = JSON.parse(rows[0].value);
    return (v && v.desc) ? { desc: String(v.desc), title: String(v.title || "") } : null;
  } catch (_e) { return null; }
}
let _gbWarn = 0;
async function writeGraveBank(name: string, hit: { desc: string; title: string }): Promise<void> {
  // #363 dry prime: resolve + report, but never touch the bank (add --commit to persist).
  if (BANK_DRY) { console.log(`    [prime] DRY — would bank ${graveBankKey(name)} → "${hit.title}"`); return; }
  try {
    const url = `${SUPABASE_URL}/rest/v1/shared_kv?on_conflict=key`;
    const res = await fetch(url, {
      method: "POST",
      headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: graveBankKey(name), value: JSON.stringify({ title: hit.title, desc: hit.desc, ts: Date.now() }), updated_at: new Date().toISOString() }),
    });
    if (!res.ok && _gbWarn++ < 5) console.error(`[gate-tiles] gravebank WRITE failed HTTP ${res.status} (needs service role) — resolves won't persist across runs.`);
  } catch (_e) { /* best-effort — a failed bank write just means a re-resolve next run */ }
}
// Search variants for a noisy grave name: the core name, the parenthetical alias
// ("Amos Blakemore (Junior Wells)" → "Junior Wells"), and the de-noised form
// (parens/quotes stripped), deduped. Widens recall so the person's article surfaces
// even when the raw OSM label is packed with birth-name + nickname.
function graveSearchQueries(name: string): string[] {
  const out = new Set<string>();
  const core = coreName(name).trim();
  if (core) out.add(core);
  const paren = core.match(/\(([^)]+)\)/);
  if (paren && paren[1].trim()) out.add(paren[1].trim());
  const noNoise = core.replace(/\([^)]*\)/g, " ").replace(/["'“”]/g, " ").replace(/\s+/g, " ").trim();
  if (noNoise) out.add(noNoise);
  return [...out].filter(Boolean).slice(0, 3);
}
// A biography signal in the intro: a life-date parenthetical / bare range, or a
// born/died-with-year. Conservative on purpose — a MISSING signal drops the pin
// (safe); a FALSE signal would attach a wrong bio (bad), so require a clear one.
function looksLikePerson(extract: string): boolean {
  const e = String(extract || "").slice(0, 300);
  if (/\((?:[^)]*\s)?(?:born\s+)?(?:c\.\s*)?\d{3,4}\b/.test(e)) return true; // "(1901–1980" / "(born 1901" / "(c. 1901"
  if (/\b\d{4}\s*[–\-—]\s*(?:\d{4}|\d{2})\b/.test(e)) return true;           // "1901–1980" bare range
  if (/\b(born|died)\b[^.]{0,40}\b\d{3,4}\b/i.test(e)) return true;          // "born … 1901" / "died … 1980"
  return false;
}
// Run ONE search query → return a confident person hit, null (clean miss for this
// query), or "throttled". Shared by every variant in resolveGraveIdentity.
async function graveSearchOnce(name: string, query: string): Promise<{ desc: string; title: string } | null | "throttled"> {
  const sUrl = "https://en.wikipedia.org/w/api.php?action=query&format=json" +
    "&generator=search&gsrsearch=" + encodeURIComponent(query) + "&gsrlimit=15&gsrnamespace=0" +
    "&prop=extracts&exintro=1&explaintext=1&exlimit=20";
  const s = await wikiFetchTA(sUrl);
  if (s.throttled) return "throttled";
  const pages: any[] = s.json ? Object.values(((s.json.query || {}).pages) || {}) : [];
  const scored = pages
    .filter((p) => p && p.title && !/\(disambiguation\)/i.test(String(p.title)))
    .map((p) => {
      const m = graveNameMatch(name, String(p.title));
      const covered = titleCoveredByName(name, String(p.title));
      // Rank a fully-covered title as a strong match even when extra name tokens
      // drag its token score down (the nickname-packed case), so it isn't buried.
      return { p, m, covered, rank: covered ? Math.max(m.score, 0.9) : m.score };
    })
    .filter((x) => ((x.m.score >= GRAVE_NAME_MIN && x.m.matched >= 2) || x.covered) && !titleIsStructureNotPerson(name, String(x.p.title)))   // guard (2) + reject facilities named after the person
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 4);
  for (const { p } of scored) {
    // Hydrate by exact title for a full, reliable intro (the combined search truncates).
    const hUrl = "https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1" +
      "&titles=" + encodeURIComponent(String(p.title)) + "&prop=extracts&exintro=1&explaintext=1";
    const h = await wikiFetchTA(hUrl);
    if (h.throttled) return "throttled";
    const pg: any = h.json ? Object.values(((h.json.query || {}).pages) || {})[0] : null;
    const cand: any = (pg && pg.missing === undefined && pg.title) ? pg : p;
    const desc = String(cand.extract || "").trim();
    if (!desc || /\bmay refer to\b/i.test(desc)) continue;           // empty / disambiguation body
    if (titleIsStructureNotPerson(name, String(cand.title || ""))) continue;   // redirect may land on a facility title
    if (graveNameMatch(name, String(cand.title || "")).matched < 2 && !titleCoveredByName(name, String(cand.title || ""))) continue;
    if (!looksLikePerson(desc)) continue;                            // guard (3): must read like a person
    return { desc, title: String(cand.title || "") };
  }
  return null;
}
// #381 — the STRUCTURE-ONLY-NAME guard, ported verbatim in intent from #375's
// nearby-places serve-path fix so the OFFLINE twin stops BANKING a structure name
// that can only wrong-attach (a future --prime-graves/--rewarm could otherwise
// re-bank "Court No. 5" → "Supreme Court" into gravebank:/resolve:). #375 fixed the
// live serve path; this is the source-side sibling (the #167/#226 offline-tooling-
// drift hazard — one fact, two places).
//   GRAVE_STRUCTURE_TOKENS: honorific/burial + structure/memorial-kind + enumeration
//     + stop/collective words — a name built ONLY of these has no identity to resolve.
//   GRAVE_ENUMERATION_WORDS: the subset marking a numbered SUB-UNIT of a larger place
//     ("Court No. 5", "Section 60", "Niche 12") — a layout label, not a landmark.
//   _isStructureOnlyName: true when a name is nothing but structure/enum/stop words
//     AND carries an enumeration signal (a number/ordinal/roman OR an enumeration
//     word). "Court No. 5"/"Section 60" → true; a name with ANY distinctive token
//     ("Grave of Grace Hopper", "Millennium Park") → false. Requiring the enum signal
//     keeps a legitimately all-generic place name ("Memorial Park", "The Monument")
//     OUT of the net — only a numbered sub-unit that can only wrong-attach is refused.
const GRAVE_STRUCTURE_TOKENS = new Set<string>([
  // honorific / burial words
  "grave", "graves", "tomb", "tombs", "gravesite", "gravestone", "headstone",
  "burial", "cemetery", "graveyard", "ground", "grounds",
  // structure / memorial kinds
  "memorial", "memorials", "monument", "mausoleum", "columbarium", "crypt",
  "vault", "niche", "niches", "ossuary", "catacomb", "catacombs", "shrine",
  // enumeration / layout words
  "court", "courts", "section", "sections", "plot", "plots", "lot", "lots",
  "block", "blocks", "row", "rows", "area", "areas", "bay", "wall", "walls",
  "garden", "gardens", "field", "fields", "circle", "terrace", "no", "number",
  "num", "unit", "units", "site", "sites",
  // stop words / collective words
  "of", "the", "and", "for", "to", "at", "in", "a", "an",
  "unknown", "unknowns", "soldier", "soldiers", "dead", "fallen", "family",
  "society", "association", "veterans", "war", "national",
]);
const GRAVE_ENUMERATION_WORDS = new Set<string>([
  "court", "courts", "section", "sections", "plot", "plots", "lot", "lots",
  "block", "blocks", "row", "rows", "bay", "unit", "units", "niche", "niches",
  "wall", "walls", "area", "areas", "circle", "terrace", "no", "number", "num", "site", "sites",
]);
function _isStructureOnlyName(name: string): boolean {
  const raw = String(name || "").trim();
  if (!raw) return false;
  const toks = raw.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  let hasEnum = false, hasDistinctive = false;
  for (const t of toks) {
    if (/^\d+$/.test(t) || /^\d+(?:st|nd|rd|th)$/.test(t) || /^[ivxlcdm]+$/.test(t)) { hasEnum = true; continue; } // number / ordinal / roman
    if (GRAVE_STRUCTURE_TOKENS.has(t)) { if (GRAVE_ENUMERATION_WORDS.has(t)) hasEnum = true; continue; }           // structure/stop word (some also enumerate)
    if (t.length > 1) hasDistinctive = true;                                                                       // a real distinctive token
  }
  return hasEnum && !hasDistinctive;
}
// Resolve a grave's person by IDENTITY — bank-first (deterministic reuse), then
// multiple search variants, NO coordinate gate. On a hit, BANK it (monotonic) so
// every later run reuses it. {desc,title} on a hit, null on a clean miss across all
// variants, "throttled" if any variant exhausts (the caller KEEPS the pin, never
// drops it).
async function resolveGraveIdentity(name: string, bankOnly = false): Promise<{ desc: string; title: string } | null | "throttled"> {
  if (_isStructureOnlyName(name)) return null;                // #381 guard (0): a numbered structure ("Court No. 5") can only wrong-attach — refuse before the bank read/search/bank-write (the #375 nearby-places guard, ported offline)
  if (personTokens(name).length < 2) return null;             // guard (1): not a full name → don't relax the gate
  const banked = await readGraveBank(name);
  if (banked) return banked;                                  // #357-style deterministic reuse
  // #363 bankOnly: for the memorial-grave class (plain person name, no "Grave of"
  // affix, no type='grave'), resolve ONLY from the pre-verified bank — NEVER a live
  // guarded search. A live search on a bare surname-shared name can attach a NAMESAKE
  // (Paul Cornell → the writer, not the Oak Woods developer); the bank holds only
  // operator-eyeballed --prime-graves hits, so a bank miss DROPS blank instead of
  // guessing. The classic tomb / "Grave of X" rung keeps its full live behaviour.
  if (bankOnly) return null;
  let sawThrottle = false;
  for (const q of graveSearchQueries(name)) {
    const r = await graveSearchOnce(name, q);
    if (r === "throttled") { sawThrottle = true; continue; }  // try the next variant; hold only if ALL throttle/miss
    if (r) { await writeGraveBank(name, r); return r; }
  }
  return sawThrottle ? "throttled" : null;                    // throttled → HOLD (keep pin); clean miss → drop
}
// #363 — the memorial-grave shape: historic=memorial tagged as a GRAVE subtype, filed
// under history with the "(grave)" filler but WITHOUT type='grave' and with a plain
// person name (no "Grave of" affix). This is the class isGraveClass newly admits; the
// tile pass resolves it BANK-ONLY (see resolveGraveIdentity's bankOnly) so an un-primed
// one drops blank rather than risk a live namesake attach. The classic tomb / "Grave of"
// pins return false here and keep their full #356 live rung.
function isMemorialGraveShape(p: any): boolean {
  if (!p || p.type === "grave") return false;
  if (/^(?:grave|tomb)\s+of\b/i.test(String(p?.name || ""))) return false;
  return /^A local memorial \((?:grave|gravestone)\)\.$/i.test(String(p?.desc || "").trim());
}

// #355 — pull the CREATOR out of an art pin's `A <type> by <X>.` osmDesc filler so the
// function's creator-qualified recall rung can search "<title> by <artist>". Guarded to
// category 'art' AND the artist template, so a non-art filler ("A local green space to
// wander.") or any human/baked desc yields "" — a wrong extraction can't happen, and even
// if one did the coordinate gate downstream would reject it (blank beats wrong, #101/#178).
const ART_BY_RE = /^A .+? by (.+)\.$/i;
function artistFromPin(p: any): string {
  if (!p || p.category !== "art") return "";
  const m = ART_BY_RE.exec(String(p.desc ?? "").trim());
  return m ? m[1].trim().slice(0, 120) : "";
}

// ---- optional --gen rescue: the function's resolveWiki (Gemini/Wikidata recall) ----
// #355 — `artist` (optional) is forwarded as the creator signal for art pins; the
// function's creator-qualified + alias-recall rungs use it to resolve title-only names.
// #355 v3 — TRI-STATE, mirroring resolveStory: "error" for a transient failure (non-200 /
// malformed / network throw), {desc} for a hit, null for a CLEAN miss (200 + no place).
// The distinction is load-bearing: under a sweep burst the function's OWN upstream
// Wikipedia calls can 429 and it then returns 200+null — indistinguishable, downstream,
// from a real "no article" unless we separate transport failures out here. Treating that
// as a clean miss is what baked confirmed-resolvable art (Goethe, The Alarm) as
// false-hides; the caller now HOLDS on "error" instead of dropping. (#344 "429 ≠ absence",
// extended from the direct-wiki pass to the recall pass.)
async function resolveViaFunction(name: string, lat: number, lng: number, artist?: string): Promise<{ desc: string } | "error" | null> {
  try {
    const payload: Record<string, unknown> = { action: "resolveWiki", name, lat, lng };
    if (artist) payload.artist = artist;                  // #355 — omit when empty so non-art pins are byte-identical to before
    const res = await fetch(NEARBY_URL, {
      method: "POST",
      headers: { apikey: NKEY, Authorization: `Bearer ${NKEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return "error";                          // transient (429/5xx) — NOT a clean miss
    const j = await res.json().catch(() => null);
    if (j === null) return "error";                       // malformed body — treat as transient, not absence
    const d = j && j.place && j.place.desc ? String(j.place.desc).trim() : "";
    return d ? { desc: d } : null;                        // hit, or a genuine 200+no-place miss
  } catch (_e) { return "error"; }                        // network/throw — transient, never a drop
}

// ---- shared_kv REST ----
// READS use the ANON key (NEARBY_PLACES_KEY): the cache is public-readable, reads
// need no elevated privilege, and this decouples the dry run from the service-role
// key. WRITES (kvWrite) keep the service-role key. A non-200 read is SURFACED, never
// silently swallowed into a skip — the v34/v35 silent-failure lesson, paid again.
let _readWarn = 0;
async function kvRead(key: string): Promise<{ ts: number; places: any[] } | null> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/shared_kv?key=eq.${encodeURIComponent(key)}&select=value`;
    const res = await fetch(url, { headers: { apikey: NKEY, Authorization: `Bearer ${NKEY}` } });
    if (!res.ok) {
      if (_readWarn++ < 5) console.error(`[gate-tiles] shared_kv READ failed HTTP ${res.status} for ${key} — check NEARBY_PLACES_KEY / SUPABASE_URL.`);
      return null;
    }
    const rows = await res.json().catch(() => []);
    if (!Array.isArray(rows) || !rows.length || !rows[0]?.value) return null; // genuinely no row
    const obj = JSON.parse(rows[0].value);
    if (!obj || !Array.isArray(obj.places)) return null;
    return obj;
  } catch (_e) { return null; }
}
// One-time preflight: prove shared_kv is readable at all, so a bad key/URL ABORTS the
// run up front instead of silently "skipping" every tile (what v1 did).
async function kvReadable(ver: string): Promise<{ ok: boolean; status: number; sample: number }> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/shared_kv?key=like.places:${ver}:*&select=key&limit=1`;
    const res = await fetch(url, { headers: { apikey: NKEY, Authorization: `Bearer ${NKEY}` } });
    if (!res.ok) return { ok: false, status: res.status, sample: 0 };
    const rows = await res.json().catch(() => []);
    return { ok: true, status: 200, sample: Array.isArray(rows) ? rows.length : 0 };
  } catch (_e) { return { ok: false, status: 0, sample: 0 }; }
}
let _writeWarn = 0;
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
    if (!res.ok && _writeWarn++ < 5) console.error(`[gate-tiles] shared_kv WRITE failed HTTP ${res.status} for ${key} — --commit needs a valid SUPABASE_SERVICE_ROLE_KEY (writes need service role).`);
    return res.ok;
  } catch (_e) { return false; }
}
// #356 --rewarm: delete a tile's cache row (service role) so the function rebuilds
// it ungated on the next warm. Only ever called under --rewarm.
let _delWarn = 0;
async function kvDelete(key: string): Promise<boolean> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/shared_kv?key=eq.${encodeURIComponent(key)}`;
    const res = await fetch(url, { method: "DELETE", headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
    if (!res.ok && _delWarn++ < 5) console.error(`[gate-tiles] shared_kv DELETE failed HTTP ${res.status} for ${key} — --rewarm needs a valid SUPABASE_SERVICE_ROLE_KEY.`);
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
  resolvedDetail: { name: string; desc: string }[];   // #344 commit fix: baked descriptions, so --from-records can re-apply them
  throttled: boolean;
  genUsed: number;
  graveResolved: number;   // #356 — how many grave-class pins the identity rung rescued
};
async function gateTile(places: any[]): Promise<GateResult> {
  const gated: any[] = [];
  const dropped: { name: string; category: string; desc: string }[] = [];
  let resolved = 0, genUsed = 0, graveResolved = 0, throttled = false;
  const resolvedDetail: { name: string; desc: string }[] = [];

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

    if (r && r.desc) { p.desc = r.desc; gated.push(p); resolved++; resolvedDetail.push({ name: String(p.name || ""), desc: r.desc }); continue; }

    // #356 — grave-identity rung: a grave-class plot pin whose person didn't
    // coordinate-resolve is rescued by an identity (name) resolve, NOT
    // coordinate-gated, guarded by full-name + person-signal (blank-beats-wrong on
    // a weak match). Runs BEFORE --gen (free), so most graves never touch Gemini.
    if (isGraveClass(p)) {
      const gr = await resolveGraveIdentity(p.name, isMemorialGraveShape(p));   // #363 memorial-grave → bank-only (no live namesake risk)
      if (gr === "throttled") { throttled = true; gated.push(p); continue; }   // KEEP, mark tile incomplete
      if (PACE_MS) await sleep(PACE_MS);
      if (gr && gr.desc) { p.desc = gr.desc; gated.push(p); resolved++; graveResolved++; resolvedDetail.push({ name: String(p.name || ""), desc: gr.desc }); continue; }
    }

    // Clean miss on the free wiki pass. Optionally try the function's recall (Gemini/Wikidata).
    if (USE_GEN) {
      const who = artistFromPin(p);                                   // #355 — creator (art pins only)
      let g = await resolveViaFunction(p.name, p.lat, p.lng, who);    // #355 — creator signal for art pins
      if (PACE_MS) await sleep(PACE_MS);
      // #355 v3 — a transient recall failure is NOT "story-less". Under a sweep burst the
      // function's own upstream can 429 and surface as "error" or a masked 200+null. Give a
      // creator-bearing pin ONE paced retry before condemning it (a real miss retries to the
      // same null and still drops; a throttled one usually clears). A hard transient ("error")
      // HOLDS the tile — kept + marked incomplete for --held — never a silent drop.
      if (RETRY_MS && (g === "error" || (g === null && who))) {
        await sleep(RETRY_MS);
        g = await resolveViaFunction(p.name, p.lat, p.lng, who);
        if (PACE_MS) await sleep(PACE_MS);
      }
      if (g === "error") { throttled = true; gated.push(p); continue; }   // transient → KEEP, mark tile incomplete
      if (g && g.desc) { p.desc = g.desc; gated.push(p); resolved++; genUsed++; resolvedDetail.push({ name: String(p.name || ""), desc: g.desc }); continue; }
    }
    // Confirmed story-less → drop.
    dropped.push({ name: String(p.name || ""), category: String(p.category || ""), desc: String(p.desc || "") });
  }
  return { gated, kept: gated.length, resolved, dropped, resolvedDetail, throttled, genUsed, graveResolved };
}

// ---- main ----
type TileRecord = {
  tile: string; metro: string; lat: number; lng: number;
  inCount: number; outCount: number; resolved: number; droppedCount: number;
  dropped: { name: string; category: string; desc: string }[];
  throttled: boolean; warmed: boolean; skipped?: string; committed?: boolean;
  resolvedDetail?: { name: string; desc: string }[];   // #344 commit fix
  graveResolved?: number;   // #356
};

// The build marker — bump on every delivery (the offline tool's APP_VERSION analog;
// confirm it in the run log). Shared by the main banner and the prime report.
const BUILD_MARKER = "gate-tiles 2026-09-22a (#381 _isStructureOnlyName guard in resolveGraveIdentity — offline twin of #375)";

// #363 — resolve the prime name list. Priority: --names="A|B|C" arg, GRAVE_PRIME_NAMES
// env, graves-prime.txt (one per line, # comments), then the built-in Oak Woods default.
async function loadPrimeNames(): Promise<string[]> {
  const argRaw = Deno.args.find((a) => a.startsWith("--names="))?.slice("--names=".length);
  const raw = (argRaw ?? Deno.env.get("GRAVE_PRIME_NAMES") ?? "").trim();
  let list: string[] = [];
  if (raw) {
    list = raw.split(/[|\n]/);
  } else {
    try {
      const txt = await Deno.readTextFile(PRIME_FILE);
      list = txt.split(/\r?\n/).filter((l) => !l.trim().startsWith("#"));
      if (list.join("").trim()) console.log(`[gate-tiles] prime names loaded from ${PRIME_FILE}`);
    } catch (_e) { /* no file — fall through to the built-in default */ }
  }
  const cleaned = list.map((s) => s.trim()).filter(Boolean);
  return cleaned.length ? cleaned : OAK_WOODS_PRIME.slice();
}

// #363 --prime-graves — resolve a short supplied grave list ONCE, paced, and bank each
// confident hit (monotonic). Reuses resolveGraveIdentity untouched (one home for the
// three guards + the bank), so priming can never wrong-attach; a name whose common label
// doesn't token-match its article MISSES (reported, so you can re-prime it). Touches only
// gravebank:*, never a tile. A later `--rewarm --commit` bakes the banked bios onto the
// real OSM plots deterministically. Needs SUPABASE_URL + SRK (+ Wikipedia); the function
// need not be reachable.
async function primeGraves(): Promise<void> {
  if (!SRK) { console.error("FATAL: --prime-graves needs SUPABASE_SERVICE_ROLE_KEY (the gravebank read+write is service-role). Nothing was changed."); Deno.exit(1); }
  const names = await loadPrimeNames();
  console.log(`[gate-tiles] --prime-graves: ${names.length} name(s), pace=${PRIME_PACE_MS}ms, throttle-retries=${PRIME_MAX_THROTTLE_RETRY}, ${BANK_DRY ? "DRY (no bank write — add --commit to persist)" : `COMMIT (writing gravebank:${GRAVEBANK_VERSION}:*)`}.`);
  console.log("[gate-tiles] each name → resolveGraveIdentity: bank-first, then guarded multi-query recall (the SAME three #356 guards as the tile pass). A namesake can't wrong-attach; a label that doesn't token-match its article MISSES — re-prime it with the article-matching label.");

  type Out = { name: string; key: string; outcome: string; title?: string; chars?: number };
  const out: Out[] = [];
  let banked = 0, already = 0, missed = 0, held = 0;

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const key = graveBankKey(name);

    // Already banked? Skip instantly — the bank is monotonic, so a re-run is idempotent.
    const pre = await readGraveBank(name);
    if (pre) {
      out.push({ name, key, outcome: "already-banked", title: pre.title, chars: pre.desc.length });
      already++;
      console.log(`  ⤿ ${name} — already banked as "${pre.title}" (skip)`);
      if (i < names.length - 1) await sleep(PRIME_PACE_MS);
      continue;
    }

    // Resolve, retrying the WHOLE name on a throttle with a long, growing breather —
    // priming's job is to out-wait the identity-keyed rate limit the tile warmer loses to.
    let r: { desc: string; title: string } | null | "throttled" = null;
    for (let attempt = 0; attempt <= PRIME_MAX_THROTTLE_RETRY; attempt++) {
      r = await resolveGraveIdentity(name);      // bank-read-first; on a hit it writes the bank (unless BANK_DRY)
      if (r !== "throttled") break;
      if (attempt < PRIME_MAX_THROTTLE_RETRY) {
        const wait = PRIME_THROTTLE_WAITS[Math.min(attempt, PRIME_THROTTLE_WAITS.length - 1)];
        console.log(`  … ${name} — throttled, waiting ${Math.round(wait / 1000)}s then retrying (${attempt + 1}/${PRIME_MAX_THROTTLE_RETRY})`);
        await sleep(wait);
      }
    }

    if (r === "throttled") {
      out.push({ name, key, outcome: "throttled-gave-up" });
      held++;
      console.log(`  ~ ${name} — still throttled after ${PRIME_MAX_THROTTLE_RETRY} retries (NOT banked; re-run --prime-graves later)`);
    } else if (r) {
      out.push({ name, key, outcome: BANK_DRY ? "resolved-dry" : "banked", title: r.title, chars: r.desc.length });
      banked++;
      console.log(`  ${BANK_DRY ? "○" : "+"} ${name} → "${r.title}" (${r.desc.length} chars)${BANK_DRY ? " [DRY — would bank]" : " banked"}`);
    } else {
      out.push({ name, key, outcome: "clean-miss" });
      missed++;
      console.log(`  ✗ ${name} — no confident person hit (guards rejected, or no article); re-prime with the exact OSM label / article title if this pin should resolve`);
    }

    if (i < names.length - 1) await sleep(PRIME_PACE_MS);
  }

  const report = { build: BUILD_MARKER, mode: BANK_DRY ? "dry" : "commit", gravebankVersion: GRAVEBANK_VERSION, names: names.length, banked, already, missed, held, results: out };
  await Deno.writeTextFile(PRIME_FILE_OUT, JSON.stringify(report, null, 2));

  console.log(`\n=== prime summary ===${BANK_DRY ? " (DRY — nothing written to the bank)" : ""}`);
  console.log(JSON.stringify({ names: names.length, banked, already, missed, held }, null, 2));
  console.log(`report → ${PRIME_FILE_OUT}`);
  if (BANK_DRY) {
    console.log(`DRY RUN: re-run with --commit to write the ${banked} resolved line(s) into gravebank:${GRAVEBANK_VERSION}:*.`);
  } else {
    console.log("\nNEXT: bake the banked bios onto the real OSM plots — re-warm the target metro so the grave rung reads the bank:");
    console.log("  SEED_CITY_NAME=Chicago SEED_CITY_LAT=41.8781 SEED_CITY_LNG=-87.6298 GATE_METRO_KM=15 \\");
    console.log("    deno run --allow-net --allow-env --allow-read --allow-write gate-tiles.ts --rewarm --commit");
    console.log("  (Oak Woods ≈ 41.77,-87.60 falls in a Chicago metro rewarm. The bank read is deterministic — no per-tile rate-limit fight.)");
  }
  if (held) console.log(`${held} name(s) still throttled — re-run the SAME --prime-graves command later; already-banked names skip instantly.`);
}

async function main() {
  console.log(`[gate-tiles] build ${BUILD_MARKER} — carries #356 grave-identity rung + MONOTONIC GRAVE BANK (#357-style deterministic reuse) + multi-query recall + title⊆name nickname match + --rewarm. #363 adds --prime-graves: resolve a supplied grave list ONCE, paced, out of band, and bank each confident hit so a later --rewarm bakes it onto the real OSM plot without the per-tile rate-limit fight.`);
  if (REWARM) console.log("[gate-tiles] --rewarm ON: each target tile will be DELETED and rebuilt UNGATED before gating (a mutation — tiles over-show until the gated write lands). The gated write still needs --commit (or a follow-up --from-records --commit).");
  if (RESUME && COMMIT && !FROM_RECORDS) {
    console.error("FATAL: `--resume --commit` writes nothing — the checkpoint skips finished tiles, so it commits zero rows yet would print success. To COMMIT the results you just dry-ran, use `--from-records --commit` (writes the exact reviewed rows WITH baked descriptions, no re-crawl). To re-crawl and commit fresh, use `--commit` WITHOUT --resume.");
    Deno.exit(1);
  }
  if (!SUPABASE_URL) { console.error("FATAL: SUPABASE_URL required."); Deno.exit(1); }

  // #363 --prime-graves is self-contained: it only talks to Wikipedia + the gravebank
  // (service-role), so it needs neither NEARBY_PLACES_KEY nor a reachable function, and
  // it never enumerates or touches a tile. Run it and stop before the tile-sweep setup.
  if (PRIME_GRAVES) { await primeGraves(); return; }

  if (!NKEY) { console.error("FATAL: NEARBY_PLACES_KEY (the function anon key) required — reads + warming use it."); Deno.exit(1); }
  // Reads use the anon key; only WRITES (--commit) need the service-role key.
  if (COMMIT && !SRK) { console.error("FATAL: --commit needs SUPABASE_SERVICE_ROLE_KEY (writes to shared_kv need service role)."); Deno.exit(1); }

  // Sync the cache-key version to whatever the function currently serves — read it
  // from a live build so the tool can never write to the wrong version's key.
  const probe = await warmTile(40.0, -100.0);
  const VER = probe && typeof probe.cacheVersion === "string" ? probe.cacheVersion : "";
  if (!VER) { console.error("FATAL: could not read cacheVersion from the function (is it deployed / reachable? is NEARBY_PLACES_KEY the right anon key?)."); Deno.exit(1); }

  // PREFLIGHT — prove shared_kv is readable before doing 48 tiles of work. v1 read
  // with the wrong credential and got null for every tile, then silently "skipped"
  // all 48 (read=0, warmed=48). This aborts loudly on a read failure instead.
  const chk = await kvReadable(VER);
  if (!chk.ok) { console.error(`FATAL: cannot READ shared_kv (HTTP ${chk.status}). Check SUPABASE_URL + NEARBY_PLACES_KEY. Nothing was changed.`); Deno.exit(1); }
  if (chk.sample === 0) console.log(`[gate-tiles] note: no existing places:${VER}:* rows found yet — cold tiles will be warmed first.`);

  console.log(`[gate-tiles] function cacheVersion=${VER}  commit=${COMMIT}  gen=${USE_GEN}  metros=${ALL_METROS ? "ALL" : "single"}  reads=anon writes=${SRK ? "service-role" : "(none)"}`);

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
  let tRead = 0, tWarmed = 0, tSkipped = 0, tCommitted = 0, tThrottled = 0, totalDropped = 0, totalResolved = 0, totalGraveResolved = 0;

  // --from-records commits already-computed records with NO re-crawl (resume path).
  if (FROM_RECORDS && !HELD_ONLY) {
    for (const rec of priorRecords) {
      if (COMMIT && !rec.throttled && !rec.skipped && typeof rec.outCount === "number") {
        // Re-read the current row, re-apply the recorded drops by name, write back.
        const row = await kvRead(`places:${VER}:${rec.tile}`);
        if (!row) { rec.committed = false; records.push(rec); continue; }
        const dropNames = new Set(rec.dropped.map((d) => d.name));
        const gated = row.places.filter((p: any) => !(p && p.source === "osm" && FACTS_CATS.has(p.category) && isFillerDesc(p.desc) && dropNames.has(String(p.name || ""))));
        // #344 commit-bug fix: the current cache row still carries FILLER descs on the
        // resolved pins, so re-apply the baked descriptions the dry run recorded — else
        // the commit keeps the drops but reverts every resolved story back to filler.
        const descByName = new Map((rec.resolvedDetail || []).map((d) => [d.name, d.desc]));
        for (const p of gated) { const nd = descByName.get(String((p as any) && (p as any).name || "")); if (nd) (p as any).desc = nd; }
        rec.committed = gated.length ? await kvWrite(`places:${VER}:${rec.tile}`, { ts: Date.now(), places: gated }) : false;
        if (rec.committed) tCommitted++;
      }
      records.push(rec);
    }
    await Deno.writeTextFile(RECORDS_FILE, JSON.stringify(records, null, 2));
    console.log(`[gate-tiles] --from-records done: committed=${tCommitted}`);
    return;
  }

  // --resume: load the per-tile checkpoint. A tile counts as DONE (skip it) if it was
  // gated cleanly last time (not throttled, had a row). Throttled / no-row tiles are
  // retried. The checkpoint is rewritten after every tile so a kill mid-run loses nothing.
  const progress: Record<string, TileRecord> = {};
  if (RESUME) {
    try {
      const prev: TileRecord[] = JSON.parse(await Deno.readTextFile(PROGRESS_FILE));
      for (const r of prev) progress[r.tile] = r;
      const done = Object.values(progress).filter((r) => !r.throttled && r.skipped !== "no-row").length;
      console.log(`[gate-tiles] --resume: ${Object.keys(progress).length} tiles in checkpoint (${done} done, rest will retry).`);
    } catch (_e) { console.log(`[gate-tiles] --resume: no ${PROGRESS_FILE} yet — starting fresh.`); }
  }
  const isDone = (tile: string) => { const r = progress[tile]; return !!r && !r.throttled && r.skipped !== "no-row"; };
  const logEvery = tiles.length <= 60 ? 1 : 25; // per-tile log on small runs, every 25 on big ones
  const flushProgress = async () => { try { await Deno.writeTextFile(PROGRESS_FILE, JSON.stringify(Object.values(progress), null, 2)); } catch (_e) { /* best-effort */ } };

  let idx = 0;
  let consecThrottle = 0;
  let bailed = false;
  for (const t of tiles) {
    idx++;

    // Resume skip: already gated cleanly. (--rewarm never skips — it must rebuild.)
    if (RESUME && !REWARM && isDone(t.tile)) {
      records.push(progress[t.tile]); tRead++;
      if (idx % logEvery === 0) console.log(`[gate-tiles] ${idx}/${tiles.length} tile=${t.tile} (resume: already done, skipped)`);
      continue;
    }

    // #356 --rewarm: drop the committed row so the warm below rebuilds it ungated,
    // bringing back graves a prior gate run had removed (to be re-gated by the rung).
    if (REWARM) await kvDelete(`places:${VER}:${t.tile}`);

    let row = await kvRead(`places:${VER}:${t.tile}`);
    let warmed = false;
    if (!row || !row.places.length) {
      await warmTile(t.lat, t.lng);       // cold tile — warm it via the function, then re-read
      warmed = true; tWarmed++;
      row = await kvRead(`places:${VER}:${t.tile}`);
    } else { tRead++; }

    if (!row || !row.places.length) {
      const rec: TileRecord = { tile: t.tile, metro: t.metro, lat: t.lat, lng: t.lng, inCount: 0, outCount: 0, resolved: 0, droppedCount: 0, dropped: [], throttled: false, warmed, skipped: "no-row" };
      records.push(rec); progress[t.tile] = rec; tSkipped++;
      await flushProgress();
      if (idx % logEvery === 0) console.log(`[gate-tiles] ${idx}/${tiles.length} tile=${t.tile} (skip: no-row)`);
      continue;
    }

    const g = await gateTile(row.places);
    const rec: TileRecord = {
      tile: t.tile, metro: t.metro, lat: t.lat, lng: t.lng,
      inCount: row.places.length, outCount: g.gated.length, resolved: g.resolved,
      droppedCount: g.dropped.length, dropped: g.dropped, throttled: g.throttled, warmed, resolvedDetail: g.resolvedDetail, graveResolved: g.graveResolved,
    };
    totalDropped += g.dropped.length; totalResolved += g.resolved; totalGraveResolved += g.graveResolved;

    if (g.throttled) {
      rec.skipped = "throttled"; held.push(rec); tThrottled++;
      consecThrottle++;
    } else {
      consecThrottle = 0;
      if (COMMIT) {
        if (g.gated.length) { rec.committed = await kvWrite(`places:${VER}:${t.tile}`, { ts: Date.now(), places: g.gated }); if (rec.committed) tCommitted++; }
        else rec.skipped = "empty-after-gate";
      }
    }
    records.push(rec);
    progress[t.tile] = rec;
    await flushProgress(); // checkpoint after every tile — a kill here loses nothing

    if (idx % logEvery === 0 || idx === tiles.length) {
      console.log(`[gate-tiles] ${idx}/${tiles.length} tile=${t.tile} in=${rec.inCount} out=${rec.outCount} resolved=${rec.resolved} dropped=${rec.droppedCount}${g.throttled ? " THROTTLED" : ""}${rec.committed ? " committed" : ""}`);
    }

    // Fail fast under a sustained IP throttle: save progress and stop, rather than
    // grinding every remaining tile through backoff. Re-run with --resume when calmer.
    if (consecThrottle >= THROTTLE_BAIL) {
      bailed = true;
      console.log(`[gate-tiles] BAIL: ${consecThrottle} tiles throttled in a row — Wikipedia is rate-limiting this IP. Progress saved (${Object.keys(progress).length} tiles). Re-run with --resume when it cools down; it will skip what's done.`);
      break;
    }
    if (g.throttled && THROTTLE_COOLDOWN_MS) await sleep(THROTTLE_COOLDOWN_MS); // brief breather before the next tile
  }

  await Deno.writeTextFile(RECORDS_FILE, JSON.stringify(records, null, 2));
  await Deno.writeTextFile(HELD_FILE, JSON.stringify(held, null, 2));
  await flushProgress();

  const perMetro: Record<string, { tiles: number; dropped: number; resolved: number; graveResolved: number; throttled: number }> = {};
  for (const r of records) {
    const m = (perMetro[r.metro] ||= { tiles: 0, dropped: 0, resolved: 0, graveResolved: 0, throttled: 0 });
    m.tiles++; m.dropped += r.droppedCount; m.resolved += r.resolved; m.graveResolved += (r.graveResolved || 0); if (r.throttled) m.throttled++;
  }
  const report = {
    cacheVersion: VER, commit: COMMIT, gen: USE_GEN, resume: RESUME, rewarm: REWARM, bailed,
    tiles: tiles.length, processed: records.length, read: tRead, warmed: tWarmed, skipped: tSkipped,
    committed: tCommitted, throttledTiles: tThrottled,
    totalResolved, totalGraveResolved, totalDropped, perMetro,
    note: bailed
      ? "BAILED on sustained throttle — progress saved to gate_tiles_progress.json. Wait for the IP to cool, then re-run the SAME command plus --resume; it skips finished tiles and continues."
      : COMMIT
      ? "Committed gated rows (ts=now). Re-run with --resume (and --held for parked tiles) if any remain."
      : "DRY RUN — nothing written. Eyeball the `dropped` lists in gate_tiles_records.json, then commit EXACTLY these results with `--from-records --commit` (writes the reviewed rows with baked descriptions; no re-crawl).",
  };
  await Deno.writeTextFile(REPORT_FILE, JSON.stringify(report, null, 2));

  console.log("\n=== gate-tiles summary ===");
  console.log(JSON.stringify(report, null, 2));
  if (totalGraveResolved) console.log(`\n#356 grave-identity rung rescued ${totalGraveResolved} grave-class pin(s) that the coordinate gate would have dropped.`);
  console.log(`\nrecords → ${RECORDS_FILE}   held → ${HELD_FILE}   report → ${REPORT_FILE}`);
  if (!COMMIT) console.log("DRY RUN: eyeball the dropped lists, then commit them with `--from-records --commit`.");
  if (tThrottled) console.log(`${tThrottled} tile(s) THROTTLED and left uncommitted — re-run: deno run … gate-tiles.ts --held --commit (when Wikipedia is healthy).`);
}

if (import.meta.main) main();
