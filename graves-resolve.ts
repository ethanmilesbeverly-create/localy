// graves-resolve.ts — the #310 notable-graves seed pipeline.
//
// WHAT IT DOES. Pulls NOTABLE GRAVES for a metro from Wikidata (the "place of
// burial" graph, P119) and turns them into history seed rows for the map. It is
// the Wikidata HALF of #310; the OSM half already works with no code — a plain
// `historic=tomb` element is a specific historic subtype, so categorizeOsm
// already files it under 'history' (the History & Lore tab). Both land in
// History & Lore — the operator's decision: graves are story-bearing history
// pins, not their own browse category (the nav is at its five-tab ceiling).
//
// THE TOP-N NOTABLE GRAVES PER SPOT (#372). Wikidata pins a burial at the
// BURIAL PLACE's coordinate, so most famous people carry the CEMETERY's
// coordinate, not their own plot — 53 notables at Memorial Park all share one
// dot. Stacking all 53 there is wrong, but emitting only ONE also leaves a
// flagship cemetery that OSM maps as a single POLYGON (no per-person grave
// nodes) with just its single most-famous person on the map — the #372 gap:
// #364 banked ~190 bios, but the serve-path rung bakes onto a NODE, so a
// polygon-only cemetery (SF/Colma, Portland/Lone Fir) had nothing to attach
// them to. graves-resolve is the seed-layer answer: per coordinate the tool
// now emits the top N "Grave of <person>" pins (by Wikidata sitelink count),
// cemetery-accurate not plot-accurate — the most famous stays dead-centre on
// the cemetery coordinate (so the already-loaded top-1 is idempotent under the
// #338 skip) and ranks 2..N ring around it on a small deterministic anti-stack
// offset (GRAVE_STACK_OFFSET_M, default ~50 m) so they never land on one dot.
// A person with their OWN distinct coordinate (their tomb/mausoleum) is a
// size-1 cluster and still emits exactly one, dead-centre. Set GRAVE_TOP_N=1
// for the pre-#372 top-1-only behaviour. Net: the notable graves of a metro,
// the famous names of each cemetery leading, spread not stacked. Identity is
// the Wikidata QID (#163), so each of the N resolves the RIGHT person's bio —
// this sidesteps the by-NAME namesake trap that made --prime-graves resolve
// "John F. Kennedy" to the living Jr. son (the #372/#373 disambiguation facet):
// P119 hands us the QID directly, so JFK/RFK resolve correctly here.
//
// REQUIRE A DESCRIPTION. A grave pin is emitted ONLY if it resolves a real
// description — the person's Wikipedia intro, or (if Wikipedia is unreachable /
// throttled) the one-line Wikidata description already in hand. A pin that can
// resolve neither is DROPPED, not shipped blank (blank-beats-wrong, #101/#178).
//
// REQUIRE-WIKI. Only people with an English Wikipedia article count AT ALL — the
// query itself requires the enwiki sitelink. This kills the long tail of "has a
// Wikidata record but nobody wrote about them" (a first pass without it surfaced
// a TV-remote inventor and a Styx guitarist). Requiring the article at the QUERY
// level keeps the result set small and the run fast.
//
// REQUIRE A CEMETERY BURIAL PLACE (#342). A Wikidata "place of burial" (P119)
// is not guaranteed to BE a cemetery — for someone whose ashes were scattered it
// can point at the scattering site (Steve Goodman → Wrigley Field), so the old
// tool planted "Grave of Steve Goodman" on a ballpark. A candidate is now emitted
// only if its kept burial place is actually a cemetery/burial ground, tested two
// ways and accepted if EITHER passes (so an oddly-modelled real cemetery is not
// false-dropped): by CLASS (the burial place is an instance/subclass of cemetery,
// wd:Q39614 — a bounded VALUES query, never a property path over the geo box) or
// by LABEL (the burial place's NAME is a specific grave structure — cemetery,
// tomb, mausoleum, church/chapel/cathedral, abbey/monastery, shrine or monument
// — via isGraveBurialLabel; P119 means "place of burial", so a named structure
// means the person is interred there, but a coarse area like a town/city/township
// centroid or a stadium is not). A burial place that fails both is REJECTED (reported outcome
// "non-cemetery-burial"), and if it is ALREADY LOADED the crawl writes it to
// graves_audit.json with a proposed retire (see the audit note below). If the
// class query is unreachable the gate degrades to LABEL-only with a warning —
// never silently off. Turn the whole gate off with GRAVE_REQUIRE_CEMETERY=0.
//
// WIDENED (#406, build 24c). The v2 word list still false-rejected places whose
// NAME says burial outright ("… Gravesite", "Taliesin West Burial Site", "Adams
// Memorial", a Friends "Meeting House" burial ground, "Mission San Francisco de
// Asís", an "Ohel", a columbarium named "… Funeral Home"), so for an already-
// loaded one the audit proposed retiring a TRUE grave — the #109 mistake v2 was
// built to avoid. The LABEL arm now also takes those words (each bounded so a
// neighbourhood like "Gravesend", "Graves County", the "Mission District" or
// "Mission Viejo" still fails). "memorial" is the risky one — it also names war
// memorials, stadiums and hospitals — so it counts only when the label carries
// the PERSON's own surname and no war/veterans/venue word. A third arm, the
// operator KEEP list (GRAVE_KEEP_BURIAL_QIDS), keeps estates and historic sites
// whose GROUNDS hold the grave but whose name never says so (the Hermitage,
// Mount Vernon, the Tennessee Capitol) — a list of QIDs, not a looser word test,
// so a town centroid can never ride in on it. Add a QID there when a dry run's
// audit lists a real burial (the audit line prints each stray's burial QID).
//
// THE LINES IT DOES NOT CROSS (the seed-pipeline discipline, #57/#263/#264):
//   * Descriptions are FACTS or BLANK. A grave pin's description is the person's
//     Wikipedia intro (identity via the Wikidata sitelink, the #163 editor-
//     asserted-link path — not coordinate-gated). Nothing is AI-authored; blank
//     beats wrong.
//   * Seeds carry submitted_by=null and source='seed:wikidata-grave' (a distinct
//     handle for verify + back-out). #23 renders no credit for a null submitter,
//     so they are honest uncredited scaffold (#162/#208).
//   * Nothing is auto-loaded. A plain run writes graves_records.json +
//     graves_report.json and STOPS. Loading is the deliberate --commit, AFTER
//     you read the report. Propose-not-dispose (#266).
//
// ALL-METROS MODE (--all) — THE #335 ROLLOUT, ONE RUN FOR EVERY LAUNCH CITY.
// Pass --all (or GRAVE_ALL=1) and the tool loops the built-in METROS roster
// below instead of the single SEED_CITY_* metro, running the exact same
// per-metro pipeline for each and accumulating one combined proposal. Two
// things the single-metro path doesn't need, added for the loop:
//   * CROSS-METRO DEDUP BY QID. Metro bounding boxes overlap (Dallas/Fort Worth,
//     the SF Bay, Minneapolis/St Paul), so the SAME famous grave can fall inside
//     two boxes. A person (Wikidata QID) already emitted for an earlier metro is
//     SKIPPED for every later one and reported as "cross-metro-dup" — so a shared
//     grave is planted ONCE, by the first metro that reaches it.
//   * PER-CITY city STAMP + PER-CITY verify/back-out. Each row still carries its
//     own metro's name in submissions.city (the commit/verify/back-out are all
//     city-scoped), and --commit prints a per-city verify line plus a single
//     time-scoped back-out that removes the WHOLE run.
// The single-metro behaviour is UNCHANGED — no --all means the same one-metro
// run it always did (safe Chicago default if SEED_CITY_* is unset). --all is
// opt-in precisely because a 20-metro run is expensive and the bare default must
// stay a single safe metro (the seed-pipeline bare-default lesson).
//
// EDIT THE ROSTER, NOT THE CODE: METROS (just below the config block) is the
// launch-city list — name + centre lat/lng. Add a city by adding a row; a
// sprawly metro can get a second row at a different centre (the bbox is ±
// GRAVE_METRO_KM around each). Coordinates are city centres; graves resolve off
// their own Wikidata burial coordinate, so the centre only sizes the bbox.
//
// RUN (offline Deno tool at the repo root — a sibling of seed-resolve.ts):
//
//   # dry run, ONE metro — query + build + propose, writes NOTHING to the DB:
//   SEED_CITY_NAME=Chicago SEED_CITY_LAT=41.8781 SEED_CITY_LNG=-87.6298 \
//     deno run --allow-net --allow-env --allow-write graves-resolve.ts
//
//   # dry run, ALL launch metros (the #335 rollout) — writes NOTHING:
//   deno run --allow-net --allow-env --allow-write graves-resolve.ts --all
//
//   # after reading graves_report.json, load EVERY metro's proposed rows:
//   deno run --allow-net --allow-env --allow-write graves-resolve.ts --all --commit
//
//   # (single metro still works exactly as before, with or without --commit)
//   SEED_CITY_NAME=Chicago ... deno run … graves-resolve.ts --commit
//
// THE RETIRE AUDIT (#342). A dry run now also writes graves_audit.json whenever
// it finds ALREADY-LOADED graves whose P119 burial place is not a cemetery — the
// misplaced pins the old ungated tool planted. It PROPOSES a soft-retire SQL for
// each (status='rejected', reversible) and writes NOTHING to the DB: each is a
// live pin, dispositioned by hand (a scattered-ashes site may deserve a RELABEL
// rather than a delete — the #109 don't-blindly-remove-a-live-pin rule). Run a
// plain dry run over the roster (no --commit) to get the audit.
//
// CONFIG OUTSIDE THE FILE: none new. --commit reuses the SAME Codespaces secrets
// seed-resolve.ts uses (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). As of #338 those
// two secrets are ALSO read on a plain dry run — to power the submissions-aware skip
// (a dry run without them still works, just prints the skip OFF and proposes all).
// Still the same two secrets, nothing added. Wikidata and Wikipedia are keyless. No
// Gemini — a Wikidata item is canonical. Optional NEARBY_PLACES_URL/_KEY turns on
// map-parity dedup (off by default; for an all-metros run set both to skip graves
// OSM already shows across every city).
//
// AN ALL-METROS RUN IS ~20× THE WIKIPEDIA TRAFFIC of one metro. The existing
// retry-backoff + Wikidata-line fallback + 300 ms per-pin pacing carry it, plus
// a short pause between metros.
//
// SUBMISSIONS-AWARE SKIP (#338) — a re-run no longer re-proposes a loaded metro.
// Before emitting, the tool reads every existing source='seed:wikidata-grave'
// row from the DB (paged past the 1,000-row REST cap) and SKIPS any candidate
// that is already there, matched by NAME + rounded COORDINATE (the QID lives in
// grave_meta, which is NOT a committed column, so the persisted identity is the
// name+coordinate — see the loadedKey note below). So you no longer hand-comment
// loaded cities out of METROS before a re-run: uncomment the whole roster, re-run
// --all, and already-loaded graves fall out as "already-loaded" while only the
// genuinely-new ones remain. The skip is ACTIVE on a dry run too (so the dry-run
// report shows exactly what is new) whenever the DB is reachable; it needs the
// same SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY --commit already uses. FAIL-CLOSED:
// on --commit, if the DB can't be read the run ABORTS rather than propose blind
// (a --commit without the skip could double-insert). Disable with GRAVE_SKIP_LOADED=0
// (then --commit CAN double-insert — the pre-#338 behaviour, kept as an escape hatch).
//
// This makes a re-run's --commit effectively idempotent — but ONLY because of the
// skip: with the skip OFF (no secrets on a dry-run, or GRAVE_SKIP_LOADED=0) the old
// seed-pipeline rule stands, never --commit the same rows twice. The skip's identity
// is name+coordinate, so a genuinely-new grave whose name/coordinate collides with a
// loaded one would be skipped (accepted: the report shows every "already-loaded" so
// a surprise skip is visible before you commit).
//
// HAND-CORRECTED GRAVES WIN OVER WIKIDATA (#384). The DB is the authority for any
// person it already holds. Three hand corrections change a loaded row's NAME or
// COORDINATE away from what a fresh crawl would produce, so the exact
// name+coordinate key above can't see them:
//   * #383 MOVED retired town-centroid graves (Joy Morton, Eugene Polley, Judith
//     Krug) onto their real cemeteries — Wikidata's P119 still says the TOWN;
//   * #379 APPENDED life-dates to same-name namesakes ("Grave of Stephen Crane
//     (1871–1900)") — a fresh crawl emits the undated name;
//   * #342 RETIRED the town-centroid rows (status='rejected') — they are still in
//     submissions, and the old read ignored status, so every audit run re-proposed
//     them as "live" pins.
// So the loaded read now also keeps each row's STATUS and a CORE-NAME index (the
// name lowercased, whitespace-collapsed, a trailing "(YYYY–YYYY)" life-date
// stripped). Against it:
//   EMIT — a candidate whose core name is already loaded is never re-planted:
//     within MATCH_RADIUS_M it's "already-loaded" (a relabelled twin); farther
//     away it's "loaded-elsewhere" (a hand-moved grave, or a namesake) — skipped
//     and REPORTED with the loaded name, coordinate and distance, so a genuinely
//     new namesake that got skipped is visible in graves_report.json before any
//     --commit. Under-emit is the safe direction (a missed grave is re-addable; a
//     re-planted centroid is misinformation on the map).
//   AUDIT — a rejected (non-cemetery) person is proposed for retire ONLY when a
//     LIVE row (approved, not merged) sits at the rejected coordinate. A retired
//     row there is "already-retired" (counted, not proposed); a row of that name
//     somewhere else is "hand-moved" (trusted, listed, not proposed).
//   --from-records — a record whose core name is already loaded is skipped too,
//     so an old graves_records.json can't re-insert a relabelled or moved grave.
// This replaces the row's first proposal (skip a loaded grave whose coordinate
// sits inside a cemetery polygon): the audit never looked at the LOADED
// coordinate, only at Wikidata's, so that guard had nothing to act on.
// FOUND ON FIRST LIVE RUN (build 24b): the 21b audit matched a live grave only at
// Wikidata's EXACT coordinate, so at a town centroid it saw the rank-1 pin and
// missed the #372 RING pins (ranks 2..5, ~50 m off) — four live "Grave of" pins
// sat on Chicago's city centre, uncaught. The within-MATCH_RADIUS_M name match
// catches them; the proposed retire SQL now keys on the row's own coordinate.
// RESIDUAL: a hand-moved row is trusted wherever it sits. If one was moved to a
// WRONG place, this tool won't catch it — the "hand-placed" list printed at the
// end of every run is the eyeball for that.
//
// RESUME WITHOUT RE-CRAWLING (--from-records, #338). After an interrupted
// --all --commit (e.g. the cloud run outlived a laptop sleep), you don't need a
// ~20-city re-crawl to finish: --from-records reads the graves_records.json already
// on disk, runs the submissions-aware skip over it, and (with --commit) inserts only
// the rows not already loaded — instant, and safe against the partial-commit double.
//
//   # validate what would be inserted from the existing file (writes nothing):
//   deno run --allow-net --allow-env --allow-read --allow-write graves-resolve.ts --from-records
//
//   # commit only the un-loaded rows from the existing file, no crawl:
//   deno run --allow-net --allow-env --allow-read --allow-write graves-resolve.ts --from-records --commit

// ---------------------------------------------------------------------------
// Config (all overridable by env; safe Chicago defaults).
// ---------------------------------------------------------------------------
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Optional map-parity dedup (nearby-places only). OFF by default.
const NEARBY_PLACES_URL = Deno.env.get("NEARBY_PLACES_URL") ?? "";
const NEARBY_PLACES_KEY = Deno.env.get("NEARBY_PLACES_KEY") ?? "";

// The metro. One run = one metro (populates submissions.city).
const CITY = {
  name: Deno.env.get("SEED_CITY_NAME")?.trim() || "Chicago",
  lat: Number(Deno.env.get("SEED_CITY_LAT") ?? 41.8781),
  lng: Number(Deno.env.get("SEED_CITY_LNG") ?? -87.6298),
};
// Half-size of the query bounding box, km (box is CITY ± this each side).
const GRAVE_METRO_KM = Number(Deno.env.get("GRAVE_METRO_KM") ?? 40);

// Source tag — the load's handle for verify + back-out.
const SOURCE_TAG = Deno.env.get("GRAVE_SOURCE_TAG")?.trim() || "seed:wikidata-grave";

// "Grave of <person>" prefix (set "" for the bare name).
const NAME_PREFIX = Deno.env.get("GRAVE_NAME_PREFIX") ?? "Grave of";

// Coordinate grouping precision. People whose coordinates round to the same key
// are treated as sharing one spot (a cemetery centroid). 4 decimals ≈ 11 m — a
// distinct tomb 50 m away rounds differently and still emits. A coordinate with
// exactly ONE notable => a grave pin; a coordinate shared by 2+ => covered by
// the cemetery, not emitted.
const COORD_DECIMALS = Number(Deno.env.get("GRAVE_COORD_DECIMALS") ?? 4);

// #372 top-N: how many notable graves to emit per shared cemetery coordinate,
// by fame. 1 = the pre-#372 top-1-only behaviour (a shared centroid emits just
// its most-famous person). Higher fills polygon-only cemeteries whose plots are
// not individual OSM nodes. Kept modest so a cemetery dot doesn't become a
// stack — this is cemetery-accurate discovery coverage, not a plot map.
const TOP_N = Math.max(1, Number(Deno.env.get("GRAVE_TOP_N") ?? 5));

// #372 anti-stack: ranks 2..N of a shared coordinate are pushed onto a small
// deterministic ring around the cemetery centroid (rank 1, the most famous,
// stays dead-centre so it matches the already-loaded top-1 for the #338 skip).
// ~50 m keeps them inside the cemetery grounds yet visually distinct at city
// zoom; the offset is a pure function of rank, so a re-run reproduces the exact
// same coordinates and the submissions-aware skip stays idempotent.
const STACK_OFFSET_M = Math.max(0, Number(Deno.env.get("GRAVE_STACK_OFFSET_M") ?? 50));

// How many names the covered-by-cemetery report lists per cemetery (by fame).
const MAX_NAMES = Number(Deno.env.get("GRAVE_MAX_NAMES") ?? 20);

const WIKI_RETRIES = Number(Deno.env.get("GRAVE_WIKI_RETRIES") ?? 3); // Wikipedia throttles cloud IPs; retry the intro fetch before falling back to the Wikidata line.
// The Wikidata SPARQL response is fetched in PAGES (LIMIT/OFFSET). A single
// full response for a big metro exceeds a ~256 KB cap on the Codespace egress
// proxy and truncates mid-JSON at a fixed byte offset (no retry can fix a
// deterministic cut). Small pages stay well under it. Lower if a page still
// truncates; raise for fewer round-trips.
const WD_PAGE_SIZE = Number(Deno.env.get("GRAVE_PAGE_SIZE") ?? 300);
// Cap a grave description so a long Wikipedia intro fits a pin card and can't
// trip a DB length limit. Trimmed at a sentence boundary, not mid-word.
const MAX_DESC_CHARS = Number(Deno.env.get("GRAVE_MAX_DESC_CHARS") ?? 600);
const MATCH_RADIUS_M = 90; // same constant as index.html dedupeReal()

// Submissions-aware skip (#338): ON by default when the DB is reachable. Set
// GRAVE_SKIP_LOADED=0 to disable it and propose every candidate (the pre-#338
// behaviour — then --commit CAN double-insert an already-loaded metro).
const SKIP_LOADED = Deno.env.get("GRAVE_SKIP_LOADED") !== "0";

// #342 grave-place gate: ON by default. A P119 "place of burial" can point at a
// NON-cemetery (Steve Goodman's ashes are scattered at Wrigley Field), so
// "Grave of X" landed on a stadium. With this ON a candidate is emitted only if
// the kept burial place is actually a cemetery/burial ground (by CLASS or by
// its NAME — see graveBurialQids). Set GRAVE_REQUIRE_CEMETERY=0 for the pre-#342
// behaviour (emit every articled burial regardless of the burial place's kind).
const REQUIRE_CEMETERY = Deno.env.get("GRAVE_REQUIRE_CEMETERY") !== "0";

// A build banner so a QA run can confirm it is running THIS file (the offline
// tool carries no APP_VERSION; this is the equivalent confirm-the-build line).
const BUILD = "graves-resolve 2026.09.24d (#405 — the operator KEEP list gains 15 burial-place QIDs the 24c audit showed are real burials: Emmy Noether's Old Library, the Schomburg Center, the Noguchi Museum, the Edison park, Salem's Charter Street burying point, two churchyards, Temple University, the Acton site, Hammond Castle, Samuel P. Taylor park, Fairview, Lookout Mountain, Bartram's Garden, Morehouse. Built on 24c [#406].)";

// A run mode + the metro shape shared by single and all-metros paths.
type Metro = { name: string; lat: number; lng: number };
const ALL_METROS = Deno.args.includes("--all") || Deno.env.get("GRAVE_ALL") === "1";

// THE LAUNCH-CITY ROSTER (#335). Edit THIS to add/remove a metro; centres are
// city centres (the bbox is ± GRAVE_METRO_KM around each). Overlapping boxes are
// fine — cross-metro QID dedup plants each shared grave once. A sprawly metro may
// get a second row at a different centre rather than one huge radius.
// AS OF #338 you no longer hand-comment already-loaded cities out before a re-run:
// the submissions-aware skip drops already-loaded graves at emit time, so you can
// leave the whole roster uncommented and re-run --all safely. (The commented rows
// below are the leftover hand-comment state from the #335 rollout — uncomment as you
// like; the skip handles the overlap.)
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

// The single-metro target (env-driven; the default is Chicago). In --all mode
// this is ignored in favour of the roster above.
const ENV_METRO: Metro = { name: CITY.name, lat: CITY.lat, lng: CITY.lng };

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
const STOP = new Set(["the", "of", "a", "an", "and", "at", "in", "on", "grave", "tomb", "memorial", "monument"]);
function tokens(s: string): Set<string> {
  return new Set(
    (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}
function titleMatch(name: string, title: string): number {
  const a = tokens(name), b = tokens(title);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size;
}

// The persisted identity of a grave row (#338): its NAME + rounded COORDINATE.
// The QID is only in grave_meta, which is NOT a committed column (see commit
// payload), so the DB has no QID to key on — name+coordinate is what actually
// survives an insert. The SAME builder runs over DB rows and over candidates so
// a re-proposed grave keys identically to its loaded twin. Coordinate rounded to
// COORD_DECIMALS (~11 m), matching the byCoord grouping precision; name lowercased
// and whitespace-collapsed so trivial spacing can't split a match.
function loadedKey(name: string, lat: number, lng: number): string {
  const nm = String(name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${nm}|${Number(lat).toFixed(COORD_DECIMALS)},${Number(lng).toFixed(COORD_DECIMALS)}`;
}

// #384: the loaded rows by CORE name — the name the way a fresh crawl would write
// it, so a hand-relabelled row still matches its candidate. Lowercased,
// whitespace-collapsed, and a trailing "(YYYY–YYYY)" life-date (any dash) removed
// — the #379 disambiguation suffix. Populated by fetchLoadedKeys; empty when the
// skip is off, so every #384 check below is a no-op then.
type LoadedRow = { name: string; lat: number; lng: number; live: boolean };
const LOADED_BY_NAME = new Map<string, LoadedRow[]>();
function graveNameCore(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*\d{3,4}\s*[-–—]\s*\d{3,4}\s*\)\s*$/, "")
    .trim();
}
// The nearest loaded row with the same core name, and how far it is — or null
// when no loaded row carries this name.
function nearestLoadedByName(name: string, lat: number, lng: number): { row: LoadedRow; distM: number } | null {
  const rows = LOADED_BY_NAME.get(graveNameCore(name));
  if (!rows || !rows.length) return null;
  let best: { row: LoadedRow; distM: number } | null = null;
  for (const r of rows) {
    const d = haversineM(lat, lng, r.lat, r.lng);
    if (!best || d < best.distM) best = { row: r, distM: d };
  }
  return best;
}

// #372 anti-stack: place the rank-th grave of a shared cemetery coordinate on a
// small deterministic ring around the centroid so N pins don't land on one dot.
// rank 0 (the most famous) is returned unchanged — dead-centre on the true
// cemetery coordinate — so it matches the already-loaded top-1 exactly and the
// #338 submissions-aware skip stays idempotent. Ranks 1..N-1 are placed on
// concentric rings of 8, radius STACK_OFFSET_M per shell, at evenly spaced
// angles. Purely a function of rank (never random), so a re-run reproduces the
// same coordinates and the skip recognises them. Cemetery-accurate, not plot-
// accurate (the row's accepted trade). With STACK_OFFSET_M=0 every rank stacks
// on the centroid (opt-out).
function stackOffset(lat: number, lng: number, rank: number): { lat: number; lng: number } {
  if (rank <= 0 || STACK_OFFSET_M <= 0) return { lat, lng };
  const PER_RING = 8;
  const shell = Math.floor((rank - 1) / PER_RING) + 1;      // 1, 2, 3, …
  const idxInRing = (rank - 1) % PER_RING;                  // 0..7
  const angle = (idxInRing / PER_RING) * 2 * Math.PI;       // evenly spaced
  const radiusM = STACK_OFFSET_M * shell;
  const dNorthM = radiusM * Math.cos(angle);
  const dEastM = radiusM * Math.sin(angle);
  const dLat = dNorthM / 111320;
  const dLng = dEastM / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

type Existing = { name: string; lat: number; lng: number; category?: string; source?: string };

// ---------------------------------------------------------------------------
// 1) Wikidata: notable ARTICLED burials inside the metro bbox, with fame.
// ---------------------------------------------------------------------------
type Person = {
  qid: string;
  person: string;
  personDesc: string;
  articleTitle: string;   // guaranteed present (enwiki required by the query)
  sitelinks: number;      // fame proxy — how many wikis link this person
  burialLabel: string;
  burialQid: string;      // the P119 burial PLACE's QID — the #342 grave-place gate keys on it
  lat: number;
  lng: number;
};

// #342: a person REJECTED because the kept P119 burial place is not a cemetery
// (Steve Goodman → Wrigley Field). Carried out of wikidataPeople so runMetro can
// report it (and flag whether an already-loaded pin needs retiring).
type RejectedBurial = {
  qid: string;
  person: string;
  lat: number;
  lng: number;
  burialLabel: string;
  burialQid: string;
};

// #378: what got collapsed when one QID carried multiple P119 coordinates —
// the coordinate we KEPT and the one(s) we DROPPED, so graves_report.json shows
// the choice (an eyeball can confirm we kept the cemetery, not the stray plot).
type CollapsedGrave = {
  qid: string;
  person: string;
  kept: { lat: number; lng: number; burialLabel: string };
  dropped: Array<{ lat: number; lng: number; burialLabel: string }>;
};

// #378 multi-P119 tiebreak: a Wikidata person can carry MORE THAN ONE "place of
// burial" (P119) coordinate — a reinterment, or a cemetery listed alongside a
// specific plot — so the SPARQL returns two rows for one QID, ~20 km apart
// (Egbert Benson: Queens vs Staten Island). We keep ONE grave per person, and
// this scores which coordinate to keep so the choice is DETERMINISTIC (the same
// every run — the property the coordinate-keyed #338 skip needs) and prefers the
// trustworthy cemetery coordinate. Higher = keep. A cemetery-class burial label
// (cemetery/graveyard/etc.) beats a bare named place beats an unlabelled one; the
// caller breaks any remaining tie on the coordinate string, so it never depends
// on Wikidata's unspecified row order for tied ?person.
function burialConfidence(label: string): number {
  const l = String(label ?? "").toLowerCase();
  // Leading \b only, no trailing \b — a trailing boundary can't sit between
  // "cemeter" and the "y", so "\bcemeter\b" never matched "cemetery" (the most
  // common cemetery label). Prefix-match instead so cemetery/cemeteries score 2.
  if (/\b(cemeter|graveyard|burial\s*ground|churchyard|necropolis|memorial\s*park|mausoleum|columbarium|catacomb|crypt|kirkyard)/.test(l)) return 2;
  if (l) return 1;
  return 0;
}

// #342 grave-place LABEL test — is the burial place's NAME a specific grave
// STRUCTURE, not a coarse administrative area? P119 is "place of burial", so a
// named cemetery / tomb / mausoleum / church / chapel / cathedral / abbey /
// monastery / shrine / monument all mean the person is interred THERE and are
// KEPT; only a coarse area (a town/city/township/county/neighbourhood centroid)
// or a plainly non-burial venue (a stadium) carries no such word and is
// rejected. Deliberately BROADER than burialConfidence (which stays the #378
// cemetery-vs-reinterment tiebreak, unchanged): the cemetery-word-only test
// false-DROPS real interred graves — Ira Couch's mausoleum ("Couch Tomb"),
// bishops entombed in their cathedrals, Emma Goldman at the "Haymarket Martyrs'
// Monument" (in Forest Home Cemetery) — so the gate keys on this wider set. A
// coarse area still fails it, so Wrigley Field / a town centroid / the bare city
// "Chicago" are still rejected.
function isGraveBurialLabel(label: string, person = ""): boolean {
  const l = String(label ?? "").toLowerCase();
  if (GRAVE_STRUCTURE_RE.test(l)) return true;
  // #406: burial words the v2 list missed. Each is bounded so a coarse area
  // that merely STARTS with the stem still fails — "Gravesend" (a Brooklyn
  // neighbourhood) and "Graves County" (Kentucky) for grave; the "Mission
  // District", "Mission Bay" and the city of "Mission Viejo" for mission.
  if (/\bgrave(s|site|sites)?\b/.test(l) && !/\bgraves\s+county\b/.test(l)) return true;
  if (/\bburial\b|\bmeeting\s*house\b|\bmeetinghouse\b|\bohel\b|\bvault\b|\bfuneral\s*home\b|\bmortuary\b/.test(l)) return true;
  if (/\bmission\s+(san|santa|dolores|nuestra|de|la)\b|\bmission\s*$/.test(l)) return true;
  // "memorial" names war memorials, stadiums and hospitals as often as graves,
  // so it counts only when it names THIS person (Henry Adams → "Adams Memorial")
  // and carries no war / veterans / venue word.
  if (/\bmemorial\b/.test(l) && !MEMORIAL_NOT_GRAVE_RE.test(l)) {
    const sn = personSurname(person);
    if (sn && new RegExp(`\\b${sn}\\b`, "u").test(l)) return true;
  }
  return false;
}

// The v2 (#342) grave-structure words, unchanged. Leading \b only (prefix
// match): a trailing \b never matched "cemetery" or "monastery" (the boundary
// can't fall between the stem and its "y"). Prefix matching leans permissive,
// which is the right bias here — P119 already asserts the place IS a burial
// site, so the gate's only job is to strip coarse-area centroids and
// non-burial venues, and a rare over-accept keeps a pin at a Wikidata-declared
// burial coordinate.
const GRAVE_STRUCTURE_RE = /\b(cemeter|graveyard|burial\s*ground|churchyard|necropolis|memorial\s*park|mausoleum|columbarium|catacomb|crypt|kirkyard|tomb|church|chapel|cathedral|basilica|abbey|minster|monaster|priory|friary|convent|shrine|monument)/;

// #406: a "memorial" with one of these words is a war memorial / venue / civic
// building, not a grave, even when it happens to share the person's surname.
const MEMORIAL_NOT_GRAVE_RE = /\b(war|veteran|soldiers|sailors|stadium|coliseum|colosseum|arena|auditorium|hall|hospital|library|bridge|highway|airport|field|school|university|college|center|centre)\b/;

// The person's surname for the #406 memorial test: the last name token, with a
// generational suffix and a trailing life-date dropped, lowercased. Under 3
// letters → "" (too short to be a safe word match).
function personSurname(person: string): string {
  const toks = String(person ?? "")
    .replace(/\(.*?\)/g, " ")
    .split(/[\s,]+/)
    .filter(Boolean)
    .filter((t) => !/^(jr|sr|ii|iii|iv|v)\.?$/i.test(t));
  // Letters only (so the regex built from it needs no escaping): "O'Brien" →
  // "obrien" won't match "O'Brien Memorial" — an under-accept, the safe side.
  const last = (toks[toks.length - 1] ?? "").toLowerCase().replace(/[^\p{L}]/gu, "");
  return last.length >= 3 ? last : "";
}

// #406 OPERATOR KEEP LIST — burial-place QIDs whose GROUNDS hold real graves
// but whose NAME carries no burial word (so neither the class arm nor the label
// arm can see them). Keyed on the burial place's QID, never on a word, so a
// town centroid can't slip in. QIDs resolved 2026-09-24 from each place's
// English Wikipedia article (the enwiki → Wikidata sitelink); if the audit
// still lists one of these places, its P119 points at a DIFFERENT item — copy
// the burial QID the audit prints into this list. Add a place only when a
// dry run's audit lists it AND the person is genuinely buried on its grounds.
const GRAVE_KEEP_BURIAL_QIDS: Record<string, string> = {
  Q2376587: "The Hermitage (Andrew Jackson, Nashville)",
  Q731635: "Mount Vernon (the Washington family vault)",
  Q675702: "Arlington House (the Custis graves)",
  Q1554859: "Gunston Hall (the Mason family cemetery)",
  Q2058611: "Hillwood Estate (Marjorie Merriweather Post)",
  Q2570396: "Tennessee State Capitol (the tombs of James K. Polk and William Strickland)",
  Q3768575: "Girard College (Stephen Girard's sarcophagus, Founder's Hall)",
  Q995265: "Bryn Mawr College (ashes interred in the cloister)",
  Q6411311: "The King Center (the King crypt)",
  Q5016739: "Martin Luther King Jr. National Historical Park (the King crypt)",
  Q1208310: "Taliesin West (the Wright burial site)",
  Q1000321: "Mission San Francisco de Asís (the mission cemetery)",
  Q351935: "Adams Memorial (Henry and Marian Hooper Adams)",
  // #405 (2026-09-24): real burials the 24c audit still listed — P119 points at
  // a building, campus, park or churchyard the #406 list didn't name. QIDs are
  // the audit's own printed [Q…], so they match P119 exactly.
  Q6712468: "Old Library, Bryn Mawr (Emmy Noether's ashes in the cloister)",
  Q1060566: "Schomburg Center (Langston Hughes's ashes beneath the floor)",
  Q836080: "Noguchi Museum (half of Isamu Noguchi's ashes in the garden)",
  Q7789244: "Thomas Edison National Historical Park (Edison's grave at Glenmont)",
  Q5086751: "Charter Street Historic District (Salem's Old Burying Point — Simon Bradstreet)",
  Q7591865: "St. Thomas' Whitemarsh (churchyard — Katherine Garrison Chapin)",
  Q7589240: "St. Joseph's on the Brandywine (churchyard — Beau Biden)",
  Q1420239: "Temple University (Russell Conwell, Founder's Garden)",
  Q4677687: "Acton State Historic Site (Elizabeth Patton Crockett's grave)",
  Q30257998: "Hammond Castle Museum (John Hays Hammond Jr., on the grounds)",
  Q7412337: "Samuel P. Taylor State Park (Taylor's grave in the park)",
  Q5430850: "Fairview Plantation (Oden Bowie, the family cemetery)",
  Q6675490: "Lookout Mountain (Buffalo Bill's grave — and Louisa Frederici's)",
  Q2313437: "Bartram's Garden (William Bartram, the family plot)",
  Q1524124: "Morehouse College (John Hope, buried on the Atlanta University Center campus)",
};

function titleFromArticleUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const raw = new URL(url).pathname.replace(/^\/wiki\//, "");
    return raw ? decodeURIComponent(raw).replace(/_/g, " ") : null;
  } catch {
    return null;
  }
}

// #342 grave-place CLASS test. Given the burial-place QIDs collected from the
// metro query, return the subset that are actually a cemetery — instance of, or
// a subclass of, cemetery (wd:Q39614), which covers the whole grave-place
// subtree (war cemetery, Jewish cemetery, natural burial ground, …). The
// property path runs inside a bounded VALUES over only the QIDs we already have
// — NOT across the geo box, where P279* could trip the WDQS 60 s timeout. This
// is the CLASS half of the gate; the LABEL half (a cemetery-word in the burial
// name, via burialConfidence) is OR'd with it in the caller so an oddly-modelled
// real cemetery isn't false-dropped. On ANY failure it returns ok:false and an
// empty set, so the caller degrades to the LABEL test alone (weaker but still
// safe) and warns — it never silently drops the whole gate.
async function graveBurialQids(burialQids: string[]): Promise<{ ok: boolean; graves: Set<string> }> {
  const graves = new Set<string>();
  const uniq = [...new Set(burialQids.filter((q) => /^Q\d+$/.test(q)))];
  if (!uniq.length) return { ok: true, graves };
  const BATCH = 200;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const batch = uniq.slice(i, i + BATCH);
    const values = batch.map((q) => `wd:${q}`).join(" ");
    const sparql = `SELECT DISTINCT ?burial WHERE { VALUES ?burial { ${values} } ?burial wdt:P31/wdt:P279* wd:Q39614 . }`;
    const endpoint = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql);
    let got = false;
    for (let attempt = 0; attempt <= WIKI_RETRIES; attempt++) {
      try {
        const r = await fetch(endpoint, {
          headers: {
            Accept: "application/sparql-results+json",
            "User-Agent": "nahgoo-graves/1.0 (grave-place gate; contact: privacy@nahgoo.com)",
          },
        });
        if (r.status === 429 || r.status >= 500 || !r.ok) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        const json = JSON.parse(await r.text());
        for (const b of json?.results?.bindings ?? []) {
          const q = String(b?.burial?.value ?? "").split("/").pop() ?? "";
          if (q) graves.add(q);
        }
        got = true;
        break;
      } catch {
        await sleep(1500 * (attempt + 1));
      }
    }
    if (!got) return { ok: false, graves: new Set() };
    await sleep(300);
  }
  return { ok: true, graves };
}

async function wikidataPeople(metro: Metro, loadedKeys: Set<string>): Promise<{ people: Person[]; collapsed: CollapsedGrave[]; rejected: RejectedBurial[] }> {
  const dLat = GRAVE_METRO_KM / 111;
  const dLng = GRAVE_METRO_KM / (111 * Math.max(0.05, Math.cos((metro.lat * Math.PI) / 180)));
  const west = `Point(${(metro.lng - dLng).toFixed(6)} ${(metro.lat - dLat).toFixed(6)})`;
  const east = `Point(${(metro.lng + dLng).toFixed(6)} ${(metro.lat + dLat).toFixed(6)})`;

  // ENWIKI ARTICLE REQUIRED (not OPTIONAL) — the require-wiki gate, at the query
  // level. wikibase:sitelinks is the fame proxy. The inner query is stable-
  // ORDERED by person so LIMIT/OFFSET paging is deterministic; the label service
  // runs OUTSIDE the ordered subquery so it only labels the current page.
  const sparqlFor = (limit: number, offset: number) => `
SELECT ?person ?personLabel ?personDescription ?sitelinks ?burial ?burialLabel ?coord ?article WHERE {
  {
    SELECT ?person ?sitelinks ?burial ?coord ?article WHERE {
      SERVICE wikibase:box {
        ?burial wdt:P625 ?coord .
        bd:serviceParam wikibase:cornerWest "${west}"^^geo:wktLiteral .
        bd:serviceParam wikibase:cornerEast "${east}"^^geo:wktLiteral .
      }
      ?person wdt:P31 wd:Q5 ;
              wdt:P119 ?burial ;
              wikibase:sitelinks ?sitelinks .
      ?article schema:about ?person ;
               schema:isPartOf <https://en.wikipedia.org/> .
    }
    ORDER BY ?person
    LIMIT ${limit} OFFSET ${offset}
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`.trim();

  // Fetch one page of results, with retry/backoff. Returns the bindings array,
  // or throws after WIKI_RETRIES (a 400 is fatal — bad query).
  async function fetchPage(limit: number, offset: number): Promise<any[]> {
    const endpoint = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparqlFor(limit, offset));
    let lastErr = "";
    for (let attempt = 0; attempt <= WIKI_RETRIES; attempt++) {
      try {
        const r = await fetch(endpoint, {
          headers: {
            Accept: "application/sparql-results+json",
            "User-Agent": "nahgoo-graves/1.0 (notable-grave seed pipeline; contact: privacy@nahgoo.com)",
          },
        });
        if (r.status === 400) {
          const body = await r.text().catch(() => "");
          console.error(`\nWikidata query FAILED: HTTP 400 (bad query) ${body.slice(0, 300)}`);
          console.error("400 = geo-box syntax; see the header note. Nothing was written.");
          Deno.exit(1);
        }
        if (r.status === 429 || r.status >= 500 || !r.ok) {
          lastErr = `HTTP ${r.status}`;
          await sleep(2000 * (attempt + 1));
          continue;
        }
        const body = await r.text(); // read fully, THEN parse — a truncated read throws here, and we retry
        const json = JSON.parse(body);
        return json?.results?.bindings ?? [];
      } catch (e) {
        lastErr = String(e);
        console.log(`  (page offset ${offset} attempt ${attempt + 1} failed: ${lastErr} — retrying)`);
        await sleep(2000 * (attempt + 1));
      }
    }
    throw new Error(`Wikidata page at offset ${offset} failed after ${WIKI_RETRIES + 1} attempts: ${lastErr}`);
  }

  // Page through until a short page signals the end.
  const rowsRaw: any[] = [];
  for (let offset = 0; ; offset += WD_PAGE_SIZE) {
    let page: any[];
    try {
      page = await fetchPage(WD_PAGE_SIZE, offset);
    } catch (e) {
      console.error(`\n${e}. If a page keeps truncating, lower GRAVE_PAGE_SIZE (e.g. 150). Nothing was written.`);
      Deno.exit(1);
    }
    rowsRaw.push(...page);
    console.log(`  page @${offset}: ${page.length} rows (total ${rowsRaw.length})`);
    if (page.length < WD_PAGE_SIZE) break;
    await sleep(300);
  }
  console.log(`Wikidata returned ${rowsRaw.length} raw articled-burial row(s) in the ${metro.name} bbox.`);

  // Collect EVERY coordinate variant per QID (#378). A person with two P119
  // "place of burial" statements returns two rows here, same QID, ~20 km apart.
  // The old code kept the FIRST-seen row and dropped the rest — but Wikidata's
  // ORDER BY ?person leaves tied rows (one person, two burials) in an unspecified
  // order, so "first" varied run to run: one run kept Queens, another Staten
  // Island, and because the #338 skip is keyed on name+COORDINATE, the second
  // coordinate wasn't recognised as already-loaded and got planted as a SECOND
  // pin. We now gather all variants and pick ONE deterministically below.
  const byQid = new Map<string, Person[]>();
  for (const b of rowsRaw) {
    const personUri = b?.person?.value as string | undefined;
    const coordWkt = b?.coord?.value as string | undefined;
    const article = titleFromArticleUrl(b?.article?.value);
    const burialUri = b?.burial?.value as string | undefined;
    if (!personUri || !coordWkt || !article) continue;
    const m = /^Point\(([-\d.]+)\s+([-\d.]+)\)$/.exec(coordWkt.trim());
    if (!m) continue;
    const lng = Number(m[1]), lat = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const qid = personUri.split("/").pop() ?? personUri;
    const person = String(b?.personLabel?.value ?? "").trim();
    if (!person || /^Q\d+$/.test(person)) continue;
    const variant: Person = {
      qid,
      person,
      personDesc: String(b?.personDescription?.value ?? "").trim(),
      articleTitle: article,
      sitelinks: Number(b?.sitelinks?.value ?? 0) || 0,
      burialLabel: String(b?.burialLabel?.value ?? "").trim(),
      burialQid: (burialUri ?? "").split("/").pop() ?? "",
      lat,
      lng,
    };
    const arr = byQid.get(qid) ?? [];
    // Guard against the identical row appearing on two pages (a paging tie):
    // treat two variants at the same rounded coordinate as one.
    const coordKey = `${lat.toFixed(COORD_DECIMALS)},${lng.toFixed(COORD_DECIMALS)}`;
    if (!arr.some((v) => `${v.lat.toFixed(COORD_DECIMALS)},${v.lng.toFixed(COORD_DECIMALS)}` === coordKey)) {
      arr.push(variant);
    }
    byQid.set(qid, arr);
  }

  // Pick ONE coordinate per QID, deterministically (#378). Order:
  //   1. an ALREADY-LOADED coordinate first — so if a prior run planted this
  //      person at one of their coords, we keep THAT one and the #338 skip
  //      recognises it (this is what stops the re-pick from planting a fresh
  //      pin at a different coord next --commit; empty loadedKeys on a dry run,
  //      so it's a no-op there);
  //   2. cemetery-class burial label (burialConfidence) — keep the cemetery,
  //      not the stray reinterment plot;
  //   3. higher sitelinks (identical for one person — a no-op, kept for a total
  //      order);
  //   4. the coordinate string (always distinct, so the sort is total and never
  //      leans on Wikidata's unspecified row order for a tied ?person).
  // With no loaded twin (a brand-new person) rule 1 ties and cemetery-first
  // decides — the same choice on every run, so the pair can never be minted.
  const loadedScore = (p: Person): number => {
    const candName = NAME_PREFIX ? `${NAME_PREFIX} ${p.person}` : p.person;
    return loadedKeys.has(loadedKey(candName, p.lat, p.lng)) ? 1 : 0;
  };
  const people: Person[] = [];
  const collapsed: CollapsedGrave[] = [];
  for (const variants of byQid.values()) {
    variants.sort((a, b) =>
      (loadedScore(b) - loadedScore(a)) ||
      (burialConfidence(b.burialLabel) - burialConfidence(a.burialLabel)) ||
      (b.sitelinks - a.sitelinks) ||
      (`${a.lat.toFixed(COORD_DECIMALS)},${a.lng.toFixed(COORD_DECIMALS)}`
        .localeCompare(`${b.lat.toFixed(COORD_DECIMALS)},${b.lng.toFixed(COORD_DECIMALS)}`)));
    const kept = variants[0];
    people.push(kept);
    if (variants.length > 1) {
      collapsed.push({
        qid: kept.qid,
        person: kept.person,
        kept: { lat: kept.lat, lng: kept.lng, burialLabel: kept.burialLabel },
        dropped: variants.slice(1).map((v) => ({ lat: v.lat, lng: v.lng, burialLabel: v.burialLabel })),
      });
    }
  }

  // #342 GRAVE-PLACE GATE. Keep a grave pin only where the kept P119 burial place
  // is actually a cemetery — by CLASS (subclass of cemetery) OR by LABEL (a
  // cemetery-word in the burial name). A non-grave P119 (a stadium, park, river)
  // fails both and is rejected here, so "Grave of X" can never land on a
  // landmark. OFF with GRAVE_REQUIRE_CEMETERY=0.
  const rejected: RejectedBurial[] = [];
  if (REQUIRE_CEMETERY && people.length) {
    const cls = await graveBurialQids(people.map((p) => p.burialQid));
    if (!cls.ok) {
      console.log("  ⚠ grave-place CLASS check unavailable (Wikidata unreachable) — gating on the burial-place NAME alone this run.");
    }
    const kept: Person[] = [];
    const keptByList: string[] = [];
    for (const p of people) {
      const byClass = p.burialQid ? cls.graves.has(p.burialQid) : false;
      const byLabel = isGraveBurialLabel(p.burialLabel, p.person);
      const byKeep = p.burialQid ? Object.hasOwn(GRAVE_KEEP_BURIAL_QIDS, p.burialQid) : false;
      if (byKeep && !byClass && !byLabel) keptByList.push(`${p.person} → ${p.burialLabel}`);
      if (byClass || byLabel || byKeep) {
        kept.push(p);
      } else {
        rejected.push({ qid: p.qid, person: p.person, lat: p.lat, lng: p.lng, burialLabel: p.burialLabel || "(unnamed)", burialQid: p.burialQid });
      }
    }
    if (keptByList.length) {
      console.log(`  ✓ ${keptByList.length} person(s) kept by the operator KEEP list (#406 — burial on an estate's grounds): ${keptByList.join(", ")}`);
    }
    if (rejected.length) {
      console.log(`  ⊘ ${rejected.length} person(s) whose P119 burial place is NOT a cemetery — rejected (#342): ${rejected.map((r) => `${r.person} → ${r.burialLabel}`).join(", ")}`);
    }
    return { people: kept, collapsed, rejected };
  }
  return { people, collapsed, rejected };
}

// ---------------------------------------------------------------------------
// 2) Wikipedia intro for a grave pin (identity via the sitelink, #163 — not
//    coordinate-gated). Blank if the fetch fails.
// ---------------------------------------------------------------------------
async function wikiIntroFor(title: string): Promise<string> {
  const ex =
    "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&redirects=1&titles=" +
    encodeURIComponent(title);
  // Wikipedia's action API throttles rapid bursts from cloud/datacenter IPs
  // (the Codespace) and can return 429/5xx or an empty body — which is why a
  // first pass showed every intro blank. Retry with backoff before giving up;
  // the caller then falls back to the Wikidata one-line description.
  for (let attempt = 0; attempt <= WIKI_RETRIES; attempt++) {
    try {
      const er = await fetch(ex, { headers: { "User-Agent": "nahgoo-graves/1.0 (contact: privacy@nahgoo.com)" } });
      if (er.status === 429 || er.status >= 500) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      if (!er.ok) return "";
      const ed = await er.json();
      const pages = ed?.query?.pages ?? {};
      const first: any = Object.values(pages)[0] ?? {};
      return String(first.extract ?? "").trim();
    } catch {
      await sleep(1000 * (attempt + 1));
    }
  }
  return "";
}

// Trim a description to <= MAX_DESC_CHARS, cutting at the last sentence end
// (. ! ?) before the cap so it never ends mid-word; falls back to a hard cut
// with an ellipsis only if no sentence break is found in range.
function trimDesc(text: string): string {
  const t = text.trim();
  if (t.length <= MAX_DESC_CHARS) return t;
  const slice = t.slice(0, MAX_DESC_CHARS);
  const lastEnd = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (lastEnd >= MAX_DESC_CHARS * 0.5) return slice.slice(0, lastEnd + 1).trim();
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim() + "…";
}

// A grave pin's description: the Wikipedia intro, else the Wikidata one-line
// description already fetched (e.g. "American folk music singer-songwriter") —
// human-written and sourced (#37/#101), never AI. "" only if BOTH are empty.
async function resolveDescription(p: Person): Promise<{ text: string; src: "wiki" | "wikidata" | "" }> {
  const intro = await wikiIntroFor(p.articleTitle);
  if (intro) return { text: trimDesc(intro), src: "wiki" };
  if (p.personDesc) return { text: p.personDesc, src: "wikidata" };
  return { text: "", src: "" };
}

// ---------------------------------------------------------------------------
// 3) Map-parity dedup (nearby-places ONLY). [] when NEARBY_PLACES_URL is unset.
// ---------------------------------------------------------------------------
async function mapNear(lat: number, lng: number): Promise<Existing[]> {
  if (!NEARBY_PLACES_URL) return [];
  try {
    const r = await fetch(NEARBY_PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(NEARBY_PLACES_KEY ? { Authorization: "Bearer " + NEARBY_PLACES_KEY } : {}),
      },
      body: JSON.stringify({ lat, lng }),
    });
    if (!r.ok) return [];
    const d = await r.json();
    const places: any[] = Array.isArray(d?.places) ? d.places : Array.isArray(d) ? d : [];
    return places
      .filter((p) => typeof p?.lat === "number" && typeof p?.lng === "number")
      .map((p) => ({ name: String(p.name ?? ""), lat: p.lat, lng: p.lng, category: p.category, source: p.source }))
      .filter((p) => p.name && haversineM(lat, lng, p.lat, p.lng) <= MATCH_RADIUS_M);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 3b) Submissions-aware skip (#338): read every already-loaded grave key from
//     the DB. PAGED past PostgREST's 1,000-row default cap — there are already
//     >1,600 grave rows, and an unpaged read would silently truncate LOW and
//     re-propose everything past the cap (the exact double-insert #338 kills, and
//     the REST-cap trap the handoff records). Assumes the secrets are present
//     (the caller checks). Throws on any HTTP/parse failure so the caller can
//     fail-closed on --commit.
// ---------------------------------------------------------------------------
async function fetchLoadedKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  const PAGE = 1000;
  let offset = 0;
  let read = 0;
  for (;;) {
    const url =
      `${SUPABASE_URL}/rest/v1/submissions?source=eq.${encodeURIComponent(SOURCE_TAG)}` +
      `&select=name,lat,lng,status,merged_into&order=id&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`submissions read HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("submissions read: response was not an array");
    for (const r of rows) {
      const lat = Number(r?.lat), lng = Number(r?.lng);
      if (r?.name != null && Number.isFinite(lat) && Number.isFinite(lng)) {
        keys.add(loadedKey(String(r.name), lat, lng));
        // #384: index by core name, keeping whether the row is LIVE (approved and
        // not merged into another row) — the audit only proposes live rows.
        const live = r?.status === "approved" && r?.merged_into == null;
        const core = graveNameCore(String(r.name));
        const arr = LOADED_BY_NAME.get(core) ?? [];
        arr.push({ name: String(r.name), lat, lng, live });
        LOADED_BY_NAME.set(core, arr);
      }
    }
    read += rows.length;
    if (rows.length < PAGE) break;
    offset += PAGE;
    await sleep(150); // gentle between pages
  }
  const liveRows = [...LOADED_BY_NAME.values()].flat().filter((r) => r.live).length;
  console.log(`Submissions-aware skip: ${keys.size} existing '${SOURCE_TAG}' key(s) loaded from the DB (${read} row(s) read, paged; ${liveRows} live, ${read - liveRows} retired/merged; ${LOADED_BY_NAME.size} distinct core names for the #384 override).`);
  return keys;
}

// ---------------------------------------------------------------------------
// 4) The submissions row shape (grave_meta dropped on --commit — no column).
// ---------------------------------------------------------------------------
type GraveRow = {
  name: string;
  description: string;      // person's Wikipedia intro, or ""
  category: "history";      // History & Lore (#310, by decision)
  lat: number;
  lng: number;
  city: string;
  status: "approved";
  submitted_by: null;
  source: string;
  grave_meta: Record<string, unknown>;
};

async function commitToSupabase(rows: GraveRow[]): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "\n--commit ABORTED: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY not set. " +
        "Set both (Codespaces secrets) and re-run, or load graves_records.json manually. Nothing was written.",
    );
    Deno.exit(1);
  }
  if (!rows.length) {
    console.log("\n--commit: 0 new rows to insert, nothing to do.");
    return;
  }
  const payload = rows.map((r) => ({
    name: r.name,
    description: r.description ? r.description : null,
    category: r.category,
    lat: r.lat,
    lng: r.lng,
    city: r.city,
    status: r.status,
    submitted_by: r.submitted_by,
    source: r.source,
  }));
  const endpoint = SUPABASE_URL + "/rest/v1/submissions";
  const CHUNK = 200;
  let inserted = 0;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const batch = payload.slice(i, i + CHUNK);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`\n--commit FAILED on rows ${i}-${i + batch.length - 1}: HTTP ${res.status} ${body.slice(0, 300)}`);
      console.error(`Inserted ${inserted} row(s) before the failure. graves_records.json is unchanged; do NOT blindly re-run --commit (it double-inserts). Inspect, then re-run over the un-inserted rows.`);
      Deno.exit(1);
    }
    inserted += batch.length;
    console.log(`  committed ${inserted}/${payload.length}…`);
  }
  // Per-city counts — one city (single-metro run) or many (--all).
  const byCity = new Map<string, number>();
  for (const r of rows) byCity.set(r.city, (byCity.get(r.city) ?? 0) + 1);
  const cities = [...byCity.keys()];
  console.log(`\n--commit: INSERTED ${inserted} row(s) into submissions (source='${SOURCE_TAG}', status='approved') across ${cities.length} cit${cities.length === 1 ? "y" : "ies"}.`);
  console.log("Verify (REST), per city — each count should match:");
  for (const [city, n] of byCity) {
    console.log(`  ${city}: submissions?source=eq.${SOURCE_TAG}&city=eq.${encodeURIComponent(city)}&select=count (Prefer:count=exact) — should equal ${n}.`);
  }
  console.log(`Verify (REST), whole run: submissions?source=eq.${SOURCE_TAG}&select=count (Prefer:count=exact) — should increase by ${inserted}.`);
  if (cities.length === 1) {
    console.log(`Back-out: delete from submissions where source='${SOURCE_TAG}' and city='${cities[0]}' and created_at > now() - interval '2 hours';`);
  } else {
    console.log(`Back-out (whole run, time-scoped — removes exactly this run): delete from submissions where source='${SOURCE_TAG}' and created_at > now() - interval '2 hours';`);
    console.log(`Back-out (one city): delete from submissions where source='${SOURCE_TAG}' and city='<City>' and created_at > now() - interval '2 hours';`);
  }
}

// ---------------------------------------------------------------------------
// runMetro() — the per-metro pipeline: query → group by coordinate → emit the
// top N graves per coordinate (most famous first, description required, ranks
// 2..N on the anti-stack ring — #372) → report every verdict. Pure compute:
// writes no files, commits nothing. `seenQids` is shared
// across metros in --all mode so a grave inside two overlapping bboxes is
// planted ONCE (by the first metro to reach it).
// ---------------------------------------------------------------------------
type MetroResult = { rows: GraveRow[]; report: any[]; coveredPeople: number };

async function runMetro(metro: Metro, seenQids: Set<string>, loadedKeys: Set<string>): Promise<MetroResult> {
  console.log(`\n=== ${metro.name} (${metro.lat}, ${metro.lng}), bbox ±${GRAVE_METRO_KM} km ===`);

  const { people, collapsed, rejected } = await wikidataPeople(metro, loadedKeys);
  console.log(`Distinct notable people (with a Wikipedia article) and a CEMETERY burial coordinate: ${people.length}${rejected.length ? ` (+${rejected.length} rejected — burial place not a cemetery, #342)` : ""}.`);

  const report: any[] = [];

  // #342: record every person rejected because their P119 burial place is not a
  // cemetery, flagging whether an ALREADY-LOADED pin sits there (→ the retire
  // audit below). Recorded even when nothing else is emitted, so the audit still
  // runs for a metro whose only findings are misplaced graves.
  for (const rj of rejected) {
    const candName = NAME_PREFIX ? `${NAME_PREFIX} ${rj.person}` : rj.person;
    // #384: only a LIVE row sitting at the rejected (Wikidata) coordinate is a
    // misplaced pin to propose. A retired row there is already dispositioned; a
    // row of this name somewhere else was hand-moved (#383) and is trusted.
    const nm = nearestLoadedByName(candName, rj.lat, rj.lng);
    let alreadyLoaded = false;
    let disposition: string | undefined;
    if (nm && nm.distM <= MATCH_RADIUS_M) {
      if (nm.row.live) alreadyLoaded = true;
      else disposition = "already-retired";
    } else if (nm) {
      disposition = "hand-moved";
    }
    report.push({
      qid: rj.qid, person: rj.person, lat: rj.lat, lng: rj.lng, burial: rj.burialLabel, burialQid: rj.burialQid,
      alreadyLoaded, outcome: "non-cemetery-burial",
      // The loaded row's OWN name + coordinate ride along whenever one matched —
      // for a live stray too, because a #372 ring pin sits ~50 m off Wikidata's
      // point, and a retire keyed on Wikidata's coordinate would update 0 rows.
      ...(nm ? { loadedName: nm.row.name, loadedLat: nm.row.lat, loadedLng: nm.row.lng, loadedDistM: Math.round(nm.distM), loadedLive: nm.row.live } : {}),
      ...(disposition ? { disposition } : {}),
    });
  }

  if (!people.length) {
    console.log("No emittable graves here (after the #342 cemetery gate). If this metro has famous graves, the geo-box query is the first suspect (see header note).");
    return { rows: [], report, coveredPeople: 0 };
  }

  // #378: record every person who carried MULTIPLE P119 coordinates and which
  // one we kept, so the eyeball can confirm the kept coordinate is the cemetery
  // (not the stray reinterment plot). Pure reporting — the pick already happened
  // in wikidataPeople; each such person now emits exactly ONE grave.
  if (collapsed.length) {
    console.log(`  ⊚ ${collapsed.length} person(s) had 2+ burial coordinates — kept one each (#378): ${collapsed.map((c) => c.person).join(", ")}`);
    for (const c of collapsed) {
      report.push({
        qid: c.qid,
        person: c.person,
        lat: c.kept.lat,
        lng: c.kept.lng,
        keptBurial: c.kept.burialLabel || "(unnamed)",
        dropped: c.dropped.map((d) => ({ lat: d.lat, lng: d.lng, burial: d.burialLabel || "(unnamed)" })),
        outcome: "multi-p119-collapsed",
      });
    }
  }

  // Group by ROUNDED COORDINATE — the stacking key. One person at a coordinate
  // => a distinct grave; 2+ => a shared cemetery centroid (covered by the
  // cemetery pin, not emitted).
  const byCoord = new Map<string, Person[]>();
  for (const p of people) {
    const key = `${p.lat.toFixed(COORD_DECIMALS)},${p.lng.toFixed(COORD_DECIMALS)}`;
    const arr = byCoord.get(key) ?? [];
    arr.push(p);
    byCoord.set(key, arr);
  }

  const rows: GraveRow[] = [];
  let coveredPeople = 0;

  for (const [, members] of byCoord) {
    const { lat, lng } = members[0];
    const distKm = haversineM(metro.lat, metro.lng, lat, lng) / 1000;
    if (distKm > GRAVE_METRO_KM * 1.5) {
      report.push({ outcome: "out-of-metro", distKm: Math.round(distKm), members: members.map((m) => m.person) });
      continue;
    }

    // TOP-N per coordinate (#372) — the most famous N here (by sitelinks). A
    // distinct-plot grave is a size-1 cluster and still emits exactly one. A
    // shared cemetery centroid (a polygon-only cemetery's dot) emits its top N
    // instead of top-1: rank 0 dead-centre (idempotent with the already-loaded
    // top-1), ranks 1..N-1 on the deterministic anti-stack ring.
    const sorted = [...members].sort((a, b) => b.sitelinks - a.sitelinks);
    const shared = members.length >= 2;
    const picks = sorted.slice(0, TOP_N);
    const covered = sorted.slice(picks.length); // beyond top-N → covered by the cemetery

    // Anyone beyond the top-N is covered by the cemetery pin — recorded once, so
    // the report shows who they are (at TOP_N=1 this is the pre-#372 behaviour:
    // covered = members.length - 1). Reported here, before the per-pick network,
    // so it can't be skewed by a later drop.
    if (covered.length) {
      coveredPeople += covered.length;
      report.push({
        outcome: "covered-by-cemetery",
        cemetery: sorted[0].burialLabel || "(unnamed burial place)",
        lat, lng,
        count: members.length,
        emittedTop: picks.map((m) => m.person),
        alsoHere: covered.slice(0, MAX_NAMES).map((m) => `${m.person} (${m.sitelinks})`),
      });
    }

    for (let rank = 0; rank < picks.length; rank++) {
      const p = picks[rank];
      const candName = NAME_PREFIX ? `${NAME_PREFIX} ${p.person}` : p.person;
      // rank 0 stays on the true cemetery coordinate; ranks 1..N-1 ring around it.
      const at = stackOffset(lat, lng, rank);

      // CROSS-METRO DEDUP (--all): a grave another metro already emitted is
      // skipped here — short-circuited BEFORE the network (mapNear + Wikipedia
      // intro), so an overlap costs nothing and can't double-count. In single-
      // metro mode seenQids starts empty, so this never fires. Keyed by QID, so
      // the same person can never emit twice even across two cemeteries' rings.
      if (seenQids.has(p.qid)) {
        report.push({ qid: p.qid, person: p.person, lat: at.lat, lng: at.lng, outcome: "cross-metro-dup" });
        console.log(`  ~ ${p.person} — already emitted for an earlier metro (skipped)`);
        continue;
      }

      // SUBMISSIONS-AWARE SKIP (#338): this grave is already loaded in the DB —
      // skip it, so a re-run stops re-proposing an already-loaded grave (no more
      // hand-commenting the roster). Keyed on candName + the pin's ACTUAL
      // coordinate (rank 0 = centroid, ranks 1..N-1 = the deterministic ring
      // point), and the offset is a pure function of rank, so a re-run reproduces
      // the exact key and this stays idempotent for every rank — not just top-1.
      // loadedKeys is empty when the skip is off (no secrets on a dry run, or
      // GRAVE_SKIP_LOADED=0), so this never fires then — matching pre-#338.
      if (loadedKeys.has(loadedKey(candName, at.lat, at.lng))) {
        report.push({ qid: p.qid, person: p.person, lat: at.lat, lng: at.lng, outcome: "already-loaded" });
        console.log(`  ⤿ ${p.person} — already loaded in submissions (skipped)`);
        seenQids.add(p.qid);
        continue;
      }
      // #384: the same person loaded under a relabelled name (#379 life-dates) or
      // at a hand-corrected coordinate (#383) — never re-plant them.
      const byName = nearestLoadedByName(candName, at.lat, at.lng);
      if (byName) {
        const near = byName.distM <= MATCH_RADIUS_M;
        report.push({
          qid: p.qid, person: p.person, lat: at.lat, lng: at.lng,
          outcome: near ? "already-loaded" : "loaded-elsewhere",
          loadedName: byName.row.name, loadedLat: byName.row.lat, loadedLng: byName.row.lng,
          loadedDistM: Math.round(byName.distM), loadedLive: byName.row.live,
        });
        console.log(near
          ? `  ⤿ ${p.person} — already loaded as "${byName.row.name}" (skipped)`
          : `  ↷ ${p.person} — already loaded as "${byName.row.name}" ${(byName.distM / 1000).toFixed(1)} km away (hand-placed or a namesake; not re-planted — check graves_report.json)`);
        seenQids.add(p.qid);
        continue;
      }

      // Map dedup: an already-mapped grave (an OSM historic=tomb, e.g. Ernie
      // Banks — or a partially-noded cemetery like Arlington where THIS person's
      // plot IS a node #372/#373) is skipped so we don't duplicate it. Checked at
      // the pin's ring point, so a synthesized ring pin near a real plot node
      // dedups. (A real plot >MATCH_RADIUS_M from the ring point can still double
      // — the accepted centroid-seed-vs-real-plot residual, cleared by the client
      // dedup / #139; see header.)
      const near = await mapNear(at.lat, at.lng);
      const dup = near.find((e) => titleMatch(p.person, e.name) >= 0.5);
      if (dup) {
        report.push({ qid: p.qid, person: p.person, lat: at.lat, lng: at.lng, outcome: "already-present", matched: dup.name });
        console.log(`  = ${p.person} — already on the map as "${dup.name}"`);
        continue;
      }

      // REQUIRE A DESCRIPTION — Wikipedia intro, else the Wikidata line. Drop if
      // neither resolves (never ship a blank pin). Identity is p.qid → p.articleTitle
      // (#163), so this resolves the RIGHT person even for a famous-parent/child
      // name (the #372 disambiguation facet the by-name prime couldn't beat).
      const { text: desc, src } = await resolveDescription(p);
      if (!desc) {
        report.push({ qid: p.qid, person: p.person, lat: at.lat, lng: at.lng, outcome: "no-description" });
        console.log(`  ✗ ${p.person} — no description (dropped)`);
        await sleep(300);
        continue;
      }

      rows.push({
        name: candName,
        description: desc,
        category: "history",
        lat: at.lat,
        lng: at.lng,
        city: metro.name,
        status: "approved",
        submitted_by: null,
        source: SOURCE_TAG,
        grave_meta: { kind: "grave", qid: p.qid, person: p.person, burialLabel: p.burialLabel, articleTitle: p.articleTitle, descSrc: src, cemeteryPin: shared, cemeteryRank: shared ? rank : undefined, topOfCemetery: shared && rank === 0 },
      });
      seenQids.add(p.qid); // claim this grave so no later metro re-emits it
      report.push({ qid: p.qid, person: p.person, lat: at.lat, lng: at.lng, sitelinks: p.sitelinks, descSrc: src, sharedCoord: shared, cemetery: shared ? p.burialLabel : undefined, cemeteryRank: shared ? rank : undefined, outcome: "grave" });
      const glyph = shared ? (rank === 0 ? "★" : "☆") : "+";
      console.log(`  ${glyph} ${candName} [${src}]${shared ? ` — #${rank + 1} of ${members.length} at ${p.burialLabel || "cemetery"}` : ""}`);
      await sleep(300);
    }
  }

  const emitted = rows.length;
  const distinct = rows.filter((r) => !(r.grave_meta as any).cemeteryPin).length;
  console.log(`  ${metro.name}: ${emitted} grave pin(s) (${distinct} distinct-plot + ${emitted - distinct} cemetery top-N), ${coveredPeople} more covered by cemeteries.`);
  return { rows, report, coveredPeople };
}

// A short summary line printed after a batch of rows.
function summarize(rows: GraveRow[], coveredPeople: number) {
  const distinct = rows.filter((r) => !(r.grave_meta as any).cemeteryPin).length;
  const cemeteryPins = rows.length - distinct;
  const wikiDesc = rows.filter((r) => (r.grave_meta as any).descSrc === "wiki").length;
  console.log(`GRAVE PINS emitted: ${rows.length} (${distinct} distinct-plot + ${cemeteryPins} cemetery top-N [TOP_N=${TOP_N}, ring ${STACK_OFFSET_M} m]). Descriptions: ${wikiDesc} Wikipedia intro, ${rows.length - wikiDesc} Wikidata line.`);
  console.log(`COVERED BY CEMETERY (not emitted, beyond the top ${TOP_N} at each): ${coveredPeople} more notable people — see graves_report.json (outcome:"covered-by-cemetery").`);
}

// ---------------------------------------------------------------------------
// #342 RETIRE AUDIT: an ALREADY-LOADED grave whose P119 burial place is not a
// cemetery is a MISPLACED live pin (the old ungated tool planted it before the
// gate existed). This crawl now surfaces those: collect the report entries that
// are both non-cemetery-burial AND alreadyLoaded, write graves_audit.json, and
// print a PROPOSED soft-retire for each. Propose-not-dispose — nothing is
// written to the DB. A scattered-ashes site may deserve a RELABEL, not a delete
// (the #109 don't-remove-a-live-pin-blindly rule + #342's own "reconsider the
// 'Grave of' wording" note), so each is dispositioned by hand.
// ---------------------------------------------------------------------------
function collectStrays(entries: any[]): any[] {
  return entries.filter((e) => e && e.outcome === "non-cemetery-burial" && e.alreadyLoaded);
}
function sqlStr(s: string): string {
  return "'" + String(s).replace(/'/g, "''") + "'";
}
async function writeRetireAudit(strays: any[], entries: any[] = []): Promise<void> {
  // #384: what the audit deliberately did NOT propose, so the eyeball sees it.
  const handMoved = entries.filter((e) => e && e.outcome === "non-cemetery-burial" && e.disposition === "hand-moved");
  const retired = entries.filter((e) => e && e.outcome === "non-cemetery-burial" && e.disposition === "already-retired");
  const elsewhere = entries.filter((e) => e && e.outcome === "loaded-elsewhere");
  if (handMoved.length || elsewhere.length) {
    console.log(`\n#384 HAND-PLACED GRAVES (trusted over Wikidata — not proposed, not re-planted): ${handMoved.length + elsewhere.length}.`);
    for (const e of [...handMoved, ...elsewhere]) {
      console.log(`  ↷ "${e.loadedName}" at (${e.loadedLat}, ${e.loadedLng}) — Wikidata puts ${e.person} ${(e.loadedDistM / 1000).toFixed(1)} km away${e.burial ? ` at "${e.burial}"` : ""}${e.loadedLive ? "" : " [row not live]"}`);
    }
    console.log("  (Confirm each is a deliberate hand placement. One you don't recognise is a namesake or a wrong move — check graves_report.json.)");
  }
  if (retired.length) {
    console.log(`#384: ${retired.length} rejected grave(s) are already RETIRED in submissions — already dispositioned, not proposed: ${retired.map((e) => e.person).join(", ")}.`);
  }
  // Always write the file, so a stale graves_audit.json from an older run can't
  // be mistaken for this run's result.
  await Deno.writeTextFile("graves_audit.json", JSON.stringify(strays, null, 2));
  if (!strays.length) {
    console.log("\n#342 grave-place audit: 0 LIVE misplaced graves — nothing to retire. Wrote an empty graves_audit.json.");
    return;
  }
  console.log(`\n⚠ #342 GRAVE-PLACE AUDIT — ${strays.length} LIVE grave(s) whose P119 burial place is NOT a cemetery (misplaced). Wrote graves_audit.json.`);
  console.log("These are LIVE pins. Nothing was written — disposition each BY HAND (a scattered-ashes site may want a RELABEL, not a delete):");
  for (const s of strays) {
    // #384: key the proposed retire on the LOADED row (its own name and
    // coordinate), not on Wikidata's point — a #372 ring pin sits ~50 m away.
    const nm = s.loadedName ?? (NAME_PREFIX ? `${NAME_PREFIX} ${s.person}` : s.person);
    const lat = Number(s.loadedLat ?? s.lat).toFixed(COORD_DECIMALS);
    const lng = Number(s.loadedLng ?? s.lng).toFixed(COORD_DECIMALS);
    const ring = s.loadedDistM ? ` — a ring pin ${s.loadedDistM} m off Wikidata's point` : "";
    console.log(`  • "${nm}" on "${s.burial}"${s.burialQid ? ` [${s.burialQid}]` : ""} (${s.loadedLat ?? s.lat}, ${s.loadedLng ?? s.lng})${ring}`);
    console.log(`      retire (reversible): update submissions set status='rejected' where source='${SOURCE_TAG}' and name=${sqlStr(nm)} and round(lat::numeric,${COORD_DECIMALS})=${lat} and round(lng::numeric,${COORD_DECIMALS})=${lng};`);
  }
  console.log("  (#406: a stray that IS a real burial on an estate's grounds → add its [Q…] to GRAVE_KEEP_BURIAL_QIDS and re-run, rather than retire it.)");
  console.log("  (use DELETE instead of the status flip for a hard removal, or fix the coordinate / relabel where the person is genuinely memorialised there.)");
}

// ---------------------------------------------------------------------------
// --from-records (#338): load the rows already in graves_records.json WITHOUT a
// re-crawl. The submissions-aware skip still runs over the file, so a resume
// after a partial/interrupted --commit inserts only the rows not already loaded
// (safe against the double-insert a blind re-commit would cause). Writes to the
// DB only with --commit; otherwise it validates and reports.
// ---------------------------------------------------------------------------
async function runFromRecords(loadedKeys: Set<string>, skipActive: boolean, commit: boolean): Promise<void> {
  let raw: string;
  try {
    raw = await Deno.readTextFile("graves_records.json");
  } catch (e) {
    console.error(`\n--from-records: cannot read graves_records.json (${e}). Run a crawl first, or put the file in this directory. Nothing was written.`);
    Deno.exit(1);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`\n--from-records: graves_records.json is not valid JSON (${e}). Nothing was written.`);
    Deno.exit(1);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error("\n--from-records: graves_records.json is empty or not an array. Nothing was written.");
    Deno.exit(1);
  }

  // Validate/coerce each row to the committed shape. The file is always a flat
  // GraveRow[] (both single and --all write a flat array); require the fields the
  // commit actually sends.
  const fileRows: GraveRow[] = [];
  let malformed = 0;
  for (const r of parsed) {
    const lat = Number(r?.lat), lng = Number(r?.lng);
    if (r && typeof r.name === "string" && Number.isFinite(lat) && Number.isFinite(lng) && typeof r.city === "string") {
      fileRows.push({
        name: r.name,
        description: typeof r.description === "string" ? r.description : "",
        category: "history",
        lat, lng,
        city: r.city,
        status: "approved",
        submitted_by: null,
        source: (typeof r.source === "string" && r.source) ? r.source : SOURCE_TAG,
        grave_meta: (r.grave_meta && typeof r.grave_meta === "object") ? r.grave_meta : {},
      });
    } else {
      malformed++;
    }
  }
  if (malformed) console.log(`--from-records: ${malformed} malformed row(s) skipped (missing name/lat/lng/city).`);
  if (!fileRows.length) {
    console.error("\n--from-records: no valid rows after validation. Nothing was written.");
    Deno.exit(1);
  }

  const before = fileRows.length;
  // #384: also skip a record whose core name is already loaded anywhere (a
  // relabelled or hand-moved grave), so an old records file can't re-insert it.
  let byNameSkipped = 0;
  const fresh = skipActive
    ? fileRows.filter((r) => {
      if (loadedKeys.has(loadedKey(r.name, r.lat, r.lng))) return false;
      const nm = nearestLoadedByName(r.name, r.lat, r.lng);
      if (nm) {
        byNameSkipped++;
        console.log(`  ↷ "${r.name}" — already loaded as "${nm.row.name}" ${Math.round(nm.distM)} m away (skipped, #384)`);
        return false;
      }
      return true;
    })
    : fileRows;
  const already = before - fresh.length;
  console.log(`\n--from-records: ${before} row(s) in graves_records.json — ${already} already in submissions (skipped${byNameSkipped ? `, ${byNameSkipped} of them by name at another coordinate or under a relabelled name, #384` : ""}), ${fresh.length} to insert.`);
  if (!skipActive) {
    console.log("  (submissions-aware skip was OFF for this run, so NO rows were filtered — see the skip status above; a --commit here trusts the file not to overlap the DB.)");
  }

  if (commit) {
    console.log("\n--from-records --commit: inserting the un-loaded rows now (no crawl).");
    await commitToSupabase(fresh);
  } else {
    console.log("\nNOTHING was written (no --commit). Re-run with --from-records --commit to insert the rows above.");
  }
}

// ---------------------------------------------------------------------------
// run() — dispatch to a single metro (env-driven, default Chicago) or the whole
// launch roster (--all), or --from-records (load the existing file, no crawl).
// A crawl writes graves_records.json + graves_report.json and then --commit (if
// passed) inserts the accumulated rows.
// ---------------------------------------------------------------------------
async function run() {
  const COMMIT = Deno.args.includes("--commit");
  const FROM_RECORDS = Deno.args.includes("--from-records");
  console.log(BUILD);
  console.log(`Mode: ${FROM_RECORDS ? "FROM RECORDS (no crawl)" : ALL_METROS ? `ALL METROS (${METROS.length} launch cities)` : `single metro — ${ENV_METRO.name}`}. Source tag: ${SOURCE_TAG}.`);
  console.log(`Require-wiki: ON. Grave-place gate (#342): ${REQUIRE_CEMETERY ? "ON — burial place must be a cemetery" : "OFF (GRAVE_REQUIRE_CEMETERY=0)"}. Top ${TOP_N} per cemetery coordinate (most famous first; ranks 2..N on the ${STACK_OFFSET_M} m anti-stack ring; require a description). Dedup: ${NEARBY_PLACES_URL ? "nearby-places" : "OFF"}.${ALL_METROS && !FROM_RECORDS ? " Cross-metro QID dedup: ON." : ""}`);

  // Build the already-loaded key set for the submissions-aware skip (#338).
  // FAIL-CLOSED on --commit: if the DB can't be read we do NOT write, because a
  // --commit without the skip could double-insert. On a dry run the skip is best-
  // effort — a failed/absent read just proposes everything (writes nothing, safe).
  let loadedKeys = new Set<string>();
  let skipActive = false;
  if (!SKIP_LOADED) {
    console.log("Submissions-aware skip DISABLED (GRAVE_SKIP_LOADED=0): every candidate is proposed; --commit CAN double-insert an already-loaded metro.");
  } else if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const msg = "Submissions-aware skip OFF: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set, so already-loaded graves can't be read.";
    if (COMMIT) {
      console.error(`\n${msg} Refusing to --commit without the skip (it could double-insert). Set both secrets and re-run. Nothing was written.`);
      Deno.exit(1);
    }
    console.log(msg + " (dry run — proceeding, nothing will be written.)");
  } else {
    try {
      loadedKeys = await fetchLoadedKeys();
      skipActive = true;
    } catch (e) {
      const msg = `Submissions-aware skip FAILED to read the DB: ${e}.`;
      if (COMMIT) {
        console.error(`\n${msg} Refusing to --commit blind (it could double-insert). Nothing was written.`);
        Deno.exit(1);
      }
      console.log(msg + " (dry run — proceeding WITHOUT the skip, nothing will be written.)");
    }
  }

  if (FROM_RECORDS) {
    await runFromRecords(loadedKeys, skipActive, COMMIT);
    return;
  }

  const seenQids = new Set<string>();

  if (ALL_METROS) {
    const allRows: GraveRow[] = [];
    const reportBlocks: any[] = [];
    let coveredTotal = 0;
    for (let i = 0; i < METROS.length; i++) {
      const metro = METROS[i];
      const { rows, report, coveredPeople } = await runMetro(metro, seenQids, loadedKeys);
      allRows.push(...rows);
      coveredTotal += coveredPeople;
      const counts = report.reduce((m: any, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {});
      reportBlocks.push({ metro: metro.name, lat: metro.lat, lng: metro.lng, emitted: rows.length, counts, entries: report });
      if (i < METROS.length - 1) await sleep(1500); // brief breather between metros (Wikipedia throttle)
    }

    await Deno.writeTextFile("graves_records.json", JSON.stringify(allRows, null, 2));
    await Deno.writeTextFile("graves_report.json", JSON.stringify(reportBlocks, null, 2));

    const crossDup = reportBlocks.reduce((n: number, b: any) => n + (b.counts["cross-metro-dup"] ?? 0), 0);
    const multiP119 = reportBlocks.reduce((n: number, b: any) => n + (b.counts["multi-p119-collapsed"] ?? 0), 0);
    console.log("\n=== ALL-METROS SUMMARY ===");
    for (const b of reportBlocks) console.log(`  ${b.metro}: ${b.emitted}`);
    summarize(allRows, coveredTotal);
    await writeRetireAudit(collectStrays(reportBlocks.flatMap((b: any) => b.entries)), reportBlocks.flatMap((b: any) => b.entries));
    console.log(`CROSS-METRO DUPLICATES skipped (a grave shared by two bboxes, planted once): ${crossDup}.`);
    console.log(`MULTI-P119 people collapsed (2+ burial coordinates → one grave kept, #378): ${multiP119} — see graves_report.json (outcome:"multi-p119-collapsed").`);
    console.log("wrote graves_records.json (all metros, load into submissions) and graves_report.json (per-metro blocks, every verdict).");

    if (COMMIT) {
      console.log("\n--commit passed: writing every metro's new grave rows to submissions now.");
      await commitToSupabase(allRows);
    } else {
      console.log("\nNOTHING was written to the database. Review graves_report.json, then re-run with --all --commit to insert (or load graves_records.json manually).");
    }
    return;
  }

  // Single metro (unchanged behaviour; flat-array file shapes).
  const { rows, report, coveredPeople } = await runMetro(ENV_METRO, seenQids, loadedKeys);
  await Deno.writeTextFile("graves_records.json", JSON.stringify(rows, null, 2));
  await Deno.writeTextFile("graves_report.json", JSON.stringify(report, null, 2));

  const counts = report.reduce((m: any, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {});
  console.log("\n--- summary ---");
  console.log(counts);
  summarize(rows, coveredPeople);
  await writeRetireAudit(collectStrays(report), report);
  console.log("wrote graves_records.json (load into submissions) and graves_report.json (every verdict).");

  if (COMMIT) {
    console.log("\n--commit passed: writing the new grave rows to submissions now.");
    await commitToSupabase(rows);
  } else {
    console.log("\nNOTHING was written to the database. Review graves_report.json, then re-run with --commit to insert (or load graves_records.json manually).");
  }
}

run();
