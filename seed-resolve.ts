// seed-resolve.ts — the #57 seed pipeline (sharpens #9: "seed ~20 cities").
//
// WHAT IT DOES. Takes a list of place NAMES (the research-input facts pulled
// from Reddit city threads — names only, no comment prose, no usernames, per
// #57's rule) and turns each into a decision:
//
//   geocode → find what is ALREADY on the map within 90 m → let Gemini judge
//   "is this the same place, or a new one?" semantically (so "Lily Pool" and
//   "Lily Pond" resolve to the same pin instead of stacking) → emit a
//   hybrid-ready seed row for the NEW ones, and a review line for the rest.
//
// WHY THIS SHAPE, and the lines it does NOT cross:
//   * The wiki "what it is" slot is sourced from WIKIPEDIA, never written by
//     Gemini. #37/#101/#178 reject AI-invented place descriptions ("invented
//     content about places nobody visited"). Gemini only DECIDES match-or-new
//     and CLASSIFIES the category. It never authors a description.
//   * A seed row carries submitted_by = null on purpose. #23's read-time credit
//     lookup already renders NOTHING for a null submitter, so a seed is honest
//     uncredited scaffold (#162/#208) with zero extra code. When a real person
//     later submits their own take on the same place, THAT is the credited
//     "review" half of the hybrid pin — this pipeline produces the wiki half
//     and leaves the review half empty by design.
//   * Nothing is auto-dropped and nothing is auto-merged on a coin-flip. The
//     name-only deduper in index.html is unsafe here (it stacks Lily Pool vs
//     Lily Pond — proven in the pilot), so this stage does the safe judgement
//     OFFLINE and hands UNCERTAIN cases to a human to eyeball. "I won't kill
//     anything" is enforced: low confidence → review list, never a silent skip.
//
// DEDUP DIRECTION MIRRORS THE APP. index.html's server dedupeReal() matches on
// name AND < 90 m; the client gem-vs-real path matches on name only. This stage
// matches on PROXIMITY (< 90 m, same haversine constant) AND Gemini semantics —
// strictly stronger than either, because it runs where latency is free.
//
// RUN (offline batch, not a deployed function):
//   GEMINI_API_KEY=... deno run --allow-net --allow-env --allow-write seed-resolve.ts
// optional:
//   --allow-read  and  pass a names file:  ... seed-resolve.ts names.txt
//
// It writes up to three files next to itself:
//   seed_records.json  — the NEW rows, ready to load into `submissions`
//   seed_report.json   — every verdict (new / already-present / uncertain / held)
//   seed_held.txt      — names that were HELD (never judged: 429/5xx/no-key),
//                        one per line — a ready-to-feed names file for a re-run.
//                        Only written when there is at least one held name.
//
// HELD vs REVIEW (the #264 / #263 lesson — "treat a throttle as a hold, never a
// silent skip"). A THROTTLE or transport failure (Gemini 429/5xx, a network
// error, or no API key) means the machine NEVER judged the place — that is a
// HOLD, and it must be re-run, not treated as a verdict. A genuine "the machine
// looked and is unsure" is REVIEW. Older runs collapsed both into `review`, so
// 429 leftovers looked like real reviews and a resume skipped them (#264's 66
// stranded rows). They are now separate buckets: re-run `held`, eyeball `review`.
//
// It does NOT write to the database. Loading seed_records.json into Supabase
// `submissions` is a deliberate, separate, reviewable step (see the delivery
// notes in chat).

// ---------------------------------------------------------------------------
// Config (all overridable by env; safe Chicago-pilot defaults).
// ---------------------------------------------------------------------------
// Printed at start so a Codespace run can confirm it is on the build delivered.
const TOOL_VERSION = "seed-resolve 2026.09.25f (#420 Wikipedia check can hold)";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = (Deno.env.get("GEMINI_MODEL")?.trim()) || "gemini-3.1-flash-lite";

// Direct-write config for the --commit path (see run()). BOTH must be set for
// --commit to insert; a plain run never reads them and never writes to the DB.
// The service-role key BYPASSES RLS, so it lives ONLY in an env var / Codespaces
// secret — never in this file, never committed. SUPABASE_URL is the project's
// API URL, e.g. https://<ref>.supabase.co (no trailing slash, no /rest/v1).
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Optional: the deployed nearby-places function. If set, we ask IT what is
// already on the map (the exact set the app would show, so our dedup matches
// the app's). If unset, we fall back to a direct Wikipedia geosearch, which
// covers the main collision class (wiki pins — the Lily Pool case).
// #418 — defaults to the live project, so a run from the Mac (where nothing is
// injected) no longer silently falls back to a Wikipedia-only duplicate check.
// The key is the PUBLIC publishable key already shipped in index.html.
const PUBLIC_KEY = "sb_publishable_sJkeQ89O2geQLB5z6d__Zw_9G6nxLt_";
const PROJECT_URL = "https://siacjgpqzaylsfefihyr.supabase.co";
const NEARBY_PLACES_URL = Deno.env.get("NEARBY_PLACES_URL")?.trim() || PROJECT_URL + "/functions/v1/nearby-places";
const NEARBY_PLACES_KEY = Deno.env.get("NEARBY_PLACES_KEY")?.trim() || PUBLIC_KEY;

// City bias for geocoding + a bounding sanity check. Env-overridable (the
// header's "all overridable by env" contract — Chicago is only the default).
const CITY = {
  name: Deno.env.get("SEED_CITY_NAME")?.trim() || "Chicago",
  lat: Number(Deno.env.get("SEED_CITY_LAT") ?? 41.8781),
  lng: Number(Deno.env.get("SEED_CITY_LNG") ?? -87.6298),
};
// Reject a geocode that lands outside the metro. Default 60 km (single-city
// pilot). Set SEED_CITY_MAX_KM=0 to DISABLE the reject — REQUIRED for a re-run
// batch that spans multiple cities (e.g. the #264 stranded-429 tail, whose 66
// names are scattered across 13 metros): a single-city radius would wrongly bin
// every out-of-town name as out-of-metro. Photon's city bias is a soft ranking
// nudge, so a well-named place ("Space Needle, Seattle") still geocodes right
// even with the Chicago default bias; it is the reject, not the bias, that
// blocks a mixed-city list.
const CITY_MAX_KM = Number(Deno.env.get("SEED_CITY_MAX_KM") ?? 60);

const MATCH_RADIUS_M = 90;      // same constant as index.html dedupeReal() — DEDUP only
// Enrichment reaches wider than dedup ON PURPOSE. A big park's Wikipedia
// coordinate can sit 200-400 m from where Photon dropped the pin, so a 90 m
// geosearch misses the article that is genuinely there. This radius is used
// ONLY to find the "what it is" description text, NEVER to merge pins, and a
// hit is attached ONLY if its title matches the place name (WIKI_TITLE_MIN) —
// so widening the search cannot pull in a neighbouring building's article.
const WIKI_ENRICH_RADIUS_M = 300;
const WIKI_TITLE_MIN = 0.5;    // min name/title token overlap to accept an article
// When the coordinate geosearch finds nothing (Photon dropped the pin too far
// from a wide feature's article coordinate — e.g. Palmisano, Promontory), fall
// back to searching Wikipedia BY NAME, then accept the article only if its OWN
// coordinate lands within this radius of the pin. Generous enough to absorb
// geocode drift across a park, tight enough to reject a same-named place in
// another city.
const WIKI_NAME_SANITY_M = 1000;
const CONF_MIN = 0.75;          // below this, a decision goes to the human, not the machine
// #57 STORY-ONLY (2026-09-25, the #308/#312 pivot applied at the tool). A seed
// may only land as park / history / art. Gemini may also answer "commercial" —
// a bar, restaurant, cafe or shop WITHOUT its own story — and that verdict is
// DROPPED as outcome "commercial-skip" instead of seeding (the 898 commercial
// seeds were retired by #312; this stops the tool re-minting them). A bar or
// restaurant WITH its own story (historic landmark, famous event, a century-old
// institution) files as `history` — submissions has no `type` column, so the
// OSM path's category:'history' + type:'bar' collapses to plain `history` here.
// "barsrest" and "shops" are no longer valid seed categories.
const VALID_CATEGORIES = new Set(["park", "history", "art"]);

// The pilot seed list — Tier 1 (named in all three AskChicago threads) then
// Tier 2 (named in two). Names only; the frequency ranking IS the filter, so
// nothing here is pre-judged for "quality". Override by passing a names file.
const DEFAULT_NAMES = [
  // Tier 1
  "International Museum of Surgical Science, Chicago",
  "Institute for the Study of Ancient Cultures, Chicago",
  "Frederick C. Robie House, Chicago",
  "Garfield Park Conservatory, Chicago",
  "Chicago Cultural Center",
  "Ping Tom Memorial Park, Chicago",
  "Palmisano Park, Chicago",
  "Richard H. Driehaus Museum, Chicago",
  "Alfred Caldwell Lily Pool, Chicago",
  "Chicago Magic Lounge",
  "Northerly Island, Chicago",
  // Tier 2
  "Graceland Cemetery, Chicago",
  "Rosehill Cemetery, Chicago",
  "Promontory Point, Chicago",
  "Steelworkers Park, Chicago",
  "Berger Park, Chicago",
  "Baháʼí House of Worship, Wilmette",
  "North Park Village Nature Center, Chicago",
  "National Museum of Mexican Art, Chicago",
  "Money Museum Federal Reserve Bank of Chicago",
  "Rockefeller Memorial Chapel, Chicago",
  "Montrose Point Bird Sanctuary, Chicago",
  "Green Mill Cocktail Lounge, Chicago",
];

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

type Existing = { name: string; lat: number; lng: number; category?: string; source?: string; seed?: boolean };

// ---------------------------------------------------------------------------
// 1) Geocode a name -> coordinates (Photon, unkeyed — the app's #88 provider).
// ---------------------------------------------------------------------------
// Does Photon's returned label actually correspond to the venue we searched
// for? Photon does fuzzy TEXT matching, so "The Green Mill" (a jazz club) can
// come back as "The Green at 320" and "The Violet Hour" as "Stop The Violence
// Chicago" — right city, wrong place. A bounding box can't catch that; only a
// name check can. We normalize both sides (lowercase, strip punctuation, drop
// short/stopword tokens) and require a strong majority of the venue's
// distinctive tokens to appear in the label. This deliberately ERRS TOWARD
// DROPPING: an unverifiable venue becomes a missing pin, never a wrong pin.
// (The real fix for commercial venues is a places API, not a gazetteer — see
// the roadmap row for Google Places resolution.)
const GEO_STOPWORDS = new Set(["the", "and", "for", "of", "at", "on", "in", "to", "a", "an", "de", "la", "le"]);
// #303 (a) — FOLD DIACRITICS BEFORE TOKENIZING. The old `[^a-z0-9]` strip ran on
// the raw lowercase string, so an accented letter became a SPLIT point:
// "Kościuszko" -> "ko" + "ciuszko", and a correct Photon match ("Tadeusz
// Kościuszko") dropped at 0.33 against the typed "Kosciuszko". NFD splits each
// accented letter into base + combining mark, and the mark range is deleted;
// the few letters NFD does NOT decompose (ł, ø, đ, ß, æ, œ) are mapped by hand.
const GEO_FOLD: Record<string, string> = { "ł": "l", "ø": "o", "đ": "d", "ß": "ss", "æ": "ae", "œ": "oe", "ı": "i" };
function geoFold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[łøđßæœı]/g, (c) => GEO_FOLD[c] ?? c);
}
function geoTokens(s: string): string[] {
  return geoFold(s)
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !GEO_STOPWORDS.has(t));
}
// #303 (b) — GENERIC TYPE WORDS CAN'T CARRY A MATCH. A place type word ("house",
// "museum", "sphere") is shared by many different places, so a match built on it
// is no evidence of identity. Live cases: "Gibson House Museum" -> "Otis House
// Museum" (Boston) and "Noyes Armillary Sphere" -> "Sarah Rittenhouse Armillary
// Sphere" (DC) both passed at 0.67 because the shared type words carried the ratio
// while the identifying proper noun MISSED. A bare type word with no proper noun is
// still a fine search term, so these are NOT stopwords — they still count in the
// overall ratio. What changes is a SECOND test below: the name's DISTINCTIVE
// (non-type) tokens must also match at >= 0.6 on their own.
const GEO_GENERIC_TYPE = new Set([
  "house", "home", "museum", "park", "monument", "memorial", "site", "garden", "gardens",
  "center", "centre", "hall", "building", "statue", "sculpture", "fountain", "sphere",
  "square", "plaza", "church", "cathedral", "chapel", "library", "theater", "theatre",
  "tower", "bridge", "station", "market", "cemetery", "trail", "beach", "lake", "pier",
  "gallery", "historic", "historical", "national", "state", "district", "street", "avenue",
]);
function labelMatchesName(name: string, label: string): boolean {
  const want = geoTokens(name);
  if (!want.length) return false; // can't verify -> drop (safe direction)
  const have = new Set(geoTokens(label));
  const hit = want.filter((t) => have.has(t)).length;
  if (hit / want.length < 0.6) return false; // the original test, unchanged
  // #303 (b): STRICTLY TIGHTER than before — this can only turn a pass into a
  // drop, never a drop into a pass, so it cannot mint a new wrong pin (the guard's
  // purpose is err-toward-dropping). It only bites when generic type words were
  // doing the carrying. A name made ONLY of type words has no distinctive tokens
  // and keeps the original behaviour.
  const distinctive = want.filter((t) => !GEO_GENERIC_TYPE.has(t));
  if (!distinctive.length) return true;
  const dHit = distinctive.filter((t) => have.has(t)).length;
  return dHit / distinctive.length >= 0.6;
}

async function geocode(
  name: string,
): Promise<{ lat: number; lng: number; label: string; nameMatch: boolean } | null> {
  // Photon's lat/lon is only a soft ranking NUDGE, not a restriction — for a
  // generically-named venue ("The Green Mill" exists worldwide) the nudge loses
  // to a more prominent match elsewhere, and limit=1 hands back that one wrong
  // winner. So we (a) add a HARD bbox around the metro so out-of-region results
  // can't come back at all, and (b) widen the limit and pick the candidate
  // NEAREST the city center. bbox radius tracks CITY_MAX_KM (the same fence the
  // caller rejects on), so geocode never returns something the caller would
  // then throw out. If CITY_MAX_KM is disabled (0, used for re-runs), fall back
  // to a generous 75 km box so we still bound, just loosely.
  const boxKm = CITY_MAX_KM > 0 ? CITY_MAX_KM : 75;
  const dLat = boxKm / 111; // ~111 km per degree latitude
  const dLng = boxKm / (111 * Math.max(0.05, Math.cos((CITY.lat * Math.PI) / 180)));
  const bbox = [CITY.lng - dLng, CITY.lat - dLat, CITY.lng + dLng, CITY.lat + dLat]
    .map((n) => n.toFixed(6))
    .join(",");
  const url =
    "https://photon.komoot.io/api/?limit=5&lat=" +
    CITY.lat +
    "&lon=" +
    CITY.lng +
    "&bbox=" +
    bbox +
    "&q=" +
    encodeURIComponent(name);
  try {
    const r = await fetch(url, { headers: { "User-Agent": "nahgoo-seed/1.0" } });
    if (!r.ok) return null;
    const data = await r.json();
    const feats: any[] = Array.isArray(data?.features) ? data.features : [];
    // Pick the in-box candidate closest to the metro center, not blindly [0].
    let best: { lat: number; lng: number; label: string } | null = null;
    let bestDist = Infinity;
    for (const f of feats) {
      const c = f?.geometry?.coordinates;
      if (!c || c.length < 2) continue;
      const [lng, lat] = c;
      const d = haversineM(CITY.lat, CITY.lng, lat, lng);
      if (d < bestDist) {
        const p = f.properties ?? {};
        const label = [p.name, p.city, p.state].filter(Boolean).join(", ");
        best = { lat, lng, label: label || name };
        bestDist = d;
      }
    }
    if (!best) return null;
    return { ...best, nameMatch: labelMatchesName(name, best.label) };
  } catch {
    return null;
  }
}

// #57 STORY LINES — ADDRESS MODE. The best hidden stories sit at an ADDRESS, not
// a named place (the apartment Dillinger shot his way out of, the row house where
// Fitzgerald wrote his first novel). Photon returns a street address for those,
// so the NAME guard above would always drop them. Here the guard is the address
// itself: a candidate counts only if Photon's house number EQUALS the one asked
// for AND >= 0.6 of the street's distinctive tokens match (suffix/direction words
// like "Avenue"/"South" don't count). Same err-toward-dropping direction: an
// address Photon can't place exactly is a missing pin, never a nearby wrong one.
const STREET_GENERIC = new Set([
  "street", "avenue", "ave", "parkway", "pkwy", "boulevard", "blvd", "road", "drive", "lane",
  "place", "court", "terrace", "way", "north", "south", "east", "west", "circle", "trail",
]);
function streetTokens(s: string): string[] {
  return geoTokens(s).filter((t) => !STREET_GENERIC.has(t));
}
// The street's DIRECTION must agree too. Without this, "327 14th Avenue SE"
// (Minneapolis) matched "327 14th Avenue South" in South St. Paul: "SE" is too
// short to be a token and "south" is a generic word, so only "14th" was
// compared. A direction named on either side must be the same set on both.
const DIR_WORDS: Record<string, string> = {
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  n: "n", s: "s", e: "e", w: "w", ne: "ne", nw: "nw", se: "se", sw: "sw",
};
function streetDirs(s: string): string {
  const out = geoFold(s).replace(/[^a-z0-9]+/g, " ").split(/\s+/).map((t) => DIR_WORDS[t]).filter(Boolean);
  return [...new Set(out)].sort().join(",");
}
async function geocodeAddress(
  address: string,
): Promise<{ lat: number; lng: number; label: string; nameMatch: boolean } | null> {
  const m = address.trim().match(/^(\d+[a-z]?)\s+(.+)$/i);
  if (!m) return null;
  const wantNum = m[1].toLowerCase();
  const wantStreet = streetTokens(m[2]);
  const wantDirs = streetDirs(m[2]);
  const boxKm = CITY_MAX_KM > 0 ? CITY_MAX_KM : 75;
  const dLat = boxKm / 111;
  const dLng = boxKm / (111 * Math.max(0.05, Math.cos((CITY.lat * Math.PI) / 180)));
  const bbox = [CITY.lng - dLng, CITY.lat - dLat, CITY.lng + dLng, CITY.lat + dLat].map((n) => n.toFixed(6)).join(",");
  const url = "https://photon.komoot.io/api/?limit=8&lat=" + CITY.lat + "&lon=" + CITY.lng +
    "&bbox=" + bbox + "&q=" + encodeURIComponent(address);
  try {
    const r = await fetch(url, { headers: { "User-Agent": "nahgoo-seed/1.0" } });
    if (!r.ok) return null;
    const data = await r.json();
    const feats: any[] = Array.isArray(data?.features) ? data.features : [];
    let first: { lat: number; lng: number; label: string } | null = null;
    for (const f of feats) {
      const c = f?.geometry?.coordinates;
      if (!c || c.length < 2) continue;
      const p = f.properties ?? {};
      const label = [[p.housenumber, p.street].filter(Boolean).join(" "), p.name, p.city].filter(Boolean).join(", ");
      if (!first) first = { lat: c[1], lng: c[0], label: label || address };
      const hn = String(p.housenumber ?? "").toLowerCase().split(/[-–;, ]/)[0];
      if (hn !== wantNum) continue;
      const have = new Set(streetTokens(String(p.street ?? "")));
      const hit = wantStreet.filter((t) => have.has(t)).length;
      if (streetDirs(String(p.street ?? "")) !== wantDirs) continue;
      if (wantStreet.length && hit / wantStreet.length >= 0.6) {
        return { lat: c[1], lng: c[0], label, nameMatch: true };
      }
    }
    // Nothing matched exactly: report what Photon offered, as a mismatch (drop).
    return first ? { ...first, nameMatch: false } : null;
  } catch {
    return null;
  }
}

// A names-file line is either a bare NAME (the original format) or a STORY LINE:
//   Name | locate | story | source_url
// `locate` starting with a house number is an ADDRESS (geocodeAddress); any other
// `@lat,lng` is a COORDINATE copied from the story's source (Photon has no
// house number for some famous addresses — 599 Summit comes back as 599
// Marshall — so a source-published coordinate beats a guessed geocode); any other
// non-empty `locate` is an alternate NAME to geocode by (e.g. display "Schmidt
// Brewery", geocode "Schmidt Artist Lofts"); empty = geocode the name. `story` is
// ONE hand-verified factual sentence with its source (#315/#316 — sourced, never
// invented); it becomes the pin's persisted story (resolved_source 'curated') and
// a `curated_descriptions` row. Lines starting with "#" are comments.
type Line = { name: string; locate: string; story: string; source: string };
function parseLine(raw: string): Line {
  const parts = raw.split("|").map((x) => x.trim());
  return { name: parts[0] ?? "", locate: parts[1] ?? "", story: parts[2] ?? "", source: parts[3] ?? "" };
}

// ---------------------------------------------------------------------------
// 2) Wikipedia intro at this spot -> the "what it is" slot (REAL source only).
//    geosearch for an article within MATCH_RADIUS_M, then pull its intro.
// ---------------------------------------------------------------------------
async function wikiAt(
  lat: number,
  lng: number,
): Promise<{ title: string; intro: string; lat: number; lng: number } | null> {
  try {
    const geo =
      "https://en.wikipedia.org/w/api.php?action=query&list=geosearch&format=json&gslimit=5&gsradius=" +
      MATCH_RADIUS_M +
      "&gscoord=" +
      lat +
      "%7C" +
      lng;
    const gr = await fetch(geo, { headers: { "User-Agent": "nahgoo-seed/1.0" } });
    if (!gr.ok) return null;
    const gd = await gr.json();
    const hit = gd?.query?.geosearch?.[0];
    if (!hit?.title) return null;

    const ex =
      "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&redirects=1&titles=" +
      encodeURIComponent(hit.title);
    const er = await fetch(ex, { headers: { "User-Agent": "nahgoo-seed/1.0" } });
    if (!er.ok) return { title: hit.title, intro: "", lat: hit.lat, lng: hit.lon };
    const ed = await er.json();
    const pages = ed?.query?.pages ?? {};
    const first: any = Object.values(pages)[0] ?? {};
    const intro = String(first.extract ?? "").trim();
    return { title: hit.title, intro, lat: hit.lat, lng: hit.lon };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2b) WIDER wiki lookup for the DESCRIPTION slot only. Searches WIKI_ENRICH_
//     RADIUS_M (300 m), but attaches an article ONLY when its title actually
//     matches the place name — so a big park whose article coordinate is 250 m
//     away gets enriched, while a random neighbouring article inside the circle
//     is rejected. Never used for dedup; never invents text (#101/#178): a name
//     with no matching article stays blank.
// ---------------------------------------------------------------------------
function tokens(s: string): Set<string> {
  const STOP = new Set(["the", "of", "a", "an", "and", "at", "in", "on", "chicago", "il", "illinois"]);
  return new Set(
    (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w)),
  );
}
function titleMatch(name: string, title: string): number {
  const a = tokens(name), b = tokens(title);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size; // fraction of the place-name's words the article title covers
}
async function wikiIntroFor(title: string): Promise<string> {
  try {
    const ex =
      "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&redirects=1&titles=" +
      encodeURIComponent(title);
    const er = await fetch(ex, { headers: { "User-Agent": "nahgoo-seed/1.0" } });
    if (!er.ok) return "";
    const ed = await er.json();
    const pages = ed?.query?.pages ?? {};
    const first: any = Object.values(pages)[0] ?? {};
    return String(first.extract ?? "").trim();
  } catch {
    return "";
  }
}

async function wikiEnrich(
  name: string,
  lat: number,
  lng: number,
): Promise<{ title: string; intro: string } | null> {
  // Path A — coordinate geosearch (300 m) + title gate. Best when Photon
  // dropped the pin near the article's own coordinate.
  try {
    const geo =
      "https://en.wikipedia.org/w/api.php?action=query&list=geosearch&format=json&gslimit=10&gsradius=" +
      WIKI_ENRICH_RADIUS_M +
      "&gscoord=" + lat + "%7C" + lng;
    const gr = await fetch(geo, { headers: { "User-Agent": "nahgoo-seed/1.0" } });
    if (gr.ok) {
      const gd = await gr.json();
      const hits: any[] = gd?.query?.geosearch ?? [];
      let best: any = null, bestScore = 0;
      for (const h of hits) {
        const s = titleMatch(name, h.title || "");
        if (s > bestScore) { bestScore = s; best = h; }
      }
      if (best && bestScore >= WIKI_TITLE_MIN) {
        const intro = await wikiIntroFor(best.title);
        if (intro) return { title: best.title, intro };
      }
    }
  } catch { /* fall through to Path B */ }

  // Path B — name search, then verify the found article's OWN coordinate is
  // within WIKI_NAME_SANITY_M of the pin. Recovers wide features whose article
  // coordinate sits beyond the 300 m circle (Palmisano, Promontory). The
  // coordinate check is what stops a same-named place elsewhere from attaching.
  try {
    const srch =
      "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=" +
      encodeURIComponent(name);
    const sr = await fetch(srch, { headers: { "User-Agent": "nahgoo-seed/1.0" } });
    if (!sr.ok) return null;
    const sd = await sr.json();
    const results: any[] = sd?.query?.search ?? [];
    // Keep only results whose title plausibly IS this place, best first.
    const ranked = results
      .map((r) => ({ title: r.title as string, score: titleMatch(name, r.title || "") }))
      .filter((r) => r.score >= WIKI_TITLE_MIN)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;

    for (const cand of ranked) {
      // One call for BOTH the coordinate (to sanity-check distance) and the
      // intro. Parsed defensively — the coordinates array is read by shape, not
      // by a fixed path, because the earlier two-call version misread it and
      // silently dropped valid hits (Palmisano returned a real coord and was
      // skipped anyway).
      const q =
        "https://en.wikipedia.org/w/api.php?action=query&prop=coordinates%7Cextracts&exintro=1&explaintext=1&format=json&redirects=1&titles=" +
        encodeURIComponent(cand.title);
      const cr = await fetch(q, { headers: { "User-Agent": "nahgoo-seed/1.0" } });
      if (!cr.ok) continue;
      const cdj = await cr.json();
      const pages = cdj?.query?.pages ?? {};
      const p: any = Object.values(pages)[0] ?? {};
      const coord = Array.isArray(p?.coordinates) ? p.coordinates[0] : null;
      const cLat = Number(coord?.lat), cLon = Number(coord?.lon ?? coord?.lng);
      // If the article carries a coordinate, it must be within the sanity
      // radius. If it carries NONE, accept on the exact-title match alone
      // (a perfect name hit with no coord is still almost certainly the place).
      if (Number.isFinite(cLat) && Number.isFinite(cLon)) {
        if (haversineM(lat, lng, cLat, cLon) > WIKI_NAME_SANITY_M) continue; // same name, wrong place
      } else if (cand.score < 1) {
        continue; // no coord AND an imperfect title — too risky, skip
      }
      const intro = String(p?.extract ?? "").trim();
      if (intro) return { title: cand.title, intro };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3) What is ALREADY on the map within MATCH_RADIUS_M of this spot?
//    Prefer the deployed nearby-places function (exact app parity); fall back
//    to Wikipedia geosearch (covers the wiki-collision class).
// ---------------------------------------------------------------------------
// #418 — THREE-SOURCE DUPLICATE CHECK. Each source alone missed real pins on the
// 2026-09-25 St. Paul runs: the live map's per-area list is CAPPED (it returned
// nothing near Landmark Center or the Schmidt lofts), a Wikipedia geosearch only
// knows articled places (it missed Swede Hollow Park and Wakan Tipi), and neither
// sees `submissions` (graves and earlier seeds — the old #57 blind spot, which is
// how a second --commit could double-insert). So the check is the UNION of all
// three, deduped by name, within MATCH_RADIUS_M. If the live map or the
// submissions read FAILS, the place is HELD (never judged), not waved through on
// a partial check — the #264 "a failure is a hold, not a verdict" rule.
// #420 — a FAILED Wikipedia check is not "no article here". It returns null
// (→ the place is HELD, like the other two arms, #264) on any non-OK response,
// network error or unreadable body, after one retry on a 429/5xx (honouring
// Retry-After, capped at 15 s). Only a clean response with zero hits is [].
// On the 2026-09-25 Mac run a silent failure made First Avenue and Foshay Tower
// read as brand new.
async function wikiNear(lat: number, lng: number): Promise<Existing[] | null> {
  const url = "https://en.wikipedia.org/w/api.php?action=query&list=geosearch&format=json&gslimit=10&gsradius=" +
    MATCH_RADIUS_M + "&gscoord=" + lat + "%7C" + lng;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "nahgoo-seed/1.0" } });
      if (!r.ok) {
        if (attempt === 1 && (r.status === 429 || r.status >= 500)) {
          const ra = Number(r.headers.get("retry-after"));
          await sleep(Math.min(15000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 3000));
          continue;
        }
        return null;
      }
      const d = await r.json();
      if (!d || !d.query || !Array.isArray(d.query.geosearch)) return null; // an error body is not "none"
      return d.query.geosearch.filter((h: any) => h?.title)
        .map((h: any) => ({ name: String(h.title), lat: h.lat, lng: h.lon, source: "wiki" }));
    } catch {
      if (attempt === 1) { await sleep(3000); continue; }
      return null;
    }
  }
  return null;
}

async function mapNear(lat: number, lng: number): Promise<Existing[] | null> {
  try {
    const r = await fetch(NEARBY_PLACES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + NEARBY_PLACES_KEY },
      body: JSON.stringify({ lat, lng }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const places: any[] = Array.isArray(d?.places) ? d.places : Array.isArray(d) ? d : [];
    return places
      .filter((p) => typeof p?.lat === "number" && typeof p?.lng === "number" && p?.name)
      // Tagged "map:<source>" so a live Wikipedia PIN ("map:wiki") is never confused
      // with a bare Wikipedia geosearch hit ("wiki" = an article, not a pin) — #419.
      .map((p) => ({ name: String(p.name), lat: p.lat, lng: p.lng, category: p.category, source: "map:" + (p.source ?? "?") }));
  } catch {
    return null;
  }
}

async function submissionsNear(lat: number, lng: number): Promise<Existing[] | null> {
  // The same read the app does (approved, not merged), so the public key is enough.
  const dLat = (MATCH_RADIUS_M * 2) / 111000;
  const dLng = (MATCH_RADIUS_M * 2) / (111000 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const url = PROJECT_URL + "/rest/v1/submissions?select=name,lat,lng,category,submitted_by" +
    "&status=eq.approved&merged_into=is.null" +
    `&lat=gte.${(lat - dLat).toFixed(6)}&lat=lte.${(lat + dLat).toFixed(6)}` +
    `&lng=gte.${(lng - dLng).toFixed(6)}&lng=lte.${(lng + dLng).toFixed(6)}`;
  try {
    const r = await fetch(url, { headers: { apikey: PUBLIC_KEY, Authorization: "Bearer " + PUBLIC_KEY } });
    if (!r.ok) return null;
    const rows: any[] = await r.json();
    return rows.map((x) => ({ name: String(x.name), lat: x.lat, lng: x.lng, category: x.category, source: "submission", seed: x.submitted_by == null }));
  } catch {
    return null;
  }
}

async function existingNear(lat: number, lng: number): Promise<{ list: Existing[]; failed: string | null; arms: string }> {
  const [map, subs, wiki] = await Promise.all([mapNear(lat, lng), submissionsNear(lat, lng), wikiNear(lat, lng)]);
  const failed = map === null ? "live-map check failed" : subs === null ? "submissions check failed"
    : wiki === null ? "Wikipedia check failed" : null;
  const seen = new Set<string>();
  const list: Existing[] = [];
  for (const e of [...(subs ?? []), ...(map ?? []), ...(wiki ?? [])]) {
    if (haversineM(lat, lng, e.lat, e.lng) > MATCH_RADIUS_M) continue;
    const k = e.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    list.push(e);
  }
  // #420 — per-arm counts within 90 m, printed per place, so an all-empty result
  // on a downtown landmark is visible in the run instead of hiding in the report.
  const near = (xs: Existing[] | null) => xs === null ? "fail" : String(xs.filter((e) => haversineM(lat, lng, e.lat, e.lng) <= MATCH_RADIUS_M).length);
  return { list, failed, arms: `map ${near(map)} · subs ${near(subs)} · wiki ${near(wiki)}` };
}

// ---------------------------------------------------------------------------
// 4) Gemini: match-or-new + category. Temperature 0, JSON out. Same call shape
//    as review-submission. Gemini NEVER writes a description here.
// ---------------------------------------------------------------------------
type Verdict = {
  // "held" = the machine NEVER judged this (429/5xx/network/no-key) — a re-run
  // candidate, NOT a verdict. Distinct from "uncertain" (judged, unsure). #264.
  decision: "match" | "new" | "uncertain" | "held";
  matchName: string | null;
  canonicalName: string;
  category: string | null;
  confidence: number;
  why: string;
  status?: number; // HTTP status when held on a throttle/error (e.g. 429), for filtering
};

async function resolve(candidate: string, wikiTitle: string | null, existing: Existing[], story = ""): Promise<Verdict> {
  if (!GEMINI_API_KEY) {
    return { decision: "held", matchName: null, canonicalName: candidate, category: null, confidence: 0, why: "no GEMINI_API_KEY set" };
  }
  const list = existing.length ? existing.map((e, i) => `${i + 1}. ${e.name}`).join("\n") : "(none within 90 m)";
  const prompt = [
    "You are deduplicating map places. Decide whether a CANDIDATE place is the SAME",
    "real-world place as one already on the map nearby, or a genuinely NEW place.",
    "",
    `CANDIDATE (from a local's recommendation): "${candidate}"`,
    story ? `Documented story of this candidate: "${story}"` : "",
    wikiTitle ? `Wikipedia article found at these coordinates: "${wikiTitle}"` : "No Wikipedia article at these coordinates.",
    "",
    "ALREADY ON THE MAP within 90 metres:",
    list,
    "",
    "Rules:",
    "- Same place even if the name differs (e.g. 'Lily Pool' vs 'Lily Pond' vs a full formal name) => decision 'match'.",
    "- Clearly a different place, or nothing nearby matches => decision 'new'.",
    "- Genuinely unsure => decision 'uncertain'. Prefer 'uncertain' over guessing.",
    "- canonicalName: the fullest correct name (prefer the Wikipedia/existing name when it is the same place).",
    "- category: EXACTLY one of park, history, art, commercial. Museums/landmarks/monuments/historic buildings/cemeteries => history. Public art, sculpture, murals, galleries => art. Parks/gardens/nature/trails => park.",
    "- A bar, restaurant, cafe, shop or entertainment business => history ONLY if it has its OWN documented story (a historic landmark building, a famous event happened there, a long-standing institution with a known history); otherwise => commercial. When unsure whether a business has a story, answer commercial.",
    "- confidence: 0..1.",
    'Return ONLY JSON: {"decision":"match|new|uncertain","matchName":string|null,"canonicalName":string,"category":string,"confidence":number,"why":string}',
  ].join("\n");

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const g = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, responseMimeType: "application/json" },
          }),
        },
      );
      const raw = await g.text();
      if (!g.ok) {
        if (attempt === 1 && [429, 500, 502, 503, 504].includes(g.status)) {
          await sleep(1200);
          continue;
        }
        // ANY non-ok response that survives the retry is a HOLD, never a
        // verdict: the machine never judged this place, so it goes to the held
        // bucket and a re-run, NOT the review bucket (that conflation stranded
        // #264's 66). "uncertain" is reserved for a SUCCESSFULLY PARSED response
        // below — a 429/5xx/4xx is a transport hold, not a judgement.
        return { decision: "held", matchName: null, canonicalName: candidate, category: null, confidence: 0, why: `gemini ${g.status}: ${raw.slice(0, 160)}`, status: g.status };
      }
      const data = JSON.parse(raw);
      const parts = data?.candidates?.[0]?.content?.parts ?? [];
      let text = parts.filter((p: any) => typeof p.text === "string" && !p.thought).map((p: any) => p.text).join("").trim();
      if (!text) text = parts.map((p: any) => p.text ?? "").join("").trim();
      text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
      const s = text.indexOf("{"), e = text.lastIndexOf("}");
      const parsed = JSON.parse(s >= 0 && e >= 0 ? text.slice(s, e + 1) : text);

      let decision = ["match", "new", "uncertain"].includes(parsed.decision) ? parsed.decision : "uncertain";
      const confidence = Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0;
      // "commercial" is carried through as a category so run() can drop it
      // (#57 story-only); anything else outside the story set is unclassified.
      let category: string | null =
        VALID_CATEGORIES.has(parsed.category) || parsed.category === "commercial" ? parsed.category : null;
      // Conservative floor: a confident-sounding answer under CONF_MIN is still
      // handed to the human. Nothing auto-merges or auto-drops on a coin-flip.
      if (decision !== "uncertain" && confidence < CONF_MIN) decision = "uncertain";

      return {
        decision,
        matchName: parsed.matchName ?? null,
        canonicalName: String(parsed.canonicalName ?? candidate).trim() || candidate,
        category,
        confidence,
        why: String(parsed.why ?? "").slice(0, 240),
      };
    } catch (err) {
      if (attempt === 1) { await sleep(1200); continue; }
      // Transport/parse failure = machine never judged = HOLD (re-run), not a
      // verdict. See the non-ok branch above (#264).
      return { decision: "held", matchName: null, canonicalName: candidate, category: null, confidence: 0, why: "parse/network error: " + String(err).slice(0, 160) };
    }
  }
  return { decision: "held", matchName: null, canonicalName: candidate, category: null, confidence: 0, why: "exhausted retries" };
}

// ---------------------------------------------------------------------------
// A seed row is `submissions`-shaped: it can be inserted with status 'approved'
// and submitted_by NULL (= uncredited scaffold, #23/#162). The wiki intro is
// the description; the human "review" half is intentionally empty until a real
// person submits their take on this place.
// ---------------------------------------------------------------------------
type SeedRow = {
  name: string;
  description: string;   // Wikipedia intro (real source) or "" (honest blank, #101)
  category: string | null;
  lat: number;
  lng: number;
  city: string;          // = CITY.name — the `submissions.city` column; each run is one metro
  status: "approved";
  submitted_by: null;
  source: "seed:reddit";
  seed_meta: { candidate: string; geocodeLabel: string; wikiTitle: string | null; confidence: number };
  // #57 story lines: the hand-verified story is persisted as the pin's story so
  // brick 5 shows it deterministically (no cascade needed); null for bare names.
  resolved_description: string | null;
  resolved_source: "curated" | null;
};
type CuratedRow = { name: string; lat: number; lng: number; description: string; source_url: string | null; note: string };

// ---------------------------------------------------------------------------
// --commit: insert the new seed rows into `submissions` via the Supabase REST
// API, using the service-role key (bypasses RLS). This is the OPTIONAL write
// half. A plain run never calls this — it writes only seed_records.json and the
// report, and the review-then-load gate is preserved: --commit is meant to be
// run AFTER you have read seed_report.json. Rows are inserted in chunks; a blank
// wiki intro is stored as NULL (not ""), matching how existing seeds were loaded
// (#279's "NULL description" set). seed_meta has no column and is dropped.
// ---------------------------------------------------------------------------
type SeedPatch = { name: string; lat: number; lng: number; story: string };
async function commitToSupabase(rows: SeedRow[], curated: CuratedRow[], patches: SeedPatch[] = []): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "\n--commit ABORTED: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY not set. " +
        "Set both (Codespaces secrets) and re-run, or load seed_records.json manually. Nothing was written.",
    );
    Deno.exit(1);
  }
  if (!rows.length && !curated.length && !patches.length) {
    console.log("\n--commit: nothing to insert or attach, nothing to do.");
    return;
  }
  const svc = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY };

  // Map to the exact `submissions` columns — drop seed_meta (no column),
  // NULL a blank description, carry city/source/status/submitted_by. id and
  // created_at are left to their DB defaults (gen_random_uuid() / now()).
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
    resolved_description: r.resolved_description,
    resolved_source: r.resolved_source,
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
      console.error(
        `\n--commit FAILED on rows ${i}-${i + batch.length - 1}: HTTP ${res.status} ${body.slice(0, 300)}`,
      );
      console.error(`Inserted ${inserted} row(s) before the failure. seed_records.json is unchanged; do NOT blindly re-run --commit (it would double-insert the successful batches). Inspect, then re-run over only the un-inserted names if needed.`);
      Deno.exit(1);
    }
    inserted += batch.length;
    console.log(`  committed ${inserted}/${payload.length}…`);
  }
  // #57 story lines: bank each story in curated_descriptions too, so the #318
  // curated rung serves it on any later re-resolve (#319) of the same pin. The
  // submission rows above already carry the story, so a failure here does not
  // blank the map — it is reported, and curated_records.json holds the rows.
  // #419: skip a curated row that already exists for this pin (same name within
  // 50 m), so re-running a file never stacks duplicate story rows.
  const fresh: CuratedRow[] = [];
  for (const c of curated) {
    try {
      const nc = c.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      const r = await fetch(SUPABASE_URL + "/rest/v1/curated_descriptions?select=lat,lng&name_clean=eq." + encodeURIComponent(nc), { headers: svc });
      const have: any[] = r.ok ? await r.json() : [];
      if (have.some((h) => haversineM(c.lat, c.lng, Number(h.lat), Number(h.lng)) <= 50)) {
        console.log(`  curated row already exists for "${c.name}" — skipped`);
        continue;
      }
    } catch { /* on a read failure, insert anyway: a duplicate row is harmless, a missing one is not */ }
    fresh.push(c);
  }
  curated = fresh;
  // #419: an existing SEED (uncredited submission) that is this place takes the
  // story as its persisted description. A user's own gem is never touched.
  for (const pt of patches) {
    const q = `?name=eq.${encodeURIComponent(pt.name)}&lat=eq.${pt.lat}&lng=eq.${pt.lng}&submitted_by=is.null&status=eq.approved`;
    const r = await fetch(SUPABASE_URL + "/rest/v1/submissions" + q, {
      method: "PATCH",
      headers: { ...svc, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ resolved_description: pt.story, resolved_source: "curated" }),
    });
    const n = r.ok ? ((await r.json().catch(() => [])) as any[]).length : 0;
    console.log(r.ok ? `  story attached to existing seed "${pt.name}" (${n} row)` : `  attach to seed "${pt.name}" FAILED: HTTP ${r.status}`);
  }
  if (curated.length) {
    const res = await fetch(SUPABASE_URL + "/rest/v1/curated_descriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(curated),
    });
    if (res.ok) console.log(`  curated_descriptions: inserted ${curated.length} story row(s).`);
    else console.error(`  curated_descriptions insert FAILED: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)} — the pins still show their story; load curated_records.json by hand.`);
  }
  console.log(`\n--commit: INSERTED ${inserted} row(s) into submissions (source='seed:reddit', city='${CITY.name}', status='approved').`);
  console.log(`Verify: submissions seed:reddit count should have risen by exactly ${inserted}. Back-out: delete from submissions where source='seed:reddit' and city='${CITY.name}' and created_at > now() - interval '1 hour';`);
}

async function run() {
  const args = Deno.args.filter((a) => !a.startsWith("--"));
  const COMMIT = Deno.args.includes("--commit");
  console.log(`[${TOOL_VERSION}] city=${CITY.name} (${CITY.lat}, ${CITY.lng}) maxKm=${CITY_MAX_KM} model=${GEMINI_MODEL}`);
  console.log(`  dedup = live map + submissions + Wikipedia (#418); map endpoint ${NEARBY_PLACES_URL}`);
  let names = DEFAULT_NAMES;
  if (args[0]) {
    try {
      const txt = await Deno.readTextFile(args[0]);
      names = txt.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      console.log(`Loaded ${names.length} names from ${args[0]}`);
    } catch (e) {
      console.error(`Could not read names file ${args[0]}: ${e}`);
      Deno.exit(1);
    }
  } else {
    console.log(`Using built-in ${names.length}-name Chicago pilot list (pass a file to override).`);
  }
  if (!GEMINI_API_KEY) console.warn("WARNING: GEMINI_API_KEY is not set — every place will be HELD (never judged), written to seed_held.txt for a re-run, not reviewed.");

  const rows: SeedRow[] = [];
  const curatedRows: CuratedRow[] = [];
  const seedPatches: SeedPatch[] = [];
  const report: any[] = [];

  for (const rawLine of names) {
    const line = parseLine(rawLine);
    const candidate = line.name;
    if (!candidate) continue;
    const byAddress = /^\d/.test(line.locate);
    const coord = line.locate.match(/^@\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    const geo = coord
      ? { lat: Number(coord[1]), lng: Number(coord[2]), label: `source coordinate ${coord[1]},${coord[2]}`, nameMatch: true }
      : byAddress
      ? await geocodeAddress(line.locate)
      : await geocode(line.locate || candidate);
    if (!geo) {
      report.push({ candidate, outcome: "geocode-failed" });
      console.log(`  ✗ ${candidate} — could not geocode`);
      continue;
    }
    const distKm = haversineM(CITY.lat, CITY.lng, geo.lat, geo.lng) / 1000;
    if (CITY_MAX_KM > 0 && distKm > CITY_MAX_KM) {
      report.push({ candidate, outcome: "out-of-metro", geo, distKm: Math.round(distKm) });
      console.log(`  ✗ ${candidate} — geocoded ${Math.round(distKm)} km from ${CITY.name}, skipped`);
      continue;
    }
    if (!geo.nameMatch) {
      report.push({ candidate, outcome: "name-mismatch", geo });
      console.log(`  ✗ ${candidate} — resolved to "${geo.label}" (name doesn't match), dropped`);
      continue;
    }

    // Tight 90 m lookup: the dedup/resolve signal (is there an article right here?).
    const wiki = await wikiAt(geo.lat, geo.lng);
    const near = await existingNear(geo.lat, geo.lng);
    const existing = near.list;
    // #418: a failed dedup source means the place was never fully checked → HOLD.
    const verdict: Verdict = near.failed
      ? { decision: "held", matchName: null, canonicalName: candidate, category: null, confidence: 0, why: near.failed }
      : await resolve(candidate, wiki?.title ?? null, existing, line.story);
    // A story line IS a storied place by construction (a human sourced the story),
    // so a "commercial" call on it is overridden to history, never skipped.
    if (line.story && verdict.category === "commercial") verdict.category = "history";

    // Description slot: prefer the tight hit's intro; if blank, widen to 300 m
    // with a title-match gate. This only fills TEXT — it never changes the
    // dedup verdict above.
    let wikiTitle = wiki?.title ?? null;
    let wikiIntro = wiki?.intro ?? "";
    let wikiWidened = false;
    if (!wikiIntro && verdict.decision === "new") {
      const enrich = await wikiEnrich(verdict.canonicalName || candidate, geo.lat, geo.lng);
      if (enrich) { wikiTitle = enrich.title; wikiIntro = enrich.intro; wikiWidened = true; }
    }

    const base = {
      candidate,
      geo,
      locate: line.locate || null,
      story: line.story || null,
      wikiTitle,
      wikiWidened,
      existing: existing.map((e) => `${e.name} [${e.source ?? "?"}]`),
      arms: near.arms,
      verdict,
    };

    // #419 — WHERE A STORY LINE GOES. A pin that is this place (its name, minus
    // any "(…)" qualifier, found in the line's name / locate / placed label) gets
    // the story; a new seed is made only when no LIVE-MAP or submission pin is
    // this place. A Wikipedia-only match is NOT "on the map": a tile carries only
    // the ~20 articles nearest its centre, so Landmark Center, Foshay Tower and
    // First Avenue have articles but no pin. Their Wikipedia title still gets a
    // curated row, so if a tile ever shows that pin it shows the story too.
    if (line.story && verdict.decision !== "held") {
      const blob = [candidate, line.locate, geo.label].join(" ");
      const bare = (n: string) => n.replace(/\s*\([^)]*\)\s*/g, " ").trim();
      const targets = existing.filter((e) => bare(e.name) && labelMatchesName(bare(e.name), blob));
      const onMap = targets.filter((e) => e.source !== "wiki");
      const stagePinRow = (e: Existing) => curatedRows.push({
        name: e.name, lat: e.lat, lng: e.lng, description: line.story,
        source_url: line.source || null, note: `#419 story on existing pin (${e.source}, ${CITY.name})`,
      });
      if (onMap.length) {
        for (const e of targets) {
          if (e.source === "submission") {
            if (e.seed) seedPatches.push({ name: e.name, lat: e.lat, lng: e.lng, story: line.story });
          } else stagePinRow(e);
        }
        report.push({ ...base, outcome: "story-attached", attachedTo: targets.map((e) => `${e.name} [${e.source}]`) });
        console.log(`  ↪ ${candidate} → story attaches to existing: ${targets.map((e) => `${e.name} [${e.source}]`).join(", ")}`);
        await sleep(7000);
        continue;
      }
      const other = verdict.decision === "match"
        ? existing.find((e) => e.source !== "wiki" && e.name === verdict.matchName) : undefined;
      if (other) {
        // Gemini says a live pin under a DIFFERENT name is this place: attaching
        // by fuzzy judgement risks the wrong pin, seeding risks a duplicate. Human.
        report.push({ ...base, outcome: "review", why: `matched live pin "${other.name}" under a different name — attach by hand` });
        console.log(`  ? ${candidate} → REVIEW: matched live pin "${other.name}" under a different name — attach by hand`);
        await sleep(7000);
        continue;
      }
      for (const e of targets) stagePinRow(e); // Wikipedia titles for this place
      verdict.decision = "new";
      if (!verdict.category || verdict.category === "commercial") verdict.category = "history";
    }

    if (verdict.decision === "new" && verdict.category === "commercial") {
      // #57 story-only: a new business with no story of its own is not a seed.
      report.push({ ...base, outcome: "commercial-skip" });
      console.log(`  − ${candidate} → commercial with no story, not seeded (#308/#312) (conf ${verdict.confidence.toFixed(2)})`);
    } else if (verdict.decision === "match") {
      report.push({ ...base, outcome: "already-present" });
      console.log(`  = ${candidate} → already on the map as "${verdict.matchName ?? existing[0]?.name}" (conf ${verdict.confidence.toFixed(2)})`);
      if (line.story) console.log(`    ! story NOT attached — the existing pin keeps its own description (report: story on an already-present pin)`);
    } else if (verdict.decision === "new") {
      // A story line keeps the operator's display name (Gemini may not rename it:
      // the curated row is keyed to this exact name) and its story is the text.
      const pinName = line.story ? candidate : verdict.canonicalName;
      const row: SeedRow = {
        name: pinName,
        description: line.story || wikiIntro,
        category: verdict.category,
        lat: geo.lat,
        lng: geo.lng,
        city: CITY.name,
        status: "approved",
        submitted_by: null,
        source: "seed:reddit",
        seed_meta: { candidate, geocodeLabel: geo.label, wikiTitle, confidence: verdict.confidence },
        resolved_description: line.story || null,
        resolved_source: line.story ? "curated" : null,
      };
      rows.push(row);
      if (line.story) {
        curatedRows.push({
          name: pinName, lat: geo.lat, lng: geo.lng, description: line.story,
          source_url: line.source || null, note: `#57 story seed (${CITY.name})`,
        });
      }
      report.push({ ...base, outcome: "new-seed" });
      const cat = verdict.category ?? "UNCLASSIFIED";
      const desc = line.story ? "story✓" : row.description ? (wikiWidened ? "wiki✓300m" : "wiki✓") : "wiki∅";
      console.log(`  + ${verdict.canonicalName} [${cat}] ${desc} (conf ${verdict.confidence.toFixed(2)})`);
      console.log(`      checked nearby: ${near.arms}`); // #420 — a new pin with nothing found by any arm is worth a second look
    } else if (verdict.decision === "held") {
      // Throttle/transport hold — the machine never judged this. Re-runnable,
      // NOT a review. Carries the HTTP status when there was one, so the report
      // is filterable (429 leftovers vs a hard 4xx). #264 / #263.
      report.push({ ...base, outcome: "held", status: verdict.status ?? null });
      console.log(`  ⏳ ${candidate} → HELD (re-run): ${verdict.why}`);
    } else {
      report.push({ ...base, outcome: "review" });
      console.log(`  ? ${candidate} → REVIEW: ${verdict.why} (conf ${verdict.confidence.toFixed(2)})`);
    }

    await sleep(7000); // ~8-9 calls/min — stays under Gemini free-tier 10 RPM (429s otherwise)
  }

  await Deno.writeTextFile("seed_records.json", JSON.stringify(rows, null, 2));
  await Deno.writeTextFile("seed_report.json", JSON.stringify(report, null, 2));
  await Deno.writeTextFile("curated_records.json", JSON.stringify(curatedRows, null, 2));

  // The held names, one per line — a ready-to-feed names file for a recovery
  // re-run: `... seed-resolve.ts seed_held.txt` with a working key clears them
  // (#264). Only written when something is actually held, so a clean run leaves
  // no stale file behind.
  const heldNames = report.filter((r) => r.outcome === "held").map((r) => r.candidate);
  if (heldNames.length) {
    await Deno.writeTextFile("seed_held.txt", heldNames.join("\n") + "\n");
  }

  const counts = report.reduce((m: any, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {});
  console.log("\n--- summary ---");
  console.log(counts);
  const uncat = rows.filter((r) => !r.category).length;
  const blank = rows.filter((r) => !r.description).length;
  const storied = rows.filter((r) => r.resolved_source === "curated").length;
  console.log(`stories attached to existing pins: ${counts["story-attached"] ?? 0} (${seedPatches.length} existing seed(s) updated on commit)`);
  console.log(`story lines seeded: ${storied} (their story ships as resolved_source 'curated'; ${curatedRows.length} curated_descriptions rows staged in curated_records.json)`);
  console.log(`new seed rows: ${rows.length}  (unclassified category: ${uncat}, no wiki description: ${blank})`);
  console.log("wrote seed_records.json (load into `submissions`) and seed_report.json (verdicts).");
  if (heldNames.length) {
    console.log(`HELD (never judged — re-run these): ${heldNames.length} → wrote seed_held.txt. Re-run: seed-resolve.ts seed_held.txt with a working key. These are NOT reviews (#264).`);
  }
  const commercialN = counts["commercial-skip"] ?? 0;
  if (commercialN) console.log(`COMMERCIAL-SKIP (no story of its own, not seeded): ${commercialN} — skim outcome:"commercial-skip" in seed_report.json for a storied place the classifier missed.`);
  const reviewN = counts.review ?? 0;
  if (reviewN) console.log(`REVIEW (judged, genuinely unsure — eyeball these): ${reviewN} in seed_report.json (outcome:"review").`);

  if (COMMIT) {
    console.log("\n--commit passed: writing the new rows to submissions now.");
    await commitToSupabase(rows, curatedRows, seedPatches);
    // #57 story-only: a new seed lands with resolved_source NULL (visible, never
    // checked). The #318 cascade stamps it — or hides it — only when the
    // recheck runs. Until then a seed with no wiki intro shows with no story.
    console.log("NEXT (#57 checklist): story lines are already stamped. Stamp the BARE-name seeds through the #318 cascade —");
    console.log("  deno run --allow-net --allow-env recheck-none-places.ts --nulls            # dry run, read it");
    console.log("  deno run --allow-net --allow-env recheck-none-places.ts --nulls --commit   # persist hits (misses stay visible)");
    console.log("  then, after eyeballing the misses: add --nulls-miss-to-none to hide the storyless ones.");
  } else {
    console.log("NOTHING was written to the database. Review the report, then re-run with --commit to insert (or load seed_records.json manually).");
  }
}

run();
