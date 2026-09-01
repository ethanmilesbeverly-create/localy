// coord-sweep.ts — #314, the misplaced-seed COORDINATE sweep.
//
// WHAT IT DOES. Reads the seed pins already in `submissions` and, for each one,
// re-resolves its NAME to a coordinate INDEPENDENTLY of the coordinate stored on
// the row — then flags any pin whose stored coordinate disagrees with where the
// world says the place is by more than SWEEP_FLAG_KM (default 1 km).
//
//   read seeds  →  for each: resolve the name via Wikipedia (the article's OWN
//   coordinate) AND via Photon (city-biased, name-gated)  →  compare BOTH to the
//   stored coordinate  →  PROPOSE a correction only when two independent sources
//   AGREE the pin is off; hand everything ambiguous to a human.
//
// WHY THIS SHAPE — and the line it will NOT cross (#314 / #266 / #316):
//   * PROPOSE, NEVER DISPOSE. This tool NEVER writes the database. A wrong pin is
//     bad; a wrongly-"corrected" pin (moved to the wrong place with confidence)
//     is WORSE. So there is no --commit here (unlike seed-resolve.ts): the output
//     is a review file + a reviewable SQL file the operator eyeballs and runs.
//   * TWO INDEPENDENT SOURCES, AND THEY MUST AGREE to propose a MOVE. Photon does
//     fuzzy text matching (#300) and a single Wikipedia hit can be a namesake in
//     another city — either alone can be wrong. A proposed coordinate correction
//     requires Wikipedia (article coordinate + title match) AND Photon (name-gated)
//     to independently land within AGREE_M of EACH OTHER while both disagree with
//     the stored pin. That two-source agreement is the coordinate-side of the
//     #316 "99% sure by location + context" gate. One source alone is REVIEW.
//   * IT RESOLVES THE NAME, NOT THE PIN. The stored (possibly wrong) coordinate is
//     never fed back into the resolvers as a bias — that would pull a fuzzy match
//     toward the wrong place and MASK the error. Photon is biased to the row's
//     CITY centre (geocoded once per city), Wikipedia is searched by name only.
//   * LONG LINEAR FEATURES ARE NOT "MISPLACED" (the #54/#279 coordinate-sanity
//     trap). A trail/river's single article centroid legitimately sits km from any
//     given point on it, so a lone Wikipedia-vs-stored gap on a linear feature is
//     NOT evidence of a wrong pin. The two-source-agreement rule handles this for
//     free: Photon and Wikipedia rarely agree on a made-up "centre" for a linear
//     feature, so it falls to REVIEW rather than a proposed move. (park is treated
//     as a facts category, not linear; it still needs both sources to agree.)
//
// SCOPE: coordinates ONLY. This does NOT touch descriptions, categories, or
// validity — those are #313/#315/#318 (descriptions) and future health sweeps.
// One job per tool.
//
// RUN (offline batch, not a deployed function — the .devcontainer injects the
// two secrets; see the seed-resolve.ts §6 handoff note):
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   deno run --allow-net --allow-env --allow-write coord-sweep.ts
//
// It writes two files next to itself:
//   coord_sweep_review.json — every row's verdict (ok / flag / review /
//                             unresolved / held), with both resolved coordinates,
//                             the stored coordinate, and the distances. THE FULL
//                             RECORD — read this first.
//   coord_sweep_fixes.sql   — reviewable UPDATE statements, TWO tiers:
//                             HIGH-confidence flags (both sources agree) are LIVE
//                             `update` lines; MED-confidence flags (one strong
//                             source) come out COMMENTED, for approval. NO
//                             BEGIN/COMMIT wrapper — one bad row must not roll the
//                             batch back (#313 batch-2 lesson); each statement is
//                             guarded on id AND the current lat/lng, so it is
//                             idempotent and will not fire if the pin already moved.
//   coord_sweep_held.txt    — names the resolvers never got to judge (Wikipedia/
//                             Photon 429/5xx/network). A throttle is a HOLD, never
//                             a silent "resolved nothing" that could hide a real
//                             misplacement (#264). Re-run to clear. Only written
//                             when something was actually held.
//
// It does NOT write to the database. Applying coord_sweep_fixes.sql is a separate,
// deliberate SQL-editor step, taken AFTER reading coord_sweep_review.json.

// ---------------------------------------------------------------------------
// Config (all overridable by env; safe defaults).
// ---------------------------------------------------------------------------
// Service-role read of `submissions`. The service-role key BYPASSES RLS, so it
// lives ONLY in an env var / Codespaces secret — never in this file, never
// committed. SUPABASE_URL is the base project URL, e.g. https://<ref>.supabase.co
// (no trailing slash, no /rest/v1 — the code appends the path).
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Which rows to sweep. Default = the seed layer (the class Photon minted, so the
// class that carries this bug). Set SWEEP_SOURCE='*' to sweep EVERY approved row.
const SWEEP_SOURCE = (Deno.env.get("SWEEP_SOURCE") ?? "seed:reddit").trim();
// Optional single-category filter (park|history|art|shops|barsrest). Blank = all.
const SWEEP_CATEGORY = (Deno.env.get("SWEEP_CATEGORY") ?? "").trim();

// A stored pin more than this far from where BOTH sources agree the place is gets
// flagged. 1 km per #314; generous enough to absorb geocode drift across a large
// park, tight enough that Clarke House (~2.5 km) and Fountain of Time (~10 km)
// both clear it easily.
const FLAG_KM = Number(Deno.env.get("SWEEP_FLAG_KM") ?? 1.0);
// How close the two independent sources must land to EACH OTHER to count as
// "agreement" (and thus a proposable HIGH-confidence move). 500 m.
const AGREE_M = Number(Deno.env.get("SWEEP_AGREE_M") ?? 500);

const WIKI_TITLE_MIN = Number(Deno.env.get("SWEEP_WIKI_TITLE_MIN") ?? 0.5); // token overlap to trust an article
const PACE_MS = Number(Deno.env.get("SWEEP_PACE_MS") ?? 700); // between rows; keeps under Wikipedia/Photon throttles
const PHOTON_BOX_KM = Number(Deno.env.get("SWEEP_PHOTON_BOX_KM") ?? 60); // metro box for the city-biased geocode

// ---------------------------------------------------------------------------
// Small helpers (self-contained copies from seed-resolve.ts — this tool is a
// standalone sibling, not a shared module).
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
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
const UA = { "User-Agent": "nahgoo-coord-sweep/1.0" };

// Title/name token overlap (fraction of the place-name's distinctive words the
// article title covers). NFD-fold first so accents don't shatter a token (#303).
function tokens(s: string): Set<string> {
  const STOP = new Set(["the", "of", "a", "an", "and", "at", "in", "on", "to", "de", "la", "le"]);
  return new Set(
    (s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STOP.has(w)),
  );
}
function titleMatch(name: string, title: string): number {
  const a = tokens(name), b = tokens(title);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size;
}

type HeldError = { held: true; why: string };
function isHeld(x: unknown): x is HeldError {
  return !!x && typeof x === "object" && (x as any).held === true;
}

// ---------------------------------------------------------------------------
// 0) Read the seed rows to sweep (service-role REST, paged). Reads only the
//    columns needed: id, name, lat, lng, category, city, source.
// ---------------------------------------------------------------------------
type SeedRow = { id: string; name: string; lat: number; lng: number; category: string | null; city: string | null; source: string | null };

async function fetchRows(): Promise<SeedRow[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("ABORT: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set (Codespaces secrets). Nothing was read.");
    Deno.exit(1);
  }
  const filters: string[] = ["status=eq.approved", "lat=not.is.null", "lng=not.is.null"];
  if (SWEEP_SOURCE !== "*") filters.push(`source=eq.${encodeURIComponent(SWEEP_SOURCE)}`);
  if (SWEEP_CATEGORY) filters.push(`category=eq.${encodeURIComponent(SWEEP_CATEGORY)}`);
  const base =
    SUPABASE_URL +
    "/rest/v1/submissions?select=id,name,lat,lng,category,city,source&" +
    filters.join("&");

  const rows: SeedRow[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(base, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
        Range: `${offset}-${offset + PAGE - 1}`,
        "Range-Unit": "items",
      },
    });
    if (!res.ok) {
      console.error(`ABORT: read failed HTTP ${res.status} — ${(await res.text().catch(() => "")).slice(0, 300)}`);
      Deno.exit(1);
    }
    const page: any[] = await res.json();
    for (const p of page) {
      const lat = Number(p.lat), lng = Number(p.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng) && p.name) {
        rows.push({ id: String(p.id), name: String(p.name), lat, lng, category: p.category ?? null, city: p.city ?? null, source: p.source ?? null });
      }
    }
    if (page.length < PAGE) break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 1) Wikipedia by NAME -> the article's OWN coordinate. Search, rank by title-
//    token coverage, take the best article that clears WIKI_TITLE_MIN, read its
//    coordinate. Independent of the stored pin (that is the point). A 429/5xx is
//    a HELD, never a silent null.
// ---------------------------------------------------------------------------
async function wikiCoordByName(
  name: string,
): Promise<{ title: string; lat: number; lng: number; score: number } | null | HeldError> {
  try {
    const srch =
      "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=" +
      encodeURIComponent(name);
    const sr = await fetch(srch, { headers: UA });
    if (!sr.ok) {
      if ([429, 500, 502, 503, 504].includes(sr.status)) return { held: true, why: `wiki search ${sr.status}` };
      return null;
    }
    const sd = await sr.json();
    const results: any[] = sd?.query?.search ?? [];
    const ranked = results
      .map((r) => ({ title: r.title as string, score: titleMatch(name, r.title || "") }))
      .filter((r) => r.score >= WIKI_TITLE_MIN)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;

    // Best-first, take the first article that actually carries a coordinate.
    for (const cand of ranked) {
      const q =
        "https://en.wikipedia.org/w/api.php?action=query&prop=coordinates&format=json&redirects=1&titles=" +
        encodeURIComponent(cand.title);
      const cr = await fetch(q, { headers: UA });
      if (!cr.ok) {
        if ([429, 500, 502, 503, 504].includes(cr.status)) return { held: true, why: `wiki coords ${cr.status}` };
        continue;
      }
      const cdj = await cr.json();
      const pages = cdj?.query?.pages ?? {};
      const p: any = Object.values(pages)[0] ?? {};
      const coord = Array.isArray(p?.coordinates) ? p.coordinates[0] : null;
      const cLat = Number(coord?.lat), cLon = Number(coord?.lon ?? coord?.lng);
      if (Number.isFinite(cLat) && Number.isFinite(cLon)) {
        return { title: cand.title, lat: cLat, lng: cLon, score: cand.score };
      }
    }
    return null; // article(s) matched by title but none carry a coordinate — no reference
  } catch (e) {
    return { held: true, why: "wiki network: " + String(e).slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// 2) Photon by NAME, biased to the row's CITY centre (NOT the stored pin), with
//    the seed-resolve.ts name-match gate so a fuzzy same-city mismatch is not
//    trusted as a coordinate. City centres are geocoded once and cached.
// ---------------------------------------------------------------------------
const GEO_STOPWORDS = new Set(["the", "and", "for", "of", "at", "on", "in", "to", "a", "an", "de", "la", "le"]);
function geoTokens(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !GEO_STOPWORDS.has(t));
}
function labelMatchesName(name: string, label: string): boolean {
  const want = geoTokens(name);
  if (!want.length) return false;
  const have = new Set(geoTokens(label));
  const hit = want.filter((t) => have.has(t)).length;
  return hit / want.length >= 0.6;
}

const cityCentreCache = new Map<string, { lat: number; lng: number } | null>();
async function cityCentre(city: string | null): Promise<{ lat: number; lng: number } | null> {
  const key = (city || "").trim();
  if (!key) return null;
  if (cityCentreCache.has(key)) return cityCentreCache.get(key)!;
  try {
    const r = await fetch("https://photon.komoot.io/api/?limit=1&q=" + encodeURIComponent(key), { headers: UA });
    if (!r.ok) { cityCentreCache.set(key, null); return null; }
    const d = await r.json();
    const c = d?.features?.[0]?.geometry?.coordinates;
    const centre = c && c.length >= 2 ? { lat: c[1], lng: c[0] } : null;
    cityCentreCache.set(key, centre);
    return centre;
  } catch {
    cityCentreCache.set(key, null);
    return null;
  }
}

async function photonCoordByName(
  name: string,
  centre: { lat: number; lng: number } | null,
): Promise<{ lat: number; lng: number; label: string } | null | HeldError> {
  // Bias + hard bbox around the city centre so an out-of-metro namesake can't win.
  let biasBox = "";
  if (centre) {
    const dLat = PHOTON_BOX_KM / 111;
    const dLng = PHOTON_BOX_KM / (111 * Math.max(0.05, Math.cos((centre.lat * Math.PI) / 180)));
    const bbox = [centre.lng - dLng, centre.lat - dLat, centre.lng + dLng, centre.lat + dLat]
      .map((n) => n.toFixed(6))
      .join(",");
    biasBox = `&lat=${centre.lat}&lon=${centre.lng}&bbox=${bbox}`;
  }
  try {
    const r = await fetch("https://photon.komoot.io/api/?limit=5" + biasBox + "&q=" + encodeURIComponent(name), { headers: UA });
    if (!r.ok) {
      if ([429, 500, 502, 503, 504].includes(r.status)) return { held: true, why: `photon ${r.status}` };
      return null;
    }
    const d = await r.json();
    const feats: any[] = Array.isArray(d?.features) ? d.features : [];
    // Nearest-to-centre candidate whose label passes the name-match gate.
    let best: { lat: number; lng: number; label: string } | null = null;
    let bestDist = Infinity;
    for (const f of feats) {
      const c = f?.geometry?.coordinates;
      if (!c || c.length < 2) continue;
      const [lng, lat] = c;
      const p = f.properties ?? {};
      const label = [p.name, p.city, p.state].filter(Boolean).join(", ") || name;
      if (!labelMatchesName(name, label)) continue;
      const dist = centre ? haversineM(centre.lat, centre.lng, lat, lng) : 0;
      if (dist < bestDist) { best = { lat, lng, label }; bestDist = dist; }
    }
    return best;
  } catch (e) {
    return { held: true, why: "photon network: " + String(e).slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// SQL escape for the review note that rides in the UPDATE comment.
// ---------------------------------------------------------------------------
function sqlStr(s: string): string {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function run() {
  const rows = await fetchRows();
  console.log(
    `Sweeping ${rows.length} row(s)  (source=${SWEEP_SOURCE}${SWEEP_CATEGORY ? `, category=${SWEEP_CATEGORY}` : ""}, flag > ${FLAG_KM} km, agree ≤ ${AGREE_M} m).`,
  );

  type Verdict = {
    id: string; name: string; category: string | null; city: string | null;
    stored: { lat: number; lng: number };
    wiki: { title: string; lat: number; lng: number; score: number } | null;
    photon: { lat: number; lng: number; label: string } | null;
    reference: { lat: number; lng: number; from: string } | null;
    storedVsRefKm: number | null;
    sourcesAgreeM: number | null;
    outcome: "ok" | "flag" | "review" | "unresolved" | "held";
    confidence: "high" | "med" | "low" | null;
    why: string;
  };

  const review: Verdict[] = [];
  const held: string[] = [];

  for (const row of rows) {
    const centre = await cityCentre(row.city);
    const wRes = await wikiCoordByName(row.name);
    const pRes = await photonCoordByName(row.name, centre);

    // A throttle/transport failure on EITHER resolver is a HOLD (re-run), never a
    // verdict — a silent null here could hide a genuinely misplaced pin (#264).
    if (isHeld(wRes) || isHeld(pRes)) {
      const why = [isHeld(wRes) ? wRes.why : "", isHeld(pRes) ? pRes.why : ""].filter(Boolean).join("; ");
      review.push({
        id: row.id, name: row.name, category: row.category, city: row.city,
        stored: { lat: row.lat, lng: row.lng }, wiki: null, photon: null,
        reference: null, storedVsRefKm: null, sourcesAgreeM: null,
        outcome: "held", confidence: null, why,
      });
      held.push(row.name);
      console.log(`  ⏳ ${row.name} — HELD (re-run): ${why}`);
      await sleep(PACE_MS);
      continue;
    }

    const wiki = wRes as { title: string; lat: number; lng: number; score: number } | null;
    const photon = pRes as { lat: number; lng: number; label: string } | null;

    // Decide the reference coordinate and its confidence.
    let reference: { lat: number; lng: number; from: string } | null = null;
    let confidence: Verdict["confidence"] = null;
    let sourcesAgreeM: number | null = null;
    let why = "";

    if (wiki && photon) {
      sourcesAgreeM = Math.round(haversineM(wiki.lat, wiki.lng, photon.lat, photon.lng));
      if (sourcesAgreeM <= AGREE_M) {
        // Both independent sources agree — the strongest possible reference. Use
        // Wikipedia's (authoritative for a named landmark) as the coordinate.
        reference = { lat: wiki.lat, lng: wiki.lng, from: "wiki+photon" };
        confidence = "high";
        why = `Wikipedia "${wiki.title}" and Photon "${photon.label}" agree within ${sourcesAgreeM} m`;
      } else {
        // Sources disagree with EACH OTHER — ambiguous (or a linear feature whose
        // article centroid ≠ Photon's point). Do not propose a move; review.
        why = `sources disagree by ${sourcesAgreeM} m (wiki "${wiki.title}" vs photon "${photon.label}") — no move proposed`;
      }
    } else if (wiki) {
      reference = { lat: wiki.lat, lng: wiki.lng, from: "wiki" };
      confidence = "med";
      why = `Wikipedia "${wiki.title}" only (title match ${wiki.score.toFixed(2)}); Photon did not resolve`;
    } else if (photon) {
      reference = { lat: photon.lat, lng: photon.lng, from: "photon" };
      confidence = "low";
      why = `Photon "${photon.label}" only; no Wikipedia article`;
    } else {
      why = "neither Wikipedia nor Photon resolved the name";
    }

    // Compare the reference to the stored pin.
    let outcome: Verdict["outcome"];
    let storedVsRefKm: number | null = null;
    if (!reference) {
      outcome = "unresolved";
    } else {
      storedVsRefKm = Number((haversineM(row.lat, row.lng, reference.lat, reference.lng) / 1000).toFixed(3));
      if (storedVsRefKm <= FLAG_KM) {
        outcome = "ok";
      } else if (confidence === "high" || confidence === "med") {
        outcome = "flag"; // proposable (high = live SQL, med = commented SQL)
      } else {
        outcome = "review"; // a single fuzzy Photon match is not enough to move a pin
      }
    }

    review.push({
      id: row.id, name: row.name, category: row.category, city: row.city,
      stored: { lat: row.lat, lng: row.lng }, wiki, photon,
      reference, storedVsRefKm, sourcesAgreeM, outcome, confidence, why,
    });

    const tag =
      outcome === "ok" ? "=" :
      outcome === "flag" ? (confidence === "high" ? "‼" : "?") :
      outcome === "review" ? "?" :
      outcome === "unresolved" ? "·" : "⏳";
    const dist = storedVsRefKm !== null ? ` (${storedVsRefKm} km off)` : "";
    console.log(`  ${tag} ${row.name} — ${outcome}${dist}`);

    await sleep(PACE_MS);
  }

  // -------------------------------------------------------------------------
  // Emit the review file (everything) + the reviewable SQL (flags only).
  // -------------------------------------------------------------------------
  await Deno.writeTextFile("coord_sweep_review.json", JSON.stringify(review, null, 2));

  const flags = review.filter((r) => r.outcome === "flag" && r.reference);
  const sqlLines: string[] = [
    "-- coord_sweep_fixes.sql — #314 misplaced-seed coordinate corrections.",
    "-- PROPOSED, not applied. Read coord_sweep_review.json first, then eyeball",
    "-- each line below against the real place before running.",
    "-- NO BEGIN/COMMIT wrapper on purpose (#313 batch-2): one bad row must not",
    "-- roll the batch back; each UPDATE is guarded on id AND the current lat/lng,",
    "-- so it is idempotent and will not fire if the pin has already been moved.",
    "-- Two tiers: HIGH-confidence (both sources agree) are LIVE; MED-confidence",
    "-- (one strong source) are COMMENTED — uncomment only after verifying.",
    "",
  ];
  const high = flags.filter((f) => f.confidence === "high");
  const med = flags.filter((f) => f.confidence === "med");

  sqlLines.push(`-- ===== HIGH confidence (${high.length}): both Wikipedia and Photon agree the pin is off =====`);
  for (const f of high) {
    const r = f.reference!;
    sqlLines.push(
      `-- ${f.name} — ${f.storedVsRefKm} km off; ${f.why}`,
      `update public.submissions set lat = ${r.lat}, lng = ${r.lng}`,
      `  where id = ${sqlStr(f.id)} and lat = ${f.stored.lat} and lng = ${f.stored.lng};`,
      "",
    );
  }
  sqlLines.push(`-- ===== MED confidence (${med.length}): one strong source only — VERIFY before uncommenting =====`);
  for (const f of med) {
    const r = f.reference!;
    sqlLines.push(
      `-- ${f.name} — ${f.storedVsRefKm} km off; ${f.why}`,
      `-- update public.submissions set lat = ${r.lat}, lng = ${r.lng}`,
      `--   where id = ${sqlStr(f.id)} and lat = ${f.stored.lat} and lng = ${f.stored.lng};`,
      "",
    );
  }
  await Deno.writeTextFile("coord_sweep_fixes.sql", sqlLines.join("\n") + "\n");

  if (held.length) await Deno.writeTextFile("coord_sweep_held.txt", held.join("\n") + "\n");

  // -------------------------------------------------------------------------
  // Summary.
  // -------------------------------------------------------------------------
  const counts = review.reduce((m: any, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {});
  console.log("\n--- summary ---");
  console.log(counts);
  console.log(
    `flags: ${flags.length}  (HIGH ${high.length} live, MED ${med.length} commented) → coord_sweep_fixes.sql`,
  );
  console.log(`full record → coord_sweep_review.json`);
  if (held.length) {
    console.log(`HELD (re-run these — a throttle is not a verdict, #264): ${held.length} → coord_sweep_held.txt`);
  }
  console.log("\nNOTHING was written to the database. Review coord_sweep_review.json, then run the vetted lines of coord_sweep_fixes.sql in the Supabase SQL editor.");
}

run();
