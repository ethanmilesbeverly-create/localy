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
//   GEMINI_API_KEY=... deno run --allow-net --allow-env --allow-read --allow-write \
//     seed-resolve.ts Seed_Data_-_Sheet1.csv
//
// The input is the verified seed CSV (name,location,description,city,source_thread).
// By DEFAULT only ADDRESS-VERIFIED rows (a ZIP in `location` — the Google
// "approved" set) are ingested; locality-only rows are left for the human queue.
// Flags:
//   --all           ingest every row, not just the address-verified ones
//   --city=Denver   restrict to one or more cities (--city=Denver,Austin)
//   --limit=N       stop after N eligible rows (smoke-test a small batch first)
//
// Geocoding uses the VERIFIED street address (the payoff of the Google pass),
// biased to the row's city centre, falling back to "name, city". Descriptions
// still come from WIKIPEDIA ONLY (#37/#101/#178) — the CSV `description` column
// is NOT used as a submission description; a place with no matching article
// ships an honest blank.
//
// It writes three files next to itself:
//   seed_records.json  — the NEW rows, ready to load into `submissions`
//   seed_report.json   — every verdict (new / already-present / review / skipped)
//   seed_cache.json    — resumable cache. Re-run in place to continue after a
//                        crash or a Gemini rate-limit; delete it to start over.
//
// It does NOT write to the database. Loading seed_records.json into Supabase
// `submissions` is a deliberate, separate, reviewable step (see the delivery
// notes in chat).

// ---------------------------------------------------------------------------
// Config (all overridable by env; safe Chicago-pilot defaults).
// ---------------------------------------------------------------------------
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = (Deno.env.get("GEMINI_MODEL")?.trim()) || "gemini-3.1-flash-lite";

// Optional: the deployed nearby-places function. If set, we ask IT what is
// already on the map (the exact set the app would show, so our dedup matches
// the app's). If unset, we fall back to a direct Wikipedia geosearch, which
// covers the main collision class (wiki pins — the Lily Pool case).
const NEARBY_PLACES_URL = Deno.env.get("NEARBY_PLACES_URL") ?? "";
const NEARBY_PLACES_KEY = Deno.env.get("NEARBY_PLACES_KEY") ?? "";

// Per-city metro centres + expected state. The centre biases Photon; MAX_KM is
// a sanity gate that rejects a geocode landing in the wrong metro (a same-named
// place in another city). Generous enough for real suburbs (Denver→Golden, LA
// sprawl), tight enough to catch a wrong-state hit. The verified address already
// carries the correct city/state/ZIP, so this is a backstop, not the main signal.
type City = { lat: number; lng: number; state: string };
const CITIES: Record<string, City> = {
  "New York": { lat: 40.7128, lng: -74.0060, state: "NY" },
  "Chicago": { lat: 41.8781, lng: -87.6298, state: "IL" },
  "San Francisco": { lat: 37.7749, lng: -122.4194, state: "CA" },
  "Los Angeles": { lat: 34.0522, lng: -118.2437, state: "CA" },
  "Washington DC": { lat: 38.9072, lng: -77.0369, state: "DC" },
  "Boston": { lat: 42.3601, lng: -71.0589, state: "MA" },
  "New Orleans": { lat: 29.9511, lng: -90.0715, state: "LA" },
  "Seattle": { lat: 47.6062, lng: -122.3321, state: "WA" },
  "Austin": { lat: 30.2672, lng: -97.7431, state: "TX" },
  "Nashville": { lat: 36.1627, lng: -86.7816, state: "TN" },
  "Portland": { lat: 45.5152, lng: -122.6784, state: "OR" },
  "Miami": { lat: 25.7617, lng: -80.1918, state: "FL" },
  "Denver": { lat: 39.7392, lng: -104.9903, state: "CO" },
};
const CITY_MAX_KM = 80; // sanity radius around each city centre (covers metro suburbs)
const CACHE_PATH = "seed_cache.json"; // resumable cache (survives crashes / 429s)

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
const VALID_CATEGORIES = new Set(["park", "shops", "barsrest", "history", "art"]);

// LEGACY pilot seed list (the original #57 Chicago pilot), kept for reference.
// The tool now reads the verified CSV; this array is no longer an input path.
// Tier 1 (named in all three AskChicago threads) then Tier 2 (named in two).
const _LEGACY_PILOT_NAMES = [
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

// ---------------------------------------------------------------------------
// Resilient Wikipedia GET -> parsed JSON, or null after real exhaustion.
//
// WHY THIS EXISTS. Every row fires several Wikipedia calls (geosearch for the
// description, the same lookup again for "what's already here", plus the widen
// / name-search). Wikipedia rate-limits, and the old raw fetches read a throttle
// as "nothing found" — so a landmark whose article is metres away would RANDOMLY
// either dedupe against it or get written as a new blank seed, depending on which
// calls got throttled that run (QA: two identical Chicago-25 runs disagreed on
// 14/25 rows). A throttle must be a WAIT, not a wrong answer.
//
// The distinction that keeps this honest: a *throttle* (HTTP 429/503, or a
// non-JSON "too many requests" body) is retried with backoff; a *valid empty
// result* (200 with real JSON and an empty geosearch) is returned as-is, so a
// genuine "no article here" still reads as blank. Only a persistent throttle
// past all retries degrades to null — now rare instead of routine.
// Self-pacing gate: keep our OWN Wikipedia requests at least WIKI_MIN_GAP_MS
// apart, globally. The tool fires 2–4 Wikipedia calls per row back-to-back
// (geosearch + extract + widen), and it was that BURST that tripped Wikipedia's
// throttle — retries then papered over it unevenly, leaving ~1/10 rows still
// flipping. Spacing the calls PREVENTS the throttle instead of reacting to it;
// the cost is ~1s/row on top of the 7s inter-row sleep. Calls are already
// sequential, so a timestamp gate is enough to serialise them politely.
const WIKI_MIN_GAP_MS = 350;
let _wikiNextAt = 0;
async function wikiPace() {
  const now = Date.now();
  const wait = Math.max(0, _wikiNextAt - now);
  _wikiNextAt = Math.max(now, _wikiNextAt) + WIKI_MIN_GAP_MS;
  if (wait > 0) await sleep(wait);
}

async function wikiJSON(url: string, tries = 6): Promise<any | null> {
  // Backoff caps at 8s (waits: 1,2,4,8,8,8 — up to ~31s for a fully throttled
  // row) with jitter so parallel-ish calls don't retry in lockstep. A row that
  // needs no retry pays nothing; only a genuinely throttled one waits. QA showed
  // 4 tries left ~1/10 rows still flipping under sustained load (National Museum
  // of Mexican Art, article 6m away, geocode stable — a pure throttle exhaustion,
  // not a boundary case); the extra headroom is to close that gap.
  for (let attempt = 1; attempt <= tries; attempt++) {
    const backoff = Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
    await wikiPace(); // space our own calls to avoid tripping the throttle
    try {
      const r = await fetch(url, { headers: { "User-Agent": "nahgoo-seed/1.0 (map seed dedup; contact via repo)" } });
      if (r.status === 429 || r.status === 503) { await sleep(backoff); continue; }
      if (!r.ok) return null; // a non-throttle error (400/404/…) is a real miss
      const text = await r.text();
      try {
        return JSON.parse(text); // valid JSON (incl. a legitimately empty result)
      } catch {
        // 200-ish but the body isn't JSON — Wikipedia's throttle/error HTML.
        // Treat as a throttle and back off; do NOT read it as an empty result.
        await sleep(backoff);
        continue;
      }
    } catch {
      await sleep(backoff); // network blip — retry
    }
  }
  return null;
}

type Existing = { name: string; lat: number; lng: number; category?: string; source?: string };

// ---------------------------------------------------------------------------
// 1) Geocode a name -> coordinates (Photon, unkeyed — the app's #88 provider).
// ---------------------------------------------------------------------------
async function geocode(query: string, center: { lat: number; lng: number }): Promise<{ lat: number; lng: number; label: string } | null> {
  const url =
    "https://photon.komoot.io/api/?limit=1&lat=" +
    center.lat +
    "&lon=" +
    center.lng +
    "&q=" +
    encodeURIComponent(query);
  try {
    const r = await fetch(url, { headers: { "User-Agent": "nahgoo-seed/1.0" } });
    if (!r.ok) return null;
    const data = await r.json();
    const f = data?.features?.[0];
    if (!f?.geometry?.coordinates) return null;
    const [lng, lat] = f.geometry.coordinates;
    const p = f.properties ?? {};
    const label = [p.name, p.city, p.state].filter(Boolean).join(", ");
    return { lat, lng, label: label || query };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2) Wikipedia intro at this spot -> the "what it is" slot (REAL source only).
//    geosearch for an article within MATCH_RADIUS_M, then pull its intro.
// ---------------------------------------------------------------------------
async function wikiAt(
  lat: number,
  lng: number,
): Promise<{ title: string; intro: string; lat: number; lng: number } | null> {
  const geo =
    "https://en.wikipedia.org/w/api.php?action=query&list=geosearch&format=json&gslimit=5&gsradius=" +
    MATCH_RADIUS_M +
    "&gscoord=" +
    lat +
    "%7C" +
    lng;
  const gd = await wikiJSON(geo);
  const hit = gd?.query?.geosearch?.[0];
  if (!hit?.title) return null;

  const ex =
    "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&redirects=1&titles=" +
    encodeURIComponent(hit.title);
  const ed = await wikiJSON(ex);
  const pages = ed?.query?.pages ?? {};
  const first: any = Object.values(pages)[0] ?? {};
  const intro = String(first.extract ?? "").trim();
  return { title: hit.title, intro, lat: hit.lat, lng: hit.lon };
}

// ---------------------------------------------------------------------------
// 2b) WIDER wiki lookup for the DESCRIPTION slot only. Searches WIKI_ENRICH_
//     RADIUS_M (300 m), but attaches an article ONLY when its title actually
//     matches the place name — so a big park whose article coordinate is 250 m
//     away gets enriched, while a random neighbouring article inside the circle
//     is rejected. Never used for dedup; never invents text (#101/#178): a name
//     with no matching article stays blank.
// ---------------------------------------------------------------------------
// Per-row extra stopwords (the current city + state words), set by run() before
// each row, so a title match isn't inflated by the city name.
let CURRENT_STOPS: Set<string> = new Set();
function tokens(s: string): Set<string> {
  const STOP = new Set(["the", "of", "a", "an", "and", "at", "in", "on"]);
  return new Set(
    (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w && !STOP.has(w) && !CURRENT_STOPS.has(w)),
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
  const ex =
    "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&redirects=1&titles=" +
    encodeURIComponent(title);
  const ed = await wikiJSON(ex);
  const pages = ed?.query?.pages ?? {};
  const first: any = Object.values(pages)[0] ?? {};
  return String(first.extract ?? "").trim();
}

async function wikiEnrich(
  name: string,
  lat: number,
  lng: number,
): Promise<{ title: string; intro: string } | null> {
  // Path A — coordinate geosearch (300 m) + title gate. Best when Photon
  // dropped the pin near the article's own coordinate.
  {
    const geo =
      "https://en.wikipedia.org/w/api.php?action=query&list=geosearch&format=json&gslimit=10&gsradius=" +
      WIKI_ENRICH_RADIUS_M +
      "&gscoord=" + lat + "%7C" + lng;
    const gd = await wikiJSON(geo);
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
    // fall through to Path B
  }

  // Path B — name search, then verify the found article's OWN coordinate is
  // within WIKI_NAME_SANITY_M of the pin. Recovers wide features whose article
  // coordinate sits beyond the 300 m circle (Palmisano, Promontory). The
  // coordinate check is what stops a same-named place elsewhere from attaching.
  {
    const srch =
      "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=" +
      encodeURIComponent(name);
    const sd = await wikiJSON(srch);
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
      const cdj = await wikiJSON(q);
      if (!cdj) continue;
      const pages = cdj?.query?.pages ?? {};
      const p: any = Object.values(pages)[0] ?? {};
      const coord = Array.isArray(p?.coordinates) ? p.coordinates[0] : null;
      const cLat = Number(coord?.lat), cLon = Number(coord?.lon ?? coord?.lng);
      // An article attaches ONLY if it carries its own coordinate AND that
      // coordinate lands within the sanity radius of the pin. A coordinate-less
      // article is rejected outright, whatever the title score. The old code
      // accepted a coord-less article on a perfect title alone ("a perfect name
      // hit is almost certainly the place") — but a NAMESAKE THAT ISN'T A PLACE
      // (a TV show, song, or person) has a perfect-token title and no coordinate,
      // so it sailed through with zero geographic check. That shipped the intro
      // for the Disney cooking show "5 STAR Kitchen ITC Chef's Special" onto the
      // Denver restaurant "Star Kitchen" (QA, Denver batch). Every real feature
      // Path B was built to recover (Palmisano, Promontory) carries a coordinate,
      // so requiring one keeps those; a place that genuinely lacks a coordinate
      // gets an honest blank (#101/#178), which is the correct, safe outcome.
      if (!Number.isFinite(cLat) || !Number.isFinite(cLon)) continue; // no coord -> not a mappable place
      if (haversineM(lat, lng, cLat, cLon) > WIKI_NAME_SANITY_M) continue; // same name, wrong place
      const intro = String(p?.extract ?? "").trim();
      if (intro) return { title: cand.title, intro };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3) What is ALREADY on the map within MATCH_RADIUS_M of this spot?
//    Prefer the deployed nearby-places function (exact app parity); fall back
//    to Wikipedia geosearch (covers the wiki-collision class).
// ---------------------------------------------------------------------------
// wikiHint is the wikiAt() result run() already computed for this exact spot.
// Reusing it removes a second identical Wikipedia geosearch per row — the old
// code called wikiAt() here again, doubling the Wikipedia load AND adding a
// second independent throttle-failure point, so the direct call and this one
// could disagree within a single row (one found the article, the other got
// throttled -> the row saw an empty "existing" and became a spurious new seed).
async function existingNear(lat: number, lng: number, wikiHint?: { title: string; lat: number; lng: number } | null): Promise<Existing[]> {
  if (NEARBY_PLACES_URL) {
    try {
      const r = await fetch(NEARBY_PLACES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(NEARBY_PLACES_KEY ? { Authorization: "Bearer " + NEARBY_PLACES_KEY } : {}),
        },
        body: JSON.stringify({ lat, lng }),
      });
      if (r.ok) {
        const d = await r.json();
        const places: any[] = Array.isArray(d?.places) ? d.places : Array.isArray(d) ? d : [];
        return places
          .filter((p) => typeof p?.lat === "number" && typeof p?.lng === "number")
          .map((p) => ({ name: String(p.name ?? ""), lat: p.lat, lng: p.lng, category: p.category, source: p.source }))
          .filter((p) => p.name && haversineM(lat, lng, p.lat, p.lng) <= MATCH_RADIUS_M);
      }
    } catch {
      // fall through to Wikipedia
    }
  }
  const w = wikiHint !== undefined ? wikiHint : await wikiAt(lat, lng);
  return w && w.title ? [{ name: w.title, lat: w.lat, lng: w.lng, source: "wiki" }] : [];
}

// ---------------------------------------------------------------------------
// 4) Gemini: match-or-new + category. Temperature 0, JSON out. Same call shape
//    as review-submission. Gemini NEVER writes a description here.
// ---------------------------------------------------------------------------
type Verdict = {
  decision: "match" | "new" | "uncertain";
  matchName: string | null;
  canonicalName: string;
  category: string | null;
  confidence: number;
  why: string;
};

async function resolve(candidate: string, wikiTitle: string | null, existing: Existing[]): Promise<Verdict> {
  if (!GEMINI_API_KEY) {
    return { decision: "uncertain", matchName: null, canonicalName: candidate, category: null, confidence: 0, why: "no GEMINI_API_KEY set" };
  }
  const list = existing.length ? existing.map((e, i) => `${i + 1}. ${e.name}`).join("\n") : "(none within 90 m)";
  const prompt = [
    "You are deduplicating map places. Decide whether a CANDIDATE place is the SAME",
    "real-world place as one already on the map nearby, or a genuinely NEW place.",
    "",
    `CANDIDATE (from a local's recommendation): "${candidate}"`,
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
    "- category: EXACTLY one of park, shops, barsrest, history, art. Museums/landmarks/monuments => history. Public art => art. Restaurants/bars/cafes => barsrest. Stores/markets => shops. Parks/gardens/nature/trails => park.",
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
        return { decision: "uncertain", matchName: null, canonicalName: candidate, category: null, confidence: 0, why: `gemini ${g.status}: ${raw.slice(0, 160)}` };
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
      let category: string | null = VALID_CATEGORIES.has(parsed.category) ? parsed.category : null;
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
      return { decision: "uncertain", matchName: null, canonicalName: candidate, category: null, confidence: 0, why: "parse/network error: " + String(err).slice(0, 160) };
    }
  }
  return { decision: "uncertain", matchName: null, canonicalName: candidate, category: null, confidence: 0, why: "exhausted retries" };
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
  status: "approved";
  submitted_by: null;
  source: "seed:reddit";
  seed_meta: { candidate: string; address: string; city: string; sourceThread: string; geocodeLabel: string; wikiTitle: string | null; confidence: number };
};

// ---------------------------------------------------------------------------
// Minimal RFC4180 CSV parser (quotes, escaped quotes, CRLF). No import so the
// tool stays dependency-free, matching the rest of this file.
// ---------------------------------------------------------------------------
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* handled at \n */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() ?? [];
  return rows
    .filter((r) => r.length && !(r.length === 1 && r[0] === ""))
    .map((r) => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => (o[h] = r[i] ?? ""));
      return o;
    });
}

const hasZip = (s: string) => /\b\d{5}(-\d{4})?\b/.test(s || "");

async function run() {
  const raw = Deno.args;
  const positional = raw.filter((a) => !a.startsWith("--"));
  const flags = new Map<string, string>();
  for (const a of raw) if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); flags.set(k, v ?? "true"); }

  const csvPath = positional[0];
  if (!csvPath) {
    console.error("Usage: seed-resolve.ts <Seed_Data.csv> [--all] [--city=Denver,Austin] [--limit=N]");
    Deno.exit(1);
  }
  let text = "";
  try { text = await Deno.readTextFile(csvPath); }
  catch (e) { console.error(`Could not read ${csvPath}: ${e}`); Deno.exit(1); }
  const allRows = parseCSV(text);

  const wantAll = flags.has("all");
  const cityFilter = flags.get("city") ? new Set(flags.get("city")!.split(",").map((s) => s.trim())) : null;
  const limit = flags.get("limit") ? parseInt(flags.get("limit")!, 10) : Infinity;

  const unknownCity = allRows.filter((r) => !CITIES[r.city]); // no centre -> can't place
  const eligibleAll = allRows.filter((r) => {
    if (!CITIES[r.city]) return false;
    if (cityFilter && !cityFilter.has(r.city)) return false;
    if (!wantAll && !hasZip(r.location)) return false; // "approved" = address-verified
    return true;
  });
  const eligible = Number.isFinite(limit) ? eligibleAll.slice(0, limit) : eligibleAll;

  if (!GEMINI_API_KEY) console.warn("WARNING: GEMINI_API_KEY is not set — every place will land in the review list.");
  console.log(
    `Input ${allRows.length} rows; ${eligible.length} eligible` +
    `${wantAll ? " (--all)" : " (address-verified only)"}` +
    `${cityFilter ? ` in ${[...cityFilter].join("/")}` : ""}` +
    `${Number.isFinite(limit) ? `, limit ${limit}` : ""}` +
    `${unknownCity.length ? `; ${unknownCity.length} skipped for unknown city` : ""}.`,
  );

  // Resumable cache: key = name||city. A cached row is never re-fetched, so a
  // re-run after a crash / 429 continues where it stopped. Outputs are rebuilt
  // from the cache in CSV order at the end, so a resumed run is complete.
  type Cached = { record: SeedRow | null; report: any };
  let cache: Record<string, Cached> = {};
  try {
    cache = JSON.parse(await Deno.readTextFile(CACHE_PATH));
    console.log(`Resuming: ${Object.keys(cache).length} rows already cached.`);
  } catch { /* fresh run */ }
  const flush = () => Deno.writeTextFile(CACHE_PATH, JSON.stringify(cache));

  let done = 0;
  for (const r of eligible) {
    done++;
    const name = r.name, city = r.city, address = r.location, sourceThread = r.source_thread ?? "";
    const ckey = `${name}||${city}`;
    if (cache[ckey]) { console.log(`[${done}/${eligible.length}] = cached  ${name} (${city})`); continue; }

    const c = CITIES[city];
    CURRENT_STOPS = new Set([...city.toLowerCase().split(/\s+/), c.state.toLowerCase()]);

    // Geocode the VERIFIED address first (the Google-pass payoff); fall back to
    // "name, city" if the address doesn't resolve.
    let geo = await geocode(address, c);
    if (!geo) geo = await geocode(`${name}, ${city}`, c);
    if (!geo) {
      cache[ckey] = { record: null, report: { candidate: name, city, address, outcome: "geocode-failed" } };
      console.log(`  \u2717 ${name} (${city}) — could not geocode`);
      if (done % 10 === 0) await flush();
      continue;
    }
    const distKm = haversineM(c.lat, c.lng, geo.lat, geo.lng) / 1000;
    if (distKm > CITY_MAX_KM) {
      cache[ckey] = { record: null, report: { candidate: name, city, address, geo, distKm: Math.round(distKm), outcome: "out-of-metro" } };
      console.log(`  \u2717 ${name} (${city}) — ${Math.round(distKm)} km from centre, skipped`);
      if (done % 10 === 0) await flush();
      continue;
    }

    const wiki = await wikiAt(geo.lat, geo.lng);
    const existing = await existingNear(geo.lat, geo.lng, wiki);
    const verdict = await resolve(name, wiki?.title ?? null, existing);

    let wikiTitle = wiki?.title ?? null;
    let wikiIntro = wiki?.intro ?? "";
    let wikiWidened = false;
    if (!wikiIntro && verdict.decision === "new") {
      const enrich = await wikiEnrich(verdict.canonicalName || name, geo.lat, geo.lng);
      if (enrich) { wikiTitle = enrich.title; wikiIntro = enrich.intro; wikiWidened = true; }
    }

    const base = { candidate: name, city, address, geo, wikiTitle, wikiWidened, existing: existing.map((e) => e.name), verdict };

    if (verdict.decision === "match") {
      cache[ckey] = { record: null, report: { ...base, outcome: "already-present" } };
      console.log(`  = ${name} (${city}) → already present as "${verdict.matchName ?? existing[0]?.name}" (conf ${verdict.confidence.toFixed(2)})`);
    } else if (verdict.decision === "new" && verdict.category) {
      const record: SeedRow = {
        name: verdict.canonicalName,
        description: wikiIntro,
        category: verdict.category,
        lat: geo.lat,
        lng: geo.lng,
        status: "approved",
        submitted_by: null,
        source: "seed:reddit",
        seed_meta: { candidate: name, address, city, sourceThread, geocodeLabel: geo.label, wikiTitle, confidence: verdict.confidence },
      };
      cache[ckey] = { record, report: { ...base, outcome: "new-seed" } };
      const desc = record.description ? (wikiWidened ? "wiki\u2713300m" : "wiki\u2713") : "wiki\u2205";
      console.log(`  + ${verdict.canonicalName} [${verdict.category}] ${desc} (${city}, conf ${verdict.confidence.toFixed(2)})`);
    } else if (verdict.decision === "new") {
      // NEW but no valid category: an unclassified 'approved' row is the #68
      // trap (renders in no tab; approve_submission refuses it). Route to review.
      cache[ckey] = { record: null, report: { ...base, outcome: "review-uncat" } };
      console.log(`  ? ${name} (${city}) → REVIEW: new but no category (conf ${verdict.confidence.toFixed(2)})`);
    } else {
      cache[ckey] = { record: null, report: { ...base, outcome: "review" } };
      console.log(`  ? ${name} (${city}) → REVIEW: ${verdict.why} (conf ${verdict.confidence.toFixed(2)})`);
    }

    if (done % 10 === 0) await flush();
    await sleep(7000); // ~8-9 calls/min — under Gemini free-tier 10 RPM (429s otherwise)
  }
  await flush();

  // Rebuild outputs from the cache in eligible (CSV) order — complete even after
  // a resume, and stable regardless of which rows were done in which run.
  const rows: SeedRow[] = [];
  const report: any[] = [];
  for (const r of eligible) {
    const cached = cache[`${r.name}||${r.city}`];
    if (!cached) continue;
    if (cached.record) rows.push(cached.record);
    report.push(cached.report);
  }
  for (const u of unknownCity) report.push({ candidate: u.name, city: u.city, outcome: "unknown-city-skipped" });

  await Deno.writeTextFile("seed_records.json", JSON.stringify(rows, null, 2));
  await Deno.writeTextFile("seed_report.json", JSON.stringify(report, null, 2));

  const counts = report.reduce((m: any, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {});
  console.log("\n--- summary ---");
  console.log(counts);
  const uncat = rows.filter((r) => !r.category).length;
  const blank = rows.filter((r) => !r.description).length;
  console.log(`new seed rows: ${rows.length}  (unclassified category: ${uncat}, no wiki description: ${blank})`);
  console.log("wrote seed_records.json (load into `submissions`) and seed_report.json (human review).");
  console.log("NOTHING was written to the database. Review the report, then load seed_records.json deliberately.");
}

run();
