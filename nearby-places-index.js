import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// --- tuning (kept identical to the client so cache keys + output line up) ---
const REAL_TILE_DEG = 0.05;                 // ~5.5km tiles
const OVERPASS_RADIUS_M = 4200;             // query radius sent to Overpass
const OVERPASS_TIMEOUT_MS = 25000;          // cold Overpass queries can be slow
const WIKI_TIMEOUT_MS = 12000;
const PLACES_CACHE_TTL_MS = 21 * 24 * 3600 * 1000; // 21 days
// #399 — a tile whose Overpass answer was a clean 200 with ZERO OSM places (open
// water, lake, bay, shoreline) is cached too, but on a SHORT TTL, so a truncated
// empty answer for a real land tile can only stick for this long before SWR
// re-checks it. See rowIsServable / rowTtlMs / isHealthyEmptyOsm.
const EMPTY_OSM_TTL_MS = 3 * 24 * 3600 * 1000; // 3 days
const EMPTY_TILE_VERSION = "399-empty-tile-cache-v1"; // #399 deploy-confirm stamp, echoed on every tile response
// Bump this whenever the shape/filtering of cached places changes. It's part of
// the cache key, so old rows (e.g. ones written before the chain filter existed
// and still full of Chipotle/McDonald's) are ignored instead of served for the
// remaining 21 days. v2 = first build with EXCLUDE_CHAINS.
// v3 = #36 trail rework (signal-gated trail query + trailhead pinning).
// v7 = per-category element budgets (ways were being starved).
// v8 = #96 Wikipedia relevance filter. THIS BUMP IS LOAD-BEARING: without it,
//      every tile already cached keeps serving its city/high-school pins for the
//      remaining 21 days of its TTL and the fix looks like it did nothing.
// v9 = #96b. v8 shipped and STILL LEAKED, so any v8 row written in between is
//      as dirty as a v7 one and has to be orphaned on exactly the same grounds.
// v10 = #104 closure filter + osmTs. LOAD-BEARING for the same reason v8 was:
//      the Chicago tile that produced the "Beyond the Wall" screenshot is
//      already cached with that pin in it, and without this bump the fix would
//      have been invisible in the one place it was reported from. Note the
//      blocklist (below) is applied at SERVE time precisely so it does NOT
//      depend on this — a bump only orphans rows, it cannot un-cache a pin you
//      discover tomorrow.
// v11 = #105 transit filter. LOAD-BEARING for the third time in this list:
//      the same Chicago tile is now cached under v10 WITH the CTA stations in
//      it, so without this bump the transit fix is invisible exactly where it
//      was reported. This is the v8 lesson arriving a third time.
// v12 = #77 full Wikipedia intro. The rendered `desc` shape changed (the
//      `exsentences=2` query cap and the 220-char slice below were both
//      removed), so every tile cached under v11 still holds the SHORT two-
//      sentence descriptions. Without this bump the longer text lands nowhere
//      for 21 days and the fix reads as doing nothing — the v8 lesson a fourth
//      time. This is the ONLY deploy trap on #77: the change is backend-only,
//      but "backend-only" still means index.js AND this constant.
// v13 = #53 + #101, both of which change the rendered `desc` shape and so are
//      baked into every cached tile. #53 gives osmDesc real artwork / museum /
//      memorial / inscription / description branches (a correctly-classified
//      sculpture used to render "A notable local spot." — a name plus a sentence
//      saying nothing). #101 deletes the invented "A notable local landmark."
//      Wikipedia fallback (emit null, render no block). Without this bump, 21
//      days of v12 tiles keep serving the OLD descriptions — the fix reads as
//      doing nothing exactly where it was reported. The v8 lesson a fifth time.
// v14 = #163 Option A: linked OSM history pins are enriched from their OWN
//      `wikipedia=` tag (a grave's or sculpture's editor-asserted article intro
//      replaces osmDesc's "A local landmark (tomb)." / "A sculpture by X." line).
//      The enriched extract is baked into the tile, so every v13 row still holds
//      the thin osmDesc line — without this bump the enrichment lands nowhere for
//      21 days and reads as doing nothing exactly where it was reported. The v8
//      lesson a sixth time. Backend-only, but "backend-only" still means index.js
//      AND this constant (the #77 note).
const CACHE_VERSION = "v34"; // v34: #359 ALT-NAME BRIDGE — a facts pin (history/park/trail/art) whose bare OSM `name` is a nickname that does NOT match its Wikipedia article title and which carries NO `wikipedia=` tag, but DOES carry an `alt_name=` (the documented name), is now bridged to its article DETERMINISTICALLY at tile-build: parseOverpass marks it (rec.altName), and the enrich step resolves the alt name through the SAME coordinate-gated resolveWikiByName (#316 gate + #357 bank) and BAKES the article's intro onto the pin, replacing a THIN line only (descIsThin — "Totem pole" → the Kwanusila article; a rich human `description` per #53 is never downgraded). Reported case: node 589512469 "Kwa-Ma-Rolas" (Lincoln Park) → the "Kwanusila" totem-pole article. The `wikidata=`-Q-id half of the same bridge is Option B (#164) — shipped 2026-09-23 WITHOUT a bump (it only fills THIN lines at build; warm v34 tiles gain it on their next rebuild, and a bump would re-cold every tile). LOAD-BEARING: which description bakes into a tile changes (a bridged pin now serves the article instead of its filler/thin `description`), and that bakes into the 21-day tile cache, so without the bump any v33 tile keeps serving the thin line for 21 days. The #357 resolve bank has its OWN version prefix and is NOT re-rolled by this tile-cache bump (a bridged hit banked under v33 is reused under v34). (v33: #80 (PIVOT / #308) TWO-AXIS SCHEMA, pass 1 (FE-INERT) — every kept OSM record now ALSO carries a place-KIND field `type` (from typeOsm) alongside the UNCHANGED scalar `category`, so a story-gated commercial pin that files under 'history' no longer THROWS AWAY the fact that it is a restaurant/bar/shop. This is the #80 "one place, two categories" EXPRESSION: `category` = the STORY axis (why it earns a map spot — post-pivot, ~always 'history'/park/trail/art), `type` = the KIND axis (what it is). `category` is BYTE-IDENTICAL to v32 — nothing re-buckets, and the front end does NOT read `type` yet, so NO pin appears, disappears, moves, or recolours vs v32 (verify by counts, not eyeball). WHY BUMP IF CATEGORY IS UNCHANGED: the record SHAPE changes (new `type` field) and bakes into the 21-day tile cache; bumping now pre-warms TYPED tiles so the pass-2 FE cutover reads `type` on every tile instead of `undefined` on warm v32 tiles for up to 21 days (the #334/#309 cache-shape rule). `type` ∈ {art, restaurant, bar, shop, park, trail, museum, grave, memorial, historic, attraction}, else null = LORE (a story pin with no distinct place-kind — a plaque, an alley, a site-where-something-happened). SCOPE: OSM records only — Wikipedia-feed pins (no clean OSM kind → null/Lore) and user GEMS (the `submissions.category` two-axis) are a LATER pass, not this one. (v32: #309 (PIVOT / #308) — OSM commercial (amenity bar/pub/biergarten/restaurant/cafe/fast_food and any shop=*) is DROPPED from the map unless it carries a notability LINK (hasNotabilityLink — wiki/wikidata/subject:/inscription), in which case it files under 'history' as a story-bearing place; non-notable commercial now returns null (was: bars/restaurants/shops categories). LOAD-BEARING: which OSM elements categorise — and whether they appear at all — changes and bakes into the 21-day tile cache, so without the bump any v31 tile keeps serving the old commercial dots for 21 days. (v31: #293 follow-up — a crash article titled by DATE/PLACE and opening as a NARRATIVE slipped v30's nets (reported: "1972 Chicago–O'Hare runway collision" — no `is a/was a` copula for WIKI_INSTITUTIONAL_RE, and "runway collision" evaded the v30 title net which only had "mid-air collision"). v31 (a) broadens WIKI_TITLE_AVIATION_RE to runway/ground/taxiway/apron/air/aircraft/aviation collisions, and (b) adds WIKI_AVIATION_OPENER_RE — an opener drop when a flight number and an incident verb co-occur, with a memorial/museum/park keep-guard. LOAD-BEARING: a v30 tile already cached this pin, so without the bump it keeps serving it for 21 days. (v30: #293 airport + aviation-accident drop — near an airport the Wikipedia geosearch (fetchWikipedia) was handing over the AIRPORT article (whose coordinate is the field centroid, i.e. on a runway — the "history on a runway" report) and every AVIATION-ACCIDENT article geotagged at a crash site near the field, both defaulting to 'history'. Two nets, same layering as #96/#105/#13: (1) airport-family + air-disaster nouns folded into WIKI_INSTITUTIONAL_RE (the CONDITIONAL civic/utility class — dropped UNLESS hasHistoricSignal, so an NRHP-listed historic airfield like College Park Airport still shows and only the operating field drops); (2) a new WIKI_TITLE_AVIATION_RE title net for the "<Airline> Flight <N>" accident-article convention (anchored at end-of-title so "Flight 93 National Memorial" and other trailing-word titles are NOT caught), added UNCONDITIONALLY beside the school/settlement/transit title rules. OSM aeroways were never the leak (isTransitStop already returns null for t.aeroway, #105) — this is the Wikipedia feed only. LOAD-BEARING: which wiki articles survive into a cached tile changes, so without the bump any v29 tile keeps serving airport/crash pins for 21 days. (v29: #280 disambiguation drop — isLowValueWikiArticle() now drops a Wikipedia disambiguation page ("<Name> may refer to: …") on the CACHED tile-build paths, not just the per-request resolver. The osm-wiki TITLE enrich (fetchWikiExtractsByTitle) fetches by title regardless of coordinates, so an OSM history pin whose `wikipedia=` tag points at a disambig article used to bake the whole "may refer to" dump into the tile as its description; it now fails isLowValueWikiArticle and the pin keeps its osmDesc line. LOAD-BEARING: which wiki extracts survive into a cached tile changes, so without the bump any v28 tile keeps serving a baked disambig dump for 21 days. Shipped alongside #289 (a TIMING-only overlap of that same extract fetch — needs no bump) and #288 (coordinate-less-namesake rejection on the per-request resolveWikiByName path — never cached, needs no bump). (v28: attraction-way ID-truncation fix — `.histw out center 20` emits ways in ascending-ID order, so in a way-dense downtown tile 20+ low-ID historic-BUILDING ways fill the budget before the high-ID Wooden Alley (way 220301292, above every historic building in tile 838_-1753 which top out ~148M) is reached — it was fetched-in-range and categorised fine yet cut by ID (proven: cached v27 tile had 13 history ways, all id<220301292, no alley). `tourism=attraction` ways are rare (the only one in that whole downtown tile), so they now get a DEDICATED `.hista out center 20` and can't be crowded out by historic-building ways. LOAD-BEARING: which ways survive the fetch changes and bakes into the tile cache, so without the bump any v27 tile keeps dropping the alley for 21 days. (v27: fetch-anchor fix — the Overpass/Wikipedia fetch anchored on the RAW REQUEST point, but a tile is ~5.5km while the fetch radius is 4.2km, so a request that landed near a tile edge left the far corner unfetched: an edge-of-tile pin (Wooden Alley, way 220301292, north edge of tile 838_-1753) fell OUTSIDE the 4.2km circle and never entered the cached tile, no matter the category-budget split (proven: `way[tourism](around:4200, alley-coords)` returned it, but the tile still cached no alley). Now the fetch anchors on the TILE CENTRE (tileCenter()), whose farthest corner is ~3.9km < 4.2km, so the circle covers the whole tile — and the tile is deterministic regardless of which requester filled it first. LOAD-BEARING: which elements the fetch reaches changes and bakes into the tile cache, so without the bump any v26 tile keeps the edge dropout for 21 days. (v26: #224 truncation fix — the `.hist` Overpass set was one `out center 30`, and Overpass emits nodes-first, so a history-dense tile spent all 30 slots on NODES before any WAY, starving tourism/historic ways (Wooden Alley = way 220301292 was fetched by v24 yet cached NO alley in tile 838_-1753). Split into `.histn out center 30` + `.histw out center 20` so ways get a guaranteed budget (same per-category-budget fix parks/trails already use). Carries v25's historic+description gate, so this deploy restores BOTH Wooden Street (node, v25) and Wooden Alley (way, this cap fix). LOAD-BEARING: which elements survive the fetch changes and bakes into the tile cache, so without the bump any v25 tile keeps starving the ways for 21 days. (v25: #13 historic gate — a generic `historic=building`/`historic=yes` element with a real `description` now reaches History even without a wiki link (reported case: node 2871468809 "Wooden Street", `historic=yes` + description, no link — the pin the user actually used to see, dropped by v22's link-only gate). Consistent with v24's attraction gate (both now: link OR description); bare/undescribed generic-historic still drops. LOAD-BEARING: which OSM elements categorise as 'history' changes and bakes into the tile cache, so without the bump any v24 tile keeps dropping this pin for 21 days. (v24: #224 + #13 attraction gate — a `tourism=attraction/museum/artwork` mapped as a WAY/area was NODE-only in the `.hist` Overpass set and never fetched (reported case: Wooden Alley, way 220301292 — `tourism=attraction` on a `highway=service` alley with a real `description` and NO wiki link, so invisible to the whole pipeline). Now `.hist` also fetches `way["tourism"~...]` (out center), AND categorizeOsm keeps a `tourism=attraction` on `hasNotabilityLink(t) || t.description` (not link-only) so a described-but-unlinked landmark like this NRHP alley reaches History with its description as the blurb (#178 passthrough). LOAD-BEARING: which OSM elements are fetched AND which categorise as 'history' both change, and both bake into the tile cache, so without the bump any v23 tile keeps serving the old (missing) pin for 21 days. (v23: #13 (fetchWikipedia opener residual) — the Wikipedia geosearch path defaulted EVERY unclassified article to 'history', so a hospital / radio station / courthouse / power station / water tower with a Wikipedia article reached the map as a History pin (the reported hospital case). New WIKI_INSTITUTIONAL_RE drops that civic/utility class at isLowValueWikiArticle — but CONDITIONALLY: kept when hasHistoricSignal() finds a strong historic marker in the extract (NRHP / National Historic Landmark / historic district / National Historic Site), so a historic radio tower or a landmarked courthouse still shows and only the ordinary ones drop. WIKI_STOP_RE (#96/#105 schools/settlements/transit/bare-station) is UNTOUCHED. LOAD-BEARING: which wiki elements categorise/drop changes and category bakes into the tile cache, so without the bump any v22 tile keeps serving the junk-history pins for 21 days. (v22: #13 (lever b) historic HALF — bare `historic=building` / `historic=yes` (generic old buildings: a courthouse, a school, a warehouse) no longer force-file under 'history'; they reach 'history' ONLY with a notability link (Wikipedia/Wikidata, incl. namespaced subject:, or an inscription), the SAME shared hasNotabilityLink() the attraction half already uses. Specific historic subtypes (memorial, monument, castle, ruins, ...) + museums + memorial= stay UNCONDITIONAL. LOAD-BEARING: which OSM elements categorise as 'history' changes, and category bakes into the tile cache, so without the bump any v21 tile keeps serving the junk-history pins for 21 days. (v21: WATER-PIN FIX — TRAIL_GEOM flipped true so trail WAYS pin to an on-geometry endpoint (on land) instead of the bbox centre, which landed offshore/mid-reservoir for shoreline-hugging and loop trails (Lakefront Trail, Shuman Running Track). LOAD-BEARING: trail-way pin COORDINATES change, and coords bake into the tile cache, so without the bump any v20 tile keeps serving the in-water pin for 21 days. (v20: #13 (lever b) FIX — v19's keep-check used bare wikipedia/wikidata only and dropped attractions whose link is NAMESPACED: a historic house/statue links the PERSON or EVENT it's known for via subject:wikidata / subject:wikipedia (e.g. Al Capone's House → subject:wikidata=Q80048), with no bare tag on the node. Now accepts subject: variants too (still excludes brand:/operator:, which mark chains). LOAD-BEARING: without the bump, any v19 tile that already dropped those pins keeps serving for 21 days. (v19: #13 (lever b) — bare tourism=attraction with no wiki/inscription link dropped from 'history'. v18: #102 — wiki opener classification (park-family → 'park'). v17: #193 — tourism=artwork split into its own 'art' category.))))))))))
const WIKI_UA = Deno.env.get("WIKI_UA") ?? "Nahgoo/1.0 (+https://github.com/ethanmilesbeverly-create/localy; map story resolver)"; // 2026 Wikimedia rate-limit fix: a compliant UA earns the 200 req/min identified bucket vs ~10/min unidentified; applied to every Wikipedia + Wikidata call below (paired with origin=* removal — a browser/CORS param that mis-buckets a server call). Keep a REAL contact in it. Override with WIKI_UA env.

// #365 — GOOGLE PLACES (New) key for the #318 EXTERNAL-SOURCE description rung (fires
// only after the Wikipedia/Wikidata rungs miss; see resolvePlacesByName + the resolveWiki
// action). CONFIG-OUTSIDE-THE-FILE: set GOOGLE_PLACES_KEY in THIS function's Supabase
// secrets (Edge Functions → secrets). No key → the rung returns null → behaviour is
// byte-for-byte what it was before the rung existed. The key is server-side only (never
// shipped to the client); restrict it to Places API (New) and cap its per-day quota.
const GOOGLE_PLACES_KEY = Deno.env.get("GOOGLE_PLACES_KEY") ?? "";

// --- #36: how picky to be about what counts as a trail ---------------------
// true  = only ways carrying a real trail signal (a name on a path, or
//         sac_scale / trail_visibility / mtb:scale on a path or track), plus
//         named hiking/foot/mtb route relations and tagged trailhead nodes.
// false = also accept bare path/track ways, the old permissive behaviour.
//
// This IS the metro-vs-rural trade-off, exposed as one switch: strict gives
// fewer-but-real trails and can render sparse rural areas nearly empty (cuts
// against R11 / #3 coverage); permissive restores volume at the cost of
// pinning parking-lot cut-throughs and logging roads as "trails".
// Flip it and bump CACHE_VERSION, or 21 days of old rows keep serving.
const TRAIL_STRICT = true;

// --- #36 rollback switch ---------------------------------------------------
// ENABLED to fix the water-pin class: with this FALSE, trail ways came back
// via `out center` (bounding-box centre), and a bbox centre lands IN THE WATER
// for any way that hugs a shoreline or loops around water — e.g. Chicago's
// Lakefront Trail pinned offshore in Lake Michigan, and the Stephanie & Fred
// Shuman Running Track pinned dead-centre in the JKO Reservoir (a closed loop
// AROUND the water, so its bbox centre IS water). Both are OSM ways, neither is
// in `submissions`, so there is no coordinate of ours to correct — the fix has
// to be here, at pin-derivation time.
//
// true  = the `.trails` set is emitted with `out geom` (full node list), so
//         trailPinPoint() pins to a real endpoint ON the trail (a trailhead /
//         road-crossing / the loop's own path) instead of the bbox centre.
//         On-geometry == on land for a land feature, which is the whole point.
//
// THE OLD WARNING HERE IS STALE. It described a `.main out center; .trailways
// out geom;` TWO-SET form that #104 replaced: the query is now five per-category
// sets each with its own `out`, and four of them (`.food/.shops/.hist/.parks
// out center N`) already prove that per-set output grammar live every request.
// Flipping this changes exactly one token — `.trails out center 20` becomes
// `.trails out geom 20`, standard Overpass verbosity in a proven structure.
// Still: a malformed query drops the WHOLE OSM response, so the overpass-turbo
// verification the old note demanded is now a QA STEP (paste the generated
// query, confirm it runs and trails carry `geometry`), and rollback is one
// line — flip back to false and bump CACHE_VERSION.
//
// SCOPE: this fixes trail WAYS only. A non-trail way bordering water (a
// `leisure=park` polygon wrapping a lake, still `.parks out center`) can still
// bbox-centre into water; that residue is the separate water-backstop audit
// dimension, not this flag.
const TRAIL_GEOM = true;

// --- #104: ask Overpass how OLD each element is -----------------------------
// `out meta` adds version / timestamp / changeset / user to every element. The
// only field kept is `timestamp`, surfaced as `osmTs` on each place.
//
// IT IS DELIBERATELY NOT USED TO DROP ANYTHING, and that restraint is the whole
// point. "Last edited 2013" is a real staleness signal and a terrible liveness
// test on its own: a huge share of good, open, correctly-mapped POIs have not
// been touched since the import that created them, and dropping on age would
// gut coverage in exactly the thin areas item 9 / item 28 are already about.
// So this pass MEASURES first — the response now carries an age histogram —
// and whoever reads that histogram gets to decide what, if anything, to do
// with it. #3's lesson, applied on purpose: the observability half goes first.
//
// #36's TRAIL_GEOM regression is the reason for the retry below rather than a
// bare switch. An `out` modifier Overpass rejects fails EVERY category, not
// just the new one, because one malformed query drops the whole OSM response —
// so if all mirrors fail with meta on, fetchOverpass retries ONCE with a
// meta-free query before giving up. The cost of the experiment is therefore one
// extra round trip in the failure case, not an app-wide blank map.
const OSM_META = true;
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// --- small helpers (ported verbatim from the client for identical output) ---
function tileKey(lat, lng) {
  return Math.round(lat / REAL_TILE_DEG) + "_" + Math.round(lng / REAL_TILE_DEG);
}
// v27 — the CENTRE of the tile a point falls in. The Overpass/Wikipedia fetch
// anchors here, NOT on the raw request point: a tile is ~5.5km (REAL_TILE_DEG
// 0.05) but the fetch radius is only 4.2km, so anchored on a request that landed
// near a tile EDGE the 4.2km circle does not cover the far corner — an
// edge-of-tile pin (Wooden Alley, way 220301292, near the north edge of tile
// 838_-1753) falls outside the fetch and never enters the cached tile, no matter
// how the category budgets are split. From the centre, the farthest corner is
// √2·(0.05/2)·111km ≈ 3.9km < 4.2km, so the circle covers the WHOLE tile. It also
// makes a tile deterministic — same tile → same fetch → same cached result,
// regardless of which requester filled it first (before, the first request in a
// tile baked in its own off-centre view for the 21-day TTL).
function tileCenter(lat, lng) {
  return {
    lat: Math.round(lat / REAL_TILE_DEG) * REAL_TILE_DEG,
    lng: Math.round(lng / REAL_TILE_DEG) * REAL_TILE_DEG,
  };
}
function normName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function haversine(la1, lo1, la2, lo2) {
  const R = 6371000, toR = (d) => (d * Math.PI) / 180;
  const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 +
    Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}


/* #105 — transit infrastructure is never a Localy pin. Reachable from our own
   query in two ways: a preserved depot tagged `historic`, and a station tagged
   `tourism=attraction`. `tourism=museum` is exempted FIRST and on purpose — a
   railway museum is a museum, which is exactly the kind of place this app is
   for, and it is the one thing a blunt railway check would wrongly take. */
function isTransitStop(t) {
  if (!t) return false;
  if (t.tourism === "museum") return false;
  // A depot mapped only as `historic=railway_station`, with no `railway` tag at
  // all, reaches categorizeOsm through the historic branch. Found by testing,
  // not by reading — the obvious guard misses it.
  if (t.historic === "railway_station" || t.historic === "station") return true;
  if (t.railway) return true;
  if (t.public_transport) return true;
  if (t.highway === "bus_stop" || t.highway === "platform") return true;
  if (t.amenity === "bus_station" || t.amenity === "ferry_terminal" || t.amenity === "taxi") return true;
  if (t.aeroway || t.aerialway === "station") return true;
  return false;
}

// #13 (lever b) / #163 — the notability-link set that lifts a LOOSE OSM tag from
// noise to a story-bearing pin: a Wikipedia/Wikidata link (bare OR the namespaced
// `subject:` form a historic house/statue uses to link the PERSON/EVENT it is
// known for — the v20 finding, e.g. Al Capone's House → subject:wikidata=Q80048),
// or a transcribed plaque (`inscription=`). `brand:`/`operator:` wiki links are
// EXCLUDED on purpose: those mark a CHAIN (isChain keys on exactly them, #39/#18),
// which is the junk this gate drops, not a story. ONE definition, shared by the
// `historic=building/yes` gate and the `tourism=attraction` gate below, so the two
// can never diverge into a #155-style two-copy fact.
function hasNotabilityLink(t) {
  return !!(t.wikipedia || t.wikidata || t["subject:wikipedia"] || t["subject:wikidata"] || t.inscription);
}

// The bare `historic=*` values that mark only "an old building" with no story of
// their own — as opposed to memorial / monument / castle / ruins /
// archaeological_site / battlefield / ..., which are inherently story-bearing.
// ONLY these are gated on a notability link (#13 lever b, historic half). Named
// exactly the two OSM catch-alls this row calls out (a courthouse/school reaches
// the map as `historic=building`); `house` is deliberately NOT gated yet — add it
// here as a one-word change if a real-tile drop-set check shows linkless
// `historic=house` junk surviving.
const LOW_VALUE_HISTORIC = new Set(["building", "yes"]);

function categorizeOsm(t) {
  if (!t) return null;
  if (isTransitStop(t)) return null; // #105

  if (t.tourism === "artwork") return "art"; // #193 — public art split out into its own category (murals, sculptures, statues, installations)
  // History. Museums and memorials/plaques are inherently what this app is for,
  // so they stay UNCONDITIONAL. So do SPECIFIC historic subtypes (monument,
  // castle, ruins, archaeological_site, ...). But the GENERIC catch-alls —
  // `historic=building` / `historic=yes` — pull in ordinary old buildings (a
  // courthouse, a school, a warehouse) with no story, and are the junk #13's
  // historic half drops UNLESS the element carries a notability link (same gate,
  // same shared set as the attraction gate below). A generic-historic element
  // that FAILS the gate falls THROUGH to the category checks below rather than
  // being force-filed under History on the strength of `historic=building` alone
  // — so a restaurant in an old building reads as a restaurant, and a bare old
  // building with nothing else worth showing drops at the final `return null`.
  // #13 (v25) — a `description=` tag ALSO keeps a generic-historic element, not
  // just a notability link, exactly as the attraction gate below now does (kept
  // in sync per #155). Reported case: node 2871468809 "Wooden Street" is
  // `historic=yes` with a real description ("This little alley has still a wood
  // surface...") and NO wiki link, so v22's link-only gate dropped it — the pin
  // the user actually used to see. A hand-written description is the same
  // "someone cared" story signal a link is; a bare/undescribed `historic=yes`
  // (the courthouse/school junk) still drops. #178 renders the description as
  // the blurb.
  if (t.tourism === "museum" || t.memorial) return "history";
  if (t.historic && (!LOW_VALUE_HISTORIC.has(t.historic) || hasNotabilityLink(t) || t.description)) return "history";
  // #309 (PIVOT / #308) — COMMERCIAL IS DROPPED UNLESS IT CARRIES A STORY.
  // The pivot repositions the map away from a Google-Maps-alike toward
  // unique/cultural discovery, so a plain OSM bar/restaurant/shop dot (nobody
  // recommended it — it just exists in a database) is exactly the anti-pitch the
  // pivot removes. A commercial place SURVIVES only if it carries a notability
  // LINK (Wikipedia/Wikidata, incl. namespaced `subject:`, or an `inscription=` —
  // the shared hasNotabilityLink()), in which case it is a STORY-bearing place
  // and files under 'history' (a landmark tavern, a historic diner) — exactly as
  // a historic-tagged notable bar already did at the `t.historic` gate above. A
  // commercial place with no link falls THROUGH to `return null` and drops.
  // WHY THE GATE IS THE LINK ONLY, NOT `|| t.description` (deliberate divergence
  // from the historic/attraction gates, #309 gravestone): on a historic alley a
  // mapper's hand-written `description` is a "someone cared" lore signal, but on a
  // bar/shop a bare `description=` is usually a marketing/self-description line —
  // precisely the cheap-dot noise the pivot removes — so it does NOT keep a
  // commercial pin. ONE-LINE SWAP: add `|| t.description` to the guard below to
  // re-admit described commercial if the rip-out QA (walk one seeded metro) leaves
  // History too thin.
  // GEM PATH UNTOUCHED: a user-SUBMITTED bar/restaurant/shop is a human
  // recommendation (a `barsrest`/`shops` gem via gemToPoint on the client, #308),
  // not an OSM dot — this change is OSM-sourced commercial only. Consequence:
  // osmDesc()'s restaurants/bars/shops branches are now DORMANT for OSM (no OSM
  // place categorises there anymore); left in place (harmless) and revived by the
  // one-line swap above.
  if ((t.amenity === "bar" || t.amenity === "pub" || t.amenity === "biergarten" ||
       t.amenity === "restaurant" || t.amenity === "cafe" || t.amenity === "fast_food" ||
       t.shop) && hasNotabilityLink(t)) return "history";
  if (t.leisure === "park" || t.leisure === "garden" || t.leisure === "nature_reserve" || t.boundary === "national_park") return "park";
  // Trails. `highway=trailhead` is checked first and deliberately: it is the
  // only OSM tag that marks the point you actually START from, which is the
  // one thing this app needs and the thing bbox centres get wrong (#36).
  if (t.highway === "trailhead") return "trail";
  if (t.highway === "path" || t.highway === "footway" || t.highway === "track" ||
      t.route === "hiking" || t.route === "foot" || t.route === "mtb") return "trail";
  // #13 (lever b) — bare `tourism=attraction` used to fall straight into
  // 'history'. It is one of OSM's loosest tags: in a real tile ~2/3 of
  // attraction-ONLY nodes are noise and ~1/3 are genuine landmarks, and the
  // thing that separates them is an article link or a transcribed plaque. A
  // kept attraction needs the SAME notability link the historic gate above uses
  // (bare or namespaced `subject:` wiki/wikidata, or an `inscription=`), via the
  // one shared `hasNotabilityLink()` so the two gates never diverge (#155).
  // A bare attraction with none of these falls through to `return null`.
  // SCOPE: attraction-ONLY nodes — one also tagged historic/memorial/museum
  // already returned 'history' above, artwork already went to 'art'. The
  // Wikipedia feed (`fetchWikipedia`) is a SEPARATE source, unaffected here.
  // #13 (v24) — a `description=` tag now ALSO keeps an attraction, not just a
  // wiki/wikidata/inscription link. Reported case: Wooden Alley (way 220301292)
  // is `tourism=attraction` + `surface=wood` + a real `description` ("Preserved
  // wooden street from the early 20th century...") and NO wiki link, so the
  // link-only gate dropped an NRHP-listed landmark. A mapper who wrote a real
  // description is doing the manual equivalent of adding a link — a "someone
  // cared" keep signal — and #178's passthrough renders that description as the
  // pin blurb, so the kept pin reads well rather than "A notable local spot".
  // ACCEPTED TRADE (gravestone): this loosens v19/v20's link-only gate and
  // re-admits any DESCRIBED attraction into History (occasionally a mediocre
  // one with a marketing blurb); bounded, and no worse for category-correctness
  // than the link path already is (a wiki-linked modern viewpoint files as
  // history today too). Bare/undescribed attractions still drop.
  if (t.tourism === "attraction" && (hasNotabilityLink(t) || t.description)) return "history";
  return null;
}
// --- #80 (PIVOT / #308): the KIND axis ---------------------------------------
// typeOsm() is categorizeOsm() with the story-gate short-circuits turned OFF: it
// answers "what KIND of place is this?" from the tags alone, independent of
// whether the element earned a map spot (that is `category`'s job). The two axes
// are the whole of #80 — a historic restaurant is `category:'history'` (the story
// that admits it) AND `type:'restaurant'` (what it is), and today the collapse to
// 'history' at categorizeOsm THREW AWAY the second fact. Only ever called on a
// record that already passed categorizeOsm (parseOverpass returns early on a null
// category), so this need not re-derive the drop decision — only the kind.
//
// DELIBERATE ORDERING (mirrors categorizeOsm's priority so the two never imply
// contradictory things): artwork → the specific historic KINDS (tomb=grave,
// museum, memorial/monument) → the COMMERCIAL kinds, returned UNCONDITIONALLY
// here (no hasNotabilityLink gate — a pin only reaches typeOsm because it already
// cleared the story gate in categorizeOsm, so re-checking the link would just
// re-collapse it and defeat the point) → park → trail → other specific historic
// subtypes (castle/ruins/…) as a generic 'historic' → a passed attraction. A
// generic `historic=building`/`historic=yes` that passed on a link-or-description
// has NO distinct place-kind, so it returns null → LORE, exactly like a pin with
// no place tags at all. null is a first-class value here (the Lore bucket), NOT
// an error. `type` is ADDITIVE and READ BY NOTHING on the client in this pass
// (pass 1 is FE-inert) — pass 2 is the browse-facet cutover that consumes it.
function typeOsm(t) {
  if (!t) return null;
  if (t.tourism === "artwork") return "art";
  if (t.historic === "tomb") return "grave"; // the #310 notable-graves kind
  if (t.tourism === "museum") return "museum";
  if (t.memorial || t.historic === "memorial" || t.historic === "monument") return "memorial";
  // Commercial KIND — no gate here (see the ordering note above): the element is
  // only in typeOsm because it already survived categorizeOsm's link gate.
  if (t.amenity === "restaurant" || t.amenity === "cafe" || t.amenity === "fast_food") return "restaurant";
  if (t.amenity === "bar" || t.amenity === "pub" || t.amenity === "biergarten") return "bar";
  if (t.shop) return "shop";
  if (t.leisure === "park" || t.leisure === "garden" || t.leisure === "nature_reserve" || t.boundary === "national_park") return "park";
  if (t.highway === "trailhead" || t.highway === "path" || t.highway === "footway" || t.highway === "track" ||
      t.route === "hiking" || t.route === "foot" || t.route === "mtb") return "trail";
  // Specific historic subtypes that ARE a place-kind (castle, ruins,
  // archaeological_site, …). LOW_VALUE_HISTORIC ({building,yes}) is NOT a kind —
  // it falls through to null/Lore below.
  if (t.historic && !LOW_VALUE_HISTORIC.has(t.historic)) return "historic";
  if (t.tourism === "attraction") return "attraction";
  return null; // no distinct place-kind → LORE
}
// --- #104: CLOSED / LIFECYCLE FILTER ----------------------------------------
// OSM has no expiry date. A shop node mapped in 2012 stays `shop=stationery`
// forever unless a human goes back and edits it, so "this place exists" is not
// a fact the data asserts — it is a fact somebody once asserted and nobody has
// retracted. That is how a defunct poster chain ended up on the map with a
// confident "A local stationery shop." under it and a walk-here pin on top.
//
// WHAT THIS DOES AND, MORE IMPORTANTLY, WHAT IT DOES NOT.
// It catches closures that a mapper TOOK THE TROUBLE TO RECORD. That is a real
// and non-trivial slice of them, and it is free. It does NOT catch the common
// case — a business that quietly closed and nobody edited — and no tag filter
// ever will, because there is no tag. The operator blocklist further down is
// the half that handles those, and item 100 (in-app "not here any more") is the
// half that scales. Do not read a passing filter here as evidence a place is
// open; it only means nobody has said otherwise.
//
// Mechanism, cheapest signal first:
//   1. LIFECYCLE PREFIXES. OSM's convention for a dead POI is to move its key
//      behind a prefix: `disused:shop=stationery`, `was:amenity=bar`,
//      `abandoned:`, `removed:`, `demolished:`, `razed:`, `closed:`. A FULLY
//      migrated POI already misses our query, which keys on the bare tag — so
//      the ones that reach us are the HALF-MIGRATED ones, where the mapper
//      added `disused:shop` and left `shop` in place. Those are exactly the
//      rows this rule is for, and they are invisible to any name check.
//   2. STANDALONE STATE TAGS: `disused=yes`, `abandoned=yes`, `demolished=yes`,
//      `razed=yes`, plus `state=abandoned`/`disused`.
//   3. `opening_hours` of `closed` / `off`. Some mappers record a permanent
//      closure this way. `opening_hours:signed=no` is NOT treated as closure —
//      it means "no sign on the door", which is a mapping note, not a state.
//   4. `end_date` / `end_date:*` in the past. Parsed leniently: a bare year is
//      enough, and anything unparseable is IGNORED rather than treated as
//      closed. OSM dates are free-form and a false drop is a lost real place.
//   5. `was:name` / `not:name` present WITHOUT a live `name` — a POI whose only
//      name is its former name is not open under it.
//
// Deliberately NOT included: `access=private`, `fixme`, `note`. Private access
// and a mapper's to-do are not closure, and folding them in here would make
// this filter mean something vaguer than its name.
//
// Set CLOSED_FILTER = false to restore the old behaviour, and bump
// CACHE_VERSION when you do or 21 days of filtered rows keep serving.
const CLOSED_FILTER = true;
const LIFECYCLE_PREFIXES = [
  "disused", "was", "abandoned", "removed", "demolished", "razed", "closed",
  "former", "destroyed", "construction", "proposed", "planned",
];
// The bare keys our query and categorizeOsm() actually read. A lifecycle prefix
// only counts as closure when it shadows one of THESE — `disused:vending` on an
// otherwise live bar is about a vending machine, not the bar.
const LIVE_KEYS = ["shop", "amenity", "leisure", "historic", "tourism", "highway", "route", "building"];

function endDateIsPast(v) {
  if (!v) return false;
  const s = String(v).trim();
  // Year-only is the common OSM form and Date() parses "2019" as a timestamp in
  // some runtimes and NaN in others, so handle it explicitly rather than hoping.
  const y = s.match(/^(\d{4})$/);
  if (y) return Number(y[1]) < new Date().getUTCFullYear();
  const m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (m) {
    const d = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] || 1));
    return Number.isFinite(d) && d < Date.now();
  }
  return false; // unparseable → not evidence of anything. Keep the place.
}

// Returns a short reason string when the element looks closed, else null.
// A reason rather than a boolean so `closedDropped` can be broken down in the
// response — a filter you cannot measure is a filter nobody can tell is
// over-firing (#94), and this one runs on every commercial pin in the app.
function closedReason(t) {
  if (!CLOSED_FILTER || !t) return null;
  for (const p of LIFECYCLE_PREFIXES) {
    for (const k of LIVE_KEYS) {
      if (t[p + ":" + k] != null) return p;
    }
  }
  const yes = (v) => v === "yes" || v === "true" || v === "1";
  if (yes(t.disused) || yes(t.abandoned) || yes(t.demolished) || yes(t.razed)) return "state_yes";
  if (t.state === "abandoned" || t.state === "disused") return "state_tag";
  const oh = (t.opening_hours || "").trim().toLowerCase();
  if (oh === "closed" || oh === "off") return "opening_hours";
  for (const k of Object.keys(t)) {
    if (k === "end_date" || k.startsWith("end_date:")) {
      if (endDateIsPast(t[k])) return "end_date";
    }
  }
  if (!t.name && (t["was:name"] || t["not:name"])) return "was_name";
  return null;
}

function osmDesc(t, category) {
  const clean = (s) => String(s).split(";")[0].replace(/_/g, " ").trim();
  // Hoisted from the history arm (#53 defined it there) so the commercial
  // passthrough below can share one copy — free text is whitespace-collapsed,
  // never clean()'d, because clean() splits on ';' and would truncate a real
  // sentence at its first semicolon.
  const prose = (s) => String(s).replace(/\s+/g, " ").trim();
  // OSM's own human-written `description` is the best possible line for a
  // commercial pin, and is exactly the kind of real, person-written text this
  // product is built around. #53 already passes it through for history; this
  // extends the same passthrough to restaurants / bars / shops, which until now
  // only ever rendered a constructed template ("A local place to eat."). Scoped
  // to the commercial trio ONLY — the history arm below has its own priority
  // ladder (description -> inscription -> artwork -> museum -> memorial) that
  // #53/#102 say not to disturb. Passed WHOLE: the one live description surface
  // (.ps-desc) scrolls (#77), so length is handled at the surface, not truncated
  // here. Coverage is partial by nature — most local shops carry no `description`
  // tag — so this lifts the ones that do and leaves the rest on the template.
  if ((category === "restaurants" || category === "bars" || category === "shops") && t.description) {
    return prose(t.description);
  }
  // ---- Compose a factual line from the tags OSM actually carries. ----
  // Every clause states ONLY what a tag asserts — cuisine, seating, takeaway,
  // diet — never a quality or vibe claim, which would be the invented-content
  // #37/#101/#162 rule out. When no tag beyond the bare category is present, the
  // original generic line is kept, so a bare pin still reads in the app's voice
  // rather than as a blunt "A restaurant."
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const article = (s) => (/^[aeiou]/i.test(s || "") ? "An" : "A");
  const cuisineOf = (raw) => {                     // first cuisine value, readable
    if (!raw) return "";
    const first = String(raw).split(";")[0].replace(/_/g, " ").trim();
    return first ? cap(first) : "";
  };
  const yes = (v) => v === "yes" || v === "only";  // OSM boolean-ish flags
  const withClause = (feats) =>
    !feats.length ? "" :
    " with " + (feats.length === 1
      ? feats[0]
      : feats.slice(0, -1).join(", ") + " and " + feats[feats.length - 1]);
  const sentence = (base, feats) => article(base) + " " + base + withClause(feats) + ".";

  if (category === "restaurants") {
    const cz = cuisineOf(t.cuisine);
    const feats = [];
    if (yes(t.outdoor_seating)) feats.push("outdoor seating");
    if (yes(t.takeaway)) feats.push("takeaway");
    if (yes(t["diet:vegan"])) feats.push("vegan options");
    else if (yes(t["diet:vegetarian"])) feats.push("vegetarian options");
    if (cz || feats.length) {
      let base;
      if (t.amenity === "cafe") {
        // cuisine on a café is usually coffee_shop/tea — redundant with "café".
        const czCafe = /coffee|cafe|tea/i.test(cz) ? "" : cz;
        base = (czCafe ? czCafe + " " : "") + "café";
      } else if (t.amenity === "fast_food") {
        base = (cz ? cz + " " : "") + "fast-food spot";
      } else {
        base = (cz ? cz + " " : "") + "restaurant";
      }
      return sentence(base, feats);
    }
    // Nothing to say beyond the category — keep the original voice.
    if (t.amenity === "cafe") return "A local café worth a stop.";
    if (t.amenity === "fast_food") return "A quick local bite.";
    return "A local place to eat.";
  }
  if (category === "bars") {
    if (t.amenity === "biergarten") return "An outdoor beer garden."; // already implies outdoor
    const cz = cuisineOf(t.cuisine);                                  // gastropubs carry one
    const feats = [];
    if (yes(t.outdoor_seating)) feats.push("outdoor seating");
    if (cz || feats.length) {
      const base = (cz ? cz + " " : "") + (t.amenity === "pub" ? "pub" : "bar");
      return sentence(base, feats);
    }
    return t.amenity === "pub" ? "A neighborhood pub." : "A local bar.";
  }
  if (category === "shops") {
    const feats = [];
    if (yes(t.second_hand)) feats.push("secondhand goods");
    if (yes(t.organic)) feats.push("organic goods");
    // The shop subtype IS the fact here and the shipped line already shows it,
    // so keep it byte-identical unless a feature tag genuinely adds something.
    if (!feats.length) return t.shop ? `A local ${clean(t.shop)} shop.` : "A local shop.";
    const base = t.shop ? "local " + clean(t.shop) + " shop" : "local shop";
    return sentence(base, feats);
  }
  if (category === "park") {
    if (t.leisure === "garden") return "A local garden to wander.";
    if (t.leisure === "nature_reserve") return "A protected local nature area.";
    return "A local green space to wander.";
  }
  if (category === "trail") {
    if (t.highway === "trailhead") return "A trailhead — the start of a marked trail.";
    if (t.route === "hiking") return "A marked hiking route.";
    if (t.route === "mtb") return "A marked mountain-bike route.";
    if (t.sac_scale && t.sac_scale !== "hiking") return `A hiking trail (${clean(t.sac_scale)}).`;
    if (t.highway === "track") return "An unpaved track worth a walk.";
    return "A walking trail nearby.";
  }
  if (category === "art") {
    // #193 — PUBLIC ART, split out of history. artwork_type (sculpture / statue /
    // mural / installation) and artist_name are the readable tags; material /
    // start_date add noise more than signal so they are deliberately left out.
    // Same human-tags-win ladder as history: a real description or inscription
    // beats any constructed sentence. `prose` collapses whitespace without
    // clean()'s ';' split, which would truncate free text at the first semicolon.
    if (t.description) return prose(t.description);
    if (t.inscription) return `\u201C${prose(t.inscription)}\u201D`;
    const type = t.artwork_type ? clean(t.artwork_type) : null;
    if (t.artist_name) return `A ${type || "public artwork"} by ${prose(t.artist_name)}.`;
    return type ? `A public ${type}.` : "A piece of public art.";
  }
  if (category === "history") {
    // #53 — THE DESCRIPTION IS THE DISAMBIGUATOR HERE, NOT POLISH. These branches
    // read the real tags parseOverpass still has in scope (`t` is live here; the
    // push object discards it one line later, so this is the last point they
    // exist). `prose` (hoisted to the top of osmDesc) collapses whitespace without
    // clean()'s ';' split — description / inscription are free text, and that
    // split would truncate them at the first semicolon.
    // Human-written tags win. OSM's own `description` first, then `inscription`,
    // which #13 and #53 both flag as the single highest-value tag on this whole
    // category — a plaque's inscription IS the transcribed story. Passed through
    // WHOLE: the one live surface (.ps-desc) scrolls (#77), so length is handled
    // at the surface, never truncated here.
    // #193 — the artwork branch that used to live here moved to the `art` arm
    // above when tourism=artwork got its own category; it can no longer reach here.
    if (t.description) return prose(t.description);
    if (t.inscription) return `\u201C${prose(t.inscription)}\u201D`;
    // Museums are precise, high-value history (#53 kept them for exactly this)
    // and were falling through to the generic "A notable local spot." below,
    // because a museum carries no `historic` tag.
    if (t.tourism === "museum") return t.museum ? `A local ${clean(t.museum)} museum.` : "A local museum.";
    // Memorials. An inscription, if present, was already returned above and is
    // strictly better than any constructed sentence; this is the fallback shape.
    if (t.memorial === "war_memorial" || t.historic === "war_memorial") return "A war memorial.";
    if (t.historic === "memorial" || t.memorial) {
      const kind = t.memorial ? clean(t.memorial) : null;
      return kind ? `A local memorial (${kind}).` : "A local memorial.";
    }
    // Everything else historic keeps its subtype label. The BARE no-information
    // case returns "" rather than "A notable local spot." — the string this row
    // is named after — so #101's render-no-block path shows no description block
    // at all. #53's standing rule, adopted in capitals: when there is no real
    // description, render NO block; never a sentence that says nothing.
    return t.historic ? `A local landmark (${clean(t.historic)}).` : "";
  }
  return "A local spot worth a look.";
}

function buildOverpassQuery(lat, lng, withMeta) {
  const R = OVERPASS_RADIUS_M;

  // Trail WAYS are gathered separately from everything else for two reasons
  // (#36): they need `out geom` rather than `out center` so a pin can land on
  // an actual endpoint instead of a bounding-box centre, and they need their
  // own element budget so a swarm of junk paths can't crowd real content out
  // of the shared 110 cap — which is exactly what was happening before.
  // QUERY PLANNING MATTERS MORE THAN IT LOOKS HERE. The obvious way to write
  // these is `way["highway"~"^(path|track)$"]["sac_scale"]` — and it TIMES OUT
  // (confirmed live: "Query timed out in \"query\" at line 8 after 45 seconds").
  // A regex on `highway` cannot use the tag index, so pairing it with a
  // key-existence filter makes Overpass scan every path and track in the
  // radius. Leading with the RARE tag flips the plan: `sac_scale`,
  // `trail_visibility` and `mtb:scale` are uncommon, so their index returns a
  // handful of ways and the highway check runs on that tiny set.
  //
  // Nothing is lost by dropping `highway` from those three: categorizeOsm()
  // only calls something a trail if it is a path/track/footway/trailhead or a
  // hiking route, so a way carrying `sac_scale` without a trail-ish highway
  // tag gets filtered out downstream anyway.
  const trailWays = TRAIL_STRICT
    ? // A name on a path is a strong signal someone deliberately mapped a
      // trail. Exact `=` match, no regex, so this one stays indexed and cheap.
      // `track` is NOT accepted on a name alone — it is OSM's tag for farm and
      // logging access roads and plenty of those are named; it gets in only
      // via the trail-specific tags below.
      `way["highway"="path"]["name"](around:${R},${lat},${lng});` +
      `way["sac_scale"](around:${R},${lat},${lng});` +
      `way["trail_visibility"](around:${R},${lat},${lng});` +
      `way["mtb:scale"](around:${R},${lat},${lng});`
      // Permissive fallback keeps v2's exact shape, which was proven live.
    : `way["highway"~"^(path|track)$"](around:${R},${lat},${lng});`;

  // PER-CATEGORY BUDGETS, and this is load-bearing.
  //
  // The old query ended in a single `out center 110`. That is one GLOBAL cap,
  // and Overpass emits in type order: all nodes, then all ways, then relations.
  // In a dense city the 110 slots were consumed entirely by bar / restaurant /
  // shop / historic NODES before emission ever reached the ways — and parks and
  // trails are almost entirely ways. Confirmed live in Chicago: a tile came
  // back `{park: 0, trail: 0, shops: 8, bars: 29, restaurants: 43}`. Zero parks
  // in Lake View is not a filtering result, it is truncation.
  //
  // Each category now gets its own set and its own budget, so a dense
  // nightlife district can no longer starve out every park and trail in range.
  // #104 — verbosity goes before geometry in Overpass's `out` grammar:
  //   out [verbosity] [geometry] [sort] [limit];
  // so it is `out meta center 45`, not `out center meta 45`. Threaded through a
  // variable rather than pasted five times, since the meta-free retry rebuilds
  // the whole query with this one flag flipped.
  const V = withMeta ? "meta " : "";
  return `[out:json][timeout:25];` +
    `(node["amenity"~"^(bar|pub|biergarten|restaurant|cafe|fast_food)$"](around:${R},${lat},${lng});)->.food;` +
    `(node["shop"~"^(books|gift|clothes|art|music|antiques|craft|florist|deli|toys|stationery|bakery|second_hand|bicycle|jewelry|shoes|furniture|records|garden_centre|variety_store)$"](around:${R},${lat},${lng});)->.shops;` +
    // #224 / v26 / v28 — history WAYS get their own set (v26), and within that,
    // `tourism=attraction` ways get a SEPARATE budget (v28). Overpass emits an
    // `out center N` set in ascending-ID order, so in a way-dense tile the 20-way
    // budget is filled by low-ID historic-BUILDING ways before a high-ID
    // attraction way is reached: Wooden Alley (way 220301292) sits above every
    // historic building in tile 838_-1753 (which top out ~id 148M), so it was cut
    // by ID even though it was fetched-in-range and categorises fine. Proven from
    // the cached v27 tile: 13 history ways present, all id < 220301292, no alley.
    // `tourism=attraction` ways are RARE (Wooden Alley was the ONLY one in this
    // whole downtown tile), so a dedicated `.hista out center 20` guarantees them
    // regardless of how many historic-building ways exist. `out center` for all
    // (short alley / building centroid fine; #268 water-pin concern is trails).
    `(node["historic"](around:${R},${lat},${lng});` +
      `node["tourism"~"^(attraction|museum|artwork)$"](around:${R},${lat},${lng});)->.histn;` +
    `(way["historic"](around:${R},${lat},${lng});` +
      `way["tourism"~"^(museum|artwork)$"](around:${R},${lat},${lng});)->.histw;` +
    `(way["tourism"="attraction"](around:${R},${lat},${lng});)->.hista;` +
    `(way["leisure"~"^(park|garden|nature_reserve)$"](around:${R},${lat},${lng});` +
      `node["leisure"~"^(park|garden)$"](around:${R},${lat},${lng});)->.parks;` +
    `(node["highway"="trailhead"](around:${R},${lat},${lng});` +
      `relation["route"~"^(hiking|foot|mtb)$"](around:${R},${lat},${lng});` +
      trailWays + `)->.trails;` +
    `.food out ${V}center 45;` +
    `.shops out ${V}center 20;` +
    `.histn out ${V}center 30;` +
    `.histw out ${V}center 20;` +
    `.hista out ${V}center 20;` +
    `.parks out ${V}center 25;` +
    `.trails out ${V}${TRAIL_GEOM ? "geom" : "center"} 20;`;
}

// --- Chain filter -----------------------------------------------------------
// Localy is about hole-in-the-wall / dive / independent spots, so franchise
// chains are dropped here — server-side, where OSM's raw tags are still
// available (parseOverpass strips tags before returning, so the client can only
// match on name; this is the only place the strong signals can be used).
//
// Signals, strongest first:
//   1. brand / brand:wikidata / brand:wikipedia — chains carry these, genuine
//      independents don't. Self-maintaining: no list to keep current.
//   2. Explicit chain-ish tags OSM uses.
//   3. Name regex — safety net for chains mapped without a brand tag.
// Set EXCLUDE_CHAINS = false to restore chains.
const EXCLUDE_CHAINS = true;
const CHAIN_NAME_RE =
  /\b(mc\s?donald|burger king|wendy'?s|taco bell|chipotle|subway|starbucks|mccafe|dunkin|kfc|kentucky fried|popeye|chick[- ]?fil[- ]?a|domino'?s|pizza hut|papa john|papa murphy|little caesar|arby'?s|sonic drive|dairy queen|panera|five guys|shake shack|in[- ]?n[- ]?out|jack in the box|carl'?s jr|hardee'?s|wingstop|raising cane|panda express|olive garden|applebee|chili'?s|buffalo wild wings|ihop|denny'?s|waffle house|cracker barrel|red lobster|red robin|outback steak|texas roadhouse|longhorn steak|cheesecake factory|tgi ?friday|baskin[- ]?robbins|krispy kreme|jimmy john|jersey mike|firehouse subs|potbelly|qdoba|moe'?s southwest|noodles ?& ?company|chuck e|hooters|white castle|whataburger|culver'?s|del taco|el pollo loco|church'?s (chicken|texas)|long john silver|auntie anne|cinnabon|tim horton|caribou coffee|peet'?s coffee|dutch bros|einstein bros|bojangle|zaxby|steak ?'?n ?shake|freddy'?s frozen|portillo'?s|jimmy the greek|7[- ]?eleven|circle k|wawa|sheetz|casey'?s general|speedway|ampm|quiktrip|racetrac|cumberland farms|walgreens|cvs|rite aid|dollar general|dollar tree|family dollar|walmart|target|costco|sam'?s club|kroger|safeway|albertsons|whole foods|trader joe|aldi|lidl|publix|meijer|wegmans|jewel[- ]?osco|food ?4 ?less|save[- ]?a[- ]?lot|piggly wiggly|home depot|lowe'?s|best buy|gamestop|barnes ?& ?noble|books[- ]?a[- ]?million|hot topic|forever 21|h ?& ?m|zara|uniqlo|old navy|gap|banana republic|american eagle|abercrombie|hollister|victoria'?s secret|bath ?& ?body|ulta|sephora|foot locker|finish line|nike|adidas|marshalls|tj ?maxx|ross dress|burlington|petco|petsmart|autozone|o'?reilly auto|advance auto|napa auto|jiffy lube|midas|firestone|goodyear|discount tire|great clips|supercuts|planet fitness|la fitness|anytime fitness|orange ?theory|massage envy|verizon|at ?& ?t|t[- ]?mobile|sprint|xfinity|spectrum|fedex|ups store|usps|h ?& ?r block|jackson hewitt|edward jones|state farm|allstate|geico|chase bank|bank of america|wells fargo|us bank|pnc bank|truist|citibank|td bank|fifth third|huntington bank|regions bank|ally|capital one)\b/i;

function isChainPlace(t, name) {
  if (!EXCLUDE_CHAINS) return false;
  if (t) {
    // 1) Brand tagging — the strongest, self-maintaining signal.
    if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) return true;
    // 2) Operator that's clearly a franchise operator carrying its own brand id.
    if (t["operator:wikidata"]) return true;
  }
  // 3) Name fallback for chains mapped without brand tags.
  if (name && CHAIN_NAME_RE.test(name)) return true;
  return false;
}

// --- #36: where a trail's pin goes -----------------------------------------
// `out center` returns a way's BOUNDING-BOX centre. For a linear 5km trail
// that point sits somewhere in the middle of the woods and may not even lie on
// the trail — so in an app whose core action is physically walking to a pin,
// you had to hike halfway in before you could capture it.
//
// With `out geom` the way arrives with its full node list, so we can pin an
// actual endpoint instead. Endpoints are where access almost always is: a
// trailhead, a road crossing, a parking lot. When the request origin is known
// we take the NEARER of the two ends, which is the one you'd realistically
// start from. Falls back to centre, then bbox midpoint, so a way that somehow
// arrives without geometry still produces a pin rather than vanishing.
function trailPinPoint(el, origin) {
  const g = el.geometry;
  if (Array.isArray(g) && g.length) {
    const ends = [g[0], g[g.length - 1]].filter((n) => n && n.lat != null && n.lon != null);
    if (ends.length) {
      let pick = ends[0];
      if (origin && ends.length === 2) {
        const d0 = haversine(origin.lat, origin.lng, ends[0].lat, ends[0].lon);
        const d1 = haversine(origin.lat, origin.lng, ends[1].lat, ends[1].lon);
        pick = d1 < d0 ? ends[1] : ends[0];
      }
      return { lat: pick.lat, lng: pick.lon };
    }
  }
  if (el.center) return { lat: el.center.lat, lng: el.center.lon };
  if (el.bounds) {
    return {
      lat: (el.bounds.minlat + el.bounds.maxlat) / 2,
      lng: (el.bounds.minlon + el.bounds.maxlon) / 2,
    };
  }
  return null;
}

// #163 — parse an OSM `wikipedia` tag into an English article title, or null.
// The tag's canonical form is "<lang>:<Title>" ("en:Ernie Banks"). Only en: is
// followed here, because the extract endpoint (fetchWikiExtractsByTitle) is
// en.wikipedia — a foreign link is treated as "no usable en title" and counts
// toward the wikidataOnly tally instead, since Option B (#164) could resolve it
// via the Q-id but Option A cannot. A bare title with no lowercase "<lang>:"
// prefix is assumed en, which is what a same-wiki link means. The lang test is
// case-SENSITIVE (lowercase only) on purpose: OSM lang codes are always
// lowercase, so a title like "OK: The Movie" is left whole rather than parsed as
// a lang prefix and dropped.
function osmWikiEnTitle(t) {
  const raw = (t && t.wikipedia ? String(t.wikipedia) : "").trim();
  if (!raw) return null;
  const m = raw.match(/^([a-z]{2,3}):([\s\S]+)$/);
  if (m) return m[1] === "en" ? m[2].trim() : null;
  return raw; // no lang prefix → same (en) wiki
}

// #359 — ALT-NAME BRIDGE support.
// A documented facts pin whose bare OSM `name` is a nickname/indigenous name that
// does NOT match its Wikipedia article TITLE, and which carries NO `wikipedia=`
// tag, resolves to NULL by name and shows its thin osmDesc line forever
// ("Kwa-Ma-Rolas" → the "Kwanusila" totem-pole article — node 589512469). When
// the node ALSO carries an `alt_name=` (the documented name, which IS the article
// title), that alt name is the deterministic bridge: parseOverpass marks the pin
// (rec.altName) and the tile-build enrich resolves it through the SAME
// coordinate-gated resolveWikiByName every by-name resolve uses (#316 gate + #357
// bank), then bakes the article. FACTS categories only — the set that carries a
// real "what it is" (matches the client REAL_DESC_FACTS_CATS: history/park/trail/
// art); commercial pins are out (#275/#309). The `wikidata=`-Q-id half of the same
// bridge is Option B (#164) — SHIPPED 2026-09-23, see enrichOsmWikidata below.
const FACTS_DESC_CATS = new Set(["history", "park", "trail", "art"]);
const ALT_RESOLVE_MAX = 12; // per-tile ceiling on cold-path alt-name resolves (banked after the first, so a rebuild is free; mirrors the client REAL_DESC_PREWARM_MAX bound)
// #387 — COLD-BUILD RESOLVE TIME BUDGET. An uncached by-name resolve now takes
// ~15–40 s (wiki + wikidata + AI-recall rungs), and the cold path ran up to 12
// alt-name + 12 storyless-OSM resolves SEQUENTIALLY — so a never-visited metro
// (Cleveland, Toledo — no gate-tiles warm) blew past the Edge Function wall clock,
// the request died with no response, no tile was ever cached, and every visit
// re-tried and died again: an empty map, forever. Now both loops run with small
// concurrency and the SERVE waits at most COLD_RESOLVE_BUDGET_MS; resolves still
// in flight keep running in the background (waitUntil) and BANK their hits
// (#357), so the warm heal serves them on the next load. The first visitor gets a
// tile in ~15–25 s instead of never; stories fill in on later loads.
const COLD_RESOLVE_BUDGET_MS = 10000;
const COLD_RESOLVE_CONCURRENCY = 4;
function keepAlive(promise) {
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") EdgeRuntime.waitUntil(promise);
  } catch (_e) { /* best effort */ }
}
// Run fn over items with limited concurrency; resolve after all finish OR after
// budgetMs, whichever is first. Unfinished work continues in the background.
// Returns { finished, deferred } where deferred = items not yet completed.
async function runBounded(items, fn, budgetMs, conc) {
  let next = 0, done = 0;
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++];
      try { await fn(it); } catch (_e) { /* per-item failure is the item's own business */ }
      done++;
    }
  };
  const all = Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
  let timer;
  const timedOut = await Promise.race([
    all.then(() => false),
    new Promise((r) => { timer = setTimeout(() => r(true), budgetMs); }),
  ]);
  clearTimeout(timer);
  if (timedOut) keepAlive(all.catch(() => {}));
  return { finished: !timedOut, deferred: items.length - done };
}
const OSM_RESOLVE_MAX = 12; // #367 — per-COLD-BUILD ceiling on by-name storyless-OSM-facts-pin resolves (banked after the first, so a rebuild is free; same cold-path budget as ALT_RESOLVE_MAX). A dense tile fills over successive rebuilds — monotonic, never re-rolls.

// #359/#358 — server sibling of the client `_descIsRicher` no-downgrade rule: a
// THIN line (a filler template, or a short `description` tag like "Totem pole",
// ≤60 chars — the same length guard the client `isFillerDesc` uses) or a blank may
// be replaced by a resolved article; a RICH human description (>60 chars, #53) is
// never touched, so the bridge upgrades filler without ever downgrading real text.
function descIsThin(s) { return !s || String(s).trim().length <= 60; }

function parseOverpass(json, origin) {
  const out = [];
  let chainsDropped = 0;
  let trailsDropped = 0;
  let closedDropped = 0;
  const closedBy = {};
  let metaSeen = 0;
  let wikidataOnly = 0; // #163 — history pins Option B (#164) would reach, A won't
  (json.elements || []).forEach((el) => {
    const t = el.tags || {};
    const category = categorizeOsm(t);
    if (!category) return;

    // #104 — before anything else that costs work, and before the name check, so
    // a closed-and-unnamed POI is counted as closed rather than as a nameless
    // trail. Applies to EVERY category, not just commercial ones: a demolished
    // building tagged `historic` is as wrong to walk to as a dead shop.
    const cr = closedReason(t);
    if (cr) { closedDropped++; closedBy[cr] = (closedBy[cr] || 0) + 1; return; }

    // #36: the old code INVENTED names here — unnamed ways became "Local
    // Trail" / "Trail <ref>" rather than being dropped. That fallback, not
    // thin OSM data, is what produced the generic trails on the map. A route
    // relation or a signal-tagged way that still has no name and no ref has
    // nothing worth showing on a card, so it goes.
    const name = t.name || (t.ref && category === "trail" ? `Trail ${t.ref}` : null);
    if (!name) {
      if (category === "trail") trailsDropped++;
      return;
    }

    let lat, lng;
    if (category === "trail" && el.type === "way") {
      const pt = trailPinPoint(el, origin);
      if (!pt) return;
      lat = pt.lat; lng = pt.lng;
    } else {
      lat = el.lat != null ? el.lat : (el.center && el.center.lat);
      lng = el.lon != null ? el.lon : (el.center && el.center.lon);
    }
    if (lat == null || lng == null) return;

    // Drop franchise chains BEFORE they're cached. Must happen here: the
    // pushed object below discards `t`, so this is the last point the brand
    // tags exist. Trails/parks/history are exempt — a chain tag on a park is
    // noise, and the concept only meaningfully applies to commercial venues.
    const commercial = category === "restaurants" || category === "bars" || category === "shops";
    if (commercial && isChainPlace(t, name)) { chainsDropped++; return; }

    // #104 — `osmTs` is the element's last-edited timestamp when `out meta` was
    // in the query, and undefined otherwise (meta-free retry, or OSM_META off).
    // UNDEFINED IS A MEANINGFUL READING and must not be coerced to a date: it
    // says "we did not ask", which is different from "this has never been
    // edited". Nothing drops on it — see the OSM_META comment.
    // #80 — carry BOTH axes: `category` (story, unchanged) + `type` (kind). See
    // typeOsm(). `type` is additive/FE-inert this pass; nothing reads it yet.
    const rec = { id: "osm_" + el.type + el.id, name, lat, lng, desc: osmDesc(t, category), category, type: typeOsm(t), source: "osm", real: true };
    if (el.timestamp) { rec.osmTs = el.timestamp; metaSeen++; }
    // #163 — attach the node's OWN wikipedia= link (resolved to an en title) so
    // enrichOsmWikipedia can follow it after the merge. History only, and only
    // when osmDesc did NOT already use a human-written `description`/`inscription`
    // — those win per #53 and must never be overwritten by a Wikipedia intro.
    // This is the last point `t` exists (the pushed rec discards it), same as the
    // brand/addr discards #39/#18 flagged. A node carrying only a `wikidata=`
    // Q-id is tallied here and followed by Option B (#164) just below.
    if (category === "history" && !t.description && !t.inscription) {
      const wpTitle = osmWikiEnTitle(t);
      if (wpTitle) rec.wp = wpTitle;
      else if (t.wikidata && /^Q\d+$/.test(String(t.wikidata).trim())) wikidataOnly++;
    }
    // #164 — OPTION B: follow the node's OWN bare `wikidata=` Q-id when no en
    // `wikipedia=` title was taken above (rec.wp) and the pin's current line is
    // THIN (descIsThin — a filler template or a short tag; a rich human
    // `description` per #53 is never overwritten). FACTS categories only
    // (history/park/trail/art — the set with a real "what it is"), so a park or
    // trail whose only link is a Q-id is covered too, and so is a pin whose
    // `wikipedia=` tag is foreign-language (osmWikiEnTitle returns null for it).
    // ONLY the bare `wikidata` key: `subject:wikidata` points at the PERSON or
    // EVENT a place is known for (Al Capone's House → Al Capone), and
    // `brand:`/`operator:` mark chains — none of those is the place's own item.
    // The Q-id is an editor-asserted IDENTITY, so it needs no name match — which
    // is exactly why it reaches the name variants the #367 strict match refuses
    // (Owens-Thomas Museum → "Owens–Thomas House"). `qid` is internal plumbing,
    // stripped by enrichOsmWikidata before the bake, like `wp`/`altName`.
    if (!rec.wp && FACTS_DESC_CATS.has(category) && descIsThin(rec.desc) && t.wikidata) {
      const q = String(t.wikidata).split(";")[0].trim();
      if (/^Q\d+$/.test(q)) rec.qid = q;
    }
    // #359 — carry a documented `alt_name` so the tile-build enrich can bridge a
    // nickname-named facts pin to its article deterministically (see FACTS_DESC_CATS
    // note above). Gated so it never fights the stronger paths: only a FACTS
    // category, only when the pin got NO `wikipedia=` title above (rec.wp — Option A
    // runs first and is exact), and only when the alt name actually DIFFERS from the
    // bare name (else resolving it just repeats the name miss). `t` is discarded
    // after this line, so the alt name must ride the record; the enrich strips
    // `altName` before the bake so it never lands in the cached tile.
    if (!rec.wp && FACTS_DESC_CATS.has(category) && t.alt_name) {
      const alt = String(t.alt_name).split(";")[0].trim();
      if (alt && normName(alt) && normName(alt) !== normName(name)) rec.altName = alt;
    }
    out.push(rec);
  });
  return { places: out, chainsDropped, trailsDropped, closedDropped, closedBy, metaSeen, wikidataOnly };
}

// #104 — age histogram over whatever carries an osmTs. Buckets rather than a
// mean, because the question this is meant to answer is "how much of the map is
// a decade-old assertion nobody has rechecked", and a mean hides that behind
// the freshly-edited half. `unknown` counts places with no timestamp at all,
// which on a meta-free retry is all of them.
function osmAgeHistogram(places) {
  const h = { lt1y: 0, y1_3: 0, y3_7: 0, gt7y: 0, unknown: 0 };
  const now = Date.now();
  (places || []).forEach((p) => {
    if (!p || p.source !== "osm") return;
    const ts = p.osmTs ? Date.parse(p.osmTs) : NaN;
    if (!Number.isFinite(ts)) { h.unknown++; return; }
    const years = (now - ts) / (365.25 * 24 * 3600 * 1000);
    if (years < 1) h.lt1y++;
    else if (years < 3) h.y1_3++;
    else if (years < 7) h.y3_7++;
    else h.gt7y++;
  });
  return h;
}

async function fetchOverpassOne(url, q, origin) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OVERPASS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " from " + url);
    const json = await res.json();
    if (json && json.remark && (!json.elements || !json.elements.length)) {
      throw new Error("Overpass remark: " + json.remark);
    }
    const parsed = parseOverpass(json, origin);
    return {
      status: res.status, places: parsed.places,
      chainsDropped: parsed.chainsDropped, trailsDropped: parsed.trailsDropped,
      closedDropped: parsed.closedDropped, closedBy: parsed.closedBy,
      metaSeen: parsed.metaSeen, wikidataOnly: parsed.wikidataOnly,
    };
  } finally { clearTimeout(timer); }
}
// Race all mirrors; take the first that answers. Returns {places, status, error}.
async function fetchOverpass(lat, lng) {
  // #104 — one attempt per query shape. The meta-free retry exists because #36's
  // TRAIL_GEOM taught this file that an untested `out` modifier does not fail
  // gracefully: Overpass rejects the whole query, so every category goes to
  // zero and the map looks like the area is empty rather than like the new flag
  // is bad. Retrying without meta converts that from an app-wide outage into a
  // silently-degraded field.
  const attempt = async (withMeta) => {
    const q = buildOverpassQuery(lat, lng, withMeta);
    let lastErr = "";
    try {
      const result = await Promise.any(
        OVERPASS_ENDPOINTS.map((url) =>
          fetchOverpassOne(url, q, { lat, lng }).catch((e) => {
            lastErr = (e && e.message) || String(e);
            throw e;
          })
        ),
      );
      return {
        places: result.places, status: result.status, error: null,
        chainsDropped: result.chainsDropped || 0, trailsDropped: result.trailsDropped || 0,
        closedDropped: result.closedDropped || 0, closedBy: result.closedBy || {},
        metaSeen: result.metaSeen || 0, metaAsked: !!withMeta,
        wikidataOnly: result.wikidataOnly || 0,
      };
    } catch (_agg) {
      return { places: [], status: null, error: lastErr || "all mirrors failed", chainsDropped: 0, trailsDropped: 0, closedDropped: 0, closedBy: {}, metaSeen: 0, metaAsked: !!withMeta, wikidataOnly: 0 };
    }
  };

  const first = await attempt(OSM_META);
  if (!first.error || !OSM_META) return first;
  // Every mirror refused the meta query. Could be Overpass load rather than the
  // modifier — the retry does not care which, it just makes sure a bad flag
  // cannot be the thing that empties the map. Flagged so the response says a
  // retry happened instead of quietly looking like a normal pass.
  const second = await attempt(false);
  return { ...second, metaRetried: true, metaError: first.error };
}

// --- #96: Wikipedia relevance filter --------------------------------------
// The geosearch below returns EVERY coordinate-bearing article within 6 km and
// pushed all of them through as category:"history". Two things came out of that
// which should never have been pins:
//   1. Settlements (city / village / CDP / unincorporated community). This is a
//      CATEGORY ERROR, not a taste one: the article is geotagged at the centroid
//      of the area you are standing in, so the app drew a pin on top of the user
//      and invited them to walk to the town they were already in. It survives
//      dedupeReal() (nothing else shares the name) and, being a centroid, sorts
//      near the top of any distance-ordered list. Every dense tile got one.
//   2. High schools. Real places, no story — they fail #13's bar.
//
// Mechanism is #96's option (a): a stoplist on the article's OPENING SENTENCE,
// which is already fetched (`exintro`), so it costs nothing. Option (b) —
// Wikidata P31 instance-of — is precise and language-independent but costs a
// second API call per tile inside a function that already races a timeout;
// `wikiDropped` is reported so precision can be MEASURED before anyone pays for
// it. Same discipline #94 asks for.
//
// The match is anchored to the copula predicate ("<X> is a <...> city in ..."),
// NOT to a bare mention of the words. An unanchored /high school/ would drop
// "Old Main is a building on the campus of Central High School" — exactly the
// pin worth keeping. The three guards that do that work:
//   - it must follow "is/was a|an|the" (or "one of the");
//   - at most three adjectives may intervene, and none of them may be a
//     function word, which is what kills "is a memorial to the city of ...";
//   - the noun must be FOLLOWED by in/of/on/and/near/... or punctuation, which
//     is what keeps "is a city landmark", "is a state park" and "was a
//     settlement house in Chicago" (Hull House) on the map.
//
// ACCEPTED TRADE, recorded so it gets a gravestone and not a re-litigation:
// this drops genuinely historic schools too — NRHP-listed buildings are
// frequently schools. The bet is that an opener-anchored stoplist loses fewer
// good pins than the settlement/school noise costs. If that turns out wrong the
// fix is (b), NOT a longer regex.
//
// Flip WIKI_RELEVANCE_FILTER to false to restore the old behaviour — and bump
// CACHE_VERSION when you do, or 21 days of filtered rows keep serving.
const WIKI_RELEVANCE_FILTER = true;
const WIKI_STOP_RE = /\b(?:is|was)\s+(?:one\s+of\s+the|a|an|the)\s+(?:(?!(?:in|of|on|to|at|for|by|with|from|near|within|the|a|an|and)\b)[^\s.]+\s+){0,3}?(?:census[-\u2010-\u2015 ]designated\s+places?|unincorporated\s+(?:communit(?:y|ies)|areas?|towns?)|(?:junior\s+high|senior\s+high|high|middle|elementary|primary|secondary|grammar|prep(?:aratory)?)\s+schools?|school\s+districts?|community\s+areas?|ghost\s+towns?|home\s+rule\s+municipalit(?:y|ies)|municipalit(?:y|ies)|cit(?:y|ies)|towns?|villages?|hamlets?|boroughs?|townships?|suburbs?|neighbou?rhoods?|count(?:y|ies)|parish(?:es)?|states?|provinces?|settlements?|localit(?:y|ies)|capitals?|communit(?:y|ies)|(?:railway|railroad|rail|train|subway|metro|tram|streetcar|light\\s+rail|rapid\\s+transit|commuter\\s+rail|bus|transit|ferry|monorail)\\s+(?:stations?|stops?|terminals?|depots?|halts?)|transit\\s+cent(?:er|re)s?|park[\\s-]and[\\s-]rides?|stations?|stops?|halts?|terminals?|termini|depots?)(?=\s*(?:[,.;:()\[\]{}"\u201c\u201d\u2014]|$)|\s+(?:in|of|on|and|within|near|located|situated|serving|which|that|for|between)\b)/i;

/* #96b — TITLE RULES. The opener stoplist reads the extract, and there are two
   ways an article reaches the pin with no usable extract to read:
     - MediaWiki caps `exlimit` at 20 and the geosearch asked for 25, so on any
       tile with more than 20 articles at least five arrived with NO extract
       field at all. The query is now aligned at 20/20, but a cached tile, a
       future limit change or an article whose intro is a bare infobox all
       reproduce it, and a filter that is blind by construction is worse than
       one that is merely wrong.
     - Some stubs genuinely have an empty intro.
   Wikipedia's own title conventions are diagnostic for exactly the two classes
   this row is about, cost nothing, and survive a missing extract:
     - Settlements use the comma form: "Northwood, Logan County, Ohio".
       Non-settlements disambiguate with PARENTHESES instead — which is why the
       rule excludes any title containing brackets, and why "Central High School
       (Columbus, Ohio)" is not caught here but by the school rule below.
     - Schools carry the school type in the title itself.
   Scope, stated so it is a decision and not an oversight: US-only, because the
   comma-then-state convention is what makes this safe. A UK village
   ("Chipping Norton, Oxfordshire") is not caught by the title rule and still
   depends on its opener. */

/* #105 — TRANSIT STOPS. Every geotagged rail and bus stop in a US city has a
   Wikipedia article, so #96's geosearch hands us the entire transit network as
   category:"history": "Wellington station (CTA)", "Belmont station (CTA)", and
   so on down every line in range. They are real, they are exactly where the
   article says they are, and they fail #13's bar completely — nobody walks
   somewhere to discover a train stop they are standing on the platform of.
   Worse than a dull pin: stations cluster along the same corridors the app
   sends people down, so they crowd genuinely interesting history off a
   distance-sorted list.

   THREE NETS, same layering as #96/#96b, cheapest and most robust first:
     A. TITLE, modifier form — "<rail|bus|subway|...> station|stop|terminal".
     B. TITLE, disambiguation form — "<Name> station (<Operator>)". This is the
        one that catches the reported pin. Restricted to the word "station"
        rather than also stop/terminal: "Bus Stop (play)" and "The Terminal
        (film)" are the shape this would otherwise hit, and while neither is
        geotagged today, the narrower rule costs nothing.
     C. OPENER — "is a station on the ...", "is an 'L' station on ...", "is a
        rapid transit station in ...". Folded into WIKI_STOP_RE's existing noun
        alternation so it inherits #96's three guards (copula-anchored, at most
        three non-function adjectives, noun must be followed by a preposition or
        punctuation) rather than being a second unanchored regex.

   ACCEPTED TRADES, recorded as gravestones so they are not re-litigated:
   - bare "station" in the opener also drops FIRE stations, POLICE stations,
     POWER stations and RESEARCH stations. Checked deliberately and kept: none
     of those is a place this app should be walking someone to either, so the
     over-reach lands on things we would want gone anyway.
   - Grand terminal buildings that are genuinely architectural landmarks —
     Chicago Union Station is the local example — are NOT caught. It has no
     operator parentheses, no modifier before "Station", and its opener
     ("...is an intercity and commuter rail terminal in...") breaks the
     adjective run on the function word "and". That is the intended outcome:
     the rule targets STOPS, and a destination building is not a stop. If you
     want those gone too, say so and it becomes a title rule, not a wider
     opener — a wider opener is how #96's regex would start eating landmarks. */
const WIKI_TITLE_TRANSIT_RE = /\b(?:railway|railroad|rail|train|subway|metro|tram|streetcar|light\s+rail|rapid\s+transit|commuter|bus|coach|transit|ferry|monorail|funicular|cable\s+car|interurban)\s+(?:stations?|stops?|terminals?|depots?|halts?|cent(?:er|re)s?)\b/i;
const WIKI_TITLE_STATION_PAREN_RE = /\bstation\b[^()]*\([^)]*\)\s*$|\([^)]*\bstation\b[^)]*\)\s*$/i;

// #293 — AVIATION-ACCIDENT TITLE NET. Standalone geotagged articles named
// "<Airline> Flight <N>" ("American Airlines Flight 191", "US Airways Flight
// 1549") are essentially always about an incident/accident, and a crash site
// beside a runway is never a place this app should walk someone to. Anchored at
// END of title (optionally a "(1979)"-style disambiguator) so a MEMORIAL or
// museum carrying the flight number in its name is NOT caught — "Flight 93
// National Memorial" has trailing words and fails the `$`, so it survives (and
// a crash memorial also reaches the map via OSM `historic=memorial`/`memorial=`,
// which categorizeOsm keeps unconditionally). Same layering as the school/
// settlement/transit title rules: it survives a missing extract, so it runs in
// the title block of isLowValueWikiArticle BEFORE the opener is read. The
// airport-family openers are handled the OTHER (conditional) way, folded into
// WIKI_INSTITUTIONAL_RE so an NRHP-listed historic airfield survives on
// hasHistoricSignal. Accidents, by contrast, are unconditional here — a crash
// article drops even if its extract mentions a historic register in passing.
//
// TWO SHAPES: (1) the "<Airline> Flight <N>" naming convention, end-anchored so
// a trailing-word title (a memorial/museum named after the flight) is not
// caught; (2) an "air/aviation/airline/aircraft disaster|crash|accident" or
// "mid-air collision" PHRASE anywhere in the title — needed because these
// articles open "The 1979 Chicago air disaster WAS the crash of…", where the
// operative noun sits BEFORE the copula and the opener-anchored INSTITUTIONAL
// regex structurally cannot reach it. The caller (isLowValueWikiArticle) pairs
// this with a memorial/museum guard so a real destination named after a crash
// (e.g. "…Air Disaster Memorial") still survives.
const WIKI_TITLE_AVIATION_RE = /\bflight\s+\d{1,4}[a-z]?(?:\s*\([^)]*\))?\s*$|\b(?:air|aviation|airline|aircraft)\s+(?:disaster|crash|accident)s?\b|\b(?:runway|ground|taxiway|apron|mid-?air|air|aircraft|aviation)\s+collisions?\b/i;
const WIKI_TITLE_AVIATION_KEEP_RE = /\b(?:memorial|museum)\b/i;

// #293 (v31) — NARRATIVE CRASH OPENER. The title nets above catch the two naming
// conventions ("<Airline> Flight <N>", "<place> air disaster/collision"), but a
// crash article can be titled by DATE/PLACE and open as a NARRATIVE — the
// reported miss, "1972 Chicago–O'Hare runway collision", opens "On December 20,
// 1972, North Central Airlines Flight 575 and Delta Air Lines Flight 954 collided
// on a runway at O'Hare…". There is no `is a/was a` copula for WIKI_INSTITUTIONAL_RE
// to anchor on, and "runway collision" evaded the pre-v31 title net. This reads the
// OPENER (first sentence) and drops it when a FLIGHT NUMBER and an INCIDENT verb
// co-occur within ~240 chars — a pairing a genuine destination's lead sentence
// effectively never has, so it stays specific to accidents. Paired with a keep-guard
// so an article whose opener SELF-DESCRIBES as a memorial/museum/park (a real place
// commemorating a crash — "…is a memorial to the passengers of Flight 93, which
// crashed…") survives; those also arrive via OSM `memorial=`/`historic=` regardless.
const WIKI_AVIATION_OPENER_RE = /\bflight\s+\d{1,4}\b[\s\S]{0,240}?\b(?:crash|collid|shot\s+down|ditch|overr(?:an|un)|forced\s+(?:to\s+)?land|emergency\s+land|hijack|disaster|accident|explod|broke\s+up|went\s+down)/i;
const WIKI_AVIATION_OPENER_KEEP_RE = /\bis\s+(?:a|an|the)\b[^.]{0,80}?\b(?:memorial|museum|park|monument|garden|historic\s+site|trail)\b/i;

const WIKI_TITLE_SCHOOL_RE = /\b(?:junior\s+high|senior\s+high|high|middle|elementary|primary|secondary|grammar)\s+school\b/i;
const WIKI_TITLE_SETTLEMENT_RE = /^[^()\[\]]+,\s+(?:[^,()\[\]]+,\s+)?(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New\s+Hampshire|New\s+Jersey|New\s+Mexico|New\s+York|North\s+Carolina|North\s+Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode\s+Island|South\s+Carolina|South\s+Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West\s+Virginia|Wisconsin|Wyoming|District\s+of\s+Columbia|D\.C\.|Puerto\s+Rico|Guam|American\s+Samoa|U\.S\.\s+Virgin\s+Islands|Northern\s+Mariana\s+Islands)$/i;

// First sentence only. No lookbehind — this has to run in older iOS Safari as
// well as Deno — so the "is this really a sentence end?" test is folded into a
// lazy match instead: a period only ends the opener when it follows two
// lowercase letters, a digit or a closing bracket/quote AND is followed by a
// space and a capital. That is what keeps "the U.S. state of Illinois" and
// "Whitney M. Young Magnet High School" in one piece; splitting naively on
// ". [A-Z]" truncated the latter to "Whitney M" and let it through the filter.
function wikiOpener(extract) {
  const s = String(extract || "").trim();
  if (!s) return "";
  const m = s.match(/^[\s\S]*?(?:[a-z]{2}|[0-9)\]"'\u201d\u2019])\.(?=\s+["'(\u201c]?[A-Z])/);
  return (m ? m[0] : s).slice(0, 300);
}
// #13 (fetchWikipedia opener residual) — THE CIVIC/UTILITY DROP CLASS, kept UNLESS historic.
// The geosearch path defaults every unclassified article to 'history' (see the `|| "history"`
// in fetchWikipedia), so a hospital, radio station, courthouse, power station or water tower
// with a Wikipedia article in range became a History pin — the reported case ("Advocate Illinois
// Masonic Medical Center ... is a 551-bed non-profit teaching hospital"). WIKI_STOP_RE
// (#96/#105 — settlements, schools, transit, bare `station`) drops its class UNCONDITIONALLY;
// this class is DIFFERENT: an ordinary hospital is noise, but a landmarked/NRHP-listed one is
// exactly what History is for. So it is a CONDITIONAL drop — matched here, then exempted by
// hasHistoricSignal() below. Same three-guard skeleton as WIKI_STOP_RE/WIKI_PARK_RE
// (copula-anchored; ≤3 non-function adjectives; the noun must be followed by punctuation or a
// continuation word) so "is a historic radio tower" and "is a radio station licensed to ..."
// match while "is a hospital drama" / "is a courthouse square" do not.
// ACCEPTED TRADES (gravestones):
//   - The trailing allow-list is WIDER than WIKI_STOP_RE's: it adds licensed/broadcasting/
//     broadcast/owned/operated/airing/providing, because a radio/TV station's opener is
//     "is a radio station LICENSED to ..." — the very phrasing WIKI_STOP_RE's bare `station`
//     misses, which is why these leak today.
//   - police/fire/power stations phrased "... station in ..." are ALREADY dropped
//     unconditionally by WIKI_STOP_RE's bare `station` and never reach this conditional gate,
//     so a historic firehouse phrased that way still drops. WIKI_STOP_RE is left UNTOUCHED
//     (do not fold #105's stations into here — that reverses a shipped decision); this class
//     only adds the civic/utility nouns #105 never covered.
//   - bare "tower" is EXCLUDED (Willis Tower is a landmark; and its opener says "skyscraper"
//     anyway) — only radio/broadcast/transmission/water/cooling towers are utility towers.
const WIKI_INSTITUTIONAL_RE = /\b(?:is|was)\s+(?:one\s+of\s+the|a|an|the)\s+(?:(?!(?:in|of|on|to|at|for|by|with|from|near|within|the|a|an|and)\b)[^\s.]+\s+){0,3}?(?:hospitals?|medical\s+cent(?:er|re)s?|health\s+cent(?:er|re)s?|clinics?|(?:radio|television|tv|fm|am|broadcast)\s+stations?|(?:radio|broadcast|transmission|transmitter|water|cooling)\s+(?:towers?|masts?)|courthouses?|(?:power|electric(?:al)?|generating)\s+(?:stations?|plants?)|power\s+plants?|pumping\s+stations?|(?:sewage|water|wastewater)\s+treatment\s+(?:plants?|works)|prisons?|jails?|penitentiar(?:y|ies)|correctional\s+(?:facilit(?:y|ies)|institutions?|cent(?:er|re)s?)|post\s+offices?|airports?|airfields?|aerodromes?|airstrips?|heliports?|air\s+bases?|air\s+force\s+bases?|aviation\s+(?:accidents?|disasters?)|air\s+disasters?|air(?:craft|line|liner|plane)?\s+(?:accidents?|crashes?|disasters?)|mid-?air\s+collisions?|plane\s+crashes?)(?=\s*(?:[,.;:()\[\]{}"\u201c\u201d\u2014]|$)|\s+(?:in|of|on|and|within|near|located|situated|serving|which|that|for|between|licensed|broadcasting|broadcast|owned|operated|airing|providing)\b)/i;

// #13 — THE HISTORIC EXEMPTION. Scans the FULL extract (not just the opener), because the
// notability marker is usually the SECOND sentence ("It was listed on the National Register of
// Historic Places in 1985."). Deliberately STRONG signals only — bare "historic" is excluded
// (a radio station "in the historic downtown" must NOT be kept on that alone); it takes an
// explicit register/landmark/district/site designation.
const WIKI_HISTORIC_SIGNAL_RE = /National\s+Register\s+of\s+Historic\s+Places|\bNRHP\b|National\s+Historic\s+Landmark|(?:National|State)\s+Historic\s+Site|historic\s+district|listed\s+on\s+the\s+(?:National|State)\s+Register|designated\s+(?:a\s+|an\s+)?(?:national\s+|state\s+|local\s+)?historic\s+(?:landmark|site|district|monument)/i;
function hasHistoricSignal(extract) {
  return WIKI_HISTORIC_SIGNAL_RE.test(String(extract || ""));
}

function isLowValueWikiArticle(title, extract) {
  if (!WIKI_RELEVANCE_FILTER) return false;
  const t = String(title || "");
  // #96b — title first: it is the only signal that survives a missing extract.
  if (t && (WIKI_TITLE_SCHOOL_RE.test(t) || WIKI_TITLE_SETTLEMENT_RE.test(t) ||
            WIKI_TITLE_TRANSIT_RE.test(t) || WIKI_TITLE_STATION_PAREN_RE.test(t) ||
            (WIKI_TITLE_AVIATION_RE.test(t) && !WIKI_TITLE_AVIATION_KEEP_RE.test(t)))) return true; // #293 — flight-number / air-disaster titles, memorials & museums exempt
  // #280 — a disambiguation page ("<Name> may refer to: …") is a list of
  // same-named things, not a description. Promoted here from resolveWikiByName's
  // local guard so the CACHED tile-build paths also drop it — the geosearch
  // (fetchWikipedia) and, the one that actually bit, the osm-wiki title enrich
  // (fetchWikiExtractsByTitle, which fetches by TITLE regardless of coordinates
  // and so CAN pull a disambig article an OSM `wikipedia=` link points at) —
  // instead of baking a "may refer to" dump into a 21-day tile. Tested on the
  // RAW extract: the disambig marker is the lead line itself, not the
  // copula-anchored opener wikiOpener() extracts. (WIKI_DISAMBIG_RE is declared
  // further down with the #54 resolver machinery; it is only referenced at
  // request time, never at module load, so the forward reference is safe.)
  if (extract && WIKI_DISAMBIG_RE.test(String(extract))) return true;
  const opener = wikiOpener(extract);
  if (!opener) return false; // no extract AND no title tell = no evidence; keep it
  if (WIKI_STOP_RE.test(opener)) return true; // #96/#105 — unconditional class
  // #293 (v31) — narrative crash opener (flight number + incident verb), memorials exempt
  if (WIKI_AVIATION_OPENER_RE.test(opener) && !WIKI_AVIATION_OPENER_KEEP_RE.test(opener)) return true;
  // #13 — civic/utility class: drop UNLESS the article carries a strong historic marker.
  if (WIKI_INSTITUTIONAL_RE.test(opener) && !hasHistoricSignal(extract)) return true;
  return false;
}

// --- #102: classify a wiki article from its own opener ----------------------
// fetchWikipedia() used to stamp category:"history" on EVERY article it returned
// — there was no classification step on the Wikipedia path at all, so a park, a
// lake and a battlefield were all "history" by construction. A metropark filed
// as history is the reported case (Pearson Metropark, Oregon OH: "is a regional
// park in ..."). This is #96's option (a): read the OPENER we already fetched and
// map it to a real category. It reuses WIKI_STOP_RE's exact three-guard skeleton
// (copula-anchored; at most three NON-function adjectives may intervene; the noun
// must be followed by a preposition or punctuation) so "regional" sits in the
// adjective run and "is a regional park in Oregon, Ohio" matches, while
// "parkway", "parking garage" and "park ranger" do NOT (the trailing lookahead
// fails on the char after "park"). Free — same already-fetched text, same
// English-only brittleness as the two filters above.
//
// SCOPE THIS PASS, stated so the omissions are decisions and not oversights:
//   - CLASSIFIES, NEVER DROPS. The row's shorthand also had "is a lake" → skip
//     and "is a bridge" → skip, but dropping natural features is a RELEVANCE call
//     (#13's "a story"), not a categorisation one, and a scenic lake or a historic
//     bridge may be exactly what #13 wants. Deferred to its own row rather than
//     shipped blind — this change can only ever MOVE a park out of history, so it
//     cannot lose a good pin.
//   - PARK FAMILY ONLY. Bars/restaurants/shops/trails from a wiki opener are a
//     thinner, riskier signal; added later if measured. classifyWikiOpener returns
//     null (→ the "history" default) for everything it does not recognise, so
//     extending it is a one-line addition here.
// ACCEPTED TRADES (gravestones): bare "garden" is EXCLUDED — "is a beer garden in
// ..." is bars (biergarten), so only "botanical garden" is a park noun. "is a
// memorial park in ..." resolves to park (park wins over the "memorial" adjective);
// low-volume and a memorial park is walkable green space, so #16 colour-is-category
// is satisfied. If either bites, narrow the noun list — do NOT widen it into the
// WIKI_STOP_RE drop path.
const WIKI_PARK_RE = /\b(?:is|was)\s+(?:one\s+of\s+the|a|an|the)\s+(?:(?!(?:in|of|on|to|at|for|by|with|from|near|within|the|a|an|and)\b)[^\s.]+\s+){0,3}?(?:metroparks?|metropolitan\s+parks?|regional\s+parks?|state\s+parks?|national\s+parks?|county\s+parks?|city\s+parks?|municipal\s+parks?|public\s+parks?|linear\s+parks?|urban\s+parks?|nature\s+(?:reserves?|preserves?)|nature\s+cent(?:er|re)s?|wildlife\s+(?:refuges?|preserves?)|botanical\s+gardens?|arboreta|arboretums?|parks?)(?=\s*(?:[,.;:()\[\]{}"\u201c\u201d\u2014]|$)|\s+(?:in|of|on|and|within|near|located|situated|serving|which|that|for|between)\b)/i;

function classifyWikiOpener(title, extract) {
  const opener = wikiOpener(extract);
  if (opener && WIKI_PARK_RE.test(opener)) return "park";
  return null; // fall through to the caller's "history" default
}

async function fetchWikipedia(lat, lng) {
  // #96b — ggslimit WAS 25 and exlimit was unset. MediaWiki's TextExtracts caps
  // exlimit at 20, so on any tile returning more than 20 articles at least five
  // arrived with NO `extract` field — invisible to an opener-based filter, and
  // (since long before #96) rendered with the generic "A notable local
  // landmark." fallback below. Aligned at 20/20 and exlimit stated explicitly
  // rather than inherited: the parameter's default has changed between
  // MediaWiki versions, and this query is the one place that cannot afford it.
  // Cost is five fewer candidate articles per dense tile, which is a good trade
  // for five fewer undescribed ones.
  // #77 — `exsentences=2` REMOVED. It was the binding truncation: the extract
  // was capped at two sentences before it ever left this function, so scaffolded
  // pins read as thin even though the article had more. `exintro=1` stays, so
  // this is still bounded to the lead SECTION (not the whole article) — the
  // natural "read this" unit — it just no longer chops the lead to two lines.
  // ggslimit/exlimit stay at 20/20: that is #96b's alignment (TextExtracts caps
  // exlimit at 20) and is a SEPARATE fact from the sentence cap. Do not couple.
  const url = "https://en.wikipedia.org/w/api.php?action=query&format=json" +
    "&generator=geosearch&ggscoord=" + lat + "%7C" + lng +
    "&ggsradius=6000&ggslimit=20" +
    "&prop=coordinates%7Cextracts&exintro=1&explaintext=1&exlimit=20&colimit=max";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WIKI_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": WIKI_UA } });
    if (!res.ok) throw new Error("wiki " + res.status);
    const json = await res.json();
    const pages = (json.query && json.query.pages) || {};
    const out = [];
    let wikiDropped = 0;
    let wikiNoExtract = 0;
    Object.values(pages).forEach((pg) => {
      const co = pg.coordinates && pg.coordinates[0];
      if (!co) return;
      const raw = (pg.extract || "").trim();
      // #96b — REPORTED, NOT SILENT. With the query aligned this should be 0.
      // If it is not, the cap moved again and the title rules are the only
      // thing standing between a settlement and the map.
      if (!raw) wikiNoExtract++;
      // #96 — the low-value filter reads the FULL opener (`raw`) and runs
      // before `desc` is used, so #77 removing the truncation below cannot
      // change what it drops. The opener is what the stoplist reads.
      if (isLowValueWikiArticle(pg.title, raw)) { wikiDropped++; return; }
      // #77 — the 220-char slice that used to sit here is GONE. It was a source
      // truncation: once it cut the text, no client surface could recover it.
      // The extract now reaches the client whole. Length is handled AT the
      // surface — the one live render, `.ps-desc` in the expanded pin sheet,
      // scrolls (max-height:44vh; overflow-y:auto). Truncate at the surface,
      // never at the source.
      // #101 — the `|| "A notable local landmark."` fallback is GONE. It was an
      // invented sentence rendered on genuine stubs (an empty intro, an
      // infobox-only article, or the next time an API limit moves) and was the
      // last survivor of the family #37 and #21(a) deleted. Emit null and let the
      // pin sheet render NO description block — #53's rule, and #21(a) already
      // proved that renders fine. The low-value filter above reads `raw`, not
      // `desc`, so nulling this cannot change what it drops.
      const desc = raw;
      out.push({
        id: "wiki_" + pg.pageid, name: pg.title, lat: co.lat, lng: co.lon,
        desc: desc || null,
        // #102 — classify from the opener (park-family → 'park'); everything else
        // keeps the historical default. This is the ONLY place a wiki category is
        // decided at fetch time; dedupeReal below is the other half (it can adopt
        // an OSM category onto a wiki pin it merges into).
        category: classifyWikiOpener(pg.title, raw) || "history", source: "wiki", real: true,
      });
    });
    return { places: out, wikiDropped, wikiNoExtract };
  } finally { clearTimeout(timer); }
}

// --- #163: enrich linked OSM history pins from their OWN wikipedia= tag --------
// The geosearch above (fetchWikipedia) finds articles by PROXIMITY and dedupes
// them onto OSM pins by name-within-90m. That misses the exact case this is for:
// a grave or a sculpture whose OSM node carries an explicit `wikipedia=` tag but
// whose article is geotagged elsewhere (a person's bio has no grave coordinate)
// or under a different name — so it never lands on the tile or never dedupes onto
// the pin, and the pin keeps osmDesc's constructed line ("A local landmark
// (tomb)." / "A sculpture by Ellsworth Kelly."). parseOverpass has already put
// each eligible history pin's en-wikipedia title on `rec.wp`; this follows that
// EDITOR-ASSERTED link and drops the article intro onto the pin — the same
// exintro/explaintext text the source:"wiki" pins get.
//
// SCOPE = OPTION A (#163): wikipedia= tag only. Nodes carrying only a wikidata=
// Q-id are resolved by Option B (#164, enrichOsmWikidata below) — a separate
// step so its extra resolve hop fails in isolation if it fails.
//
// Best-effort throughout: any fetch/parse failure leaves the pin's osmDesc line
// untouched (strictly additive, never worse). Runs BEFORE the cache write so the
// article intro is baked into the tile and served for 21 days with no
// per-request wiki call — the same economics as the geosearch text.
const WIKI_EXTRACT_CHUNK = 20; // MediaWiki TextExtracts caps exlimit at 20 (#96b)

// Fetch intros for a set of exact article titles. Returns a Map keyed by the
// REQUESTED title -> extract string, or null where there is nothing usable.
// Handles MediaWiki's title normalisation and redirect hops so a redirect or a
// case/underscore variant still maps back to the title we asked for.
async function fetchWikiExtractsByTitle(titles) {
  const out = new Map();

  // #290 — split into MediaWiki-legal chunks (exlimit caps at 20) and fetch them
  // CONCURRENTLY. The old loop `await`ed each chunk before starting the next, so a
  // dense tile with >20 linked titles (Midtown Manhattan carried 35 → 2 chunks)
  // paid two serial Wikipedia round-trips stacked AFTER Overpass — the one place
  // #289's overlap could not help, because this fetch is data-dependent on
  // Overpass's titles and the quick geosearch is long done by the time it starts.
  // Chunks are independent (titles are deduped upstream, so each chunk writes only
  // its OWN keys into `out` — no overlap, no lost-update), so firing them in
  // parallel collapses N serial round-trips into one wall-clock call. Per-chunk
  // try/catch is preserved: one chunk failing leaves its pins on their osmDesc
  // line without sinking the others, and the worst-case wall time drops from
  // N×WIKI_TIMEOUT_MS to WIKI_TIMEOUT_MS. Same titles in, same extracts out — no
  // cached shape changes, so this rides CACHE_VERSION v29 with no bump.
  const chunks = [];
  for (let i = 0; i < titles.length; i += WIKI_EXTRACT_CHUNK) {
    chunks.push(titles.slice(i, i + WIKI_EXTRACT_CHUNK));
  }

  const fetchChunk = async (chunk) => {
    const url = "https://en.wikipedia.org/w/api.php?action=query&format=json" +
      "&prop=extracts&exintro=1&explaintext=1&exlimit=20&redirects=1&titles=" +
      chunk.map((t) => encodeURIComponent(t)).join("%7C");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WIKI_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": WIKI_UA } });
      if (!res.ok) throw new Error("wiki-extract " + res.status);
      const q = ((await res.json()) || {}).query || {};
      const norm = {}; (q.normalized || []).forEach((n) => { norm[n.from] = n.to; });
      const redir = {}; (q.redirects || []).forEach((r) => { redir[r.from] = r.to; });
      const byTitle = {};
      Object.values(q.pages || {}).forEach((pg) => { if (pg && pg.title) byTitle[pg.title] = pg; });
      const resolve = (req) => {
        let t = req;
        if (norm[t]) t = norm[t];   // normalisation hop (underscores, first-letter case)
        if (redir[t]) t = redir[t]; // redirect hop
        return byTitle[t] || null;
      };
      chunk.forEach((req) => {
        const pg = resolve(req);
        const extract = pg && pg.extract ? String(pg.extract).trim() : "";
        // Filter with the ARTICLE'S OWN title (a mis-link points at a
        // settlement/school/station; #96's title+opener rules catch it), then
        // keep only if there is a real extract to show.
        out.set(req, (extract && !isLowValueWikiArticle(pg.title, extract)) ? extract : null);
      });
    } catch (_e) {
      // Chunk failed: leave its titles unresolved. Their pins keep osmDesc.
      chunk.forEach((req) => { if (!out.has(req)) out.set(req, null); });
    } finally { clearTimeout(timer); }
  };

  await Promise.all(chunks.map(fetchChunk));
  return out;
}

// --- #54: resolve a place's "what it is" by NAME, not by tile proximity -------
// The tile geosearch/Overpass path only surfaces places OSM or a nearby-article
// happens to carry. The diagnostic on Mr. Beef proved the gap: a famous,
// Wikipedia-documented, cash-only local spot that OSM simply does not have — 108
// tile places, none of them it. For a product about word-of-mouth places that
// is the COMMON case, not an edge one. This searches Wikipedia BY NAME (the same
// path seed-resolve.ts's wikiEnrich uses), verifies the found article's OWN
// coordinate is within WIKI_NAME_SANITY_M of the pin (so a same-named place in
// another city is rejected), and returns one place STAMPED AT THE PIN'S COORDS
// so the client's <90 m twin check accepts it. Server-side by #37's rule (no
// client CORS/native call), adjacent to the #163 wiki enrichment that already
// owns Wikipedia here. Per-request only — NOT written to the tile cache, so it
// changes no cached shape and needs a redeploy but NO CACHE_VERSION bump.
const WIKI_NAME_SANITY_M = 1000;
function _wikiNameTokens(s) {
  const STOP = new Set(["the", "of", "a", "an", "and", "at", "in", "on", "chicago", "il", "illinois"]);
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
}
function _wikiTitleScore(name, title) {
  const A = _wikiNameTokens(name), B = new Set(_wikiNameTokens(title));
  if (!A.length || !B.size) return 0;
  let hit = 0; for (const w of A) if (B.has(w)) hit++;
  return hit / A.length; // fraction of the place-name's words the article title covers
}
// #54 — a DISAMBIGUATION page ("Lakefront may refer to: ...") is a list of
// same-named things, not a description of a place. It carries NO coordinates, so
// it also slips past the distance sanity below, and it half-matches a multi-word
// place name (bare "Lakefront" covers 1 of {lakefront,trail} = 0.5), so without
// this guard "Lakefront Trail" rendered the whole "may refer to" dump as its blurb
// (the reported case). #280 — this is NOW ALSO promoted into
// isLowValueWikiArticle, so the CACHED tile-build paths (geosearch + osm-wiki
// title enrich) drop a disambig page too instead of baking a "may refer to" dump
// into a tile. That promotion is what carries this deploy's CACHE_VERSION bump
// (v28 → v29): it changes which articles survive into the cache. The redundant
// local test on `raw` in resolveWikiByName below is KEPT as belt-and-suspenders
// (that resolver is per-request, never cached) alongside its `(disambiguation)`
// title guard — a cheap double-check, not a second source of truth.
const WIKI_DISAMBIG_RE = /^.{0,80}?\b(?:may|can)\s+refer\s+to\b|\bis\s+a\s+disambiguation\s+page\b/i;
// #54 — WIKI_NAME_SANITY_M (1 km) exists to reject a same-named place in another
// city. But a long LINEAR feature — an 18-mi trail, a 3-mi elevated park — has ONE
// article centroid sitting kilometres from wherever a pin lands on it, so the
// strict 1 km rejected the CORRECT article ("Chicago Lakefront Trail",
// "Bloomingdale Trail") and left only the coordinate-less disambig junk, or
// nothing. When the article TITLE is a subset of the place NAME (every title word
// appears in the name — so the name IS the article's subject, optionally plus a
// qualifier like "The 606 (…)"), that is a strong identity signal, so widen the
// radius to metro scale. A different-CITY namesake is titled with its own
// qualifier ("Lincoln Park, Michigan") whose extra token breaks the subset, so it
// stays on the strict 1 km — the wrong-city guard is preserved. BOUNDED, not
// skipped: a namesake within 25 km could still slip, an accepted trade for the
// linear-feature class this is here to rescue.
const WIKI_NAME_SANITY_STRONG_M = 25000;
// #318 — on the RECALL path only (strictLoc), an article whose OWN coordinate sits this
// close to the pin is treated as the same place even when its title shares no tokens with
// the search alias — the alias case ("Kwa-Ma-Rolas" pin → "Kwanusila" article) where
// name-matching is structurally impossible and the coordinate is the only identity. Kept
// far TIGHTER than the location radius so a nearby-but-distinct landmark can't cross-match.
const WIKI_COORD_IDENTITY_M = 150;
function _titleTokensSubsetOfName(name, title) {
  const N = new Set(_wikiNameTokens(name));
  const T = _wikiNameTokens(title);
  if (!T.length || !N.size) return false;
  for (const w of T) if (!N.has(w)) return false; // every title word is in the place name
  return true;
}
// #318 — the HINT half of the context check. _wikiTitleScore asks "what fraction
// of the PIN NAME's words does the title cover"; for a free-text user writeup
// that is the wrong direction (a 12-word writeup shares few words with a 2-word
// title). Here we ask the containment the other way: what fraction of the
// TITLE's distinctive words appear IN the writeup. "Dillinger died here" carries
// no shared token with "Biograph Theater" (name score 0), but the writeup
// ("...shot outside the Biograph Theater...") contains both title tokens → 1.0,
// so the operator-authorized hint lets a descriptively-named gem match the real
// article by RECALL. This only ever RELAXES the name half — the LOCATION anchor
// in descriptionGate (coordinate present + within radius) is unchanged, so a hint
// can never attach an article whose coordinate is not sitting on the pin.
function _titleCoveredByText(text, title) {
  const T = _wikiNameTokens(title), H = new Set(_wikiNameTokens(text));
  if (!T.length || !H.size) return 0;
  let hit = 0; for (const w of T) if (H.has(w)) hit++;
  return hit / T.length; // fraction of the article title's words the writeup contains
}
// --- #316: THE COORDINATE+CONTEXT GATE — one home for "is this the RIGHT place?" -
// Every path that attaches a SOURCED description decides accept/reject HERE, so
// the "blank beats wrong" rule (#101/#178) lives in ONE place (#98) instead of
// being re-derived per caller. Returns true to ACCEPT the attach, false to REJECT
// (→ the caller emits null / keeps its existing line). Three checks, ALL required:
//
//   (a) CONTEXT — name-token match: the article title must plausibly BE this
//       place, i.e. cover at least half the place-name's distinctive words
//       (_wikiTitleScore ≥ WIKI_NAME_MIN_SCORE, the #54 0.5 floor) AND cover at
//       least one DISTINCTIVE (non-generic-type) token, so a 0.50 built purely
//       from generic words like "national"/"memorial"/"museum" can't clear it
//       (#351 — the #303 generic-type-word pad ported to the gate; via
//       _nameMatchesTitle / _hintCoversTitle).
//   (b) LOCATION — the article's OWN coordinate must sit within radius of the pin.
//       #288: a coordinate-LESS candidate is REJECTED, never accepted on the name
//       alone (the Lake-Erie-"Central-Basin"-on-a-Chicago-pin failure). The radius
//       widens to metro scale (WIKI_NAME_SANITY_STRONG_M) when the title is a
//       subset of the name (#54 linear-feature rescue: an 18-mi trail has one far
//       centroid), and stays strict (WIKI_NAME_SANITY_M) otherwise so a
//       different-city namesake with its own qualifier token still drops.
//   (c) TYPE — a real extract that is NOT a disambiguation page and NOT a
//       low-value class (isLowValueWikiArticle — the shared #96/#105/#13/#280/#293
//       context filter, and the /\(disambiguation\)/ title tell).
//
// This is the FORMALISATION of #316: the exact discipline resolveWikiByName
// already applied, lifted into a named predicate so #315 (the forward submit path)
// and #318 (the source cascade) can attach through the SAME gate rather than
// re-implementing it. The one behavioural delta vs the old inline form is that the
// TYPE check now runs PER CANDIDATE instead of only on the score winner, so a real
// article is no longer shadowed by a higher-scoring junk candidate (a disambig
// page, or one with no extract) that the old post-loop check would let win and
// then null out — strictly a recovery, never a new attach. All thresholds are
// unchanged. resolveWikiByName is per-request and never cached, so this rides the
// existing CACHE_VERSION with NO bump (the #288 precedent).
const WIKI_NAME_MIN_SCORE = 0.5; // #54 — the article title must cover ≥ half the place-name's distinctive words
// #351 — GENERIC TYPE / SCOPE WORDS: words that say what KIND of place something is
// ("National", "Memorial", "Museum", "Park", "Hall", …) rather than WHICH one. Two
// different places can share every one of these and nothing else: "Federal Hall National
// Memorial" and "National September 11 Memorial & Museum" share {national, memorial} and
// NOTHING distinctive, yet that 2-of-4 = 0.50 cleared WIKI_NAME_MIN_SCORE and — with the
// 9/11 article's coordinate ~700 m inside WIKI_NAME_SANITY_M — the gate wrong-attached the
// 9/11 Museum's description to Federal Hall (downgrading a correct stored line, #333). This
// is the #303 generic-type-word pad — the seed geocoder's labelMatchesName guard — ported to
// the DESCRIPTION gate. A name (or hint) match must now rest on ≥ 1 DISTINCTIVE token, never
// on generic words alone. Applies to rung 1 AND the #345 affix rung equally (both gate here).
const WIKI_GENERIC_NAME_TOKENS = new Set([
  "national", "state", "county", "city", "municipal", "regional", "international",
  "memorial", "museum", "monument", "park", "gardens", "garden", "hall", "house",
  "center", "centre", "building", "site", "square", "plaza", "fountain", "statue",
  "sphere", "collection", "library", "theater", "theatre", "church", "cathedral",
  "cemetery", "bridge", "tower", "market", "gallery", "institute", "society",
  "foundation", "association", "district", "historic", "historical",
]);
function _distinctiveNameTokens(s) {
  return _wikiNameTokens(s).filter((w) => !WIKI_GENERIC_NAME_TOKENS.has(w));
}
// #351 — the NAME half of the context check. A title matches only when it (a) clears the #54
// score floor AND (b) covers ≥ 1 DISTINCTIVE (non-generic-type) token of the pin name — so a
// 0.50 built purely from "national"+"memorial" no longer passes. THE EXCEPTION: a name with
// NO distinctive token at all (a purely generic "The Monument" / "Memorial Park") falls back
// to the bare score floor — there is nothing distinctive to demand, and the LOCATION + TYPE
// halves of the gate still apply — so this can only REJECT generic-collision attaches, never
// newly reject a name that carries its own distinctive identity (the 5 "…Memorial" pins that
// resolve today all match on their proper-noun tokens and are unaffected).
function _nameMatchesTitle(name, title) {
  if (_wikiTitleScore(name, title) < WIKI_NAME_MIN_SCORE) return false;
  const distinctive = _distinctiveNameTokens(name);
  if (!distinctive.length) return true;               // all-generic name → score floor stands (no regression)
  const T = new Set(_wikiNameTokens(title));
  return distinctive.some((w) => T.has(w));
}
// #351 — the HINT half (#318 recall), same discipline in the title→writeup direction: the
// writeup must cover ≥ the floor of the title's tokens AND ≥ 1 DISTINCTIVE title token, so a
// writeup that merely contains generic type words can't clear it. ("Dillinger died here" /
// "…shot outside the Biograph Theater" still resolves — the writeup covers the distinctive
// title token "biograph", not just the generic "theater".)
function _hintCoversTitle(hint, title) {
  if (_titleCoveredByText(hint, title) < WIKI_NAME_MIN_SCORE) return false;
  const distinctive = _distinctiveNameTokens(title);
  if (!distinctive.length) return true;               // all-generic title → floor stands
  const H = new Set(_wikiNameTokens(hint));
  return distinctive.some((w) => H.has(w));
}
function descriptionGate({ name, lat, lng, title, coord, extract, hint, strictLoc }) {
  if (!name || typeof lat !== "number" || typeof lng !== "number" || !title) return false;
  // (b) LOCATION FIRST (the coordinate-identity context fallback below needs the
  // distance). Coordinate present (#288) AND within radius. The name-subset radius
  // WIDENS to metro scale (#54) only for the rung-1 NAME search, where `name` is the
  // real pin name and a title-subset means a genuine long-linear-feature relationship.
  // For a CANDIDATE search (Wikidata / AI-recall / literal-hint) `name` is the candidate
  // title itself, so those rungs pass `strictLoc:true` to force the tight radius — a
  // point landmark must sit AT its pin, not anywhere in the metro (the Kwa-Ma-Rolas →
  // Lincoln Park Zoo wrong-attach: the zoo article ~3 km away passed only because the
  // wide radius applied to a recall candidate).
  if (!coord || typeof coord.lat !== "number" || typeof coord.lon !== "number") return false;
  const distM = haversine(lat, lng, coord.lat, coord.lon);
  const maxM = (!strictLoc && _titleTokensSubsetOfName(name, title)) ? WIKI_NAME_SANITY_STRONG_M : WIKI_NAME_SANITY_M;
  if (distM > maxM) return false;
  // (a) CONTEXT — the title must plausibly BE this place: a name-token match (the #54
  // floor) OR, when a writeup HINT is supplied (#318), the title's tokens appearing in
  // it. For an ALIAS recall the article's real title differs from the pin name BY
  // DEFINITION (OSM "Kwa-Ma-Rolas" → article "Kwanusila"), so name-scoring can NEVER
  // validate it — the only honest identity signal is the coordinate. So on the recall
  // path (strictLoc) a coordinate sitting essentially ON the pin (≤ WIKI_COORD_IDENTITY_M)
  // satisfies context by itself. This is TIGHTER than the location gate, not looser: the
  // zoo (3 km) and Lincoln Park (1.17 km) are already rejected by distance above; only a
  // real, non-junk article within ~150 m — overwhelmingly the same place — passes here.
  const nameOk = _nameMatchesTitle(name, title);              // #351 — ≥1 distinctive token, not generic words alone
  const hintOk = !!hint && _hintCoversTitle(hint, title);     // #351 — same distinctive-token discipline for the recall hint
  const coordIdentity = !!strictLoc && distM <= WIKI_COORD_IDENTITY_M;
  if (!nameOk && !hintOk && !coordIdentity) return false;
  // (c) TYPE — a real, non-disambiguation, non-low-value article (#101/#280/#96/#105/#13)
  const raw = String(extract || "").trim();
  if (!raw) return false;                                       // #101 — nothing to show beats an invented line
  if (WIKI_DISAMBIG_RE.test(raw) || /\(disambiguation\)/i.test(title)) return false;
  if (isLowValueWikiArticle(title, raw)) return false;
  return true;
}

// One Wikipedia `generator=search` call → the raw candidate pages. Factored out of
// the resolver so the NAME rung and the #318 HINT rung share the exact same fetch,
// timeout, and abort discipline (one `generator=search` call per rung — the
// throttle-friendly shape #313/#314's tools settled on). Returns [] on any failure
// so the caller's rung logic never has to catch.
async function _wikiSearchPages(query) {
  const url = "https://en.wikipedia.org/w/api.php?action=query&format=json" +
    "&generator=search&gsrsearch=" + encodeURIComponent(query) + "&gsrlimit=5&gsrnamespace=0" +
    "&prop=coordinates%7Cextracts&exintro=1&explaintext=1&exlimit=20&colimit=max";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WIKI_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": WIKI_UA } });
    if (!res.ok) throw new Error("wiki-name " + res.status);
    const q = ((await res.json()) || {}).query || {};
    return Object.values(q.pages || {});
  } catch (_e) {
    return [];
  } finally { clearTimeout(timer); }
}

// #318 — HYDRATE one article by EXACT title. The multi-page generator=search query
// above truncates extracts (Mr. Beef came back as one 87-char sentence) AND
// intermittently drops coordinates (A Signal of Peace: real article, coordinate
// omitted, so it failed the location gate and blanked — confirmed against the live API,
// where a single-title fetch returns the coordinate the combined query did not). So the
// resolver hydrates its chosen candidate here for a reliable PRIMARY coordinate + the
// full intro. Follows redirects. Returns null (missing/error) so the caller falls back
// to the search-data candidate.
async function _wikiHydrate(title) {
  const t = String(title || "").trim();
  if (!t) return null;
  const url = "https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1" +
    "&titles=" + encodeURIComponent(t) +
    "&prop=coordinates%7Cextracts&coprimary=all&colimit=max&exintro=1&explaintext=1";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WIKI_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": WIKI_UA } });
    if (!res.ok) throw new Error("wiki-hydrate " + res.status);
    const pg = Object.values((((await res.json()) || {}).query || {}).pages || {})[0];
    if (!pg || pg.missing !== undefined || !pg.title) return null;
    return pg;                                       // {title, pageid, coordinates:[{lat,lon}], extract}
  } catch (_e) {
    return null;
  } finally { clearTimeout(timer); }
}

// #318 — find the best Wikipedia article for a query, hydrating candidates so the gate
// sees a RELIABLE coordinate + FULL intro rather than the combined search's truncated,
// coordinate-flaky rows. Ranks by name/hint score (then search relevance, so an ALIAS
// hit with no name overlap but sitting ON the pin is still considered on the recall
// path), then hydrates and gates up to CAP candidates. `pick` is the resolver's gate
// closure (carries the pin lat/lng). RECALL/strictLoc rungs allow score-0 candidates
// (coordinate-identity decides); rung 1 requires a name match. Bounded fan-out so a hard
// pin can't burst Wikipedia.
async function _bestArticle(query, matchName, matchHint, strictLoc, pick, lat, lng) {
  const pages = await _wikiSearchPages(query);
  if (!pages || !pages.length) return null;
  const okNums = typeof lat === "number" && typeof lng === "number";
  const scored = pages
    .filter((pg) => pg && pg.title)
    .map((pg, i) => {
      const nameS = Math.max(_wikiTitleScore(matchName, pg.title), matchHint ? _titleCoveredByText(matchHint, pg.title) : 0);
      let key = nameS;
      // On the RECALL path (strictLoc), a candidate that ALREADY carries a coordinate
      // near the pin is the strongest signal — it outranks name-token matches, closest
      // first. This is why an ALIAS hit like "Kwanusila" (name score 0, coordinate ON the
      // pin) must beat "Totem pole"/"Lincoln Park" (name score 0.5, wrong/far), which
      // otherwise crowd it out of the hydrate budget.
      if (strictLoc && okNums) {
        const co = (pg.coordinates && pg.coordinates[0]) || null;
        if (co && typeof co.lat === "number" && typeof co.lon === "number") {
          const km = haversine(lat, lng, co.lat, co.lon) / 1000;
          if (km <= 2) key = 10 - km;
        }
      }
      return { pg, i, nameS, key };
    })
    .sort((a, b) => (b.key - a.key) || (a.i - b.i));
  const CAP = strictLoc ? 4 : 2;
  let tried = 0;
  for (const { pg, nameS } of scored) {
    if (!strictLoc && nameS < WIKI_NAME_MIN_SCORE) break;   // rung 1: require a name match to spend a hydrate
    if (tried >= CAP) break;
    tried++;
    const h = await _wikiHydrate(pg.title);
    const cand = h || pg;                                   // hydrate failed → fall back to search-data row
    if (pick([cand], matchName, matchHint, strictLoc)) return cand;
  }
  return null;
}
// candidate canonical names the place could be found under (or []), so a gem whose
// writeup DESCRIBES a place without NAMING it resolves by recall. WHY A LIST, NOT ONE
// NAME: a "site of X" pin can be named at several granularities — the building, the
// EVENT that happened there, the PERSON associated with it, the WORK created there —
// and only SOME have their own geolocated article. A single-name prompt is whack-a-
// mole: bias it toward the building and "Site of the Great Chicago Fire" loses the
// event; bias it toward the event/person and "John Dillinger Fate Alley" names the
// person (no article) instead of the Biograph (has one). Returning several and letting
// the COORDINATE GATE pick the one geolocated at the pin removes the guessing: the
// model supplies recall, the gate supplies correctness. Every candidate runs through
// the SAME descriptionGate with the pin coordinate the unchanged hard anchor, so a
// wrong/hallucinated name costs nothing — it fails the gate and the pin stays blank
// (blank beats wrong, #101/#178; harness-verified: Biograph resolves, Great Chicago
// Fire 65 m resolves, every Oz candidate — book/author/house — blanks).
// CONFIG-OUTSIDE-THE-FILE: needs GEMINI_API_KEY in THIS function's env (separate from
// review-submission's — Supabase scopes secrets per function). No key → returns [] →
// the rung is INERT and the resolver falls back to the #318 literal writeup search.
// Mirrors review-submission's proven call shape (temperature 0, JSON, 2-try retry).
// Per-request, never cached (NO CACHE_VERSION bump).
const AI_MODEL = (Deno.env.get("GEMINI_MODEL") || "").trim() || "gemini-3.1-flash-lite";
const AI_RECALL_MIN_CONF = 0.5;                    // below this the model isn't sure enough to spend Wikipedia searches
const AI_RECALL_MAX_NAMES = 3;                     // cap the candidate list (and thus the Wikipedia searches per pin)
const AI_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const AI_RETRY_DELAY_MS = 1500;
// #318 (Wikidata rung) — the open Wikidata endpoint (no API key). Search finds an item
// by label OR alias; getentities returns its P625 coordinate + enwiki sitelink + short
// description. WD_ENWIKI_RESOLVE_CAP bounds how many enwiki sitelinks we chase into a
// rich Wikipedia intro per query (each is one extra Wikipedia search), so a resolve
// can't fan out into a burst — the #313/#314 throttle lesson.
const WD_ENDPOINT = "https://www.wikidata.org/w/api.php";
const WD_SEARCH_LIMIT = 5;
const WD_ENWIKI_RESOLVE_CAP = 2;
// Shared Gemini call for BOTH recall rungs — the writeup→subject rung (#320,
// _aiResolvePlaceNames) and the name→alias rung (#318, _aiResolveNameAliases). POST the
// prompt, parse {names:[...], confidence}, enforce AI_RECALL_MIN_CONF, de-dup and cap.
// Returns [] on no-key / throttle / http / parse failure so a rung is always safely
// INERT. CRITICAL INVARIANT: the model returns only NAMES to search — never a
// description — so a wrong or hallucinated name costs nothing: it fails the coordinate
// gate downstream and the pin stays blank (blank beats wrong, #101/#178). Mirrors the
// temperature-0 / JSON / 2-try-retry shape review-submission proved.
async function _aiNameListCall(prompt) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return [];                             // no key in this function's env → rung inert
  try {
    let res = null, raw = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + AI_MODEL + ":generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, responseMimeType: "application/json" },
          }),
        },
      );
      raw = await res.text();
      if (res.ok || !AI_RETRY_STATUSES.has(res.status) || attempt === 2) break;
      await new Promise((r) => setTimeout(r, AI_RETRY_DELAY_MS));
    }
    if (!res || !res.ok) return [];                // throttle / http error → no guess (#264)
    const data = JSON.parse(raw);
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    let text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("").trim();
    if (!text) text = parts.map((p) => p.text || "").join("").trim();
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    const parsed = JSON.parse((s >= 0 && e >= 0) ? text.slice(s, e + 1) : text);
    const conf = Number(parsed.confidence);
    if (!Number.isFinite(conf) || conf < AI_RECALL_MIN_CONF) return [];
    const raw_names = Array.isArray(parsed.names) ? parsed.names
      : (typeof parsed.name === "string" ? [parsed.name] : []);  // tolerate a single-name shape too
    const seen = new Set(), out = [];
    for (const n of raw_names) {
      if (typeof n !== "string") continue;
      const nm = n.trim();
      if (!nm || nm.toLowerCase() === "null") continue;
      const k = nm.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(nm.slice(0, 120));                  // each is a NAME to search — the gate + coordinate anchor decide
      if (out.length >= AI_RECALL_MAX_NAMES) break;
    }
    return out;
  } catch (_e) {
    return [];                                     // parse / network failure → no guess
  }
}

// #320 — AI RECALL from a submitter's WRITEUP (the credited-gem path). Names what the
// note is ABOUT (building / event / person / work) so its article can be found; the
// coordinate gate then picks the right granularity. See _aiNameListCall for the
// invariant (names only, gate decides) and the header on resolveWikiByName for the
// three single-name gravestones this multi-candidate shape replaced.
async function _aiResolvePlaceNames(hint, lat, lng) {
  const writeup = String(hint || "").trim().slice(0, 400);
  if (!writeup || typeof lat !== "number" || typeof lng !== "number") return [];
  const prompt =
    "You identify what real, named subject a short user-written place description is " +
    "ABOUT, so its Wikipedia article can be found.\n" +
    "Return UP TO THREE candidate canonical names to search, MOST LIKELY FIRST. Include " +
    "the different things the place could be known as — a specific building or landmark, " +
    "the historical EVENT that happened there, the PERSON associated with it, and/or the " +
    "WORK created there — because only some may have their own article. Name what the " +
    "place is ABOUT; do NOT include the neighborhood, city, region, or street it merely " +
    "sits in (from a description of the house where an author wrote a book in a given " +
    "neighborhood, return the author, the book, and the house — NEVER the neighborhood). " +
    "Do NOT invent anything and do NOT describe. If you cannot tell what real subject the " +
    "description is about, return an empty list.\n" +
    "Respond with JSON only: {\"names\": [<string>, ...], \"confidence\": <0..1>}\n" +
    "Approximate location (lat,lng): " + lat.toFixed(4) + "," + lng.toFixed(4) + "\n" +
    "Description: " + writeup;
  return _aiNameListCall(prompt);
}

// #318 (AI RECALL for OSM/facts pins) — the OSM counterpart of _aiResolvePlaceNames. A
// browsed facts pin (history/park/trail/art) carries a NAME but no submitter writeup,
// and its real article is often under a DIFFERENT title (OSM "Kwa-Ma-Rolas" → Wikipedia
// "Kwanusila"). Given the pin's name + coordinate, the model proposes up to 3
// aliases / canonical article titles the place could sit under; each is then searched
// on Wikipedia (and Wikidata) through the SAME descriptionGate, so the pin COORDINATE
// still decides and a wrong/hallucinated alias just blanks. This is RECALL, NOT
// generation: the model supplies a NAME to look up, never a description — the text
// always comes verbatim from a coordinate-verified article. Inert without
// GEMINI_API_KEY. Reached only when Wikipedia-by-name AND Wikidata-by-name both miss,
// and (client side, #327) NOT prewarmed for OSM pins, so it fires on a genuine
// unresolved facts pin the user actually opened — bounded to taps, not a render burst.
// If OSM description volume ever makes even that a burst, the levers are a nearest-N
// prewarm cap or a client opt-in (recorded available-not-taken, the #327 pattern).
// #355 — optional `artist` (the CREATOR signal). Fed to the model as a NAMING hint for a
// public-art pin whose OSM name is a title alone / nickname; the model still returns only
// names to SEARCH and the coordinate gate still decides, so a wrong/absent creator costs
// nothing. Backward-compatible — callers that pass no artist behave exactly as before.
async function _aiResolveNameAliases(name, lat, lng, artist) {
  const nm = String(name || "").trim().slice(0, 160);
  if (!nm || typeof lat !== "number" || typeof lng !== "number") return [];
  const who = String(artist || "").trim().slice(0, 120);   // #355 — creator, when known (art pins)
  const prompt =
    "A local-discovery map has a point of interest with the NAME and LOCATION below. " +
    "Its encyclopedia article may be under a DIFFERENT title — an official name, a known " +
    "alias, the artist or subject it depicts, or a historical name.\n" +
    (who
      ? ("This point of interest is a PUBLIC ARTWORK. Its creator/artist is: " + who + ". " +
         "The work's encyclopedia article is most often titled with the work's own name " +
         "(which may be the map name above), sometimes disambiguated by its type or its " +
         "creator (for example \"<work> (sculpture)\" or \"<work> (<creator>)\"). Use the " +
         "creator to pin down the SPECIFIC work at this location — but NEVER return the " +
         "creator's own biography article, and NEVER return a different work by the same " +
         "creator that is somewhere else.\n")
      : "") +
    "Return UP TO THREE candidate canonical article names to search on Wikipedia, MOST " +
    "LIKELY FIRST, for THIS EXACT object or place.\n" +
    "CRITICAL: return names for the specific object ITSELF only. Do NOT return a larger " +
    "park, zoo, museum, garden, campus, building, district, neighborhood, city, street, " +
    "or institution that merely CONTAINS it or sits nearby — those are different places " +
    "with their own articles and would be wrong. Do NOT invent anything and do NOT " +
    "describe. If the specific object is unlikely to have its OWN encyclopedia article, " +
    "or you are not reasonably sure what it is, return an empty list.\n" +
    "Respond with JSON only: {\"names\": [<string>, ...], \"confidence\": <0..1>}\n" +
    "Place name: " + nm + "\n" +
    (who ? ("Creator/artist: " + who + "\n") : "") +
    "Approximate location (lat,lng): " + lat.toFixed(4) + "," + lng.toFixed(4);
  return _aiNameListCall(prompt);
}

// #318 (Wikidata rung) — resolve a place NAME against Wikidata and return candidate
// pages in the SAME shape _wikiSearchPages returns, so they drop straight into the
// resolver's pick() + descriptionGate with ZERO gate changes. Wikidata indexes ALIASES
// (its search matches label OR alias), so a pin whose common name differs from its
// article title can still find the right item; each candidate carries its P625
// coordinate (or none — in which case the gate's LOCATION half rejects it: Wikidata
// NEVER relaxes the coordinate anchor). `extract` is left empty here — the resolver
// fills it, choosing the enwiki sitelink's rich Wikipedia intro or the terse-but-
// SOURCED Wikidata description. Returns [] on any failure (open endpoint, no key).
async function _wikidataCandidatePages(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WIKI_TIMEOUT_MS);
  try {
    const sUrl = WD_ENDPOINT + "?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=" +
      WD_SEARCH_LIMIT + "&search=" + encodeURIComponent(q);
    const sRes = await fetch(sUrl, { signal: ctrl.signal, headers: { "User-Agent": WIKI_UA } });
    if (!sRes.ok) throw new Error("wd-search " + sRes.status);
    const ids = (((await sRes.json()) || {}).search || []).map((r) => r && r.id).filter(Boolean).slice(0, WD_SEARCH_LIMIT);
    if (!ids.length) return [];
    const gUrl = WD_ENDPOINT + "?action=wbgetentities&format=json&ids=" + encodeURIComponent(ids.join("|")) +
      "&props=claims%7Csitelinks%7Cdescriptions%7Clabels&languages=en&sitefilter=enwiki";
    const gRes = await fetch(gUrl, { signal: ctrl.signal, headers: { "User-Agent": WIKI_UA } });
    if (!gRes.ok) throw new Error("wd-get " + gRes.status);
    const ents = (((await gRes.json()) || {}).entities) || {};
    const out = [];
    for (const id of ids) {                         // preserve wbsearchentities' relevance order
      const ent = ents[id];
      if (!ent) continue;
      let coord = null;
      const p625 = ((ent.claims || {}).P625 || [])[0];
      const v = p625 && p625.mainsnak && p625.mainsnak.datavalue && p625.mainsnak.datavalue.value;
      if (v && typeof v.latitude === "number" && typeof v.longitude === "number") {
        coord = { lat: v.latitude, lon: v.longitude };
      }
      const enwiki = ((ent.sitelinks || {}).enwiki || {}).title || null;
      const label = ((ent.labels || {}).en || {}).value || "";
      const wddesc = ((ent.descriptions || {}).en || {}).value || "";
      const title = enwiki || label;
      if (!title) continue;
      out.push({ title, coordinates: coord ? [coord] : [], extract: "", pageid: "wd_" + id, _enwiki: enwiki, _wddesc: wddesc });
    }
    return out;
  } catch (_e) {
    return [];
  } finally { clearTimeout(timer); }
}

// Turn a Wikidata name search into a gated `best`, reusing the resolver's pick()/gate.
// Two paths, both coordinate-gated:
//   (a) enwiki sitelink → the RICH Wikipedia intro via _wikiSearchPages, scored against
//       the SITELINK title (Wikidata already established name↔item via label/alias, so
//       the gate confirms article-identity + coordinate, not the raw pin name). Capped
//       at WD_ENWIKI_RESOLVE_CAP so a query can't fan out into a search burst.
//   (b) no gate-passing enwiki article → the terse Wikidata DESCRIPTION, held to the
//       STRICT name-token overlap with the original query (scored against `query`), so
//       a coordinate-only near-namesake can't attach through the loose path — the pure
//       alias case is already served by (a) and by AI recall.
async function _wikidataResolve(query, pick, lat, lng) {
  const cands = await _wikidataCandidatePages(query);
  if (!cands.length) return null;
  let resolved = 0;
  for (const c of cands) {
    if (c._enwiki && resolved < WD_ENWIKI_RESOLVE_CAP) {
      resolved++;
      const w = await _bestArticle(c._enwiki, c._enwiki, "", true, pick, lat, lng);
      if (w) return w;
    }
  }
  const withDesc = cands.map((c) => ({ title: c.title, coordinates: c.coordinates, extract: c._wddesc || "", pageid: c.pageid }));
  return pick(withDesc, query, "", true) || null;
}

// #318 (FINAL RUNG — "B") — AI-GENERATED "what it is" from the submitter's WRITEUP.
// The last resort for a CREDITED GEM whose place has NO gate-passing article in ANY
// wiki rung (name / AI-recall / literal-hint all returned null): the lore-gem class
// no encyclopedia documents (the DMB-waste bridge, "Couch Tomb", the unnamed alley).
// UNLIKE every rung above it this attaches NO externally-sourced fact — the model
// writes ONE short, neutral, factual sentence GROUNDED STRICTLY on the writeup. This
// is the operator-authorized SOFTENING of blank-beats-wrong for exactly that class,
// and its safety is ENTIRELY in the prompt + two guards, because (a) there is no
// source article, so NO coordinate gate can back it, and (b) operator decision: the
// line renders on the card with NO label, indistinguishable from a Wikipedia fact.
// So the prompt is conservative — describe only what the note asserts, invent nothing,
// third person, no opinion/feelings — and blank is REQUIRED when the note doesn't say
// what the place IS. Two guards on top: a confidence floor (stricter than the recall
// rung's, since nothing downstream catches an error) and an ANTI-LAUNDER check that
// rejects a line that is merely the raw take reworded (#315 never displays the take;
// a near-copy would launder it onto the card). Blank still beats wrong (#101/#178).
// CONFIG-OUTSIDE-THE-FILE: reuses THIS function's GEMINI_API_KEY (already set for
// #320) — NOTHING NEW outside the file. No key → returns null → the pin stays blank
// exactly as today. Per-request, never cached (NO CACHE_VERSION bump — #288/#316).
// Only ever reached with a hint, i.e. the credited-gem path (maybeEnrichWhatItis);
// the OSM/seed and shared-spot resolves send no hint and never trigger it.
const GEN_MIN_CONF = 0.6;                          // stricter than AI_RECALL_MIN_CONF — no coordinate gate backs this rung
const GEN_MAX_LEN = 240;                           // one short factual sentence; .ps-desc scrolls (#77) but keep it tight
async function _generateWhatItisFromWriteup(hint, name, lat, lng) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return null;                           // no key in this function's env → rung inert, pin stays blank
  const writeup = String(hint || "").trim().slice(0, 400);
  if (!writeup) return null;
  const prompt =
    "You write ONE short, neutral, factual sentence saying WHAT A PLACE IS, for a " +
    "local-discovery map, given a visitor's short note about the place.\n" +
    "RULES:\n" +
    "- Use ONLY facts stated or clearly implied in the note. Invent NOTHING — no " +
    "history, dates, names, numbers, or details the note does not give.\n" +
    "- Describe the PLACE, not the visit: no opinions, feelings, recommendations, or " +
    "second-person address. Third person, present tense.\n" +
    "- If the note does not make clear what the place actually IS, return an empty " +
    "string. A blank is required in that case — do NOT guess.\n" +
    "Respond with JSON only: {\"desc\": <string>, \"confidence\": <0..1>}\n" +
    (name ? ("Place name: " + String(name).slice(0, 120) + "\n") : "") +
    "Visitor's note: " + writeup;
  try {
    let res = null, raw = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + AI_MODEL + ":generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, responseMimeType: "application/json" },
          }),
        },
      );
      raw = await res.text();
      if (res.ok || !AI_RETRY_STATUSES.has(res.status) || attempt === 2) break;
      await new Promise((r) => setTimeout(r, AI_RETRY_DELAY_MS));
    }
    if (!res || !res.ok) return null;              // throttle / http error → no line (#264)
    const data = JSON.parse(raw);
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    let text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("").trim();
    if (!text) text = parts.map((p) => p.text || "").join("").trim();
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    const parsed = JSON.parse((s >= 0 && e >= 0) ? text.slice(s, e + 1) : text);
    const conf = Number(parsed.confidence);
    if (!Number.isFinite(conf) || conf < GEN_MIN_CONF) return null;   // model not sure enough → blank
    let desc = String(parsed.desc || "").replace(/\s+/g, " ").trim();
    if (!desc) return null;                                            // model returned blank (note didn't say what it is)
    if (desc.length > GEN_MAX_LEN) desc = desc.slice(0, GEN_MAX_LEN).trim();
    // ANTI-LAUNDER (#315): the raw take is NEVER displayed, so reject a line that is
    // just the writeup with light edits. Normalised-equality is the floor the client
    // ALSO enforces (its `val !== t.desc` guard); this catches the punctuation/case
    // variants that guard would miss.
    const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (norm(desc) === norm(writeup)) return null;
    const idSlug = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 40) || "x";
    return {
      id: "gen_" + idSlug, name: name || "",
      lat, lng,                                    // stamp at pin coords (grounded on THIS pin's writeup)
      desc, category: "history", source: "gen", real: true,
    };
  } catch (_e) {
    return null;                                   // best-effort; the pin just stays blank
  }
}

// #345 — RESOLVER-BROADENING. A documented pin can carry a NAME that its Wikipedia
// article title does not string-match: an honorific/relational PREFIX ("Grave of" /
// "Site of" / "Birthplace of" / "Home of") or a trailing TYPE word ("…Memorial").
// Rung 1 searches the raw name, misses, and the pin lands resolved_source='none' —
// which the #344 story-gate would HIDE despite a real article existing. This returns
// the CORE ENTITY with the affix removed (or null when there is nothing to strip, or
// nothing distinctive left), so the affix rung below can retry the search against it.
// STRIP IS QUERY-ONLY: it changes what is SEARCHED, never the pin's display name (the
// pin still reads "Grave of Al Capone"; only its description is sourced).
//
// SAFETY lives in the CALLER, not here. The affix rung runs the stripped entity through
// the UNCHANGED #316 descriptionGate under strictLoc:true (the TIGHT coordinate radius),
// so a stripped entity attaches ONLY when its OWN article coordinate sits on the pin.
// That is what keeps the Walt-Disney trap closed: "Birthplace of Walt Disney" strips to
// "Walt Disney", but the person's article carries no coordinate on the house, so the
// gate rejects it and the pin falls to `gen` rather than borrowing the man's biography.
// A GRAVE/SITE whose OWN place-article is geolocated at the pin is the only thing that
// resolves. The rung also fires ONLY after the raw-name search misses, so a plainly-
// named pin ("Washington Monument" resolves at rung 1) never reaches the strip at all.
const NAME_AFFIX_PREFIXES = ["grave of", "site of", "birthplace of", "home of"];
const NAME_AFFIX_TRAILERS = ["memorial"];
function _stripNameAffixes(name) {
  const s = String(name || "").trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  let stripped = null;
  for (const p of NAME_AFFIX_PREFIXES) {
    if (lower.startsWith(p + " ")) { stripped = s.slice(p.length).trim(); break; }
  }
  if (!stripped) {
    for (const t of NAME_AFFIX_TRAILERS) {
      if (lower.endsWith(" " + t)) { stripped = s.slice(0, s.length - t.length).trim(); break; }
    }
  }
  if (!stripped) return null;
  if (!_wikiNameTokens(stripped).length) return null;        // nothing distinctive left to search on
  if (stripped.toLowerCase() === lower) return null;          // no-op strip → skip the extra call
  return stripped;
}

// #318 / #320 — resolve a place's "what it is", each rung best-effort, each passing
// EVERY candidate through the SAME descriptionGate (#316) with the pin coordinate the
// unchanged hard anchor. Order is chosen so free/structured sources run before paid AI:
//   Rung 1  (#54)   — search Wikipedia by the pin NAME (Mr. Beef resolves here).
//   Rung 1-affix (#345) — on a rung-1 MISS only, retry Wikipedia with the CORE ENTITY
//                     (honorific/relational prefix or trailing "…Memorial" stripped),
//                     scored against that core name and gated under the TIGHT radius
//                     (strictLoc) so a broadened search can't wrong-attach a same-named
//                     different place. Deterministic (no AI), ≤1 extra call per miss.
//   Rung 1b (#318)  — WIKIDATA by name (free, coordinate-gated). Matches label OR alias,
//                     so a pin whose common name differs from its article title resolves
//                     — to the enwiki article's rich intro, else the terse Wikidata desc.
//                     Runs for gem and OSM alike.
//   Then, if a WRITEUP exists (credited gem):
//   Rung 2  (#320)  — AI RECALL from the writeup: the model returns up to 3 candidate
//                     names for what it is ABOUT (building / event / person / work); try
//                     each (Wikipedia then Wikidata). The pin COORDINATE picks the right
//                     granularity — ends the single-name whack-a-mole (Fire→event,
//                     Dillinger→Biograph, Oz→none geolocated→blank). Inert without a key.
//   Rung 3  (#318)  — literal-writeup token search (subject-naming writeups; carries the
//                     container risk the AI rung runs ahead of it to avoid).
//   Else, no writeup (OSM/seed facts pin):
//   Rung 2-OSM (#318) — AI RECALL from the pin NAME + coordinate: the model proposes up
//                     to 3 aliases / canonical article titles (OSM "Kwa-Ma-Rolas" →
//                     "Kwanusila"); try each (Wikipedia then Wikidata). RECALL, never
//                     generation — a wrong alias fails the coordinate gate → blank.
// EVERY rung is RECALL or a structured source: it can only widen WHICH articles are
// CONSIDERED, never WHERE one may sit — the LOCATION half of the gate is untouched, so
// no rung can produce a wrong-PLACE description (blank beats wrong, #101/#178). The
// Google-Places (needs an API key) + hand-curated rungs and the eventual shared
// `resolveDescription(...)` home remain #318's to add. Per-request, never cached: rides
// the existing CACHE_VERSION with NO bump (the #288/#316/#320 precedent). `hint` is
// optional; without it rungs 2/3 never fire and only the name/Wikidata/alias rungs run.
async function resolveWikiByName(name, lat, lng, hint, artist, refresh) {
  if (!name || typeof lat !== "number" || typeof lng !== "number") return null;
  // #375 — a STRUCTURE-ONLY name (a numbered sub-unit like "Court No. 5" /
  // "Section 60") has no identity of its own, so a by-name search can only
  // WRONG-ATTACH to whatever article shares its generic token ("Court No. 5" ~
  // "Supreme Court of the United States", the #303/#351 generic-token weakness —
  // "court" padded the distinctive-token floor). Refuse it here, BEFORE the bank
  // read, so it never returns a previously-banked wrong hit and never banks one:
  // it resolves to NOTHING, which is what lets #367 remove the demoted structure
  // pins entirely (the clean end state #374's kind-demotion was the interim for).
  if (_isStructureOnlyName(name)) return null;
  // #357 — DURABLE RESOLVE BANK, read-first. A prior coordinate-gated hit for this
  // (name, coord) is VERIFIED TRUTH (#316) and is returned deterministically, skipping
  // the 2–4 Wikipedia round-trips and immune to the #355 recall nondeterminism. `refresh`
  // (the re-validate lever) bypasses the read to re-check a moved/deleted article; a hit
  // still re-banks below, a miss leaves the banked hit intact. See the bank helpers.
  if (!refresh) {
    const banked = await readResolveBank(name, lat, lng);
    if (banked) return { id: banked.id, name: banked.name, lat, lng, desc: banked.desc, category: banked.category || "history", source: banked.source || "wiki", real: true };
  }
  const hintText = (typeof hint === "string" && hint.trim()) ? hint.trim().slice(0, 300) : "";
  // #355 — the CREATOR signal (art pins). Optional; consumed only on the no-writeup
  // facts-pin branch below. Absent it, behaviour is identical to before.
  const artistText = (typeof artist === "string" && artist.trim()) ? artist.trim().slice(0, 120) : "";
  // Gate every candidate, score it by the BETTER of its name-match and (when a hint
  // exists) its title-in-writeup containment, and keep the top-scoring survivor.
  // The gate has already guaranteed a real, non-disambig, non-low-value, coordinate-
  // verified article, so the winner needs no post-loop re-check (#316 — the gate is
  // the one home; the per-candidate run is the #316 recovery, unchanged here).
  // `matchName`/`matchHint` default to the pin's own name + writeup (rung 1,
  // unchanged). Candidate rungs (Wikidata / AI-recall / literal-hint) pass the
  // CANDIDATE name as `matchName` (and `strictLoc:true`) so the gate scores the
  // article title against that candidate AND holds the tight coordinate radius —
  // the subset-widened radius is only correct for the rung-1 real-pin-name search.
  const pick = (pages, matchName = name, matchHint = hintText, strictLoc = false) => {
    let best = null, bestScore = 0;
    for (const pg of (pages || [])) {
      if (!pg || !pg.title) continue;
      const co = (pg.coordinates && pg.coordinates[0]) || null;
      if (!descriptionGate({ name: matchName, lat, lng, title: pg.title, coord: co, extract: pg.extract, hint: matchHint, strictLoc })) continue;
      let score = Math.max(_wikiTitleScore(matchName, pg.title), matchHint ? _titleCoveredByText(matchHint, pg.title) : 0);
      // A gate survivor with NO name/hint overlap passed by coordinate-identity (the
      // alias-recall case). Give it a tiny proximity score so the CLOSEST such candidate
      // wins and it is selectable at all — kept below any real name-match score, so a
      // genuine title match always outranks a coordinate-only one.
      if (score === 0 && strictLoc && co && typeof co.lat === "number") {
        score = 0.001 / (1 + haversine(lat, lng, co.lat, co.lon) / 1000);
      }
      if (score > bestScore) { bestScore = score; best = pg; }
    }
    return best;
  };
  try {
    // Rung 1 — Wikipedia by NAME, hydrated (the #54 path). Canonically-named pins
    // (Mr. Beef) resolve here; _bestArticle fetches a reliable coordinate + full intro
    // so a coordinate the combined search dropped no longer blanks the pin.
    let best = await _bestArticle(name, name, hintText, false, pick, lat, lng);
    // Rung 1-affix (#345) — RESOLVER-BROADENING. Only when the raw-name search missed:
    // retry with the core entity (affix stripped) under the TIGHT radius (strictLoc:true),
    // so a broadened search still cannot attach a same-named-but-different place — the
    // #316 gate is untouched and the pin coordinate remains the hard anchor (the Walt-
    // Disney trap stays closed). Deterministic string strip, no AI, and it fires ONLY on
    // a rung-1 miss, so it adds at most one Wikipedia call per otherwise-unresolved pin
    // (throttle-conscious — the gate-tiles warmer is at the Wikipedia IP-cooldown ceiling)
    // and, by running BEFORE the AI rungs below, can spare an AI call when a strip resolves.
    if (!best) {
      const core = _stripNameAffixes(name);
      if (core) best = await _bestArticle(core, core, hintText, true, pick, lat, lng);
    }
    if (!best && hintText) {
      // Rung 2 (#320) — AI RECALL from the WRITEUP (credited-gem path): the model returns
      // up to 3 candidate names for what the writeup is ABOUT (building / event / person
      // / work), most-likely first. Try each through the SAME gate — the pin COORDINATE
      // decides which granularity is right (Dillinger → [Biograph, John Dillinger] → the
      // Biograph is at the pin; Fire → [Great Chicago Fire, …] → the event is; Oz →
      // [Baum house, book, L. Frank Baum] → none geolocated → blank). A wrong/hallucinated
      // name fails the coordinate gate → costs nothing (#101/#178).
      const aiNames = await _aiResolvePlaceNames(hintText, lat, lng);
      for (const nm of aiNames) {
        best = await _bestArticle(nm, nm, "", true, pick, lat, lng);
        if (best) break;
      }
      // Rung 3 (#318) — literal-writeup token search as the FINAL wiki fallback (no key,
      // or no AI candidate resolved). Container risk is why the AI rung runs first.
      if (!best) best = await _bestArticle(hintText, name, hintText, true, pick, lat, lng);
    } else if (!best && !hintText) {
      // Rung 2-OSM-a (#355 v2) — DETERMINISTIC creator-qualified NAME search. When the
      // pin carries a creator (art), search the pin's OWN name qualified by the artist so
      // the WORK's real (often disambiguated) article surfaces — "The Alarm" + "Boyle" →
      // "The Alarm (Boyle)"; "Goethe Monument" + "Herman Hahn" → "Goethe Monument
      // (Chicago)" — WITHOUT relying on the model to GUESS the disambiguated title. That
      // was the #355-v1 miss: handed a title-only name + a creator, the model returned the
      // artist's BIO ("John J. Boyle (sculptor)", "Ellsworth Kelly", "Abraham Lincoln"),
      // which the coord gate then rejected (no coord / wrong place), so the work's own
      // coordinate-bearing article was never even searched. A probe confirmed those
      // articles EXIST with coordinates — the gap was candidate SELECTION, not the gate.
      // matchName stays the PIN name so the title score is against the work, never the
      // artist; strictLoc + the #316 coord gate are UNCHANGED, so a same-named work in
      // another city still can't attach. Runs BEFORE the AI rung and spares its Gemini
      // call on a hit. Deterministic, so it adds at most one Wikipedia search per art pin.
      if (artistText) best = await _bestArticle(name + " " + artistText, name, "", true, pick, lat, lng);
      // Rung 2-OSM-b (#318 AI-recall for facts pins) — the recall rung for the pins the
      // qualified-name search can't place (nicknames, oblique names): the model proposes
      // up to 3 aliases / canonical titles the article could sit under (OSM
      // "Kwa-Ma-Rolas" → "Kwanusila"); each is searched and hydrated through the SAME gate
      // under the TIGHT coordinate radius (strictLoc). RECALL, never generation — a wrong
      // alias just blanks. OSM facts pins aren't prewarmed (#327), so this fires on a pin
      // the user opened — bounded to taps. #355 — the creator is fed here too.
      if (!best) {
        const aliases = await _aiResolveNameAliases(name, lat, lng, artistText);
        for (const nm of aliases) {
          best = await _bestArticle(nm, nm, "", true, pick, lat, lng);
          if (best) break;
        }
      }
    }
    // FINAL fallback (#318 Wikidata) — LAST, so it never preempts a richer Wikipedia
    // article or the recall rungs (that ordering mistake made Mr. Beef / A Signal of
    // Peace show a terse "X is a Y" Wikidata blurb instead of their real article).
    // Wikidata's search matches label OR alias: an enwiki sitelink resolves (hydrated)
    // to the RICH intro; only when nothing richer exists does its terse-but-SOURCED
    // description stand in, better than blank. Coordinate-gated like everything else.
    if (!best) best = await _wikidataResolve(name, pick, lat, lng);
    if (!best) return null;
    const raw = (best.extract || "").trim();
    const res = {
      id: "wikiname_" + best.pageid, name: best.title,
      lat, lng,                                   // STAMP at pin coords: server verified, client 90 m check passes
      desc: raw, category: classifyWikiOpener(best.title, raw) || "history",
      source: "wiki", real: true,
    };
    // #357 — bank the verified coordinate-gated hit so it is returned deterministically
    // hereafter and a later nondeterministic miss can never un-resolve it (monotonic).
    await writeResolveBank(name, lat, lng, res);
    return res;
  } catch (_e) {
    return null;                                  // best-effort; the pin just keeps one slot
  }
}

// Mutates `places` in place: overwrites `desc` on any OSM pin whose `wp` link
// resolved to a usable intro, and ALWAYS strips the internal `wp` field so it is
// never cached or sent to the client. Never throws.
// #289 — `prefetched` is the title→extract Map the handler kicks off overlapped
// with the geosearch (see the live-fetch block). When it is supplied, this
// applies it with NO fetch of its own — the whole point of the overlap. When
// called WITHOUT it (any stand-alone caller, present or future), it falls back
// to fetching the titles itself, so the function stays correct in isolation.
async function enrichOsmWikipedia(places, prefetched) {
  const targets = (places || []).filter((p) => p && p.source === "osm" && p.wp);
  let enriched = 0;
  if (targets.length) {
    try {
      const extracts = (prefetched instanceof Map)
        ? prefetched
        : await fetchWikiExtractsByTitle(Array.from(new Set(targets.map((p) => p.wp))));
      targets.forEach((p) => {
        const ex = extracts.get(p.wp);
        if (ex) { p.desc = ex; enriched++; }
      });
    } catch (_e) { /* best-effort: every pin keeps its osmDesc line */ }
  }
  // `wp` is internal plumbing — strip unconditionally, even on total failure, so
  // a failed enrich cannot bake `wp` into the cached tile.
  (places || []).forEach((p) => { if (p && p.wp) delete p.wp; });
  return { enriched, wpLinked: targets.length };
}

// --- #164: OPTION B — resolve an OSM pin's own `wikidata=` Q-id --------------
// The counter (#163/#118) measured ~8 Q-id-only facts pins per dense historic
// tile (Savannah 4, Baltimore 11, Richmond 14, New Haven 7, Buffalo 2), and the
// #367 story-gate HIDES them: the cold by-name resolve is capped at 12 per tile
// and _osmStrictMatch refuses their name variants (Owens-Thomas Museum, Mercer
// Williams House, James Monroe's tomb). The Q-id is the place's identity, so it
// needs no name match: Q-id → enwiki sitelink title → the same intro text every
// other wiki pin gets.
//
// GUARDS (blank beats wrong, #101/#178):
//   • isLowValueWikiArticle on the ARTICLE's own title + extract — the same #96/
//     #13/#293 filters the #163 wikipedia= path runs (a school/station/hospital
//     article drops; the pin keeps its line).
//   • The article must carry its OWN primary coordinate within QID_SANITY_M of
//     the pin. A bare `wikidata=` that an editor pointed at a PERSON or an event
//     (the tag misuse subject:wikidata exists to prevent) resolves to an article
//     with NO coordinate and is rejected; a namesake in another region is
//     rejected by distance. 25 km (the existing strong-name sanity reach), not
//     the resolver's 1 km: the link is editor-asserted, and a trail pin sits on
//     an endpoint while its article coordinate can sit many km along the route.
//   • Thin-only, longer-only (descIsThin + length) — never downgrades (#358/#359).
// NOT #316-gated and NOT #357-banked, the #163 precedent: an editor-asserted link
// is not a guess, and the tile bake persists the result — a rebuild re-derives it
// deterministically from the same Q-id, so there is nothing to protect from a
// nondeterministic re-roll. Runs at tile BUILD only (cold path); a warm tile
// gains it when it next rebuilds (≤21-day TTL). NO CACHE_VERSION bump — the #118
// / #387 reasoning: a bump would force every tile back through the ~15 s
// Overpass wall at once and orphan the offline warm (#359/#360).
// Best-effort throughout: any failure leaves the pin on its current line.
const QID_SANITY_M = WIKI_NAME_SANITY_STRONG_M; // 25 km — see the guard note above
const WD_GET_BATCH = 50;                         // wbgetentities `ids` limit
const QID_TIMEOUT_MS = 6000;                     // per call; two hops in series, overlapped with the geosearch

async function _fetchEnwikiTitlesByQid(qids) {
  const out = new Map();
  const batches = [];
  for (let i = 0; i < qids.length; i += WD_GET_BATCH) batches.push(qids.slice(i, i + WD_GET_BATCH));
  await Promise.all(batches.map(async (batch) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), QID_TIMEOUT_MS);
    try {
      const url = WD_ENDPOINT + "?action=wbgetentities&format=json&props=sitelinks&sitefilter=enwiki&ids=" +
        encodeURIComponent(batch.join("|"));
      const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": WIKI_UA } });
      if (!res.ok) throw new Error("wd-get " + res.status);
      const ents = (((await res.json()) || {}).entities) || {};
      // A redirected (merged) item comes back under its TARGET id with a
      // `redirects.from` pointing at the id we asked for — map both.
      for (const [key, ent] of Object.entries(ents)) {
        if (!ent || ent.missing !== undefined) continue;
        const title = ((ent.sitelinks || {}).enwiki || {}).title || null;
        if (!title) continue;
        out.set(key, title);
        if (ent.id) out.set(ent.id, title);
        if (ent.redirects && ent.redirects.from) out.set(ent.redirects.from, title);
      }
    } catch (_e) { /* batch failed — its pins keep their current line */ }
    finally { clearTimeout(timer); }
  }));
  return out;
}

// Intro + primary coordinate for a set of exact titles. Same normalise/redirect
// mapping as fetchWikiExtractsByTitle; kept separate so the #163 path's request
// shape is untouched. Returns Map requestedTitle -> {title, extract, lat, lng} | null.
async function _fetchWikiIntroCoordByTitle(titles) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < titles.length; i += WIKI_EXTRACT_CHUNK) chunks.push(titles.slice(i, i + WIKI_EXTRACT_CHUNK));
  await Promise.all(chunks.map(async (chunk) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), QID_TIMEOUT_MS);
    try {
      const url = "https://en.wikipedia.org/w/api.php?action=query&format=json" +
        "&prop=extracts%7Ccoordinates&exintro=1&explaintext=1&exlimit=20" +
        "&coprimary=all&colimit=max&redirects=1&titles=" +
        chunk.map((t) => encodeURIComponent(t)).join("%7C");
      const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": WIKI_UA } });
      if (!res.ok) throw new Error("wiki-qid " + res.status);
      const q = ((await res.json()) || {}).query || {};
      const norm = {}; (q.normalized || []).forEach((n) => { norm[n.from] = n.to; });
      const redir = {}; (q.redirects || []).forEach((r) => { redir[r.from] = r.to; });
      const byTitle = {};
      Object.values(q.pages || {}).forEach((pg) => { if (pg && pg.title) byTitle[pg.title] = pg; });
      chunk.forEach((req) => {
        let t = req;
        if (norm[t]) t = norm[t];
        if (redir[t]) t = redir[t];
        const pg = byTitle[t] || null;
        const extract = pg && pg.extract ? String(pg.extract).trim() : "";
        if (!pg || !extract || isLowValueWikiArticle(pg.title, extract)) { out.set(req, null); return; }
        // coprimary=all, PRIMARY preferred: some place articles carry their only
        // coordinate as a non-primary tag (Mercer House, Savannah), which
        // coprimary=primary silently drops — that would reject a real landmark.
        const cs = Array.isArray(pg.coordinates) ? pg.coordinates : [];
        const c = cs.find((x) => x && x.primary !== undefined) || cs[0];
        out.set(req, {
          title: pg.title, extract,
          lat: c && typeof c.lat === "number" ? c.lat : null,
          lng: c && typeof c.lon === "number" ? c.lon : null,
        });
      });
    } catch (_e) {
      chunk.forEach((req) => { if (!out.has(req)) out.set(req, null); });
    } finally { clearTimeout(timer); }
  }));
  return out;
}

// Q-id list -> Map qid -> {title, extract, lat, lng}. Called from the cold path,
// chained off Overpass so it overlaps the geosearch (the #289 pattern).
async function fetchQidArticles(qids) {
  const out = new Map();
  const ids = Array.from(new Set((qids || []).filter((q) => /^Q\d+$/.test(q))));
  if (!ids.length) return out;
  try {
    const titleOf = await _fetchEnwikiTitlesByQid(ids);
    const titles = Array.from(new Set(ids.map((q) => titleOf.get(q)).filter(Boolean)));
    if (!titles.length) return out;
    const arts = await _fetchWikiIntroCoordByTitle(titles);
    for (const q of ids) {
      const t = titleOf.get(q);
      const a = t ? arts.get(t) : null;
      if (a) out.set(q, a);
    }
  } catch (_e) { /* best-effort */ }
  return out;
}

// Apply the prefetched Q-id articles in place (thin-only, coordinate-sane), then
// strip the internal `qid` field off EVERY place so it never bakes into the tile.
async function enrichOsmWikidata(places, prefetched) {
  const stats = { qidLinked: 0, qidEnriched: 0, qidNoArticle: 0, qidNoCoord: 0, qidFar: 0 };
  const targets = (places || []).filter((p) => p && p.source === "osm" && p.qid);
  stats.qidLinked = targets.length;
  if (targets.length) {
    try {
      const arts = (prefetched instanceof Map) ? prefetched : await fetchQidArticles(targets.map((p) => p.qid));
      for (const p of targets) {
        const a = arts.get(p.qid);
        if (!a || !a.extract) { stats.qidNoArticle++; continue; }
        if (a.lat == null || a.lng == null) { stats.qidNoCoord++; continue; }
        if (haversine(p.lat, p.lng, a.lat, a.lng) > QID_SANITY_M) { stats.qidFar++; continue; }
        if (descIsThin(p.desc) && a.extract.length > String(p.desc || "").trim().length) {
          p.desc = a.extract; stats.qidEnriched++;
        }
      }
    } catch (_e) { /* best-effort: every pin keeps its current line */ }
  }
  (places || []).forEach((p) => { if (p && p.qid) delete p.qid; });
  return stats;
}

// De-dupe by same-name-within-90m; `primary` wins ties (kept first).
function dedupeReal(primary, secondary) {
  const merged = [];
  const seen = [];
  const tryAdd = (p) => {
    const key = normName(p.name);
    if (!key) return;
    const hit = seen.find((s) => s.key === key && haversine(s.lat, s.lng, p.lat, p.lng) < 90);
    if (hit) {
      // #102 (c) — the duplicate we are about to drop still carries information the
      // kept pin lacks. This is called dedupeReal(wiki, osm): the wiki pin wins the
      // tie for its richer description, but it was stamped category:"history" by
      // construction (fetchWikipedia's default), so a metropark that dedupes here
      // keeps "history" while the OSM copy that knew it was a "park" is discarded —
      // correctly-categorised data thrown away for a better sentence. Adopt the OSM
      // category onto the kept pin. Guarded tightly: it only ever moves a wiki
      // 'history' pin ONTO a real OSM category, never the reverse, and never touches
      // a wiki pin the opener classifier (a) already resolved off 'history'.
      const kept = merged[hit.idx];
      if (kept && kept.source === "wiki" && kept.category === "history" &&
          p.source === "osm" && p.category && p.category !== "history") {
        kept.category = p.category;
      }
      return;
    }
    seen.push({ key, lat: p.lat, lng: p.lng, idx: merged.length });
    merged.push(p);
  };
  (primary || []).forEach(tryAdd);
  (secondary || []).forEach(tryAdd);
  return merged;
}

// --- Supabase (service role) for the shared_kv tile cache ---
const supabase = createClient(
  Deno.env.get("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
);

// Versioned cache key: bumping CACHE_VERSION orphans pre-filter rows instantly.
function cacheKey(tile) {
  return "places:" + CACHE_VERSION + ":" + tile;
}

async function readCacheRow(tile) {
  try {
    const { data, error } = await supabase
      .from("shared_kv").select("value").eq("key", cacheKey(tile)).maybeSingle();
    if (error || !data || !data.value) return null;
    const obj = JSON.parse(data.value);
    if (!obj || !obj.ts || !Array.isArray(obj.places)) return null;
    return obj;
  } catch (_e) { return null; }
}
async function writeCacheRow(tile, places, osmEmpty = false) {
  try {
    // #399 — `osmEmpty` is an ADDITIVE field: a row written from a healthy-empty
    // Overpass answer carries osmEmpty:true (short TTL, servable with zero
    // places). Rows without it — every row written before #399, and every
    // normal row — read exactly as before, so NO CACHE_VERSION bump.
    const row = osmEmpty ? { ts: Date.now(), places, osmEmpty: true } : { ts: Date.now(), places };
    await supabase.from("shared_kv").upsert(
      { key: cacheKey(tile), value: JSON.stringify(row), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch (_e) { /* best-effort */ }
}

// --- #399: HEALTHY-EMPTY TILES ARE CACHED (short TTL) ------------------------
// #104's write guard (`!osm.error && osm.places.length > 0`) exists so an
// Overpass FAILURE — a Wikipedia-only `merged` — is never cached for 21 days.
// It also refused a different answer: Overpass SUCCEEDED and there is nothing
// there. A lake / bay / ocean tile is that case (overpassStatus 200, 0 OSM
// places, maybe a few Wikipedia pins), so it was rebuilt from scratch on EVERY
// visit and paid the full Overpass wall each time (20–52 s measured, #292) — no
// pre-warm could help. A clean 200 with no elements is a real answer:
// fetchOverpassOne already THROWS on the timed-out-query shape (a `remark` with
// no elements) and on any non-2xx, so osm.error is set for every failure we can
// detect. What remains is the risk #104 guarded — a mirror returning a
// truncated 200-empty for a real LAND tile. Two mitigations:
//   (1) the row is written with osmEmpty:true and a 3-day TTL (EMPTY_OSM_TTL_MS),
//       so #394 SWR re-checks it within days instead of 21;
//   (2) a healthy-empty answer NEVER overwrites a row that had OSM places — if a
//       tile we already believed in suddenly answers empty, that is far likelier
//       a bad mirror than the city vanishing, so the old row keeps serving.
// Path 4 (a tile with no places at all) and the SWR refresh follow the same rule.
function isHealthyEmptyOsm(osm) {
  return !!osm && !osm.error && Array.isArray(osm.places) && osm.places.length === 0;
}
function rowHasOsm(row) {
  return !!row && Array.isArray(row.places) && row.places.some((p) => p && p.source === "osm");
}
// A row is servable if it has places, or if it is a deliberate healthy-empty row.
// A pre-#399 empty row (no osmEmpty flag) is still NOT servable, as before.
function rowIsServable(row) {
  return !!row && Array.isArray(row.places) && (row.places.length > 0 || row.osmEmpty === true);
}
function rowTtlMs(row) {
  return row && row.osmEmpty === true ? EMPTY_OSM_TTL_MS : PLACES_CACHE_TTL_MS;
}

// --- #363: GRAVE-BIO BAKE FROM THE OFFLINE gravebank ------------------------
// A grave's Wikipedia article is the PERSON's bio, whose OWN coordinate sits at
// their life, not their plot, so descriptionGate (#316) correctly REFUSES to
// attach it on the live path — which is why a live tile rebuild used to REVERT
// #356's baked grave bios to OSM filler ("A local memorial (grave).") and clobber
// the gate-tiles commit (proven: places:v34:835_-1752 rebuilt with filler ~6 min
// after a --rewarm, so the seven Oak Woods notables showed a bio then reverted on
// the next fetch). The offline gate-tiles warmer resolves each grave's bio ONCE,
// paced, by NAME under the three #356 guards (+ #363 --prime-graves for the dense
// clusters the per-tile warmer can't hold) and banks it in gravebank:g1:<name>.
// This bakes that banked line onto a grave pin at SERVE time — on BOTH the build
// path (so writeCacheRow PERSISTS it and a rebuild RE-BAKES instead of reverting)
// and the warm fast path (so an already-clobbered cached tile serves the bio
// immediately, no purge). Pure bank READ — no Wikipedia, no rate-limit fight,
// deterministic. BANK-ONLY, exactly like gate-tiles' memorial-grave class: an
// un-banked grave keeps its filler (never a live namesake guess — "Paul Cornell"
// stays blank, not the British writer), and a rich human `description` is never
// downgraded (descIsThin guard, the #53/#358 no-downgrade rule). One batched
// shared_kv read per grave-bearing tile; HITS memoised (the bank is MONOTONIC so
// a hit is immutable; a miss is never cached, so a freshly-primed grave bakes on
// the next request without waiting for a worker restart). Key derivation mirrors
// gate-tiles' graveBankKey (coreName-strip + diacritic-fold) BYTE-FOR-BYTE, or a
// banked key won't match the pin's label.
const GRAVEBANK_VERSION = "g1";
const _graveBankMemo = new Map(); // bankKey -> desc; HITS ONLY
function _gbFold(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function _gbCoreName(name) {
  let n = String(name || "").trim();
  n = n.replace(/^(grave|site|home|birthplace|statue|bust|memorial|monument|tomb|resting place|burial)\s+(of|to|for)\s+/i, "");
  n = n.replace(/\s+(memorial|monument|statue|bust|sculpture|plaque|marker|fountain|gravesite|grave)$/i, "");
  return n.trim() || String(name || "").trim();
}
function graveBankKey(name) {
  const k = _gbFold(_gbCoreName(name)).replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "_");
  return "gravebank:" + GRAVEBANK_VERSION + ":" + k;
}
// The serve-side grave-class test: the #310 tomb kind (type 'grave'), a
// "Grave of X"/"Tomb of X" name, or the MEMORIAL-GRAVE shape (historic=memorial
// filed with the "A local memorial (grave)." filler + a plain person name — the
// whole Oak Woods cluster). Union of gate-tiles' isGraveClass + isMemorialGraveShape.
function _isGraveClassPin(p) {
  if (!p) return false;
  if (p.type === "grave") return true;
  const n = String(p.name || "");
  if (/^(grave|tomb)\s+of\b/i.test(n)) return true;
  return p.type === "memorial" && /^A local memorial \((?:grave|gravestone)\)\.$/i.test(String(p.desc || "").trim());
}
// --- #374: DEMOTE STRUCTURE-NAMED GRAVE-CLASS OSM PINS ----------------------
// A `historic=tomb` OSM pin becomes type:'grave' in typeOsm, which the client
// (historyKindFacet/pinKind) renders under Graves & Memorials with the grave
// glyph + "Grave" label, and which _isGraveClassPin exempts from the #367
// storyless hide (kept-until-primed). That is right for a PERSON's grave — but
// Arlington (and other national cemeteries) map their COLUMBARIUM courts as
// `historic=tomb`, so a numbered STRUCTURE ("Court No. 5", "Section 60", a bare
// "Columbarium"/"Mausoleum") inherits both and renders as a grave (#373's second
// finding). It is not a person's grave, so #374 requires a PERSON SIGNAL before
// a grave-class pin renders as a grave.
//
// PROVEN ON LIVE DATA (why a hide-only guard is not enough): Arlington's four
// "Court No. N" pins are NOT storyless — each wrong-attached to the "Supreme
// Court of the United States" article ("Court No. 5" ~ "Supreme Court", the
// #303/#351 generic-token wrong-attach), so they carry a >60-char (wrong)
// description and the #367 storyless hide never sees them. The fix must change
// the KIND, not just the hide: demoteStructureGraves re-maps a structure-named
// type:'grave' OSM pin to type:'historic' on the way out, so historyKindFacet
// returns 'lore' → it renders as a plain History pin (no grave glyph/label, out
// of the Graves & Memorials card) and _isGraveClassPin no longer exempts it (a
// storyless one then falls to the ordinary #367 hide).
//
// The person-signal test is the #353 near_name tightener applied to the
// grave-CLASSIFIER side: after dropping the "Grave of"/"Tomb of" honorific and
// the generic grave/structure/enumeration words, a real person grave still
// carries a DISTINCTIVE token (a surname / place name), while a numbered court
// strips to nothing but digits/ordinals. A life-date ("1895–1972" / born…died)
// in the resolved bio also reads like a person. SCOPED tight: OSM pins only
// (seeds/gems are source!=='osm'), type:'grave' only (memorials + "Grave of X"
// person names untouched), a reversible serve-time re-map (no CACHE_VERSION
// bump — the #367/#363 serve-opinion pattern), and the default for anything
// grave-class is to KEEP it — only a name that is nothing but structure words
// (and no life-date bio) is demoted.
const GRAVE_STRUCTURE_TOKENS = new Set([
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
// Reads like a person's grave: a distinctive name token in the label, or a
// life-date signal in the resolved bio. Deliberately conservative — the default
// for anything grave-class is to KEEP the exemption; only a name that is nothing
// but structure/enumeration words (and no life-date bio) loses it.
function _graveHasPersonSignal(p) {
  if (!p) return true; // fail-safe: never newly-hide on a missing record
  const d = String(p.desc || "");
  // (a) life-date / born–died signal in the resolved bio
  if (/\b(1[0-9]{3}|20[0-2][0-9])\s*[–—-]\s*(1[0-9]{3}|20[0-2][0-9])\b/.test(d)) return true;
  if (/\bborn\b[\s\S]{0,40}\bdied\b/i.test(d) || /\(\s*(?:b\.|born)\b/i.test(d)) return true;
  // (b) a distinctive person token in the NAME (after stripping structure words,
  // bare numbers, ordinals and roman numerals, and single letters/initials)
  const toks = String(p.name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !GRAVE_STRUCTURE_TOKENS.has(t))
    .filter((t) => !/^\d+$/.test(t))                       // bare numbers: "3", "60"
    .filter((t) => !/^\d+(?:st|nd|rd|th)$/.test(t))        // ordinals: "1st"
    .filter((t) => !/^[ivxlcdm]+$/.test(t))                // roman numerals: "iii"
    .filter((t) => t.length > 1);                          // single letters / initials
  return toks.length > 0;
}
// #375 — the ENUMERATION signal subset of GRAVE_STRUCTURE_TOKENS: words that mark a
// pin as a numbered SUB-UNIT of a larger place ("Court No. 5", "Section 60", "Niche
// 12", "Plot 3") rather than a place in its own right. A name built only of these
// (plus a number/ordinal/roman) has no identity to resolve — it is a layout label,
// not a landmark.
const GRAVE_ENUMERATION_WORDS = new Set([
  "court", "courts", "section", "sections", "plot", "plots", "lot", "lots",
  "block", "blocks", "row", "rows", "bay", "unit", "units", "niche", "niches",
  "wall", "walls", "area", "areas", "circle", "terrace", "no", "number", "num", "site", "sites",
]);
// #375 — NAME-ONLY structure test (the sibling of _graveHasPersonSignal's name arm,
// but with no pin/desc needed, so the by-name RESOLVER can call it before it ever
// searches). True when a name is nothing but structure/enumeration/stop words AND
// carries an enumeration signal — a number/ordinal/roman OR an enumeration word like
// "Court"/"Section"/"Niche". "Court No. 5" → true (nothing distinctive, has "court"+
// "5"); "Section 60" → true; a real place with any distinctive token ("Millennium
// Park", "Grave of Grace Hopper") → false. Requiring the enumeration signal keeps a
// legitimately all-generic place name ("Memorial Park", "The Monument") OUT of the
// net — those still resolve through the ordinary LOCATION+TYPE gate; only a numbered
// sub-unit that can only wrong-attach ("Court No. 5" → "Supreme Court") is refused.
function _isStructureOnlyName(name) {
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
// #374/#375 — the serve-time structure-grave cleanup. Re-maps a structure-named
// type:'grave' OSM pin to type:'historic' (in-memory, never a cache rewrite — the
// #367/#363 reversible-serve-opinion rule, no CACHE_VERSION bump) so it stops
// rendering as a grave (#374), AND — #375 — STRIPS a wrong-attached description
// off it so it becomes storyless and #367 removes it entirely (the clean end state
// #374's demotion was the interim for). A numbered structure has no article of its
// own, so any non-thin desc it carries is a generic-token wrong-attach (a
// bank-baked "Court No. 5 is the Supreme Court…"); Overpass never said it, so
// blanking RESTORES the faithful #104 record rather than editing it, which is why
// this needs no CACHE_VERSION bump. A THIN OSM tag is left alone — it is already
// storyless, so #367 hides the pin anyway. Scoped to source==='osm' + type==='grave'
// with no person signal, so seeds, gems, memorials and person-named "Grave of X"
// pins are never touched. Returns {demoted, stripped} (deploy/QA signals).
function demoteStructureGraves(places) {
  let demoted = 0, stripped = 0;
  for (const p of (places || [])) {
    if (p && p.source === "osm" && p.type === "grave" && !_graveHasPersonSignal(p)) {
      p.type = "historic";
      demoted++;
      if (!descIsThin(p.desc)) { p.desc = ""; stripped++; } // #375 — a wrong-attach on a nameless structure; blank → storyless → #367 hides it
    }
  }
  return { demoted, stripped };
}
async function bakeGravesFromBank(places) {
  try {
    // #375 — never bake a person's banked bio onto a structure-only grave (a
    // columbarium "Court No. 5" is grave-class by the historic=tomb tag but is NOT
    // a person). Without this, an offline gate-tiles prime that wrong-banked a
    // structure name (court_no_5 → SCOTUS) would re-apply here on every thin serve.
    // Reuses #374's person-signal test, so the two structure guards can't drift.
    const targets = (places || []).filter((p) => p && _isGraveClassPin(p) && _graveHasPersonSignal(p) && descIsThin(p.desc));
    if (!targets.length) return 0;
    const keyOf = new Map();
    for (const p of targets) keyOf.set(p, graveBankKey(p.name));
    const need = [...new Set([...keyOf.values()])].filter((k) => !_graveBankMemo.has(k));
    if (need.length) {
      const { data, error } = await supabase.from("shared_kv").select("key,value").in("key", need);
      if (!error && Array.isArray(data)) {
        for (const row of data) {
          try { const v = JSON.parse(row.value); if (v && v.desc) _graveBankMemo.set(row.key, String(v.desc)); } catch (_) {}
        }
      }
    }
    let baked = 0;
    for (const p of targets) {
      const nd = _graveBankMemo.get(keyOf.get(p));
      if (nd && nd.length > String(p.desc || "").trim().length) { p.desc = nd; baked++; }
    }
    return baked;
  } catch (_e) { return 0; }
}

// --- #357: DURABLE RESOLVE BANK --------------------------------------------
// A coordinate-gated resolve (descriptionGate #316) is VERIFIED TRUTH. #355
// proved the recall path is NONDETERMINISTIC — the same resolveWikiByName call
// returns a documented article one minute and null the next (three KM=12 gate
// runs read 285/271/272 resolved; Goethe / The Alarm traded in and out; Hans
// Christian Andersen, resolvable, missed all three and was wrongly dropped). So
// the FIRST time a (name, coord) pin resolves we BANK the verified line here,
// keyed by name+coord, and every later resolve reads the bank FIRST and returns
// it DETERMINISTICALLY (also faster — no Wikipedia round-trips). A fresh miss
// only ever fails to WRITE; it can never overwrite a stored hit, so the bank is
// MONOTONIC: a re-run (gate-tiles best-of-N, the #319 sweep, a client re-open)
// only ADDS resolutions, never randomly subtracts. That is what lets the #344
// story-gate roll out city-wide WITHOUT a hand-run best-of-N (#302), and it also
// ends the client-side transient-miss latch the #358 report hit — once a pin is
// banked, the client's resolveWiki always gets the hit instead of a 429-induced
// blank.
//
// INDEPENDENT OF CACHE_VERSION ON PURPOSE (own `resolve:` prefix, own
// RESOLVE_CACHE_VERSION): a tile-cache (`places:`) bump re-rolls tiles but must
// NOT re-roll the country's banked resolves — the bank is the permanent layer
// the 21-day tile cache (#291) sits ON TOP of as a speed layer. The `resolve:`
// prefix is OUTSIDE the #126 tilecache-sweep scope (`places:%`, blocklist-
// excluded), which is correct — banked hits are permanent, not aged out.
//
// SELF-RETIRING FALLBACK STAYS EPHEMERAL: only resolveWikiByName's coordinate-
// gated wiki/wikidata hits reach this bank. The #328 'gen' writeup-grounded line
// is produced in the resolveWiki HANDLER, AFTER this function returns null, so it
// is never banked and still self-retires the instant a real article exists.
//
// RE-VALIDATE LEVER (sticky-but-refreshable, the row's chosen fork): a per-request
// `refresh` skips the READ so a moved/deleted article can be re-checked; a hit
// still re-banks, a miss leaves the prior banked hit untouched (never a blind
// wipe). A coarse reset is a RESOLVE_CACHE_VERSION bump (orphans the whole bank).
// Written/read by the SAME service-role path as the tile cache, so — like the
// #104 blocklist — NO migration, NO new RLS policy, nothing in the dashboard.
const RESOLVE_CACHE_VERSION = "r1";
function resolveBankKey(name, lat, lng) {
  const n = normName(String(name || ""));
  // ~11 m rounding: dedupes float noise between the pin's own coord and the
  // request coord while keeping genuinely distinct pins on distinct keys (a
  // same-named work >11 m away banks separately, and the #316 gate is what made
  // each a verified identity in the first place).
  const la = Math.round(Number(lat) * 1e4) / 1e4;
  const ln = Math.round(Number(lng) * 1e4) / 1e4;
  return "resolve:" + RESOLVE_CACHE_VERSION + ":" + n + "@" + la + "," + ln;
}
async function readResolveBank(name, lat, lng) {
  if (!name || typeof lat !== "number" || typeof lng !== "number") return null;
  try {
    const { data, error } = await supabase
      .from("shared_kv").select("value").eq("key", resolveBankKey(name, lat, lng)).maybeSingle();
    if (error || !data || !data.value) return null;
    const o = JSON.parse(data.value);
    if (!o || !o.desc || !o.name) return null;
    return o; // { id, name, desc, category, source, ts }
  } catch (_e) { return null; } // a bank-read failure falls through to a live resolve — never blocks
}
async function writeResolveBank(name, lat, lng, hit) {
  if (!hit || !hit.desc || typeof lat !== "number" || typeof lng !== "number") return;
  try {
    await supabase.from("shared_kv").upsert(
      { key: resolveBankKey(name, lat, lng),
        value: JSON.stringify({ id: hit.id, name: hit.name, desc: hit.desc, category: hit.category, source: hit.source, ts: Date.now() }),
        updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch (_e) { /* best-effort — a failed bank just means the next resolve re-rolls, never a wrong answer */ }
}

// --- #367: BY-NAME RESOLVE for storyless OSM facts pins ---------------------
// The #367 universal story-gate HIDES a storyless OSM pin (source==='osm' &&
// descIsThin). Many of those pins ARE documented — Mattress Factory, Children's
// Museum of Pittsburgh — they were simply never RESOLVED at tile build, because
// the build only resolves a pin that carries a `wikipedia=` tag (#163 enrich) or
// an `alt_name` (#359 bridge). This generalises the #359 alt-name bridge from
// "pins with an alt_name" to "any thin OSM facts pin", keyed on the pin's own
// NAME, through the SAME coordinate-gated, #357-banking resolveWikiByName every
// by-name resolve uses (so the #316 descriptionGate + the #365 Places rung run,
// and a hit is banked → the warm heal below serves it deterministically and a
// rebuild is free).
//
// THE WRONG-ATTACH GUARD (why this needs a STRICTER test than the gate): the
// #316 gate's name-match floor (#351 distinctive-token ≥ 0.5) is deliberately
// loose, which is safe for a hint/alt-name recall but WRONG-ATTACHES on the
// generic names that dominate the OSM backlog (memorials, "…Historic District",
// parks). Proven live: "Allegheny West Historic District" → a DIFFERENT
// "…Second Ward Industrial Historic District"; "Conney M. Kimbo Art Gallery" →
// "William Pitt Union"; a "Point of View" sculpture → "Point of View Park" (the
// containing park). So the OSM auto-bake adds _osmStrictMatch ON TOP of the
// gate: the article title's DISTINCTIVE (non-type-word) token set must EQUAL the
// pin's, and the article must not add a CONTAINING-place word the pin lacks
// (park/district/building/…), which means the article is about a bigger/other
// thing. Everything ambiguous is REFUSED and stays hidden → the #368/#369 rescue
// queue for hand-curation. Blank-beats-wrong (#101/#178) over recall.
//
// NO CACHE_VERSION BUMP (the #363 grave-bake pattern): the build-path resolve
// (resolveThinOsmByName) banks + bakes into the persisted tile on rebuild, and
// the warm-path heal (healThinOsmFromBank) serves a banked hit onto an already-
// cached tile in memory — so existing v34 tiles pick the descriptions up lazily
// as they refresh, with NO country-wide re-warm (the #360 cost a bump would pay).
const OSM_MATCH_GENERIC = new Set([
  "the", "of", "a", "an", "and", "at", "de", "park", "parkway", "museum", "memorial",
  "monument", "garden", "gardens", "hall", "center", "centre", "gallery", "house",
  "field", "square", "district", "historic", "national", "trail", "greenway",
  "passage", "bridge", "tower", "building", "cemetery", "community", "foundation",
  "association", "society", "parklet", "academy", "school", "church",
]);
// A CONTAINING kind the TITLE adds but the PIN lacks means the article is about a
// larger place the pin sits IN (an art pin → the park around it), not the pin.
const OSM_MATCH_CONTAINING = new Set([
  "park", "district", "building", "complex", "campus", "grounds", "bridge", "union", "hall", "tower",
]);
function _osmMatchNorm(s) {
  let out;
  try { out = String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); }
  catch (_e) { out = String(s || ""); }
  return out.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function _osmMatchTokens(s) { return _osmMatchNorm(s).split(" ").filter(Boolean); }
function _osmDistinct(s) { return new Set(_osmMatchTokens(s).filter((t) => !OSM_MATCH_GENERIC.has(t))); }
// STRICT: exact normalized match, OR equal distinctive-token sets with no
// containing-place word the pin lacks. This is the tighter acceptance test the
// live-sample dry run validated (6 clean rescues, 0 wrong-attaches on 22 pins).
function _osmStrictMatch(pinName, title) {
  const pn = _osmMatchNorm(pinName), tn = _osmMatchNorm(title);
  if (!pn || !tn) return false;
  if (pn === tn) return true;
  const dp = _osmDistinct(pinName), dt = _osmDistinct(title);
  if (!dp.size || !dt.size || dp.size !== dt.size) return false;
  for (const t of dp) if (!dt.has(t)) return false; // distinctive-token sets must be EQUAL
  const pinToks = new Set(_osmMatchTokens(pinName));
  for (const t of _osmMatchTokens(title)) if (OSM_MATCH_CONTAINING.has(t) && !pinToks.has(t)) return false;
  return true;
}

const _osmBankMemo = new Map(); // resolveBankKey -> { name, desc }; HITS ONLY (the bank is monotonic, so a cached hit never goes stale)
// WARM heal — the #363 grave-bake pattern for storyless OSM facts pins: read the
// #357 resolve bank (ONE batched shared_kv read, no network) and bake a banked,
// strict-matching hit onto a cached tile in memory before it serves. Serves a
// pin the build path (or the resolveWiki action, or the recheck tool) already
// resolved onto an already-cached tile without waiting for its rebuild. Bank-only
// (no live guess), no-downgrade (descIsThin + longer), fully guarded.
async function healThinOsmFromBank(places) {
  try {
    const targets = (places || []).filter(
      (p) => _isStorylessOsm(p) && !_isGraveClassPin(p) && FACTS_DESC_CATS.has(p.category) && p.name,
    );
    if (!targets.length) return 0;
    const keyOf = new Map();
    for (const p of targets) keyOf.set(p, resolveBankKey(p.name, p.lat, p.lng));
    const need = [...new Set([...keyOf.values()])].filter((k) => !_osmBankMemo.has(k));
    if (need.length) {
      const { data, error } = await supabase.from("shared_kv").select("key,value").in("key", need);
      if (!error && Array.isArray(data)) {
        for (const row of data) {
          try {
            const v = JSON.parse(row.value);
            if (v && v.desc && v.name) _osmBankMemo.set(row.key, { name: String(v.name), desc: String(v.desc) });
          } catch (_e) { /* skip a malformed row */ }
        }
      }
    }
    let baked = 0;
    for (const p of targets) {
      const hit = _osmBankMemo.get(keyOf.get(p));
      if (hit && _osmStrictMatch(p.name, hit.name) && hit.desc.length > String(p.desc || "").trim().length) {
        p.desc = hit.desc; baked++;
      }
    }
    return baked;
  } catch (_e) { return 0; }
}

// BUILD resolve — on the COLD path, resolve each storyless OSM facts pin by its
// NAME through resolveWikiByName (which banks the hit), accept only on
// _osmStrictMatch, and bake a thin line up (never downgrade a rich one). Bounded
// to OSM_RESOLVE_MAX per build; a transient failure keeps the current line, never
// blanks (#358 "429 ≠ absence"). Grave-class pins are handled by the bank bake,
// not here (kept-until-primed).
async function resolveThinOsmByName(merged) {
  const targets = (merged || []).filter(
    (p) => _isStorylessOsm(p) && !_isGraveClassPin(p) && FACTS_DESC_CATS.has(p.category) && p.name,
  );
  let resolved = 0;
  // #387 — bounded + concurrent; stragglers finish in the background and bank.
  // (A late in-memory write to `p` after the response is harmless: the tile was
  // already serialised; the bank is what carries the hit forward.)
  const b = await runBounded(targets.slice(0, OSM_RESOLVE_MAX), async (p) => {
    try {
      const hit = await resolveWikiByName(p.name, p.lat, p.lng);
      const nd = hit && hit.desc ? String(hit.desc).trim() : "";
      if (nd && hit.name && _osmStrictMatch(p.name, hit.name) && descIsThin(p.desc) && nd.length > String(p.desc || "").trim().length) {
        p.desc = nd; resolved++;
      }
    } catch (_e) { /* transient — keep the pin's current line, never blank (#358) */ }
  }, COLD_RESOLVE_BUDGET_MS, COLD_RESOLVE_CONCURRENCY);
  _lastOsmDeferred = b.deferred;
  return resolved;
}
let _lastOsmDeferred = 0; // #387 — how many storyless-OSM resolves were still in flight when this build served (deploy-confirm / diagnostics)

// #365 — PLACES (New) tunables for the external-source rung. TWO-TIER coordinate gate: a
// POINT venue (gallery, museum, restaurant, theater) must sit within PLACES_POINT_M of the
// pin; a BIG / linear / area feature (park, trail, beach, island, district, pier) is allowed
// out to PLACES_BIG_M, because Places returns the feature's LABEL point, which for a large
// feature legitimately sits km from a pin dropped ON it (Boston Harbor Islands' centroid is
// 3.6 km from a seed on one island). PLACES_BIG_M is set BELOW the ~4 km where the coverage
// probe found MISPLACED SEEDS (Waterton 11.6 km, Laser Dome 9.5 km, Hobie 5.6 km, Sloan's
// 5.2 km): those must NOT get a right-name description stamped on a wrong-located pin — they
// stay blank and go to a SEPARATE coordinate-fix pass (the #314 family). Moving a pin is
// never this rung's job; it only attaches a description at the pin's existing coordinate.
const PLACES_BIAS_M     = 5000;   // Text Search locationBias radius (so a big feature whose centre is a few km off is still found)
const PLACES_POINT_M    = 1000;   // tight radius for point venues — matches the codebase's WIKI_NAME_SANITY_M "tight" convention
const PLACES_BIG_M      = 4000;   // loose radius for big/linear/area features; clean gap below the misplaced-seed cluster
const PLACES_TIMEOUT_MS = 10000;
// A Places type (primaryType or any of `types`) marking a BIG / area / linear feature → loose radius.
const PLACES_BIG_TYPE_RE = /park|trail|beach|island|canyon|forest|greenway|refuge|preserve|garden|plaza|landmark|nature|hiking|campground|marina|waterfront|riverfront|boardwalk|broadwalk|promenade|pier|neighborhood|tourist_attraction|cemetery/;

// Map a Places type string to Nahgoo's story taxonomy for the returned `category` field.
// Cosmetic for the backfill (which writes only resolved_description/_source), kept correct
// in case a live tile-inject path reads it; defaults to 'history' like the wiki rung.
function _placesCategory(typeStr) {
  if (/art_gallery|sculpture|\bart\b/.test(typeStr)) return "art";
  if (/park|trail|beach|garden|nature|hiking|greenway|refuge|preserve|canyon|forest|waterfront|riverfront|pier|boardwalk|broadwalk/.test(typeStr)) return "park";
  return "history";
}

// #365 — the #318 EXTERNAL-SOURCE rung. Called ONLY from the resolveWiki action, AFTER
// resolveWikiByName (wiki + wikidata) returns null — so it never fires per-tile and stays
// quota-safe. Google Places Text Search (New), biased to the pin, requesting editorialSummary.
// A result is accepted only when it clears three guards, mirroring the #316 discipline:
//   (1) a REAL editorial summary is present — a tag/type-only "an art gallery in X" line is the
//       #308/#344 no-story class, so a summary-less result returns null and the pin stays blank
//       (curatable later), never an auto-written definitional stub;
//   (2) the pin name matches the result on a DISTINCTIVE token (#351 _nameMatchesTitle) — the
//       anti-namesake guard, and the reason Places is SAFER here than the wiki by-name path: it
//       matches on the full place name, so it got "Shelby Bottoms Greenway" right where the wiki
//       rung wrong-attached it to "Shelby Park";
//   (3) the result's coordinate sits within the TYPE-AWARE radius above.
// A pass is banked like a wiki hit (#357), so a repeat resolve is served from the bank and costs
// no Places quota. Returns the SAME place shape as resolveWikiByName (source 'places') or null.
async function resolvePlacesByName(name, lat, lng) {
  if (!GOOGLE_PLACES_KEY || !name || typeof lat !== "number" || typeof lng !== "number") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PLACES_TIMEOUT_MS);
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_KEY,
        "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.editorialSummary,places.primaryType,places.types",
      },
      body: JSON.stringify({
        textQuery: String(name),
        languageCode: "en",
        maxResultCount: 3,
        locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: PLACES_BIAS_M } },
      }),
    });
    if (!res.ok) return null;                     // bad key / billing off / quota exhausted → blank, never wrong
    const j = await res.json();
    const results = (j && Array.isArray(j.places)) ? j.places : [];
    for (const p of results) {
      const title = (p.displayName && p.displayName.text) ? String(p.displayName.text) : "";
      const summary = (p.editorialSummary && p.editorialSummary.text) ? String(p.editorialSummary.text).trim() : "";
      const loc = p.location;
      if (!title || !summary) continue;           // (1) require a real editorial summary — no-summary stays blank/curatable
      if (!loc || typeof loc.latitude !== "number" || typeof loc.longitude !== "number") continue;
      if (!_nameMatchesTitle(name, title)) continue;   // (2) #351 distinctive-token match — namesake / wrong-place guard
      const typeStr = ((p.primaryType || "") + " " + ((p.types || []).join(" "))).toLowerCase();
      const maxM = PLACES_BIG_TYPE_RE.test(typeStr) ? PLACES_BIG_M : PLACES_POINT_M;
      if (haversine(lat, lng, loc.latitude, loc.longitude) > maxM) continue;  // (3) off-pin → blank (misplaced seed / far namesake)
      const hit = {
        id: "places_" + (p.id || normName(title)),
        name: title, lat, lng,                    // stamp at the PIN's coords — this rung never moves a pin (#314 owns coord fixes)
        desc: summary, category: _placesCategory(typeStr),
        source: "places", real: true,
      };
      await writeResolveBank(name, lat, lng, hit); // #357 — deterministic + monotonic; a later resolve is served free from the bank
      return hit;
    }
    return null;
  } catch (_e) {
    return null;                                  // timeout / network → blank; the pin just keeps one slot (blank beats wrong)
  } finally { clearTimeout(timer); }
}

// --- #318 CURATED EXTERNAL-SOURCE RUNG (the cascade's last SOURCE rung) --------
// After wiki + wikidata + Google Places (#365) all miss, a place can still be
// real-and-documented with NO machine-readable source — the summary-LESS tail
// Places can LOCATE but not describe (small galleries, arts districts, named
// local parks/trails, quirky museums). For those, a human writes ONE neutral
// factual line into the `curated_descriptions` table (name + coord + description,
// service-role only, 318_curated_descriptions.sql), and this rung serves it like
// any other source, as source 'curated'.
//
// NOT #316-GATED, ON PURPOSE: a curated row is a HUMAN ASSERTION keyed to THIS
// pin, so — exactly like the #163 by-title enrich — the identity IS the
// name+coordinate row match, not a name-token/coordinate gate over a candidate
// article. The only guard is proximity: a curated row must sit within
// CURATED_MATCH_M of the pin, or it is a different place (a same-name namesake in
// another metro) and is skipped → blank (blank beats wrong, #101/#178).
//
// NOT BANKED (#357): the gem writer (review-submission) persists the returned
// line onto the submission row (resolved_description/resolved_source), so it is
// already durable there; skipping the resolve bank keeps an EDITED curated line
// live on the next resolve instead of serving a stale banked copy.
//
// FIRES ONLY FROM THE resolveWiki ACTION (the gem writer + the recheck runner) —
// never a per-tile/serve call — so it adds ZERO Google Places quota and no
// serve-path cost, and it runs BEFORE the #328 gen-from-writeup rung because a
// sourced human line beats a model-written one. Empty table / no nearby row →
// null → gen-or-blank, exactly as today.
const CURATED_MATCH_M = 2000;  // a curated row must sit within 2 km of the pin, else it's a different place → skip
async function resolveCuratedByName(name, lat, lng) {
  if (!name || typeof lat !== "number" || typeof lng !== "number") return null;
  const n = normName(String(name));            // SAME transform the generated name_clean column uses, so the key can't drift
  if (!n) return null;
  try {
    const { data, error } = await supabase
      .from("curated_descriptions")
      .select("id,name,description,lat,lng")
      .eq("name_clean", n)
      .limit(8);
    if (error || !Array.isArray(data) || !data.length) return null;
    let best = null, bestM = Infinity;          // nearest same-name curated row to this pin
    for (const row of data) {
      if (!row || !row.description) continue;
      const rlat = Number(row.lat), rlng = Number(row.lng);
      if (!Number.isFinite(rlat) || !Number.isFinite(rlng)) continue;
      const m = haversine(lat, lng, rlat, rlng);
      if (m < bestM) { bestM = m; best = row; }
    }
    if (!best || bestM > CURATED_MATCH_M) return null;  // no row near this pin → blank
    return {
      id: "curated_" + best.id,
      name: best.name || String(name), lat, lng,  // stamp at the PIN's coords — this rung never moves a pin (#314 owns coord fixes)
      desc: String(best.description).trim(),
      category: null,                              // caller (gem row / tile) keeps its own category; the writer reads desc + source only
      source: "curated", real: true,
    };
  } catch (_e) {
    return null;                                   // a table-read failure falls through to blank — never blocks a resolve
  }
}

// --- #362: CURATED LINES REACH THE OSM TILE LAYER ----------------------------
// Until now resolveCuratedByName fired ONLY from the resolveWiki action (gems +
// seeds). The OSM tile path (resolveThinOsmByName cold / healThinOsmFromBank
// warm) only ever called the wiki/wikidata resolver + the #357 bank, so a
// `curated_descriptions` row could NEVER reach an OSM pin — which is why Al
// Capone's House (an OSM tile pin with no article of its own, #362) stayed
// hidden under the #367 story-gate however many curated rows existed.
//
// Now every serve (warm AND cold) applies a matching curated line to a storyless
// OSM facts pin, so "add one curated row" un-hides ANY such pin — no code, no
// seed. Same identity rule as the action rung: exact normName match + within
// CURATED_MATCH_M (a human assertion keyed to the place, NOT #316-gated).
//
// SERVE-TIME ONLY, NEVER PERSISTED: applied to a SHALLOW CLONE of each matched
// pin on the way out (never mutates `merged`, never reaches writeCacheRow), so
// editing or deleting a curated row takes effect within CURATED_INDEX_TTL_MS
// everywhere — a wrong line is un-done by deleting the row, with no tile to
// purge. Same reversible-serve-opinion shape as the blocklist and the #367 hide.
// Cost: the whole table is read ONCE per CURATED_INDEX_TTL_MS per instance
// (it is small — tens to low thousands of rows), then matched in memory; zero
// Places quota. Precedence mirrors the action cascade: the bank heal (wiki /
// wikidata / places) runs FIRST, curated only fills a pin still thin after it.
const CURATED_INDEX_TTL_MS = 5 * 60 * 1000;
let _curatedIndex = { at: 0, byName: new Map(), ok: false };
async function loadCuratedIndex() {
  if (_curatedIndex.ok && Date.now() - _curatedIndex.at < CURATED_INDEX_TTL_MS) return _curatedIndex.byName;
  try {
    const { data, error } = await supabase
      .from("curated_descriptions")
      .select("id,name,name_clean,description,lat,lng")
      .limit(5000);
    if (!error && Array.isArray(data)) {
      const m = new Map();
      for (const r of data) {
        if (!r || !r.name_clean || !r.description) continue;
        const k = String(r.name_clean);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      _curatedIndex = { at: Date.now(), byName: m, ok: true };
    }
  } catch (_e) { /* keep the previous index (or empty) — a read failure never blocks a serve */ }
  return _curatedIndex.byName;
}
function curatedHitFromIndex(index, name, lat, lng) {
  if (!index || !name || typeof lat !== "number" || typeof lng !== "number") return null;
  const rows = index.get(normName(String(name)));
  if (!rows || !rows.length) return null;
  let best = null, bestM = Infinity;
  for (const r of rows) {
    const rlat = Number(r.lat), rlng = Number(r.lng);
    if (!Number.isFinite(rlat) || !Number.isFinite(rlng)) continue;
    const m = haversine(lat, lng, rlat, rlng);
    if (m < bestM) { bestM = m; best = r; }
  }
  if (!best || bestM > CURATED_MATCH_M) return null;   // same name, different place → skip (blank beats wrong)
  const desc = String(best.description || "").trim();
  return desc ? { name: best.name || String(name), desc } : null;
}
// Returns a NEW array; matched pins are shallow clones, everything else is the
// same object. Grave-class pins are left to the gravebank (#363); non-facts
// categories and non-OSM pins are never touched.
function applyCuratedToServe(places, index) {
  let curated = 0;
  const out = (places || []).map((p) => {
    if (!p || !_isStorylessOsm(p) || _isGraveClassPin(p) || !FACTS_DESC_CATS.has(p.category) || !p.name) return p;
    const hit = curatedHitFromIndex(index, p.name, p.lat, p.lng);
    if (!hit || hit.desc.length <= String(p.desc || "").trim().length) return p;
    curated++;
    return { ...p, desc: hit.desc, descSource: "curated" };
  });
  return { places: out, curated };
}

// --- #385: TILE-VIEW COUNTER (the free "where people actually look" signal) ----
// A SAMPLED, time-decayed per-tile view score, so the nightly Places sweep below
// can spend its small quota on the storyless pins people actually browse past,
// and so the order moves on its own as people explore new areas. Sampled at
// TILEHIT_SAMPLE of serves (each sampled hit adds 1/TILEHIT_SAMPLE, so the score
// is an unbiased estimate), decayed with a TILEHIT_TAU_MS time constant so a tile
// that was busy last month fades behind one that is busy this week. Background
// (waitUntil) and fully guarded — it never delays or breaks a serve. Own
// `tilehits:` namespace, outside the #126 `places:%` sweep. Read-modify-write
// races under concurrency just undercount slightly; it's a ranking hint, not a
// metric anyone bills on. No PII — a tile id and a number.
const TILEHIT_VERSION = "h1";
const TILEHIT_SAMPLE = 0.1;
const TILEHIT_TAU_MS = 14 * 24 * 3600 * 1000;
function tileHitKey(tile) { return "tilehits:" + TILEHIT_VERSION + ":" + tile; }
function decayedTileScore(o, now) {
  if (!o || typeof o.n !== "number" || typeof o.ts !== "number") return 0;
  return o.n * Math.exp(-Math.max(0, now - o.ts) / TILEHIT_TAU_MS);
}
async function _bumpTileHit(tile) {
  const key = tileHitKey(tile);
  const now = Date.now();
  let prev = null;
  try {
    const { data } = await supabase.from("shared_kv").select("value").eq("key", key).maybeSingle();
    if (data && data.value) prev = JSON.parse(data.value);
  } catch (_e) { /* treat as first hit */ }
  const n = decayedTileScore(prev, now) + 1 / TILEHIT_SAMPLE;
  await supabase.from("shared_kv").upsert(
    { key, value: JSON.stringify({ n, ts: now }), updated_at: new Date(now).toISOString() },
    { onConflict: "key" },
  );
}
function sampleTileHit(tile) {
  try {
    if (!tile || Math.random() >= TILEHIT_SAMPLE) return;
    const job = _bumpTileHit(tile).catch(() => {});
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") EdgeRuntime.waitUntil(job);
  } catch (_e) { /* never affects the serve */ }
}

// Page past PostgREST's 1,000-row response cap (the #346 lesson) for a
// shared_kv prefix scan. Ordered by key so .range() pages are stable.
async function fetchKvByPrefix(prefix, cols) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; from < 50000; from += PAGE) {
    const { data, error } = await supabase
      .from("shared_kv").select(cols || "key,value")
      .like("key", prefix + "%").order("key", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(String(error.message || error));
    if (!Array.isArray(data) || !data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// --- #385: NIGHTLY PLACES SWEEP — bounded, popularity-ordered rescue ---------
// The only AUTOMATIC source left for the storyless OSM backlog (wiki + wikidata
// already ran on every pin; #328 generation needs a writeup OSM pins don't have).
// Google Places is quota- and cost-capped (Text Search with editorialSummary
// bills at the Enterprise + Atmosphere SKU — ~1,000 free calls/month, then paid),
// so it can never run per tile. Instead, once a day (pg_cron → this action), the
// sweep spends a SMALL fixed budget on the storyless pins most worth rescuing:
//
//   ORDER: tiles people actually browse (the #385 decayed view score above) first,
//          then the most recently rebuilt tiles — both free signals. Google's
//          review count is only knowable by PAYING for the lookup, so it can't
//          order the queue up front; it is RECORDED from each call and used to
//          rank the curation queue (located-but-no-summary places, below).
//   ONE CALL DOES BOTH: the request asks for editorialSummary AND rating fields,
//          so the same call that ranks a pin can also rescue it.
//   ACCEPT: the SAME guards the heal enforces — _osmStrictMatch on the name
//          (distinctive-token equality), the type-aware PLACES_POINT_M /
//          PLACES_BIG_M coordinate radius, and a REAL editorial summary. A hit is
//          written to the #357 resolve bank under the pin's own (name, coord)
//          key, which healThinOsmFromBank (warm) and resolveWikiByName (cold,
//          bank-first) already read — so the pin un-hides on its next serve with
//          no tile rebuild and no CACHE_VERSION bump.
//   SKIP (zero quota): pins already banked, pins with a curated line, grave-class
//          pins (the gravebank owns them), non-facts categories, and pins tried
//          recently (a ledger row per pin: miss/no-summary retried after a long
//          window, an HTTP error retried next day).
//   STOP: on the first 429/403 (quota spent / key restricted) or the wall-clock
//          deadline — never burns through an error.
//   CURATION QUEUE: a place Places LOCATES and name-matches but has no summary for
//          (or only a loose name match) is recorded with its review count; the
//          status row lists the top ones — the most-reviewed hidden places a
//          human should curate a line for (then the #362 path above shows it).
//
// GUARDED: the action needs PLACES_SWEEP_TOKEN (a function secret) in the body —
// the function is callable with the public publishable key, so without a token
// anyone could burn the Places quota. No token set → the action is disabled.
// `dry:true` plans the run (candidate order) with ZERO Places calls.
const SWEEP_VERSION = "p1";
const SWEEP_STAMP = "385-places-sweep-v2";
const PLACES_SWEEP_TOKEN = Deno.env.get("PLACES_SWEEP_TOKEN") ?? "";
const PLACES_SWEEP_MAX = Math.max(0, Math.min(200, Number(Deno.env.get("PLACES_SWEEP_MAX") ?? 25) || 0));
const SWEEP_RETRY_MISS_MS = 60 * 24 * 3600 * 1000;
const SWEEP_RETRY_NOSUMMARY_MS = 90 * 24 * 3600 * 1000;
const SWEEP_RETRY_ERR_MS = 20 * 3600 * 1000;
const SWEEP_DEADLINE_MS = 100 * 1000;          // stay well inside the Edge Function wall-clock limit
const SWEEP_QUEUE_TOP = 25;
function sweepLedgerKey(bankKey) { return "placessweep:" + SWEEP_VERSION + ":" + bankKey.slice("resolve:".length); }
const SWEEP_STATUS_KEY = "placessweepstatus:" + SWEEP_VERSION;   // own prefix so the ledger scan never picks it up

async function placesSweepLookup(name, lat, lng) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PLACES_TIMEOUT_MS);
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST", signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_KEY,
        "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.editorialSummary,places.primaryType,places.types,places.rating,places.userRatingCount",
      },
      body: JSON.stringify({
        textQuery: String(name), languageCode: "en", maxResultCount: 3,
        locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: PLACES_BIAS_M } },
      }),
    });
    if (!res.ok) return { o: "http" + res.status, stop: res.status === 429 || res.status === 403 };
    const j = await res.json();
    const results = (j && Array.isArray(j.places)) ? j.places : [];
    let loose = null;
    for (const p of results) {
      const title = (p.displayName && p.displayName.text) ? String(p.displayName.text) : "";
      const loc = p.location;
      if (!title || !loc || typeof loc.latitude !== "number" || typeof loc.longitude !== "number") continue;
      const typeStr = ((p.primaryType || "") + " " + ((p.types || []).join(" "))).toLowerCase();
      const maxM = PLACES_BIG_TYPE_RE.test(typeStr) ? PLACES_BIG_M : PLACES_POINT_M;
      if (haversine(lat, lng, loc.latitude, loc.longitude) > maxM) continue;       // off-pin → not this place
      const urc = (typeof p.userRatingCount === "number") ? p.userRatingCount : null;
      const rating = (typeof p.rating === "number") ? p.rating : null;
      const summary = (p.editorialSummary && p.editorialSummary.text) ? String(p.editorialSummary.text).trim() : "";
      if (_osmStrictMatch(name, title)) {
        if (summary) {
          return { o: "hit", urc, rating, title, hit: {
            id: "places_" + (p.id || normName(title)), name: title, lat, lng,
            desc: summary, category: _placesCategory(typeStr), source: "places", real: true,
          } };
        }
        return { o: "nosummary", urc, rating, title };                              // located + exact name, nothing to say → curate
      }
      if (!loose && _nameMatchesTitle(name, title)) loose = { o: "loose", urc, rating, title };  // plausible but not strict → human eyeball
    }
    return loose || { o: "nomatch" };
  } catch (_e) {
    return { o: "error" };
  } finally { clearTimeout(timer); }
}

async function runPlacesSweep(opts) {
  const t0 = Date.now();
  const dry = !!(opts && opts.dry);
  const budget = Math.max(0, Math.min(PLACES_SWEEP_MAX, Number(opts && opts.max) || PLACES_SWEEP_MAX));
  const out = {
    sweepVersion: SWEEP_STAMP, dry, budget, key_present: !!GOOGLE_PLACES_KEY,
    candidates: 0, skipped: { banked: 0, curated: 0, recent: 0, grave: 0, category: 0 },
    calls: 0, outcomes: {}, banked: 0, stopped: null, planned: [], errors: [],
  };
  try {
    const now = Date.now();
    const [wrRows, hitRows, ledgerRows, curIdx] = await Promise.all([
      fetchKvByPrefix("wouldremove:" + WOULDREMOVE_VERSION + ":"),
      fetchKvByPrefix("tilehits:" + TILEHIT_VERSION + ":"),
      fetchKvByPrefix("placessweep:" + SWEEP_VERSION + ":"),
      loadCuratedIndex(),
    ]);
    const tileScore = new Map();
    for (const r of hitRows) {
      try { tileScore.set(r.key.slice(("tilehits:" + TILEHIT_VERSION + ":").length), decayedTileScore(JSON.parse(r.value), now)); } catch (_) { /* skip */ }
    }
    const ledger = new Map();
    for (const r of ledgerRows) { try { ledger.set(r.key, JSON.parse(r.value)); } catch (_) { /* skip */ } }

    // Collect + dedupe by bank key; cheap filters first.
    const byKey = new Map();
    for (const r of wrRows) {
      let o; try { o = JSON.parse(r.value); } catch (_) { continue; }
      if (!o || !Array.isArray(o.items)) continue;
      for (const it of o.items) {
        if (!it || !it.name || typeof it.lat !== "number" || typeof it.lng !== "number") continue;
        if (!FACTS_DESC_CATS.has(it.category)) { out.skipped.category++; continue; }
        if (_isGraveClassPin({ type: it.type, name: it.name, desc: "" })) { out.skipped.grave++; continue; }
        const bk = resolveBankKey(it.name, it.lat, it.lng);
        if (byKey.has(bk)) continue;
        byKey.set(bk, { ...it, tile: o.tile, tileTs: Number(o.ts) || 0, score: tileScore.get(o.tile) || 0, bk });
      }
    }
    // Already banked? (batched, zero quota)
    const keys = [...byKey.keys()];
    for (let i = 0; i < keys.length; i += 200) {
      const { data, error } = await supabase.from("shared_kv").select("key,value").in("key", keys.slice(i, i + 200));
      if (error) throw new Error(String(error.message || error));
      for (const row of (data || [])) {
        try { const v = JSON.parse(row.value); if (v && v.desc && v.name) { byKey.delete(row.key); out.skipped.banked++; } } catch (_) { /* keep */ }
      }
    }
    const queue = [];
    for (const c of byKey.values()) {
      if (curatedHitFromIndex(curIdx, c.name, c.lat, c.lng)) { out.skipped.curated++; continue; }
      const led = ledger.get(sweepLedgerKey(c.bk));
      if (led && typeof led.ts === "number") {
        const wait = led.o === "nosummary" || led.o === "loose" ? SWEEP_RETRY_NOSUMMARY_MS
          : (led.o === "nomatch" ? SWEEP_RETRY_MISS_MS : SWEEP_RETRY_ERR_MS);
        if (now - led.ts < wait) { out.skipped.recent++; continue; }
      }
      queue.push(c);
    }
    // ORDER (v2 — the first live dry run drained ONE arboretum tile of "Oaks" /
    // "Maples" / "employee/dock entrance" before touching anything else):
    //  (a) skip names that can't be a findable, describable place — one word, a
    //      lowercase start, or a slash (sub-features / signage), so no quota is
    //      spent on them (they stay curatable by hand);
    //  (b) ROUND-ROBIN across tiles (tiles ordered by view score, then rebuild
    //      recency), one pin per tile per round, so no single tile monopolises
    //      the budget and the calls spread across the areas people browse;
    //  (c) inside a tile: history > art > park > trail, then the more specific
    //      (longer) name first.
    const CAT_RANK = { history: 0, art: 1, park: 2, trail: 3 };
    const byTile = new Map();
    for (const c of queue) {
      const nm = String(c.name).trim();
      if (nm.split(/\s+/).length < 2 || /[\/]/.test(nm) || !/^[A-Z0-9"'“‘(]/.test(nm)) { out.skipped.name = (out.skipped.name || 0) + 1; continue; }
      if (!byTile.has(c.tile)) byTile.set(c.tile, []);
      byTile.get(c.tile).push(c);
    }
    const tiles = [...byTile.values()].map((list) => {
      list.sort((a, b) => ((CAT_RANK[a.category] ?? 9) - (CAT_RANK[b.category] ?? 9)) || (String(b.name).length - String(a.name).length));
      return { list, score: list[0].score, ts: list[0].tileTs };
    }).sort((a, b) => (b.score - a.score) || (b.ts - a.ts));
    const ordered = [];
    for (let round = 0; ordered.length < budget; round++) {
      let any = false;
      for (const t of tiles) {
        if (round < t.list.length) { ordered.push(t.list[round]); any = true; if (ordered.length >= budget) break; }
      }
      if (!any) break;
    }
    out.candidates = [...byTile.values()].reduce((n, l) => n + l.length, 0);
    const picks = ordered;
    out.planned = picks.map((c) => ({ name: c.name, category: c.category, tile: c.tile, viewScore: Math.round(c.score) }));

    if (!dry) {
      if (!GOOGLE_PLACES_KEY) { out.stopped = "no GOOGLE_PLACES_KEY"; }
      else {
        for (const c of picks) {
          if (Date.now() - t0 > SWEEP_DEADLINE_MS) { out.stopped = "deadline"; break; }
          const r = await placesSweepLookup(c.name, c.lat, c.lng);
          out.calls++;
          out.outcomes[r.o] = (out.outcomes[r.o] || 0) + 1;
          if (r.o === "hit" && r.hit) { await writeResolveBank(c.name, c.lat, c.lng, r.hit); out.banked++; }
          try {
            await supabase.from("shared_kv").upsert(
              { key: sweepLedgerKey(c.bk),
                value: JSON.stringify({ o: r.o, ts: Date.now(), name: c.name, category: c.category, lat: c.lat, lng: c.lng, tile: c.tile, urc: r.urc ?? null, rating: r.rating ?? null, title: r.title || null }),
                updated_at: new Date().toISOString() },
              { onConflict: "key" },
            );
            ledger.set(sweepLedgerKey(c.bk), { o: r.o, ts: Date.now(), name: c.name, category: c.category, lat: c.lat, lng: c.lng, urc: r.urc ?? null, title: r.title || null });
          } catch (_e) { /* ledger write is best-effort; worst case the pin is retried next run */ }
          if (r.stop) { out.stopped = r.o; break; }
        }
      }
    }

    // Curation queue: located-but-no-summary (or loose-match) places, most-reviewed first.
    const cq = [];
    for (const v of ledger.values()) {
      if (v && (v.o === "nosummary" || v.o === "loose")) cq.push({ name: v.name, match: v.o, placesName: v.title || null, reviews: v.urc ?? 0, category: v.category, lat: v.lat, lng: v.lng });
    }
    cq.sort((a, b) => (b.reviews || 0) - (a.reviews || 0));
    out.curation_queue = cq.slice(0, SWEEP_QUEUE_TOP);
    out.ledger_size = ledger.size;
  } catch (e) {
    out.errors.push(String((e && e.message) || e));
  }
  out.ms = Date.now() - t0;
  if (!dry) {
    try {
      await supabase.from("shared_kv").upsert(
        { key: SWEEP_STATUS_KEY, value: JSON.stringify({ ...out, ts: Date.now() }), updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
    } catch (_e) { /* status is informational */ }
  }
  return out;
}
async function readPlacesSweepStatus() {
  try {
    const { data } = await supabase.from("shared_kv").select("value").eq("key", SWEEP_STATUS_KEY).maybeSingle();
    if (data && data.value) return { sweepVersion: SWEEP_STAMP, last: JSON.parse(data.value) };
  } catch (_e) { /* fall through */ }
  return { sweepVersion: SWEEP_STAMP, last: null };
}

// --- #367: STORY-GATE OBSERVE-ONLY ARM — OSM would_remove tally + rescue queue ---
// OBSERVE ONLY. Nothing is hidden here; no pin's desc/category/coord changes.
// #344 brick 5 hides storyless GEMS/SEEDS (resolved_source='none') and app-report
// v13 surfaces THAT set as a rescue queue — but that report is submissions-scoped,
// so it is BLIND to the OSM/tile layer (these pins never touch `submissions`).
// Before #367 widens the hide onto the live serve path, this records — at serve
// time, inside nearby-places, the ONLY function that reads the tile store and can
// run the gate's own filler test — the set of OSM pins the universal story-gate
// WOULD remove, so the operator can SEE and RESCUE the popular ones (a curated /
// Places line baked into the tile build, the #362 pattern; a notability-linked
// place files under history #309) BEFORE any dot comes off the map. Report-first,
// exactly as #361/#368 gated the gem hide.
//
// STORYLESS = an OSM-sourced pin (source==='osm') whose description is THIN
// (descIsThin — the SAME ≤60-char filler test the tile-build no-downgrade rule
// and the client isFillerDesc guard use; REUSED, never re-implemented, so the
// classifier can't drift from the gate — the #141 three-copy trap). A wiki-feed
// pin (source==='wiki') carries a real extract by construction and is never
// counted; an OSM pin the #163 enrich gave a real article is >60 chars and drops
// out too. So this set is precisely the OSM dots currently showing filler = what
// #367 will hide. Grave-class pins are TAGGED (type) so the reader can split the
// #364-primeable ones out; they are NOT excluded (a grave still on filler IS
// storyless today).
const WOULDREMOVE_VERSION = "w1";
const WOULDREMOVE_ITEMS_MAX = 60;       // per-tile item cap so the banked JSON stays bounded (the `total` count is exact regardless)
const WOULDREMOVE_RANK_MAX = 40;        // hard cap on live Places lookups per read (quota guard — GetPlace 200/day)
const WOULDREMOVE_QUEUE_MAX = 500;      // cap on the returned item array
function wouldRemoveKey(tile) { return "wouldremove:" + WOULDREMOVE_VERSION + ":" + tile; }
function _isStorylessOsm(p) {
  return !!p && p.source === "osm" && descIsThin(p.desc);
}
// Record — never MUTATE — the tile's storyless-OSM set into its own shared_kv
// namespace (outside the #126 `places:%` sweep, like gravebank:/resolve:). One
// upsert per COLD build (the warm fast path serves an already-recorded tile, so
// it does not re-write). Fully guarded, so a bank failure never touches the
// served tile; it only READS `places` and writes a SEPARATE row — the served
// pins are byte-identical to pre-deploy, which is why this ships with NO
// CACHE_VERSION bump (the #357 own-namespace precedent).
async function recordWouldRemove(places, tile) {
  try {
    const storyless = (places || []).filter(_isStorylessOsm);
    const by_category = {};
    const items = [];
    for (const p of storyless) {
      const c = p.category || "?";
      by_category[c] = (by_category[c] || 0) + 1;
      if (items.length < WOULDREMOVE_ITEMS_MAX) {
        items.push({ id: p.id, name: p.name, category: p.category, type: p.type || null, lat: p.lat, lng: p.lng });
      }
    }
    await supabase.from("shared_kv").upsert(
      { key: wouldRemoveKey(tile),
        value: JSON.stringify({ v: WOULDREMOVE_VERSION, tile, ts: Date.now(), cacheVersion: CACHE_VERSION, total: storyless.length, by_category, items }),
        updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
    return storyless.length;
  } catch (_e) { return 0; } // observe-only — a failed record must never affect the serve
}

// Bounded, ON-DEMAND popularity signal for the would_remove READ action ONLY —
// NEVER per-tile (Google Places is quota-capped at 200/day, so a per-serve call
// would exhaust it instantly; #365 keeps Places off the tile path for exactly
// this reason). Mirrors resolvePlacesByName's request but asks for the RATING
// fields, so the reader can rank the rescue backlog by how many people actually
// go there. Same #351 name + coordinate guards, so a namesake's rating is never
// attributed to the pin. No key / miss → null (the entry ranks last), never an error.
async function placesPopularity(name, lat, lng, stats) {
  const bump = (k) => { if (stats) stats[k] = (stats[k] || 0) + 1; };
  if (!GOOGLE_PLACES_KEY) { bump("nokey"); return null; }
  if (!name || typeof lat !== "number" || typeof lng !== "number") { bump("badarg"); return null; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PLACES_TIMEOUT_MS);
  try {
    bump("calls");
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST", signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_KEY,
        "X-Goog-FieldMask": "places.displayName,places.location,places.rating,places.userRatingCount,places.primaryType,places.types",
      },
      body: JSON.stringify({
        textQuery: String(name), languageCode: "en", maxResultCount: 1,
        locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: PLACES_BIAS_M } },
      }),
    });
    if (!res.ok) { bump("http" + res.status); return null; }   // e.g. http429 = SearchText daily quota spent; http403 = key restriction
    const j = await res.json();
    const p = (j && Array.isArray(j.places) && j.places[0]) ? j.places[0] : null;
    if (!p) { bump("noresult"); return null; }
    const title = (p.displayName && p.displayName.text) ? String(p.displayName.text) : "";
    if (!title || !_nameMatchesTitle(name, title)) { bump("namereject"); return null; }   // #351 distinctive-token guard — don't rank a namesake's ratings
    const loc = p.location;
    if (loc && typeof loc.latitude === "number" && typeof loc.longitude === "number") {
      const typeStr = ((p.primaryType || "") + " " + ((p.types || []).join(" "))).toLowerCase();
      const maxM = PLACES_BIG_TYPE_RE.test(typeStr) ? PLACES_BIG_M : PLACES_POINT_M;
      if (haversine(lat, lng, loc.latitude, loc.longitude) > maxM) { bump("offpin"); return null; }   // off-pin → don't attribute a rating
    }
    bump("rated");
    return {
      rating: (typeof p.rating === "number" ? p.rating : null),
      userRatingCount: (typeof p.userRatingCount === "number" ? p.userRatingCount : null),
    };
  } catch (_e) { bump("throw"); return null; } finally { clearTimeout(timer); }
}

// Aggregate the banked would_remove rows into ONE view — the OSM analog of the
// gem rescue queue. Reads ONLY `wouldremove:w1:%` (never the tile cache), dedupes
// items by id across overlapping tiles. With rank=N (default 0, capped at
// WOULDREMOVE_RANK_MAX) the top-N candidates get a bounded Places rating lookup
// and the queue is sorted by rating-count so the busy ones surface first. The
// response carries `wouldRemoveVersion` as the deploy-confirm stamp (this function
// has no APP_VERSION — the #345/#365 resolveVersion precedent).
async function readWouldRemove(rank) {
  const out = {
    wouldRemoveVersion: "367-would-remove-observe-v4",
    version: WOULDREMOVE_VERSION, tiles: 0, total: 0, by_category: {},
    ranked: 0, queue: [], errors: [],
    key_present: !!GOOGLE_PLACES_KEY,   // is GOOGLE_PLACES_KEY configured on this function
    rank_debug: {},                     // per-call outcome tally when rank>0 (rated / noresult / namereject / offpin / httpNNN) — tells quota vs guard state apart
  };
  try {
    const { data, error } = await supabase
      .from("shared_kv").select("key,value").like("key", "wouldremove:" + WOULDREMOVE_VERSION + ":%");
    if (error) { out.errors.push(String(error.message || error)); return out; }
    const byId = new Map();
    for (const row of (data || [])) {
      let o; try { o = JSON.parse(row.value); } catch (_) { continue; }
      if (!o) continue;
      out.tiles++;
      for (const it of (o.items || [])) {
        if (!it || it.id == null) continue;
        if (!byId.has(it.id)) byId.set(it.id, { ...it, tile: o.tile });
      }
    }
    const items = [...byId.values()];
    out.total = items.length;
    for (const it of items) {
      const c = it.category || "?";
      out.by_category[c] = (out.by_category[c] || 0) + 1;
    }
    const n = Math.max(0, Math.min(Number(rank) || 0, WOULDREMOVE_RANK_MAX));
    if (n > 0 && GOOGLE_PLACES_KEY && items.length) {
      // Sample EVENLY across the whole backlog by STRIDE, not just the head —
      // otherwise the tiles that cold-built first monopolise the N Places calls
      // (a queue full of one metro's obscure campus art) and the busy, rescue-
      // worthy pins deeper in the queue never get a rating (the v1 QA finding).
      // Rate the sampled pins, then float the rated ones to the top so the
      // popular pins lead the returned queue.
      const stride = Math.max(1, Math.floor(items.length / n));
      const picks = [];
      for (let i = 0; i < items.length && picks.length < n; i += stride) picks.push(items[i]);
      for (const it of picks) {
        const pop = await placesPopularity(it.name, it.lat, it.lng, out.rank_debug);
        if (pop) { it.rating = pop.rating; it.userRatingCount = pop.userRatingCount; out.ranked++; }
      }
      items.sort((a, b) => (b.userRatingCount || 0) - (a.userRatingCount || 0));
    }
    out.queue = items.slice(0, WOULDREMOVE_QUEUE_MAX);
    return out;
  } catch (e) { out.errors.push(String((e && e.message) || e)); return out; }
}

// --- #104: OPERATOR BLOCKLIST -----------------------------------------------
// The tag filter above catches recorded closures. This catches the other kind:
// a place you have physically stood in front of and know is not there. It is
// the half that would actually have removed the pin that started this row,
// because that POI carries no closure tag at all — nobody edited it.
//
// STORED IN `shared_kv`, NOT A NEW TABLE, and that is a considered choice
// rather than laziness: the tile cache already lives there, the service-role
// key already reaches it, so this ships with NO migration, NO new RLS policy
// and nothing to forget in the dashboard. If it ever grows past a few hundred
// entries or needs per-user writes (item 100), it earns its own table then.
//
//   key:   places:blocklist
//   value: {"ids":["osm_node123456"],"names":["beyond the wall posters frames"]}
//
// `ids` is exact and preferred. `names` is normalised with the same normName()
// the deduper uses and matches ANY place with that name anywhere — deliberately
// blunt, for defunct chains with a dozen dead branches. Use ids unless you mean
// it.
//
// APPLIED AT SERVE TIME, ON BOTH PATHS, and that is the load-bearing part. If
// it were applied only before writeCacheRow(), a pin you blocked today would
// keep being served from the 21-day cache row written yesterday, and the only
// fix would be a CACHE_VERSION bump that nukes every tile on earth to remove
// one shop. Filtering on the way out means adding an id takes effect on the
// next request, everywhere, with no deploy.
//
// Costs one extra shared_kv read per request, memoised in module scope for five
// minutes. The memo is per-isolate, so an edit propagates as isolates recycle —
// five minutes is the ceiling, not the guarantee.
const BLOCKLIST_KEY = "places:blocklist";
const BLOCKLIST_MEMO_MS = 5 * 60 * 1000;
let _blocklist = null;
let _blocklistAt = 0;

// --- #25: USER REPORTS — REASON CODES ---------------------------------------
// The vocabulary is defined HERE and nowhere else. The client renders labels
// from its own copy for latency reasons, but this object is the validator: an
// unknown `reason` is a 400, not a row. That ordering matters — a free-text
// reason column fills up with junk within a week and the threshold below can
// never be computed from it again.
//
// `suppresses` IS THE WHOLE DESIGN DECISION IN THIS ROW AND IT IS NOT WHAT #25
// PROPOSED. The roadmap listed five reason codes and one threshold, as though
// crossing it always meant "remove the pin." It does not. Three of these are
// claims that the pin should not exist at all; four are claims that something
// ABOUT the pin is wrong, which is a fix, not a deletion. Auto-removing a real
// park because seven people said the pin sits 40 m off is a worse outcome than
// leaving the offset in place, and it is unrecoverable from the user's side.
//
// `unsafe` IS DELIBERATELY NOT SUPPRESSING, and this is the one to read twice.
// You asked for it and it is the most valuable reason code here for a human
// reader — it is also the only one where threshold-based automation is
// actively dangerous. A handful of reports removing every pin in a
// neighbourhood is redlining implemented as a feature, executed by a counter
// that cannot tell fear from prejudice and leaves no trace of what it deleted.
// It goes in the queue, it never moves the map on its own. Do not "finish" this
// by adding suppresses:true here later.
//
// #132 — `moved` EXISTS BECAUSE ITS ABSENCE WAS AN AUTOMATED DELETION. #25
// shipped seven codes and this was not one of them, which #106 and #109 had
// both specified in advance. The consequence was not "one missing button": a
// person standing at 2426 N Racine looking at the bar that replaced Gaslight
// taps "It's not here / permanently closed", because that is the honest report
// and it was the only one on offer — and `gone` suppresses. So a bar that
// MOVED was deleted by a counter, with no replacement pin, which #109 states
// plainly is a worse outcome than the wrong pin, because a wrong pin is
// visible and an absent one is not.
//
// It is `suppresses: false` for the same reason `unsafe` is: a move is a
// RELOCATION, and the correct response is to find the new node, not to remove
// the old one. The note field is where the value actually is — someone who
// knows a place moved usually knows where to — and the client prompts for it
// specifically on this reason. Do not "finish" this by adding suppresses:true.
//
// What this does NOT fix, said out loud so it is not rediscovered: `gone`
// still cannot tell CLOSED from MOVED, because the reporter frequently does
// not know either. `moved` lowers the misclassification rate, it does not
// eliminate it, and the free text remains the only thing that separates "it's
// a Chase bank now" from "they moved to Clark". That disambiguation belongs in
// #130's gate, and #109's step (1) — check OSM for a node at the new address
// before anything is suppressed — is still owed.

// --- #134: ONE NUMBER WAS DOING TWO OPPOSITE JOBS ---------------------------
// #25 shipped a single SUPPRESS_THRESHOLD of 3 across every suppressing
// reason. For `gone` and `chain` that number is exactly right and exists for a
// stated reason: one tap must not remove a place, because the reporter may be
// at the wrong door, the shop may be shut on a Tuesday, or the reporter may be
// griefing. Three strangers independently agreeing is the evidence bar.
//
// For `bogus` the SAME number produces the OPPOSITE failure. With this user
// base, three distinct reporters on one gem may never happen, so a single
// genuinely obscene submission sits on a public map indefinitely on one honest
// report. App Store policy 1.2 — the rule #25 and #49 both cite and #32
// inherits — wants objectionable UGC removable within 24 hours; a mechanism
// that acts only after three strangers independently find it does not meet
// that in substance, however many report buttons exist. #82's shape: shipping
// the control is not the same as backing the promise.
//
// THE ASYMMETRY THAT JUSTIFIES THE SPLIT, AND IT IS THE WHOLE ARGUMENT:
// `gone` protects a PLACE from its reporters. `bogus` protects USERS from the
// place. Those are not the same risk and must not share a dial.
//
// `bogus` is 1 and is DELIBERATELY NOT ENV-TUNABLE. Every other threshold here
// reads a secret; this one is a floor, and a floor with a knob on it is a
// floor that gets raised by whoever is annoyed at a false positive that week.
// Unpublishing a gem is reversible — it goes to `pending`, an operator
// re-approves — so the worst case in this direction is a legitimate gem hidden
// until someone looks. The worst case in the other direction is obscene
// content on a public map. Bounded loss against unbounded loss.
//
// The env var keeps its existing name and now governs the CROWD reasons only,
// so an operator who already set it gets the behaviour they set. #3(a)/#70
// rule verbatim: the code default and the secret must be kept identical,
// because a default nobody exercises is untested by construction. Live state
// today: NO secret is set, so every request runs the code default of 3.
const THRESHOLD_ENV_RAW = Deno.env.get("REPORT_SUPPRESS_THRESHOLD");
const THRESHOLD_ENV = (() => {
  const n = parseInt(String(THRESHOLD_ENV_RAW || "").trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
})();
const CROWD_THRESHOLD = THRESHOLD_ENV ?? 3;
const THRESHOLD_SOURCE = THRESHOLD_ENV ? "secret" : "fallback";

// #347 — BOGUS_THRESHOLD (=1) is RETIRED as bogus's LIVE bar, kept as a
// gravestone (not deleted — the #134 reasoning above is still the WHY, now
// satisfied differently). #134 made bogus=1 a no-knob floor so obscene UGC came
// off on ONE report (App Store 1.2, ~24 h), accepting that a single mistaken or
// malicious tap could yank a real, well-sourced gem (the World's Fair pin
// `be4cc026` was the live proof). #347 REVERSES that mechanism, not its goal:
// the FAST path moves off a single human tap onto a single AI content-check
// (the `_aiReviewReport` background pass — AI_ACT_REASONS), so obscene content
// still comes off on one report (faster than a tap ever was), while the HUMAN
// bar for bogus rises to the crowd threshold — so no lone tap can hide a real
// pin. bogus now reads CROWD_THRESHOLD like gone/chain (and so becomes
// env-tunable via REPORT_SUPPRESS_THRESHOLD, which #134 forbade — deliberately
// reversed, because the fast path no longer depends on this number). This
// const is no longer read by REPORT_REASONS below.
const BOGUS_THRESHOLD = 1; // retired — see #347 note above

// #347 — the reasons whose AI verdict may ACT (auto-remove on a confident
// 'remove'). ONLY content-judgeable reasons belong here: the AI reads the pin's
// OWN text, which answers "is this inappropriate/fake", NOT "did it close /
// move / is it a chain" (those need real-world ground truth, not a text model —
// #134). So gone/chain keep their crowd bar UNCHANGED and receive an advisory
// overview only; moved/unsafe/wrong_location/wrong_info/private NEVER
// auto-remove (#132/#134) and receive an overview routed to the human queue.
const AI_ACT_REASONS = new Set(["bogus"]);
// #347 — build stamp echoed on the report response so a deploy is confirmable
// (this function has no APP_VERSION; CACHE_VERSION is NOT bumped — serve-time
// filtering, the #25 no-bump precedent). Bump this string on any change to the
// report-review behaviour so QA can confirm the live build from the response.
const REPORT_REVIEW_VERSION = "349-report-backoff-v1";

const REPORT_REASONS = {
  gone:           { suppresses: true,  threshold: CROWD_THRESHOLD },  // doesn't exist / permanently closed
  moved:          { suppresses: false },                              // #132 — relocated. NEVER automated.
  chain:          { suppresses: true,  threshold: CROWD_THRESHOLD },  // a franchise the #104 filter missed
  bogus:          { suppresses: true,  threshold: CROWD_THRESHOLD },  // #347 — human bar = crowd; AI acts on ONE report (AI_ACT_REASONS). See the #347 note above.
  wrong_location: { suppresses: false },                              // pin is off — fix, not a deletion
  wrong_info:     { suppresses: false },                              // wrong name/category — same
  private:        { suppresses: false },                              // can't get to it — still exists
  unsafe:         { suppresses: false },                              // NEVER automated. See above.
};
const SUPPRESS_REASONS = Object.keys(REPORT_REASONS).filter((k) => REPORT_REASONS[k].suppresses);
// One accessor rather than REPORT_REASONS[r].threshold at four call sites, so
// a non-suppressing reason can never silently read `undefined` and compare
// false against every count. A reason that does not suppress has no threshold
// and asking for one is a bug, so this returns Infinity — unreachable — rather
// than a number that would quietly work.
function thresholdFor(reason) {
  const r = REPORT_REASONS[reason];
  if (!r || !r.suppresses) return Infinity;
  return r.threshold;
}
const SUPPRESS_THRESHOLDS = SUPPRESS_REASONS.reduce((o, k) => { o[k] = thresholdFor(k); return o; }, {});
// #25 — echoed on every places response so the client can CHECK its own copy of
// this vocabulary against the one that validates it, instead of the two drifting
// silently until a button starts 400ing. It costs seven short strings on a
// response that already carries dozens of places, and it needs no extra request
// because the client is already making this one. #68's "three lists that must
// agree" with the check actually wired up — the version of that row's mistake
// available here was shipping a comment claiming a check that did not exist.
const REASON_CODES = Object.keys(REPORT_REASONS);
const REPORT_SOURCES = new Set(["osm", "wiki", "gem"]);
const REPORT_NOTE_CAP = 500;

// #25 — DISTINCT REPORTERS, not report count. One person tapping the same pin
// from three devices is one reporter; the unique (target_id, reported_by)
// constraint on the table makes that true at the storage layer rather than
// trusting this count. #25 called for "threshold-based rather than one-tap, or
// a single bad actor can delete a real place from the map" — one row per person
// is what actually delivers that, the number is just the dial.
//
// #134 — THE DIAL MOVED UP, and this is where someone will look for it. After
// the per-reason split there is no single number to declare here: the
// threshold is a property of the REASON, not of the count. See the #134 block
// above REPORT_REASONS for the env var, the crowd default and why `bogus` is
// 1 and deliberately has no knob. The response still reports `thresholdSource`
// so the env fallback is observable rather than checkable — #70's finding,
// that an instrument nothing consumes is not installed.

async function readBlocklist() {
  if (_blocklist && Date.now() - _blocklistAt < BLOCKLIST_MEMO_MS) return _blocklist;
  try {
    const { data, error } = await supabase
      .from("shared_kv").select("value").eq("key", BLOCKLIST_KEY).maybeSingle();
    if (error) throw error;
    const obj = data && data.value ? JSON.parse(data.value) : {};
    _blocklist = {
      ids: new Set((obj.ids || []).map((s) => String(s))),
      names: new Set((obj.names || []).map((s) => normName(s)).filter(Boolean)),
      // #25 — `exempt` is the OPERATOR OVERRIDE on crowd suppression, and it
      // rides in this existing value rather than a new key so it needs no
      // migration and no second read. Semantics are the inverse of `ids`: an id
      // listed here can never be hidden by the report threshold, no matter how
      // many people file. It is the recovery path for "I went and looked, the
      // place is real, people are wrong" — without it, a wrongly-suppressed pin
      // can only be restored by deleting other people's reports, which destroys
      // the evidence of the mistake. It does NOT override `ids`: an operator
      // block still wins, or the override could be used to un-block by accident.
      exempt: new Set((obj.exempt || []).map((s) => String(s))),
    };
  } catch (_e) {
    // A failed read must NOT be cached as "nothing is blocked" — that is the
    // #1a shape (an error indistinguishable from an empty answer) and here it
    // would quietly resurrect every pin you ever removed. Serve empty for this
    // request only, and retry on the next one.
    return { ids: new Set(), names: new Set(), exempt: new Set(), failed: true };
  }
  _blocklistAt = Date.now();
  return _blocklist;
}

// --- #25: CROWD SUPPRESSION -------------------------------------------------
// The blocklist above is one operator asserting a fact. This is N users
// asserting one, and it is derived rather than stored: there is no
// "suppressed" column anywhere. The set is recomputed from open reports, which
// means an operator un-suppresses a pin by taking the rows out of `open` and
// the pin returns on the next memo expiry.
//
// #131 — THAT IS NOW A FUNCTION AND NOT A HAND-WRITTEN UPDATE, and this
// comment used to print the raw statement. `dismiss_report(id, note)` in the
// SQL editor is the supported path; `select * from public.reports_open;` is
// where you find the id. The raw UPDATE still works and is still the same
// mechanism — but it leaves no reviewer, no timestamp and no resolution note,
// which is #74's finding from the other direction: the header rule says never
// hand-edit status, and that rule is only honest if a function exists for
// every operation you actually need. Now one does.
//
// #104's rule, unchanged and load-bearing: a
// moderation decision belongs at the point of SERVING, not the point of
// storing. A stored boolean would have made every threshold crossing permanent
// and would have had to be un-set by hand, in a column, from memory.
//
// Applied on all four response paths for the same reason the blocklist is: a
// pin suppressed today is still sitting in a tile row written three weeks ago,
// and filtering on the way out is what makes it disappear without a
// CACHE_VERSION bump that nukes every tile on earth. THIS IS WHY #25 SHIPS
// WITH NO BUMP — say it out loud, because six entries in the version list above
// exist precisely because someone assumed a change was invisible to the cache.
// Here it genuinely is: nothing about what gets STORED changes.
//
// Costs one extra query per request, memoised five minutes per isolate, same
// contract as the blocklist. It reads only open rows carrying a suppressing
// reason, so the row count stays near the size of the live problem rather than
// the size of the report history.
const SUPPRESSION_MEMO_MS = 5 * 60 * 1000;
let _suppression = null;
let _suppressionAt = 0;

async function readSuppression() {
  if (_suppression && Date.now() - _suppressionAt < SUPPRESSION_MEMO_MS) return _suppression;
  try {
    // #134 — `reason` is now SELECTED, and that one extra column is the whole
    // change. Under a single threshold it was correct to pool every
    // suppressing report on a target into one set of distinct reporters.
    // Under per-reason thresholds that pooling is WRONG in both directions: it
    // would let two `gone` reports plus one `bogus` cross a bar of 3 that
    // neither reason reached on its own, and it would let a lone `bogus`
    // report — which is now sufficient by itself — be counted against 3
    // because a `gone` row shared the bucket. Distinct reporters are therefore
    // counted per (target, reason), and a target is hidden if ANY reason
    // clears its OWN bar.
    // #347 — `ai_verdict` is now SELECTED alongside the count columns. A
    // confident AI 'remove' on a CONTENT report (AI_ACT_REASONS) hides the pin
    // on ONE report — this is the fast path that replaces the retired bogus=1
    // floor (see the #347 note by REPORT_REASONS). The distinct-reporter counts
    // still drive the crowd bar for every suppressing reason (bogus included,
    // now at CROWD_THRESHOLD); the AI verdict is an ADDITIONAL way in, never a
    // way to KEEP a pin up — an 'unsure'/'keep'/'error'/absent verdict simply
    // leaves the report to accumulate toward the crowd bar like any other.
    const { data, error } = await supabase
      .from("reports")
      .select("target_id,reported_by,reason,ai_verdict")
      .eq("status", "open")
      .in("reason", SUPPRESS_REASONS);
    if (error) throw error;
    const byTargetReason = new Map();
    const aiRemoveIds = new Set();
    (data || []).forEach((r) => {
      if (!r || !r.target_id || !REPORT_REASONS[r.reason]) return;
      if (r.ai_verdict === "remove" && AI_ACT_REASONS.has(r.reason)) aiRemoveIds.add(String(r.target_id));
      const k = String(r.target_id) + "\u0000" + String(r.reason);
      let s = byTargetReason.get(k);
      if (!s) { s = new Set(); byTargetReason.set(k, s); }
      s.add(String(r.reported_by));
    });
    const ids = new Set();
    const counts = {};
    byTargetReason.forEach((s, k) => {
      const sep = k.indexOf("\u0000");
      const targetId = k.slice(0, sep);
      const reason = k.slice(sep + 1);
      if (!counts[targetId]) counts[targetId] = {};
      counts[targetId][reason] = s.size;
      if (s.size >= thresholdFor(reason)) ids.add(targetId);
    });
    // #347 — a confident AI 'remove' hides regardless of reporter count.
    aiRemoveIds.forEach((id) => ids.add(id));
    // `counts` is still built and still read by nothing — a pre-existing #115
    // shape, carried forward rather than quietly deleted, and now at least
    // shaped so that whatever eventually reads it gets the per-reason
    // breakdown rather than a pooled number that no threshold matches.
    _suppression = { ids, counts, failed: false };
  } catch (_e) {
    // Same #1a shape the blocklist guards against, pointing the other way. A
    // failed read here CANNOT be memoised as "nothing is suppressed" or a
    // transient DB blip resurrects every reported pin for five minutes and
    // looks exactly like the feature not working. Serve unsuppressed for THIS
    // request, retry on the next. Reported as `suppressionFailed` rather than
    // swallowed, so "no suppressions" and "couldn't check" are different
    // readings — the distinction #90 and #78c both turned out to need.
    return { ids: new Set(), counts: {}, failed: true };
  }
  _suppressionAt = Date.now();
  return _suppression;
}

// #25 — `blocked` and `suppressed` are counted SEPARATELY and both are
// returned. They are different claims with different owners: one is an operator
// decision, one is a crowd verdict that may be wrong. Folding them into a
// single number would make "the blocklist is broken" and "seven people reported
// a real place" the same reading, which is the failure this file has now hit in
// #90, #78c and #104 and should stop hitting.
function applyBlocklist(places, bl, sup) {
  const supIds = (sup && sup.ids) || new Set();
  const exempt = (bl && bl.exempt) || new Set();
  const hasBl = bl && (bl.ids.size || bl.names.size);
  if (!hasBl && !supIds.size) return { places: places || [], blocked: 0, suppressed: 0 };
  let blocked = 0, suppressed = 0;
  const kept = (places || []).filter((p) => {
    if (!p) return false;
    const id = String(p.id);
    if (hasBl && bl.ids.has(id)) { blocked++; return false; }
    if (hasBl && bl.names.size && bl.names.has(normName(p.name))) { blocked++; return false; }
    if (supIds.has(id) && !exempt.has(id)) { suppressed++; return false; }
    return true;
  });
  return { places: kept, blocked, suppressed };
}

// --- #367: STORY-GATE SERVE-PATH HIDE (OSM/tile layer) ----------------------
// The load-bearing half of #367. The OSM dots the observe-only arm above has
// been tallying (source==='osm' && descIsThin — an OSM pin still on filler)
// are now HIDDEN at serve time, so the live map is "OSM places with a real,
// sourced story" — every metro, both the warm and cold paths, all categories.
// This is the serve-path sibling of #344 brick 5 (which hides storyless GEMS);
// together they make the universal story-gate real on the tile layer too.
//
// APPLIED AS A SERVE-TIME FILTER over the already-blocklisted set — NOT baked
// into `merged`. The cache row stays the faithful #104 record of what Overpass
// and Wikipedia said, so this ships with NO CACHE_VERSION bump and is INSTANTLY
// reversible (delete the two calls + redeploy — no 21-day tile poisoning, no
// "nuke every tile on earth"). The observe arm (recordWouldRemove) still tallies
// the full storyless set from the un-hidden `merged`, so the #369/#370 rescue
// queue keeps working WHILE the hide is live — rescue-in-parallel, never blind.
//
// CARVE-OUTS (the two operator decisions, 2026-09-17 — mostly fall out of the
// existing _isStorylessOsm shape, so there is little to special-case here):
//   - Human-vouched gems (source!=='osm') are never touched: the filter keys on
//     source==='osm' exactly as _isStorylessOsm does, so a seed/user gem is out
//     of scope by construction — its story-gate is #344 brick 5, on the gem side.
//   - Non-notable OSM commercial is ALREADY dropped at categorize time (#309);
//     a notability-linked commercial pin files under 'history' and carries a
//     story (not thin), so it is not storyless. Nothing extra to do.
//   - GRAVE-CLASS pins are KEPT-UNTIL-PRIMED (_isGraveClassPin exemption): an
//     un-primed grave (#364 has primed 7 of ~21 metros) shows filler today, but
//     priming is monotonic and ongoing, so hiding it because its metro's
//     gravebank is still cold would be a FALSE-hide, not a storyless dot. Once
//     #364 primes it the bio is >60 chars and it is not storyless anyway. This
//     exemption is UNCHANGED — #374 does its work UPSTREAM (demoteStructureGraves,
//     which runs before this) by re-mapping a structure-named `type:'grave'` OSM
//     pin to `type:'historic'`, so it is no longer grave-class here: a storyless
//     one then falls to this hide like any other lore pin, and a non-storyless
//     one (e.g. a wrong-attached columbarium court) survives as a plain History
//     pin instead of a grave. A person-named grave is never demoted, so it keeps
//     the exemption.
//
// ESCAPE HATCH — showHidden (body.showhidden, or ?showhidden=1 on the URL for a
// curl/dashboard eyeball) disables the hide and serves everything, so the
// operator can see exactly what came off the map (the server sibling of #344's
// client ?showhidden=1). The `hidden` count is reported either way.
function hideStorylessOsm(places, showHidden) {
  if (showHidden) return { places: places || [], hidden: 0 };
  let hidden = 0;
  const kept = (places || []).filter((p) => {
    if (_isStorylessOsm(p) && !_isGraveClassPin(p)) { hidden++; return false; }
    return true;
  });
  return { places: kept, hidden };
}

// --- #25: REPORT INTAKE -----------------------------------------------------
// A second route on THIS function rather than a new Edge Function, and the
// reason is not laziness. The suppression read has to live here — it is the
// only code path that serves pins — so a separate `report-pin` function would
// mean two deploy targets that must be kept in step on one vocabulary, which is
// the exact "one fact, two deploy targets" shape this project keeps getting
// burned by. Routed on `action:"report"` in the body, checked BEFORE the
// lat/lng validation so a report never has to carry coordinates it doesn't
// have.
//
// AUTH IS REQUIRED AND VERIFIED SERVER-SIDE. `reported_by` is taken from the
// JWT, never from the body: a client-supplied user id makes the distinct-
// reporter threshold decorative, since one script could file three "reports"
// under three invented uuids and delete any place on the map. The anon key
// produces a token with no user, so demo/logged-out sessions get a clean 401
// rather than a row.

// #347 — flip a reported GEM out of the live set. Factored out of the
// synchronous crossed-threshold branch so the background AI-remove path (below)
// applies the EXACT same effect (one home for "hide a gem"): approve→pending,
// reversible by an operator re-approve. An OSM/wiki pin needs no write — it is
// hidden at serve time by readSuppression(). See the crossed branch for why
// 'pending' (not a new status) and the audit-trail caveat.
async function _flipGemToPending(targetId) {
  try {
    await supabase.from("submissions")
      .update({ status: "pending" })
      .eq("id", targetId)
      .eq("status", "approved");
  } catch (_e) { /* the report is recorded either way; the queue catches it */ }
}

// #347 — AI REVIEW OF A REPORT. Judges the pin's OWN text only: is it content
// the public map must not carry (sexual/obscene, hateful, violent, harassing,
// or obviously fake/spam)? Returns {verdict:'remove'|'keep'|'unsure'|'error',
// rationale}. Mirrors _aiNameListCall's temperature-0 / JSON / 2-try shape and
// reuses AI_MODEL + the per-function GEMINI_API_KEY. FAIL-OPEN by construction:
// no key / throttle / http / parse failure returns 'error', which the caller
// treats as NOT a removal (behaves like 'unsure') — an AI outage can never pull
// a pin, and can never suppress the crowd backstop. The model is told NOT to
// judge closed/moved/chain (it cannot know that from text); only CONTENT.
// #349 — the report-overview backoff ladder (2/5/12/25 s). Longer than the
// resolve path's single AI_RETRY_DELAY_MS because _aiReviewReport runs in the
// BACKGROUND (EdgeRuntime.waitUntil — the reporter's POST already returned), so
// it can afford to pace through a 429 burst instead of giving up after 2 tries
// and landing ai_verdict='error'. STILL FAIL-OPEN: a final failure returns
// 'error', which the caller treats as NOT a removal (safety-neutral — the burst
// just means the ADVISORY overview populates more often, never that a pin is
// pulled). Scoped to the report overview only; the two resolve-path AI calls
// keep the tight 2x1500 loop (a user can be waiting on the resolveWiki action).
const AI_REPORT_BACKOFF_MS = [2000, 5000, 12000, 25000];
// Honour a Retry-After header (delta-seconds or an HTTP-date) when Gemini sends
// one, capped at 60 s; otherwise fall back to the ladder step. Never throws.
function _retryAfterMs(res, fallbackMs) {
  try {
    const h = res && res.headers ? res.headers.get("retry-after") : null;
    if (h) {
      const secs = Number(h);
      if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60000);
      const when = Date.parse(h);
      if (Number.isFinite(when)) return Math.max(0, Math.min(when - Date.now(), 60000));
    }
  } catch (_e) { /* fall through to the ladder step */ }
  return fallbackMs;
}
async function _aiReviewReport({ name, description, reason, note }) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return { verdict: "error", rationale: "no AI key" };  // rung inert → no-act
  const prompt =
    "You are a content-safety reviewer for a public map of real local places. A user " +
    "reported a pin. Judge ONLY whether the pin's OWN text below is content the map must " +
    "not carry: sexual or obscene, hateful, harassing, violent, or obviously fake/spam. " +
    "You are judging the CONTENT you can see — do NOT try to judge whether the place has " +
    "closed, moved, or is a chain, because you cannot know that from text.\n" +
    "Return verdict 'remove' ONLY if you are highly confident the text is clearly " +
    "inappropriate or fake. If it reads like a real place, return 'keep'. If you are not " +
    "sure, return 'unsure'. When in any doubt, do NOT return 'remove'.\n" +
    "Respond with JSON only: {\"verdict\": \"remove\" | \"keep\" | \"unsure\", \"rationale\": <short string>}\n" +
    "Reported reason: " + String(reason || "") + "\n" +
    "Reporter note: " + (String(note || "").slice(0, 300) || "(none)") + "\n" +
    "Pin name: " + (String(name || "").slice(0, 200) || "(none)") + "\n" +
    "Pin description: " + (String(description || "").slice(0, 600) || "(none)");
  try {
    let res = null, raw = "";
    const maxAttempts = AI_REPORT_BACKOFF_MS.length + 1;  // #349 — initial try + 4 backoffs
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + AI_MODEL + ":generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, responseMimeType: "application/json" },
          }),
        },
      );
      raw = await res.text();
      if (res.ok || !AI_RETRY_STATUSES.has(res.status) || attempt >= maxAttempts) break;
      // #349 — pace through the throttle: Retry-After if given, else the ladder step.
      await new Promise((r) => setTimeout(r, _retryAfterMs(res, AI_REPORT_BACKOFF_MS[attempt - 1])));
    }
    if (!res || !res.ok) return { verdict: "error", rationale: "ai http " + (res ? res.status : "none") };
    const data = JSON.parse(raw);
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    let text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("").trim();
    if (!text) text = parts.map((p) => p.text || "").join("").trim();
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    const parsed = JSON.parse((s >= 0 && e >= 0) ? text.slice(s, e + 1) : text);
    let verdict = String(parsed.verdict || "").trim().toLowerCase();
    if (verdict !== "remove" && verdict !== "keep" && verdict !== "unsure") verdict = "unsure";
    const rationale = String(parsed.rationale || "").trim().slice(0, 300);
    return { verdict, rationale };
  } catch (_e) {
    return { verdict: "error", rationale: "ai parse/network failure" };
  }
}

// #347 — the BACKGROUND review, scheduled from handleReport via
// EdgeRuntime.waitUntil so the reporter's POST never waits on Gemini. Runs on
// EVERY report (the overview the operator asked to "start with"): it reads the
// pin's text, gets a verdict, and writes {ai_verdict, ai_rationale, ai_model,
// ai_at} to the report row for the human queue + the app-report digest. It ACTS
// only when the verdict is 'remove' AND the reason is in AI_ACT_REASONS — for
// everything else the verdict is advisory. Every write is best-effort and the
// whole task is wrapped so it can never throw out of a background context.
async function _runReportReview(row) {
  try {
    let name = row.target_name || "";
    let description = "";
    if (row.target_source === "gem") {
      // A gem is a row we own — read its stored text to judge. OSM/wiki pins
      // have no stored description here (they live in a cached tile blob), so
      // the AI judges on name + reporter note alone for those.
      try {
        const { data } = await supabase
          .from("submissions")
          .select("name,description,description_clean")
          .eq("id", row.target_id)
          .maybeSingle();
        if (data) {
          name = data.name || name;
          description = data.description || data.description_clean || "";
        }
      } catch (_e) { /* judge on what we have */ }
    }
    const { verdict, rationale } = await _aiReviewReport({
      name, description, reason: row.reason, note: row.note,
    });
    try {
      await supabase.from("reports")
        .update({
          ai_verdict: verdict,
          ai_rationale: rationale,
          ai_model: AI_MODEL,
          ai_at: new Date().toISOString(),
        })
        .eq("target_id", row.target_id)
        .eq("reported_by", row.reported_by);
    } catch (_e) { /* the overview is best-effort; the report itself is recorded */ }
    // ACT only on a confident 'remove' for a content reason. 'keep'/'unsure'/
    // 'error' do nothing here — the report stays open and counts toward the
    // crowd bar, so a pin the AI wrongly cleared can still be pulled by 3 humans.
    if (verdict === "remove" && AI_ACT_REASONS.has(row.reason)) {
      _suppressionAt = 0;                          // this isolate re-reads on the next map request
      if (row.target_source === "gem") await _flipGemToPending(row.target_id);
    }
  } catch (_e) { /* a background task must never throw */ }
}

async function handleReport(req, body) {
  const reason = String(body.reason || "");
  const targetId = String(body.target_id || "").trim();
  const targetSource = String(body.target_source || "").trim();

  if (!REPORT_REASONS[reason]) return { status: 400, body: { error: "unknown_reason" } };
  if (!targetId || targetId.length > 200) return { status: 400, body: { error: "bad_target_id" } };
  if (!REPORT_SOURCES.has(targetSource)) return { status: 400, body: { error: "bad_target_source" } };

  const auth = req.headers.get("Authorization") || "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  let user = null;
  if (jwt) {
    try {
      const { data } = await supabase.auth.getUser(jwt);
      user = (data && data.user) || null;
    } catch (_e) { user = null; }
  }
  if (!user || !user.id) return { status: 401, body: { error: "sign_in_required" } };

  const noteRaw = typeof body.note === "string" ? body.note.trim() : "";
  const note = noteRaw ? noteRaw.slice(0, REPORT_NOTE_CAP) : null;

  const row = {
    target_id: targetId,
    target_source: targetSource,
    reason,
    note,
    reported_by: user.id,
    // Denormalised on purpose. The moderation queue (#38) needs to know WHAT
    // was reported, and for an OSM pin there is nothing to join to — the pin
    // exists only inside a cached tile blob. Storing the name and coordinates
    // at report time also captures what the reporter actually saw, which
    // survives the pin later changing or vanishing from OSM entirely.
    target_name: typeof body.target_name === "string" ? body.target_name.slice(0, 200) : null,
    lat: typeof body.lat === "number" ? body.lat : null,
    lng: typeof body.lng === "number" ? body.lng : null,
    status: "open",
  };

  const { error: insErr } = await supabase
    .from("reports")
    .upsert(row, { onConflict: "target_id,reported_by" });
  if (insErr) return { status: 500, body: { error: "write_failed", detail: insErr.message || String(insErr) } };

  // Recount THIS target from the table, not from the memo. The memo is up to
  // five minutes stale and the report just written would not be in it, so a
  // third reporter would be told they were the second and the pin would stay
  // up until the memo expired. Ordering is load-bearing: write, then count.
  //
  // #134 — the recount is now scoped to THIS reason, matching readSuppression()
  // above. It has to be: the bar this report is measured against is the bar for
  // the reason that was tapped, so counting rows filed under a different reason
  // would compare a mixed population to a single number and get both the
  // crossing and the "you are the Nth" wrong.
  let distinct = 0, crossed = false, countFailed = false;
  if (REPORT_REASONS[reason].suppresses) {
    try {
      const { data, error } = await supabase
        .from("reports")
        .select("reported_by")
        .eq("target_id", targetId)
        .eq("status", "open")
        .eq("reason", reason);
      if (error) throw error;
      distinct = new Set((data || []).map((r) => String(r.reported_by))).size;
      crossed = distinct >= thresholdFor(reason);
    } catch (_e) { countFailed = true; }
  }

  if (crossed) {
    // Drop the memo so the pin disappears on the NEXT map request rather than
    // up to five minutes later. Only this isolate's memo, so the ceiling
    // elsewhere is still five minutes — same honesty the blocklist comment owes.
    _suppressionAt = 0;
    // #25's "two distinct resolution paths, and conflating them is the trap."
    // An OSM/Wikipedia pin cannot be edited from here, so it is suppressed at
    // serve time by readSuppression() above and nothing is written. A GEM is a
    // row we own, and it is read by the client STRAIGHT FROM `submissions`
    // (status='approved') without passing through this function — so serve-time
    // suppression is not available to it and the row itself has to move.
    //
    // Flipped to 'pending', NOT to a new 'reported' value: `status` may carry a
    // CHECK constraint written before this row existed, and an unknown enum
    // value would 500 the whole report — losing a legitimate report to a schema
    // detail. 'pending' is reversible (an operator re-approves), it is a value
    // the AI gate already writes, and nothing auto-approves pending rows, since
    // review-submission only ever runs on ids the client hands it at submit
    // time. The cost, and it is real: a gem pulled by reports is
    // indistinguishable in `submissions` from one never reviewed — the reports
    // table is the only place that records why. Named here so it is not
    // rediscovered as a bug.
    if (targetSource === "gem") await _flipGemToPending(targetId);  // #347 — one home for "hide a gem"
  }

  // #347 — schedule the background AI overview AFTER the synchronous crowd
  // decision above (which is unchanged, and still the only thing this response
  // reports). It runs on every report; it ACTS only on a confident 'remove' for
  // a content reason (AI_ACT_REASONS) — that is the fast path that lets bogus
  // sit at the crowd bar instead of the retired 1-tap floor. waitUntil so the
  // reporter never waits on Gemini; typeof-guarded so a runtime without it
  // degrades to inline (the crowd path is unaffected either way — the AI is
  // purely additive, and fail-open inside _runReportReview). Skipped when the
  // synchronous crowd bar already crossed — the pin is coming off regardless, so
  // the overview would only add cost; it will be reviewed from the queue.
  if (!crossed) {
    try {
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
        EdgeRuntime.waitUntil(_runReportReview(row));
      } else {
        _runReportReview(row).catch(() => {});   // no waitUntil → best-effort inline, never blocks the return
      }
    } catch (_e) { /* scheduling must never fail the report */ }
  }

  return {
    status: 200,
    body: {
      ok: true,
      reason,
      suppresses: REPORT_REASONS[reason].suppresses,
      distinctReporters: distinct,
      // #134 — the threshold that actually applied to THIS report, not a
      // global. `Infinity` does not survive JSON.stringify (it serialises as
      // null), so a non-suppressing reason reports null, which is the honest
      // value: there is no bar because nothing is being counted.
      threshold: REPORT_REASONS[reason].suppresses ? thresholdFor(reason) : null,
      thresholdSource: THRESHOLD_SOURCE,
      suppressed: crossed,
      countFailed,
      // #347 — build stamp so a deploy of this pass is confirmable from the
      // report response (this function has no APP_VERSION). A first `bogus`
      // report now returns suppressed:false here (was true under the retired
      // 1-tap floor) — the AI verdict lands asynchronously, not in this body.
      reviewVersion: REPORT_REVIEW_VERSION,
    },
  };
}


// --- #394: STALE-WHILE-REVALIDATE, RESTORED -------------------------------------
// #291 shipped this on 2026-08-18 and a later rebuild of this file dropped it,
// so every tile past its 21-day TTL was rebuilt INLINE on its next request —
// the full Overpass wall (26–44 s in the #164 QA) paid by a returning user in
// an area that already had a perfectly good row. Restored here ON THE CURRENT
// FILE (not by pasting #291's old code), so it carries every serve layer added
// since. Three pieces:
//
//   buildLiveTile()    — THE one home for building a tile from scratch: Overpass
//                        + Wikipedia geosearch + the #163 title enrich + the #164
//                        Q-id bake + the #359 alt-name / #367 by-name resolves
//                        (#387 time-bounded) + the #363 grave bake + the #367
//                        would-remove tally. Called INLINE by path 2 (a tile with
//                        no row, nothing to serve stale) and in the BACKGROUND by
//                        a stale refresh. It does NOT write the cache row — the
//                        caller decides (path 2 serves then writes, exactly as
//                        before; the refresh writes under the same guard).
//   serveCachedLayers() — the warm-path serve layers, one home for the fresh fast
//                        path (1), the stale serve (1b) and the Overpass-failed
//                        fallback (3): grave bake (#363), bank heal (#367),
//                        curated (#362), blocklist + suppression (#104/#25),
//                        structure-grave demote (#374/#375), storyless hide
//                        (#367). A stale row is served with the SAME opinions a
//                        fresh one gets — before #394, path 3 applied only the
//                        blocklist and would have shown hidden storyless dots.
//   scheduleTileRefresh() — fires buildLiveTile in the background via
//                        EdgeRuntime.waitUntil, coalesced per isolate through
//                        refreshInFlight (N requests to one expired tile → ONE
//                        Overpass refresh), with a short per-tile cooldown after a
//                        failed refresh so a down Overpass isn't hit by every
//                        visitor. No waitUntil in this runtime → returns null and
//                        the request falls through to the inline build (path 2),
//                        i.e. exactly the pre-#394 behaviour, never worse.
//
// NO CACHE_VERSION BUMP: this changes WHEN a row is built, not its SHAPE (the
// #291 rule). The written row is byte-for-byte what path 2 writes — the refresh
// runs the same curated clone → blocklist → structure-demote sequence before the
// write, because demoteStructureGraves mutates the shared pin objects and path 2
// has always persisted that mutation.
//
// Tradeoff, accepted (as in #291): the first visitor to an expired tile sees
// the row as it was (up to 21+ days old) instantly; the next request gets the
// rebuilt row. Serve-time layers (bank heal, grave bake, curated, blocklist,
// suppression, hide) are applied fresh on every serve anyway, so the stale part
// is only what Overpass/Wikipedia would say today. A NEVER-fetched tile still
// pays the wall inline — that residual is #292.
const SWR_VERSION = "394-swr-v1";
const SWR_FAIL_COOLDOWN_MS = 2 * 60 * 1000; // after a failed/unhealthy refresh, wait this long before this isolate retries the tile
const refreshInFlight = new Set();           // tiles with a background refresh running in THIS isolate
const _refreshFailedAt = new Map();          // tile -> ms of the last failed/unhealthy refresh (this isolate)

function _canBackground() {
  return typeof EdgeRuntime !== "undefined" && EdgeRuntime && typeof EdgeRuntime.waitUntil === "function";
}

async function buildLiveTile(tile, fc) {
  // 2) Live fetch — Overpass (raced) + Wikipedia geosearch in parallel.
  // #96 — fetchWikipedia now returns {places, wikiDropped}; the catch has to
  // return the same SHAPE, not [], or a wiki failure crashes the merge.
  // #289 — the OSM-history wiki-title enrichment (#163) used to run in a THIRD,
  // SERIAL Wikipedia round-trip AFTER this Promise.all resolved, so a cold tile
  // paid Overpass + geosearch + a separate extract fetch back-to-back. But the
  // extract fetch only needs the OSM titles (`parseOverpass` stashes them on
  // `.wp`), NOT the geosearch — so kick it off the MOMENT Overpass resolves and
  // let it OVERLAP the geosearch instead of stacking after both. Overpass and
  // the geosearch still run in parallel exactly as before; only the third fetch
  // moves. Titles are collected pre-dedupe (a superset of the surviving pins) —
  // accepted, see enrichOsmWikipedia's note: an extract fetched for an OSM pin
  // that later dedupes away is simply never applied, so `merged` is
  // byte-identical to before. This is a TIMING change, not a shape change, so
  // on its own it needs NO CACHE_VERSION bump (the bump this deploy carries is
  // #280's disambig drop, above).
  // (#395 — the temporary [#289-timing] probes that wrapped each leg here were
  // stripped: #289 measured the wall (Overpass), #291/#394 own the fix.)
  const osmP = fetchOverpass(fc.lat, fc.lng);
  const wikiP = fetchWikipedia(fc.lat, fc.lng)
    .catch(() => ({ places: [], wikiDropped: 0, wikiNoExtract: 0 }));
  const wpExtractsP = osmP
    .then((o) => {
      const titles = Array.from(new Set(((o && o.places) || [])
        .filter((p) => p && p.source === "osm" && p.wp).map((p) => p.wp)));
      return titles.length ? fetchWikiExtractsByTitle(titles) : new Map();
    })
    .catch(() => new Map());
  // #164 — the Q-id hop (wbgetentities → intro+coordinate) also only needs the
  // Overpass result, so it chains off osmP beside the #163 extract fetch and
  // overlaps the geosearch the same way. A failure resolves to an empty Map.
  const qidArticlesP = osmP
    .then((o) => {
      const qids = ((o && o.places) || []).filter((p) => p && p.source === "osm" && p.qid).map((p) => p.qid);
      return qids.length ? fetchQidArticles(qids) : new Map();
    })
    .catch(() => new Map());
  const [osm, wiki, wpExtracts, qidArticles] = await Promise.all([osmP, wikiP, wpExtractsP, qidArticlesP]);
  const merged = dedupeReal(wiki.places, osm.places); // wiki wins ties (richer desc)

  // #163 — enrich linked OSM history pins from their own wikipedia= tag, in
  // place, BEFORE the cache write so the article intro is baked into the tile
  // (writeCacheRow persists `merged`) and served for 21 days with no
  // per-request wiki call. #289 — the extract fetch already ran OVERLAPPED with
  // the geosearch above; enrichOsmWikipedia now APPLIES that pre-fetched Map
  // (and still strips the internal `wp` field off every place). The .catch is
  // belt-and-suspenders — enrichOsmWikipedia does not throw — but if it ever
  // did, the tile still serves with osmDesc lines intact rather than 500ing.
  const wpEnrich = await enrichOsmWikipedia(merged, wpExtracts).catch(() => ({ enriched: 0, wpLinked: 0 }));

  // #164 — OPTION B, applied right after the #163 wikipedia= enrich and BEFORE
  // the #359 alt-name / #367 by-name resolves: a Q-id is a deterministic
  // identity, so a pin it fills is no longer thin and the by-name passes skip
  // it (their per-tile budget goes to pins that still need a guess). Also
  // strips the internal `qid` field so it never bakes into the tile.
  const qidEnrich = await enrichOsmWikidata(merged, qidArticles)
    .catch(() => ({ qidLinked: 0, qidEnriched: 0, qidNoArticle: 0, qidNoCoord: 0, qidFar: 0 }));

  // #359 — ALT-NAME BRIDGE, applied here (after the #163 wikipedia= enrich, before
  // the cache write) so a resolved article BAKES into the tile and the client gets
  // it on first paint (#358's client is already ready to render it, no-downgrade).
  // Each pin parseOverpass marked with an `altName` is resolved through the SAME
  // coordinate-gated, banking resolver every by-name resolve uses: resolveWikiByName
  // runs the #316 descriptionGate, so a broadened alt-name search CANNOT wrong-
  // attach — the article's OWN coordinate must sit on the pin — and a #357-banked
  // hit returns deterministically, so re-building this tile is free. A hit replaces
  // the pin's line ONLY when the current line is THIN (descIsThin — "Totem pole"
  // yields to the Kwanusila article; a rich human `description` per #53 is never
  // downgraded) and the article is actually longer. BOUNDED to ALT_RESOLVE_MAX per
  // tile so a nickname-dense tile can't blow the cold-path Wikipedia budget. A
  // transient resolver failure leaves the pin on its current line, never blank
  // (the #358 "429 ≠ absence" rule — do not latch a negative).
  const altTargets = merged.filter((p) => p && p.altName && descIsThin(p.desc)); // #164 — a Q-id-filled pin needs no alt-name guess
  let altResolved = 0;
  // #387 — bounded + concurrent (was sequential and could alone exceed the wall clock).
  // Capture altName up front: the delete below runs before any background straggler reads it.
  const altWork = altTargets.slice(0, ALT_RESOLVE_MAX).map((p) => ({ p, alt: p.altName }));
  await runBounded(altWork, async ({ p, alt }) => {
    try {
      const hit = await resolveWikiByName(alt, p.lat, p.lng);
      const nd = hit && hit.desc ? String(hit.desc).trim() : "";
      if (nd && descIsThin(p.desc) && nd.length > String(p.desc || "").trim().length) { p.desc = nd; altResolved++; }
    } catch (_) { /* transient — keep the pin's current line, never blank (#358) */ }
  }, COLD_RESOLVE_BUDGET_MS, COLD_RESOLVE_CONCURRENCY);
  merged.forEach((p) => { if (p && p.altName) delete p.altName; }); // internal plumbing — never bake it into the tile

  // #367 — GENERALISED by-name resolve: every storyless OSM facts pin (not just
  // the #359 alt-name ones) is resolved by its NAME through the coordinate-gated,
  // #357-banking resolveWikiByName, accepted only on the stricter _osmStrictMatch
  // (so a generic name can't wrong-attach), and baked (thin-only, no-downgrade).
  // A hit is banked → writeCacheRow persists it AND the warm heal serves it on
  // already-cached tiles → no CACHE_VERSION bump. Runs BEFORE recordWouldRemove +
  // the cold-path hide below, so a rescued pin drops out of the would-remove tally
  // and is not hidden on this very serve.
  const osmResolved = await resolveThinOsmByName(merged);

  // #363 — bake banked grave bios into `merged` so writeCacheRow PERSISTS them:
  // a live rebuild (SWR refresh, cold fetch) now RE-BAKES from the gravebank
  // instead of reverting the grave pins to OSM filler and clobbering the
  // gate-tiles commit. Deterministic bank read, bank-only (an un-banked grave
  // keeps its filler — no live namesake guess), no-downgrade (descIsThin).
  const gravesBaked = await bakeGravesFromBank(merged);

  // #367 — OBSERVE-ONLY: record (never hide) the OSM pins the universal story-
  // gate WOULD remove, so the rescue backlog is visible before the hide widens.
  // Runs on the COLD build only (the warm fast path above returns before here),
  // reads `merged`, writes a SEPARATE `wouldremove:` row — the served tile is
  // byte-identical. Awaited but fully guarded; a bank failure never affects the
  // serve. A pre-#367 warm tile carries no row until its next SWR/TTL refresh.
  const wouldRemove367 = await recordWouldRemove(merged, tile);

  // (#395 — the temporary [#118] cold-tile console line was stripped; its
  // Option-A-vs-B question was settled by #164. Its counters now ride the
  // cold-path RESPONSE instead — see path 2's envelope.)
  return {
    merged, osm, wiki, wpEnrich, qidEnrich, altResolved, osmResolved, gravesBaked, wouldRemove367,
  };
}

async function serveCachedLayers(places, curIdx, bl, sup, showHidden) {
  // #363 — bake banked grave bios onto a cached tile BEFORE serving, so a tile
  // that was written with filler (a live rebuild that reverted #356's graves)
  // still serves the bio. In-memory only — the cached row is not rewritten
  // here (same reason the blocklist isn't), so this heals the warm read without
  // a purge; the build path persists the bake for future rebuilds.
  await bakeGravesFromBank(places);
  // #367 — heal storyless OSM facts pins from the #357 resolve bank on the way
  // out too (in-memory, no rewrite, same reversible-serve-opinion rule as the
  // grave bake): a pin already resolved+banked by a prior build/action/recheck
  // un-hides on this cached tile without waiting for its rebuild.
  await healThinOsmFromBank(places);
  // #362 — curated lines for storyless OSM facts pins, on a CLONE (serve-only,
  // never persisted — editing/deleting a curated row takes effect in minutes).
  const cur = applyCuratedToServe(places, curIdx);
  const f = applyBlocklist(cur.places, bl, sup);
  // #367 — hide storyless OSM dots on the way out, AFTER the blocklist and
  // over the same in-memory copy. The cached row is not rewritten (same
  // reason the blocklist isn't), so this is a reversible serve opinion, not a
  // mutation: a rescued/enriched tile rebuild un-hides on its own. Graves are
  // exempt (kept-until-primed); gems are source!=='osm'.
  const graveStruct = demoteStructureGraves(f.places); // #374/#375 — before the hide
  const g = hideStorylessOsm(f.places, showHidden);
  // The row is NOT rewritten without the blocked entries. Leaving them in the
  // cache and filtering on the way out is what makes un-blocking possible:
  // remove an id from the list and the pin comes back on the next request.
  // Rewriting would make every block permanent and irreversible.
  return { cur, f, graveStruct, g };
}

// The response envelope for a CACHED serve (fresh, stale, or Overpass-failed
// fallback) — one home so the three paths can't drift on deploy-confirm stamps.
function cachedEnvelope(tile, cached, s) {
  return {
    tile, places: s.g.places, cached: true, ts: cached.ts,
    cacheVersion: CACHE_VERSION,
    overpassStatus: null, overpassError: null,
    blocked: s.f.blocked, blocklistFailed: false,
    suppressed: s.f.suppressed, suppressionFailed: false,
    storyHidden: s.g.hidden, storyGateVersion: "367-osm-story-gate-v1",
    osmCurated: s.cur.curated, curatedOsmVersion: "362-curated-osm-v1", // #362 deploy-confirm + curated lines applied this serve
    graveStructVersion: "375-structure-grave-remove-v1", graveDemoted: s.graveStruct.demoted, graveStoryStripped: s.graveStruct.stripped, // #374/#375 deploy-confirm + counts this serve
    qidVersion: "164-wikidata-qid-v1", // #164 deploy-confirm (the Q-id bake runs at tile BUILD; a warm tile gains it on its next rebuild)
    swrVersion: SWR_VERSION, // #394 deploy-confirm
    emptyTileVersion: EMPTY_TILE_VERSION, osmEmpty: cached.osmEmpty === true, // #399 deploy-confirm + whether this is a healthy-empty (3-day) row
    reasonCodes: REASON_CODES,
    osmAge: osmAgeHistogram(s.g.places),
  };
}

// Background rebuild of an expired tile. Writes the row only under the SAME
// guard path 2 uses (Overpass healthy AND something survives the blocklist),
// so an Overpass outage never overwrites a good stale row with a Wikipedia-only
// one. A failed/unhealthy refresh leaves the stale row in place (it keeps
// serving) and starts the cooldown; the next request after it tries again.
// #399 — a healthy-EMPTY answer rewrites the row as a fresh 3-day osmEmpty row,
// but ONLY when the stale row had no OSM places (`prevHadOsm` false); a tile
// that had OSM places and now answers empty is treated as an unhealthy refresh.
async function _refreshTile(tile, fc, bl, sup, curIdx, prevHadOsm) {
  try {
    const b = await buildLiveTile(tile, fc);
    const osmHealthy = !b.osm.error && b.osm.places.length > 0;
    if (isHealthyEmptyOsm(b.osm)) {
      if (!prevHadOsm) {
        await writeCacheRow(tile, b.merged, true);
        _refreshFailedAt.delete(tile);
      } else {
        _refreshFailedAt.set(tile, Date.now());
      }
      return;
    }
    // Mirror path 2 exactly up to its write: curated clone → blocklist →
    // structure-grave demote (which mutates the shared pin objects in `merged`,
    // and path 2 has always persisted that). The hide is a serve opinion and is
    // NOT applied to the stored row, same as path 2.
    const curC = applyCuratedToServe(b.merged, curIdx);
    const shown = applyBlocklist(curC.places, bl, sup);
    demoteStructureGraves(shown.places);
    if (osmHealthy && shown.places.length) {
      await writeCacheRow(tile, b.merged);
      _refreshFailedAt.delete(tile);
    } else {
      _refreshFailedAt.set(tile, Date.now());
    }
  } catch (_e) {
    _refreshFailedAt.set(tile, Date.now());
  } finally {
    refreshInFlight.delete(tile);
  }
}

// Returns the refresh state for the response: "started", "in_flight",
// "cooldown", or null when this runtime can't run background work (the caller
// then builds inline instead of serving stale).
function scheduleTileRefresh(tile, fc, bl, sup, curIdx, prevHadOsm) {
  if (!_canBackground()) return null;
  if (refreshInFlight.has(tile)) return "in_flight";
  const failedAt = _refreshFailedAt.get(tile);
  if (failedAt && Date.now() - failedAt < SWR_FAIL_COOLDOWN_MS) return "cooldown";
  refreshInFlight.add(tile);
  try {
    EdgeRuntime.waitUntil(_refreshTile(tile, fc, bl, sup, curIdx, prevHadOsm));
  } catch (_e) {
    refreshInFlight.delete(tile);
    return null;
  }
  return "started";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  try {
    const body = await req.json().catch(() => ({}));

    // #25 — report intake. Checked BEFORE the lat/lng guard: a report is about
    // a pin, not about where the reporter is standing, and requiring
    // coordinates would have meant inventing them for a pin opened from the
    // nearby list. Body-shape routing rather than a path, because
    // supabase-js's functions.invoke() posts to the function root.
    if (body && body.action === "report") {
      const r = await handleReport(req, body);
      return json(r.body, r.status);
    }

    // #54 — resolve a place's wiki "what it is" BY NAME (the hybrid pin's on-
    // demand fallback for a place OSM does not carry, e.g. Mr. Beef). Body-shape
    // routed like `report`, and BEFORE the lat/lng guard is irrelevant here since
    // it validates its own args. Returns {place} or {place:null}; never 500s.
    if (body && body.action === "resolveWiki") {
      // #318 — `hint` (optional) is the submitter's stored writeup, forwarded by the
      // client so a descriptively-named gem can resolve by RECALL through the same
      // #316 gate. Absent it, this behaves exactly as the #54 name-only resolve.
      // #355 — `artist` (optional) is a public-art pin's creator, forwarded by the
      // offline gate warmer (gate-tiles.ts) so a title-only/nickname art name resolves
      // via the creator-qualified rung. Consumed only on the no-hint OSM branch.
      // #357 — `refresh` (optional) skips the resolve-bank read so a banked hit can be
      // re-validated against live Wikipedia (a moved/deleted article); a fresh hit
      // re-banks, a miss leaves the banked hit intact. Absent it, banked hits serve.
      let place = await resolveWikiByName(body.name, body.lat, body.lng, body.hint, body.artist, !!body.refresh).catch(() => null);
      // #365 — PLACES EXTERNAL-SOURCE RUNG (#318 cascade). The wiki + wikidata rungs found no
      // gate-passing article, but the place may be real-and-documented OUTSIDE Wikipedia — the
      // seed layer's blank-desc class (small museums, galleries, named parks/trails). Google
      // Places returns a name AND a coordinate, so it is gate-able like wiki (#316): a type-aware
      // coordinate radius + the #351 distinctive-token name match + a REQUIRED editorial summary
      // (a tag/type-only line is the #308/#344 no-story class → left blank/curatable, never
      // auto-written). SOURCED, not generated, so it runs BEFORE the gen-from-writeup rung below.
      // Per-request, banked (#357) so repeats cost no quota. No GOOGLE_PLACES_KEY → null → today.
      if (!place) place = await resolvePlacesByName(body.name, body.lat, body.lng).catch(() => null);
      // #318 CURATED RUNG — Places found no summarised match, but a human may have
      // curated a factual line for exactly this place (the summary-less tail).
      // Keyed to the pin by name + coordinate, served as source 'curated'. Runs
      // BEFORE the gen rung: a sourced human line beats a model-written one. Empty
      // table / no nearby curated row → null → gen-or-blank, exactly as today.
      if (!place) place = await resolveCuratedByName(body.name, body.lat, body.lng).catch(() => null);
      // #318 FINAL RUNG ("B") — the wiki rungs (name / AI-recall / literal-hint) found
      // NO gate-passing article. For a credited gem (the ONLY caller that sends a
      // hint), write a neutral factual "what it is" GROUNDED on the writeup so a place
      // no encyclopedia documents still gets a description instead of blank. The raw
      // take is never shown (the model neutralises it + the anti-launder guard); no
      // GEMINI_API_KEY → still null → blank, exactly as today. Per-request, uncached.
      if (!place && body.hint) {
        place = await _generateWhatItisFromWriteup(body.hint, body.name, body.lat, body.lng).catch(() => null);
      }
      // #345 — deploy-confirm stamp (this function has no APP_VERSION; the #347
      // reviewVersion precedent). Extra field, client ignores it — response shape
      // for the `place` consumer is unchanged.
      return json({ place, resolveVersion: "318-curated-rung-v1" });
    }

    // #367 — OBSERVE-ONLY read: aggregate the banked OSM would_remove set (the
    // storyless dots the universal story-gate would drop) into the OSM analog of
    // app-report's gem rescue queue. Body-shape routed like the actions above,
    // validates its own args, hides NOTHING. `rank` (optional, capped at
    // WOULDREMOVE_RANK_MAX) adds a bounded Places popularity lookup so the busy
    // ones surface first; without it the read costs zero external calls.
    if (body && body.action === "would_remove") {
      const wr = await readWouldRemove(body.rank);
      return json(wr);
    }

    // #385 — nightly Places sweep (pg_cron → here). TOKEN-GUARDED: the function
    // is callable with the public publishable key, so without PLACES_SWEEP_TOKEN
    // anyone could spend the Places quota. No token configured → disabled.
    // `dry:true` plans the run with zero Places calls; `max` can LOWER the budget.
    if (body && body.action === "places_sweep") {
      if (!PLACES_SWEEP_TOKEN) return json({ error: "places_sweep disabled: PLACES_SWEEP_TOKEN not set", sweepVersion: SWEEP_STAMP }, 503);
      if (body.token !== PLACES_SWEEP_TOKEN) return json({ error: "forbidden", sweepVersion: SWEEP_STAMP }, 403);
      const r = await runPlacesSweep({ dry: !!body.dry, max: body.max });
      return json(r);
    }
    // #385 — read-only status of the last sweep (outcomes + the curation queue:
    // the most-reviewed hidden places Places located but can't describe). Pin
    // names only, no PII, zero external calls — open like would_remove.
    if (body && body.action === "places_sweep_status") {
      return json(await readPlacesSweepStatus());
    }

    const { lat, lng } = body;
    if (typeof lat !== "number" || typeof lng !== "number") {
      return json({ error: "lat and lng (numbers) required" }, 400);
    }
    // #367 — story-gate escape hatch. Disables the OSM storyless-hide so the
    // operator can eyeball exactly what the gate removed. Read from the JSON
    // body (functions.invoke posts a body) OR the URL query (?showhidden=1, the
    // easy curl/dashboard lever). Any truthy value except "0"/"false"/"".
    let showHidden = !!body.showhidden;
    try {
      const qp = new URL(req.url).searchParams.get("showhidden");
      if (qp != null && qp !== "0" && qp !== "false" && qp !== "") showHidden = true;
    } catch (_) { /* body flag already read */ }
    const tile = tileKey(lat, lng);
    // v27 — anchor the live fetch on the tile CENTRE, not the raw request point,
    // so the 4.2km fetch circle always covers this whole ~5.5km tile (edge pins
    // no longer fall out) and the cached tile is the same no matter where in the
    // tile the first requester stood. See tileCenter() for the geometry.
    const fc = tileCenter(lat, lng);
    // #104 — read once, use on every path below. Cheap (memoised) and it has to
    // be in hand before the cached fast path returns, not after.
    // #25 — the suppression set has exactly the same requirement, and the two
    // reads run in parallel so the second one costs no wall clock.
    // #289 — the cache-row read depends on neither of those, so it JOINS the same
    // batch instead of paying its own serial Supabase round-trip on EVERY request
    // (the warm fast path included). Strictly fewer round-trips, same rows read.
    // #362 — the curated index joins the same parallel batch (memoised; a real
    // read only once per CURATED_INDEX_TTL_MS per instance).
    const [bl, sup, cached, curIdx] = await Promise.all([readBlocklist(), readSuppression(), readCacheRow(tile), loadCuratedIndex()]);
    // #385 — sampled, backgrounded tile-view count (the sweep's "where people look" signal).
    sampleTileHit(tile);

    // 1) Fast path — fresh cache row serves everyone.
    // #399 — the TTL is per row (3 days for a healthy-empty row, 21 otherwise),
    // and a healthy-empty row is servable with zero places.
    if (cached && Date.now() - cached.ts <= rowTtlMs(cached) && rowIsServable(cached)) {
      const s = await serveCachedLayers(cached.places, curIdx, bl, sup, showHidden);
      const env = cachedEnvelope(tile, cached, s);
      env.blocklistFailed = !!bl.failed; env.suppressionFailed = !!sup.failed;
      return json(env);
    }

    // 1b) #394 — STALE-WHILE-REVALIDATE. The row exists but is past its TTL:
    // serve it NOW (with every serve layer applied fresh) and rebuild it in the
    // background, instead of making this visitor wait on Overpass. `refresh`
    // reports "started" / "in_flight" (another request already kicked it off
    // in this isolate) / "cooldown" (a refresh failed <2 min ago; the stale row
    // keeps serving). If this runtime can't run background work, fall through
    // to the inline build below — the pre-#394 behaviour.
    if (rowIsServable(cached)) {
      const refresh = scheduleTileRefresh(tile, fc, bl, sup, curIdx, rowHasOsm(cached));
      if (refresh) {
        const s = await serveCachedLayers(cached.places, curIdx, bl, sup, showHidden);
        const env = cachedEnvelope(tile, cached, s);
        env.blocklistFailed = !!bl.failed; env.suppressionFailed = !!sup.failed;
        env.stale = true;
        env.refreshing = refresh !== "cooldown";
        env.refresh = refresh;
        return json(env);
      }
    }

    // 2) Live fetch — no usable row (a never-fetched tile, an empty row, or a
    // runtime without background work). The build itself lives in
    // buildLiveTile() so the #394 background refresh runs the identical code.
    const {
      merged, osm, wiki, wpEnrich, qidEnrich, altResolved, osmResolved, gravesBaked, wouldRemove367,
    } = await buildLiveTile(tile, fc);



    // #104 — the cache row is written from `merged`, i.e. BEFORE the blocklist,
    // for the same reason the fast path does not rewrite: the block is a serve-
    // time opinion, not a fact about the tile. What gets persisted stays a
    // faithful record of what Overpass and Wikipedia said.
    // #362 — curated lines on a CLONE of `merged` (serve-only; writeCacheRow
    // below still persists the faithful un-curated `merged`).
    const curC = applyCuratedToServe(merged, curIdx);
    const shown = applyBlocklist(curC.places, bl, sup);
    // #367 — hide storyless OSM dots on the cold serve too, AFTER the blocklist.
    // The cache write below still persists the FULL `merged` (the #104 faithful
    // record + the recordWouldRemove tally both read the un-hidden set), so the
    // hide is a serve opinion with no CACHE_VERSION concern and no bump. The
    // cache-write guard stays on `shown.places.length` (pre-hide): a tile that is
    // entirely storyless is still a real, believed-in tile worth caching — it
    // simply serves empty until its pins are rescued/enriched.
    const graveStruct = demoteStructureGraves(shown.places); // #374/#375 — before the hide
    const gated = hideStorylessOsm(shown.places, showHidden);

    // Only cache a tile we actually believe in. Overpass failing while Wikipedia
    // succeeds still produces a non-empty `merged` — caching that wrote a
    // Wikipedia-only tile and served it for 21 days, so one slow Overpass call
    // silently stripped every bar, shop, park and trail from an area. Serve the
    // partial result, but don't persist it: the next request retries Overpass.
    const osmHealthy = !osm.error && osm.places.length > 0;
    // #399 — a clean 200 with zero OSM places is a real answer (water, empty
    // land): cache it as a 3-day osmEmpty row, whether or not any Wikipedia pins
    // survive — unless an existing row already had OSM places (a tile we believed
    // in answering empty is likelier a bad mirror; keep the old row).
    const osmEmpty = isHealthyEmptyOsm(osm);
    let cacheWritten = false;
    if (osmHealthy && shown.places.length) {
      await writeCacheRow(tile, merged);
      cacheWritten = true;
    } else if (osmEmpty && !rowHasOsm(cached)) {
      await writeCacheRow(tile, merged, true);
      cacheWritten = true;
    }
    if (shown.places.length) {
      return json({
        tile, places: gated.places, cached: false, ts: Date.now(),
        cacheVersion: CACHE_VERSION,
        storyHidden: gated.hidden, storyGateVersion: "367-osm-story-gate-v1",
        osmCurated: curC.curated, curatedOsmVersion: "362-curated-osm-v1", // #362 deploy-confirm + curated lines applied this serve
        graveStructVersion: "375-structure-grave-remove-v1", graveDemoted: graveStruct.demoted, graveStoryStripped: graveStruct.stripped, // #374/#375 deploy-confirm + counts this serve
        overpassStatus: osm.status, overpassError: osm.error,
        chainsDropped: osm.chainsDropped, trailsDropped: osm.trailsDropped,
        closedDropped: osm.closedDropped, closedBy: osm.closedBy,
        wikiDropped: wiki.wikiDropped || 0, wikiNoExtract: wiki.wikiNoExtract || 0,
        osmCount: osm.places.length, wikiCount: wiki.places.length, cacheWritten,
        osmEmpty, emptyTileVersion: EMPTY_TILE_VERSION, // #399 — healthy-empty answer + deploy-confirm
        wpLinked: wpEnrich.wpLinked || 0, wpEnriched: wpEnrich.enriched || 0,
        osmResolveDeferred: _lastOsmDeferred, coldResolveVersion: "387-cold-resolve-budget-v1", // #387 deploy-confirm + resolves left running in the background
        wikidataOnly: osm.wikidataOnly || 0, osmResolved, // #367 — by-name OSM facts-pin rescues on this cold build (deploy-confirm signal)
        altResolved, gravesBaked, wouldRemove367, // #395 — cold-build counters that used to print only in the stripped [#118] log (#359 alt-name / #363 grave bake / #367 would-remove tally)
        swrVersion: SWR_VERSION, // #394 deploy-confirm (this row was built inline — no usable cached row)
        qidVersion: "164-wikidata-qid-v1", ...qidEnrich, // #164 — deploy-confirm + Q-id pins linked / baked / rejected (no article, no coordinate, >25 km) on this cold build
        blocked: shown.blocked, blocklistFailed: !!bl.failed,
        suppressed: shown.suppressed, suppressionFailed: !!sup.failed,
        // #134 — a map, not a number, because after the split there is no
        // single threshold to report and printing the crowd one would have
        // read as the whole truth. Nothing on the client consumed the old
        // scalar, so this is a free shape change rather than a break.
        suppressThresholds: SUPPRESS_THRESHOLDS, thresholdSource: THRESHOLD_SOURCE,
        reasonCodes: REASON_CODES,
        metaAsked: !!osm.metaAsked, metaSeen: osm.metaSeen || 0,
        metaRetried: !!osm.metaRetried, metaError: osm.metaError || null,
        osmAge: osmAgeHistogram(shown.places),
      });
    }

    // 3) Nothing fresh — fall back to a stale cache row if one exists. Since
    // #394 an existing row is normally served by 1b above, so this is reached
    // only when background work is unavailable AND the inline Overpass fetch
    // failed. Same serve layers as the warm path (#394 — this used to apply the
    // blocklist only, which would have shown hidden storyless dots).
    if (cached && cached.places.length) {
      const s = await serveCachedLayers(cached.places, curIdx, bl, sup, showHidden);
      const env = cachedEnvelope(tile, cached, s);
      env.blocklistFailed = !!bl.failed; env.suppressionFailed = !!sup.failed;
      env.stale = true;
      env.overpassStatus = osm.status; env.overpassError = osm.error;
      return json(env);
    }

    // 4) Truly empty — the client renders the area empty (there is no procedural
    // fallback any more; see #37). `closedDropped` and `blocked` are reported
    // here too, because "empty because everything here is shut" and "empty
    // because Overpass returned nothing" are different diagnoses and the old
    // response could not tell them apart.
    return json({
      tile, places: [], cached: false,
      cacheVersion: CACHE_VERSION,
      swrVersion: SWR_VERSION, // #394 deploy-confirm
      cacheWritten, osmEmpty, emptyTileVersion: EMPTY_TILE_VERSION, // #399 — a healthy-empty tile is now cached (3-day row)
      osmCount: osm.places.length, wikiCount: wiki.places.length,
      overpassStatus: osm.status, overpassError: osm.error,
      closedDropped: osm.closedDropped, closedBy: osm.closedBy,
      blocked: shown.blocked, blocklistFailed: !!bl.failed,
      suppressed: shown.suppressed, suppressionFailed: !!sup.failed,
      reasonCodes: REASON_CODES,
    });
  } catch (e) {
    return json({ error: (e && e.message) || String(e) }, 500);
  }
});