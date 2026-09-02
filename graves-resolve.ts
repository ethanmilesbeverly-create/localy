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
// ONE SHAPE OF PIN — an individual grave with its OWN distinct coordinate.
// Wikidata pins a burial at the BURIAL PLACE's coordinate, so most famous
// people carry the CEMETERY's coordinate, not their own plot — 40 notables at
// Graceland all share one dot. Those are NOT emitted: the cemetery itself is
// already a pin on the map (a seeded/OSM place that resolves its own Wikipedia
// article, e.g. Graceland Cemetery), so it already represents them. This tool
// emits a "Grave of <person>" pin ONLY when the person's burial has a coordinate
// that no other notable shares (their own tomb / mausoleum / standalone
// monument) — a precise, net-new location that does not stack. People who only
// carry a shared cemetery coordinate are REPORTED (covered-by-cemetery), not
// emitted. No cluster pins: a cemetery pin already exists and is richer.
//
// REQUIRE-WIKI. Only people with an English Wikipedia article count AT ALL — the
// query itself requires the enwiki sitelink. This kills the long tail of "has a
// Wikidata record but nobody wrote about them" (a first pass without it surfaced
// a TV-remote inventor and a Styx guitarist). Requiring the article at the QUERY
// level keeps the result set small and the run fast.
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
// RUN (offline Deno tool at the repo root — a sibling of seed-resolve.ts):
//
//   # dry run — query + build + propose, writes NOTHING to the DB:
//   SEED_CITY_NAME=Chicago SEED_CITY_LAT=41.8781 SEED_CITY_LNG=-87.6298 \
//     deno run --allow-net --allow-env --allow-write graves-resolve.ts
//
//   # after reading graves_report.json, load the proposed rows:
//   SEED_CITY_NAME=Chicago ... deno run --allow-net --allow-env --allow-write \
//     graves-resolve.ts --commit
//
// CONFIG OUTSIDE THE FILE: none new. --commit reuses the SAME Codespaces secrets
// seed-resolve.ts uses (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). Wikidata and
// Wikipedia are keyless. No Gemini — a Wikidata item is canonical. Optional
// NEARBY_PLACES_URL/_KEY turns on map-parity dedup (off by default).

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

// How many names the covered-by-cemetery report lists per cemetery (by fame).
const MAX_NAMES = Number(Deno.env.get("GRAVE_MAX_NAMES") ?? 20);

const MATCH_RADIUS_M = 90; // same constant as index.html dedupeReal()

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
  lat: number;
  lng: number;
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

async function wikidataPeople(): Promise<Person[]> {
  const dLat = GRAVE_METRO_KM / 111;
  const dLng = GRAVE_METRO_KM / (111 * Math.max(0.05, Math.cos((CITY.lat * Math.PI) / 180)));
  const west = `Point(${(CITY.lng - dLng).toFixed(6)} ${(CITY.lat - dLat).toFixed(6)})`;
  const east = `Point(${(CITY.lng + dLng).toFixed(6)} ${(CITY.lat + dLat).toFixed(6)})`;

  // ENWIKI ARTICLE REQUIRED (not OPTIONAL) — the require-wiki gate, at the query
  // level. wikibase:sitelinks is the fame proxy used to rank names.
  const sparql = `
SELECT ?person ?personLabel ?personDescription ?sitelinks ?burialLabel ?coord ?article WHERE {
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
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`.trim();

  const endpoint = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql);
  let data: any;
  try {
    const r = await fetch(endpoint, {
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": "nahgoo-graves/1.0 (notable-grave seed pipeline; contact: privacy@nahgoo.com)",
      },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error(`\nWikidata query FAILED: HTTP ${r.status} ${body.slice(0, 300)}`);
      console.error("403 = User-Agent; 400 = geo-box syntax; 500/timeout = smaller GRAVE_METRO_KM. Nothing was written.");
      Deno.exit(1);
    }
    data = await r.json();
  } catch (e) {
    console.error(`\nWikidata query ERROR: ${e}. Nothing was written.`);
    Deno.exit(1);
  }

  const rowsRaw: any[] = data?.results?.bindings ?? [];
  console.log(`Wikidata returned ${rowsRaw.length} raw articled-burial row(s) in the ${CITY.name} bbox.`);

  const byQid = new Map<string, Person>();
  for (const b of rowsRaw) {
    const personUri = b?.person?.value as string | undefined;
    const coordWkt = b?.coord?.value as string | undefined;
    const article = titleFromArticleUrl(b?.article?.value);
    if (!personUri || !coordWkt || !article) continue;
    const m = /^Point\(([-\d.]+)\s+([-\d.]+)\)$/.exec(coordWkt.trim());
    if (!m) continue;
    const lng = Number(m[1]), lat = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const qid = personUri.split("/").pop() ?? personUri;
    if (byQid.has(qid)) continue;
    const person = String(b?.personLabel?.value ?? "").trim();
    if (!person || /^Q\d+$/.test(person)) continue;
    byQid.set(qid, {
      qid,
      person,
      personDesc: String(b?.personDescription?.value ?? "").trim(),
      articleTitle: article,
      sitelinks: Number(b?.sitelinks?.value ?? 0) || 0,
      burialLabel: String(b?.burialLabel?.value ?? "").trim(),
      lat,
      lng,
    });
  }
  return [...byQid.values()];
}

// ---------------------------------------------------------------------------
// 2) Wikipedia intro for a grave pin (identity via the sitelink, #163 — not
//    coordinate-gated). Blank if the fetch fails.
// ---------------------------------------------------------------------------
async function wikiIntroFor(title: string): Promise<string> {
  try {
    const ex =
      "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&redirects=1&titles=" +
      encodeURIComponent(title);
    const er = await fetch(ex, { headers: { "User-Agent": "nahgoo-graves/1.0" } });
    if (!er.ok) return "";
    const ed = await er.json();
    const pages = ed?.query?.pages ?? {};
    const first: any = Object.values(pages)[0] ?? {};
    return String(first.extract ?? "").trim();
  } catch {
    return "";
  }
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
  console.log(`\n--commit: INSERTED ${inserted} row(s) into submissions (source='${SOURCE_TAG}', city='${rows[0].city}', status='approved').`);
  console.log(`Verify (REST): submissions?source=eq.${SOURCE_TAG}&city=eq.${rows[0].city}&select=count with Prefer:count=exact — should equal ${inserted}.`);
  console.log(`Back-out: delete from submissions where source='${SOURCE_TAG}' and city='${rows[0].city}' and created_at > now() - interval '1 hour';`);
}

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------
async function run() {
  const COMMIT = Deno.args.includes("--commit");
  console.log(`Metro: ${CITY.name} (${CITY.lat}, ${CITY.lng}), bbox ±${GRAVE_METRO_KM} km. Source tag: ${SOURCE_TAG}.`);
  console.log(`Require-wiki: ON. Distinct-coordinate graves only (shared cemetery coords are reported, not emitted). Dedup: ${NEARBY_PLACES_URL ? "nearby-places" : "OFF"}.`);

  const people = await wikidataPeople();
  console.log(`Distinct notable people (with a Wikipedia article) and a burial coordinate: ${people.length}.`);
  if (!people.length) {
    console.log("Nothing to do. If this metro has famous graves, the geo-box query is the first suspect (see header note).");
    await Deno.writeTextFile("graves_records.json", "[]\n");
    await Deno.writeTextFile("graves_report.json", "[]\n");
    return;
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
  const report: any[] = [];
  let coveredPeople = 0;

  for (const [, members] of byCoord) {
    const { lat, lng } = members[0];
    const distKm = haversineM(CITY.lat, CITY.lng, lat, lng) / 1000;
    if (distKm > GRAVE_METRO_KM * 1.5) {
      report.push({ outcome: "out-of-metro", distKm: Math.round(distKm), members: members.map((m) => m.person) });
      continue;
    }

    if (members.length >= 2) {
      // Shared cemetery coordinate — covered by the cemetery pin, NOT emitted.
      const sorted = [...members].sort((a, b) => b.sitelinks - a.sitelinks);
      coveredPeople += members.length;
      report.push({
        outcome: "covered-by-cemetery",
        cemetery: sorted[0].burialLabel || "(unnamed burial place)",
        lat, lng,
        count: members.length,
        notable: sorted.slice(0, MAX_NAMES).map((m) => `${m.person} (${m.sitelinks})`),
      });
      console.log(`  ~ ${sorted[0].burialLabel || "shared coord"} — ${members.length} notable, covered by cemetery pin (top: ${sorted.slice(0, 3).map((m) => m.person).join(", ")})`);
      continue;
    }

    // Distinct coordinate — a real individual grave. Emit "Grave of <person>".
    const p = members[0];
    const near = await mapNear(lat, lng);
    const dup = near.find((e) => titleMatch(p.person, e.name) >= 0.5);
    if (dup) {
      report.push({ qid: p.qid, person: p.person, lat, lng, outcome: "already-present", matched: dup.name });
      console.log(`  = ${p.person} — already on the map as "${dup.name}"`);
      continue;
    }
    const intro = await wikiIntroFor(p.articleTitle);
    const name = NAME_PREFIX ? `${NAME_PREFIX} ${p.person}` : p.person;
    rows.push({
      name,
      description: intro,
      category: "history",
      lat,
      lng,
      city: CITY.name,
      status: "approved",
      submitted_by: null,
      source: SOURCE_TAG,
      grave_meta: { kind: "grave", qid: p.qid, person: p.person, burialLabel: p.burialLabel, articleTitle: p.articleTitle },
    });
    report.push({ qid: p.qid, person: p.person, lat, lng, articleTitle: p.articleTitle, hasDesc: !!intro, outcome: "grave" });
    console.log(`  + ${name} ${intro ? "wiki✓" : "wiki∅"} (${p.personDesc || "—"})`);
    await sleep(400);
  }

  await Deno.writeTextFile("graves_records.json", JSON.stringify(rows, null, 2));
  await Deno.writeTextFile("graves_report.json", JSON.stringify(report, null, 2));

  const counts = report.reduce((m: any, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {});
  const cemeteries = report.filter((r) => r.outcome === "covered-by-cemetery").length;
  console.log("\n--- summary ---");
  console.log(counts);
  console.log(`GRAVE PINS emitted (distinct coordinate): ${rows.length}.`);
  console.log(`COVERED BY CEMETERY (not emitted): ${coveredPeople} notable people across ${cemeteries} cemetery coordinate(s) — see graves_report.json (outcome:"covered-by-cemetery").`);
  console.log("wrote graves_records.json (load into submissions) and graves_report.json (every verdict).");

  if (COMMIT) {
    console.log("\n--commit passed: writing the new grave rows to submissions now.");
    await commitToSupabase(rows);
  } else {
    console.log("\nNOTHING was written to the database. Review graves_report.json, then re-run with --commit to insert (or load graves_records.json manually).");
  }
}

run();
