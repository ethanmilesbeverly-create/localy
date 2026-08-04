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
// It writes two files next to itself:
//   seed_records.json  — the NEW rows, ready to load into `submissions`
//   seed_report.json   — every verdict (new / already-present / uncertain)
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

// Pilot city bias for geocoding + a bounding sanity check.
const CITY = { name: "Chicago", lat: 41.8781, lng: -87.6298 };
const CITY_MAX_KM = 60; // reject a geocode that lands outside metro Chicago

const MATCH_RADIUS_M = 90;      // same constant as index.html dedupeReal()
const CONF_MIN = 0.75;          // below this, a decision goes to the human, not the machine
const VALID_CATEGORIES = new Set(["park", "shops", "barsrest", "history", "art"]);

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

type Existing = { name: string; lat: number; lng: number; category?: string; source?: string };

// ---------------------------------------------------------------------------
// 1) Geocode a name -> coordinates (Photon, unkeyed — the app's #88 provider).
// ---------------------------------------------------------------------------
async function geocode(name: string): Promise<{ lat: number; lng: number; label: string } | null> {
  const url =
    "https://photon.komoot.io/api/?limit=1&lat=" +
    CITY.lat +
    "&lon=" +
    CITY.lng +
    "&q=" +
    encodeURIComponent(name);
  try {
    const r = await fetch(url, { headers: { "User-Agent": "nahgoo-seed/1.0" } });
    if (!r.ok) return null;
    const data = await r.json();
    const f = data?.features?.[0];
    if (!f?.geometry?.coordinates) return null;
    const [lng, lat] = f.geometry.coordinates;
    const p = f.properties ?? {};
    const label = [p.name, p.city, p.state].filter(Boolean).join(", ");
    return { lat, lng, label: label || name };
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
// 3) What is ALREADY on the map within MATCH_RADIUS_M of this spot?
//    Prefer the deployed nearby-places function (exact app parity); fall back
//    to Wikipedia geosearch (covers the wiki-collision class).
// ---------------------------------------------------------------------------
async function existingNear(lat: number, lng: number): Promise<Existing[]> {
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
  const w = await wikiAt(lat, lng);
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
  seed_meta: { candidate: string; geocodeLabel: string; wikiTitle: string | null; confidence: number };
};

async function run() {
  const args = Deno.args.filter((a) => !a.startsWith("--"));
  let names = DEFAULT_NAMES;
  if (args[0]) {
    try {
      const txt = await Deno.readTextFile(args[0]);
      names = txt.split("\n").map((l) => l.trim()).filter(Boolean);
      console.log(`Loaded ${names.length} names from ${args[0]}`);
    } catch (e) {
      console.error(`Could not read names file ${args[0]}: ${e}`);
      Deno.exit(1);
    }
  } else {
    console.log(`Using built-in ${names.length}-name Chicago pilot list (pass a file to override).`);
  }
  if (!GEMINI_API_KEY) console.warn("WARNING: GEMINI_API_KEY is not set — every place will land in the review list.");

  const rows: SeedRow[] = [];
  const report: any[] = [];

  for (const candidate of names) {
    const geo = await geocode(candidate);
    if (!geo) {
      report.push({ candidate, outcome: "geocode-failed" });
      console.log(`  ✗ ${candidate} — could not geocode`);
      continue;
    }
    const distKm = haversineM(CITY.lat, CITY.lng, geo.lat, geo.lng) / 1000;
    if (distKm > CITY_MAX_KM) {
      report.push({ candidate, outcome: "out-of-metro", geo, distKm: Math.round(distKm) });
      console.log(`  ✗ ${candidate} — geocoded ${Math.round(distKm)} km from ${CITY.name}, skipped`);
      continue;
    }

    const wiki = await wikiAt(geo.lat, geo.lng);
    const existing = await existingNear(geo.lat, geo.lng);
    const verdict = await resolve(candidate, wiki?.title ?? null, existing);

    const base = {
      candidate,
      geo,
      wikiTitle: wiki?.title ?? null,
      existing: existing.map((e) => e.name),
      verdict,
    };

    if (verdict.decision === "match") {
      report.push({ ...base, outcome: "already-present" });
      console.log(`  = ${candidate} → already on the map as "${verdict.matchName ?? existing[0]?.name}" (conf ${verdict.confidence.toFixed(2)})`);
    } else if (verdict.decision === "new") {
      const row: SeedRow = {
        name: verdict.canonicalName,
        description: wiki?.intro ?? "",
        category: verdict.category,
        lat: geo.lat,
        lng: geo.lng,
        status: "approved",
        submitted_by: null,
        source: "seed:reddit",
        seed_meta: { candidate, geocodeLabel: geo.label, wikiTitle: wiki?.title ?? null, confidence: verdict.confidence },
      };
      rows.push(row);
      report.push({ ...base, outcome: "new-seed" });
      const cat = verdict.category ?? "UNCLASSIFIED";
      const desc = row.description ? "wiki✓" : "wiki∅";
      console.log(`  + ${verdict.canonicalName} [${cat}] ${desc} (conf ${verdict.confidence.toFixed(2)})`);
    } else {
      report.push({ ...base, outcome: "review" });
      console.log(`  ? ${candidate} → REVIEW: ${verdict.why} (conf ${verdict.confidence.toFixed(2)})`);
    }

    await sleep(250); // be polite to Photon / Wikipedia / Gemini
  }

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
