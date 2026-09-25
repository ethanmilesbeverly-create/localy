import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// --- #3(a): pinned model, never an alias -----------------------------------
// `gemini-flash-latest` resolved to gemini-2.5-flash, which Google retired
// ~Jul 9 2026 ahead of its own announced Oct 16 date with no changelog, 404ing
// this gate. The alias is the defect, not the retirement: it hides which model
// is actually called, and the 404 names the RESOLVED id, so the failing string
// appears nowhere in this file. Do not substitute another `-latest`.
//
// This default MUST track whatever GEMINI_MODEL is set to. It is not a spare
// tyre: if the secret is ever cleared or lost in a project migration, this value
// is what runs, and a default pointing at a retired model fails every submission
// open into pending with no signal that a fallback even happened.
//
// Empty string is normalised to unset. `??` only catches null/undefined, so a
// GEMINI_MODEL set to "" would previously produce MODEL = "" and every call
// would POST to `.../models/:generateContent` — a 404 naming a model id that
// appears nowhere, which is the exact diagnostic dead-end #3(a) was about.
const MODEL_ENV_RAW = Deno.env.get("GEMINI_MODEL");
const MODEL_ENV = MODEL_ENV_RAW && MODEL_ENV_RAW.trim() ? MODEL_ENV_RAW.trim() : null;
const MODEL = MODEL_ENV ?? "gemini-3.1-flash-lite";

// --- #70(B1): make the fallback observable instead of checkable -------------
// A correct secret and a correct default produce byte-identical behaviour, so a
// migration that dropped GEMINI_MODEL looks healthy right up until the pinned
// default is itself retired. Every review writes down which of the two values it
// ran on, so a lost secret surfaces in pending_review on the first submission.
// REQUIRES the `ai_model_source` column — run its migration BEFORE deploying.
const MODEL_SOURCE: "secret" | "fallback" = MODEL_ENV ? "secret" : "fallback";

// Retry only on transient upstream conditions. A 400/403/404 is a
// configuration error; retrying just doubles the latency before failing.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 1200;

// --- #114: the live display buckets the classifier may emit -----------------
// The gate now CLASSIFIES (it no longer takes the user's category as input): the
// model picks the category and this Set is the allow-list its answer is
// validated against, so an off-schema pick is dropped to null rather than
// written. TWO-PLACE FACT, now THREE: keep identical to GEM_BUCKET_CATEGORY /
// the (removed) #gem-category options in index.html AND to the bucket list in
// approve_submission (moderation). 'lore' is NOT here — #192 merged it into
// 'history'; 'art' was split out by #193.
const VALID_CATEGORIES = new Set(["park", "shops", "barsrest", "history", "art"]);

// --- #12: copy editor, capped at mechanics, discard-on-overreach -----------
// The gate ALSO asks the model for a cleaned name/description and stores them in
// name_clean/description_clean (separate columns; raw text is never overwritten
// and is always recoverable). The AI is a copy editor and NEVER a rewriter: case,
// spelling, punctuation and whitespace only, wording and clause order preserved.
// The prompt asks for mechanics only, but prompt-hope does not hold a line — so
// the guard below is the real fence. THE GUARD NEVER TOUCHES THE GATE AND NEVER
// ENQUEUES: on overreach it discards the clean value and keeps the raw text.
const CLEAN_MIN_SIMILARITY = 0.85; // normalised char similarity to accept a clean value
const CLEAN_LEN_LO = 0.5;          // clean.length / raw.length lower bound (caught: truncation)
const CLEAN_LEN_HI = 1.7;          // upper bound (caught: appended sentences / expansion)
const NAME_CLEAN_CAP = 200;        // hard length caps before the guard even runs
const DESC_CLEAN_CAP = 2000;

// Lowercase, collapse whitespace, strip everything that is not a letter/digit/
// space. Mechanics (case + punctuation) vanish under this; a spelling fix leaves
// a small character delta; a reword leaves a large one. Unicode-aware so an
// accent fix (cafe -> café) is a 1-char delta, not a whole-token swap.
function normalizeForCompare(s: string): string {
  return s.toLowerCase().normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Iterative two-row Levenshtein similarity (1 - dist/maxLen). Inputs here are a
// short name or a capped description, so the O(n*m) cost is trivial.
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

// Returns a cleaned string ONLY if it passes as mechanics-only, else null.
// null means "no safe clean was produced; the raw text stands" — it is not an
// error and does not affect the gate. `why` is for the response/console so QA
// can see whether a value was applied or discarded and why.
function safeClean(
  raw: string | null | undefined,
  clean: unknown,
  cap: number,
): { value: string | null; applied: boolean; why: string } {
  const rawStr = (raw ?? "").trim();
  if (!rawStr) return { value: null, applied: false, why: "raw_empty" };
  if (typeof clean !== "string") return { value: null, applied: false, why: "no_clean_returned" };
  const cleanStr = clean.trim().slice(0, cap);
  if (!cleanStr) return { value: null, applied: false, why: "clean_blank" };

  const rawN = normalizeForCompare(rawStr);
  const cleanN = normalizeForCompare(cleanStr);
  if (rawN === cleanN) {
    return cleanStr === rawStr
      ? { value: null, applied: false, why: "no_change" }
      : { value: cleanStr, applied: true, why: "mechanics_only" };
  }

  const lenRatio = cleanStr.length / rawStr.length;
  if (lenRatio < CLEAN_LEN_LO || lenRatio > CLEAN_LEN_HI) {
    return { value: null, applied: false, why: `overreach_length(${lenRatio.toFixed(2)})` };
  }
  const sim = similarity(rawN, cleanN);
  if (sim < CLEAN_MIN_SIMILARITY) {
    return { value: null, applied: false, why: `overreach_similarity(${sim.toFixed(2)})` };
  }
  return { value: cleanStr, applied: true, why: `spelling_ok(${sim.toFixed(2)})` };
}

// #3(c) — the failure modes that used to be indistinguishable in the queue.
type AiStatus =
  | "ok"             // model answered, output parsed, decision honoured
  | "http_error"     // reached Google, non-2xx (404 dead model, 429, 5xx)
  | "parse_error"    // 200 but output was not usable JSON
  | "bad_decision"   // parsed fine, `decision` was not one of the three
  | "network_error"; // never got an HTTP status at all

// =====================================================================
// #31 — DUPLICATE DETECTION. One place, one pin, however many people
// submit it.
//
// THE RULE THIS WHOLE BLOCK EXISTS TO SERVE: never create a second pin,
// ALWAYS record the second submission. Rejecting a duplicate is the
// obvious implementation and it is the wrong one — the second submission
// IS the signal, and a "this already exists" rejection throws away the
// only evidence the app will ever have that a place is worth two trips.
// A duplicate is a VOUCH, not a failed write.
//
// THE MATCH RULE IS ITEM #54's, WITH ONE DELIBERATE NARROWING.
// #54 wrote: same category within ~75 m with meaningful token overlap,
// OR within ~25 m regardless of name. The first half is used verbatim.
// The second half is NARROWED to still require name overlap, because #54
// was scoped to gem-vs-scaffolding, where the scaffolded row is a guess
// and overriding it is cheap. Here both sides are a human who walked
// somewhere, and "within 25 m regardless of name" merges two different
// shops in one building — an unrecoverable loss of somebody's real
// submission. Proximity alone therefore does NOT merge; it falls through
// to the normal gate.
// =====================================================================
const DUP_SAME_CAT_M   = 75;   // #54's radius, same category
const DUP_CROSS_CAT_M  = 25;   // tighter: one place filed under two buckets
const DUP_TOKEN_RATIO  = 0.6;  // shared / min(tokens)

// 0.6 is chosen against real rows in the table, not picked round:
//   "Canes Chicken Shack" vs "Canes Chicken"          -> 2/2 = 1.00  merge
//   "Couch Mausoleum from original chicago cemetery"
//                        vs "The Couch Mausoleum"     -> 2/2 = 1.00  merge
//   "Montrose Point Bird Sanctuary" vs "Montrose Harbor" -> 1/2 = 0.50  NO
// Anything at or below 0.5 must not merge.
const DUP_STOPWORDS = new Set([
  "the", "a", "an", "of", "at", "in", "on", "and", "or", "to", "for",
]);

// =====================================================================
// #228 — SEMANTIC "SAME PLACE?" FALLBACK, THE NET THE MATCHER ABOVE
// STRUCTURALLY CANNOT CATCH.
//
// The deterministic matcher above merges on NAME OVERLAP *and* PROXIMITY.
// It was reproduced-broken on purpose: move a pin past DUP_SAME_CAT_M and
// reword the title, and the same place is filed twice — the name reworded
// below DUP_TOKEN_RATIO, or the coordinate drifted past 75 m, or both.
// String+distance cannot judge "The Bear's Mr. Beef" vs "Mr. Beef on
// Orleans" 90 m apart are one place; a reader can, and so can the model
// that already runs the gate.
//
// SO: only when the deterministic matcher MISSES, gather same-category
// candidates in a WIDER radius and ask Gemini one strict "same real-world
// place?" question. This costs ZERO extra calls on the common path — a
// submission with no near-miss candidate never triggers it (no candidate,
// no call), and a submission the deterministic matcher already caught
// never reaches it.
//
// THE ASYMMETRY IS DELIBERATE AND IS THE #54 NARROWING AGAIN: a MISSED
// merge is fully recoverable (the operator folds it later with
// merge_submissions, #74), a WRONG merge silently destroys a real
// person's submission. So this fires ONLY on same:true AND a high
// confidence floor, and every failure mode — no key, 429, HTTP error,
// unparseable output, off-schema answer — falls through to the normal
// gate and creates the pin rather than merging on a guess.
// =====================================================================
const DUP_SEMANTIC_M          = 200;  // same-category candidate radius for the model
const DUP_SEMANTIC_CONF       = 0.85; // only merge on same:true at/above this
const DUP_SEMANTIC_MAX_CANDS  = 6;    // nearest N passed to the model, bounds the prompt

function dupNormName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function dupTokens(s: string | null | undefined): Set<string> {
  return new Set(
    (s ?? "").toLowerCase()
      // Strip apostrophes FIRST (delete, don't space) so a possessive keeps its
      // stem as one token: "Will's" -> "wills" (matches a typed "Wills"), "Joe's"
      // -> "joes". Spacing the apostrophe split "will's" into {will, s} and broke
      // the match against the apostrophe-free variant — the live "Wills northward
      // inn" vs seed "Will's Northwoods Inn" miss (shared only "inn", 0.33 < 0.6).
      // dupNormName already strips all non-alnum, so the exact-name path was never
      // affected; this only aligns the token path with it.
      .replace(/['\u2019]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !DUP_STOPWORDS.has(t)),
  );
}

function dupTokenRatio(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

function dupMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/* Returns the pin this submission duplicates, or null.

   CANDIDATE SCOPE IS approved + pending, AND LEAVING 'rejected' OUT IS A
   DECISION. Pending has to be in: two people submitting the same unreviewed
   place is precisely the case the live table already produced. Rejected stays
   out because a rejection was a call about THAT row, and quietly folding a
   fresh submission into it would both swallow the new contribution and
   re-litigate a decision already made.

   OLDEST WINS. Ordering by created_at makes the first person to put the pin
   there the canonical one, which is stable: a later submission can never
   displace a pin that people have already captured against. */
async function findDuplicate(
  supabase: any,
  sub: { id: string; name: string; category: string; lat: number; lng: number },
): Promise<{ row: any; meters: number } | null> {
  if (typeof sub.lat !== "number" || typeof sub.lng !== "number") return null;

  // Bounding box first so this stays one indexed query, not a table scan.
  // Widened to the larger of the two radii; exact distance is checked below.
  const dLat = DUP_SAME_CAT_M / 111320;
  const dLng = DUP_SAME_CAT_M /
               (111320 * Math.max(0.15, Math.cos(sub.lat * Math.PI / 180)));

  const { data, error } = await supabase
    .from("submissions")
    .select("id,name,name_clean,category,lat,lng,status,submitted_by,merged_into,created_at")
    .in("status", ["approved", "pending"])
    .neq("id", sub.id)
    .gte("lat", sub.lat - dLat).lte("lat", sub.lat + dLat)
    .gte("lng", sub.lng - dLng).lte("lng", sub.lng + dLng)
    .order("created_at", { ascending: true });

  if (error || !data) return null;

  const myNorm   = dupNormName(sub.name);
  const myTokens = dupTokens(sub.name);

  for (const c of data) {
    if (c.merged_into) continue;            // never chain a merge into a merge
    if (typeof c.lat !== "number" || typeof c.lng !== "number") continue;

    /* MATCH THE DISPLAYED NAME, NOT THE RAW ONE. #12's copy editor writes
       name_clean, and that is what the map and the dashboard show. Matching
       raw-against-raw would miss pairs a human would call identical. The
       incoming row has no clean value yet by design: dedup runs BEFORE the gate. */
    const cName = c.name_clean || c.name;
    const meters = dupMeters(sub.lat, sub.lng, c.lat, c.lng);

    const nameHit = dupNormName(cName) === myNorm ||
                    dupTokenRatio(myTokens, dupTokens(cName)) >= DUP_TOKEN_RATIO;
    if (!nameHit) continue;

    // #114 HOLE: dedup runs BEFORE the gate classifies, so a USER submission has
    // category=null here and `c.category === sub.category` is always false —
    // collapsing every user submission onto the 25 m cross-cat path and never the
    // 75 m same-cat one. Treat a null incoming category as a wildcard: a strong
    // name hit within 75 m is the same place whatever bucket it lands in.
    if ((sub.category == null || c.category === sub.category) && meters <= DUP_SAME_CAT_M) return { row: c, meters };
    if (meters <= DUP_CROSS_CAT_M) return { row: c, meters };
  }
  return null;
}

/* #228 — semantic same-place fallback. Runs ONLY after findDuplicate returns
   null. Returns the canonical it should merge into, or null to fall through to
   the gate. Same-category only (a reworded-and-moved dup is the same place, so
   the same bucket; cross-category collisions are #80's problem, not a merge).
   Conservative everywhere: any error, any low confidence, any off-schema answer
   -> null -> the pin is created and can be folded by hand later (#74). */
async function findSemanticDuplicate(
  supabase: any,
  sub: { id: string; name: string; description?: string | null; category: string; lat: number; lng: number },
): Promise<{ row: any; meters: number; confidence: number } | null> {
  if (typeof sub.lat !== "number" || typeof sub.lng !== "number") return null;
  // #114 HOLE: a user submission has category=null at dedup time (gate not run
  // yet). The old guard `|| !sub.category` returned here immediately, so #228
  // NEVER fired for a single user submission — the exact reworded/typo dupes it
  // exists to catch. Only `!sub.name` is a real disqualifier now.
  if (!sub.name) return null;

  // Widened box: DUP_SEMANTIC_M so a pin that drifted past the 75 m matcher is
  // still a candidate. Same-category only, one indexed query.
  const dLat = DUP_SEMANTIC_M / 111320;
  const dLng = DUP_SEMANTIC_M /
               (111320 * Math.max(0.15, Math.cos(sub.lat * Math.PI / 180)));

  const { data, error } = await (() => {
    let q = supabase
      .from("submissions")
      .select("id,name,name_clean,description,description_clean,category,lat,lng,status,submitted_by,merged_into,created_at")
      .in("status", ["approved", "pending"])
      .neq("id", sub.id)
      .gte("lat", sub.lat - dLat).lte("lat", sub.lat + dLat)
      .gte("lng", sub.lng - dLng).lte("lng", sub.lng + dLng);
    // Filter by category ONLY when we have one (seed-vs-seed at seed time). For a
    // category-less user submission, scan every bucket in the box and let the
    // model be the same-place judge — its verdict, not the bucket, is the gate.
    if (sub.category) q = q.eq("category", sub.category);
    return q.order("created_at", { ascending: true }); // oldest first -> oldest-wins bias
  })();
  if (error || !data || !data.length) return null;

  // Exact-distance filter + drop merged rows, keep the created_at order.
  const cands = [];
  for (const c of data) {
    if (c.merged_into) continue;
    if (typeof c.lat !== "number" || typeof c.lng !== "number") continue;
    const meters = dupMeters(sub.lat, sub.lng, c.lat, c.lng);
    if (meters > DUP_SEMANTIC_M) continue;
    cands.push({ ...c, meters });
  }
  if (!cands.length) return null; // no candidate -> no Gemini call, common path

  // Nearest N, but keep them presented oldest-first so the model's pick lands on
  // the earliest same-place row when more than one is genuinely the same place.
  const byDist = [...cands].sort((a, b) => a.meters - b.meters).slice(0, DUP_SEMANTIC_MAX_CANDS);
  const shortlist = byDist.sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const line = (name: string, desc: string) =>
    `${name}${desc ? ` — ${desc}` : ""}`.slice(0, 240);
  const candText = shortlist.map((c, i) =>
    `${i}: ${line(c.name_clean || c.name, c.description_clean || c.description || "")} (~${Math.round(c.meters)} m away)`
  ).join("\n");

  const prompt =
`You are deduplicating a local-places database. Decide whether a NEW submission is the SAME REAL-WORLD PLACE as one of the existing nearby entries.

NEW: ${line(sub.name, sub.description || "")}

EXISTING (same category, within ${DUP_SEMANTIC_M} m):
${candText}

"Same place" means the SAME physical establishment or landmark — the same restaurant, the same monument — even if the name is worded differently or the pin sits a little apart. It does NOT mean merely similar, same category, same chain at a different location, or two different businesses near each other. When unsure, answer false.

Reply with ONLY this JSON: {"same":true|false,"match":<index of the same existing entry, or null>,"confidence":<0 to 1>}`;

  try {
    let g: Response | null = null;
    let raw = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      g = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")!,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, responseMimeType: "application/json" },
          }),
        },
      );
      raw = await g.text();
      if (g.ok || !RETRY_STATUSES.has(g.status) || attempt === 2) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
    if (!g!.ok) return null; // http error -> fall through to the gate, never merge on a guess

    const parsedData = JSON.parse(raw);
    const parts = parsedData?.candidates?.[0]?.content?.parts ?? [];
    let text = parts.filter((p: any) => typeof p.text === "string" && !p.thought)
                    .map((p: any) => p.text).join("").trim();
    if (!text) text = parts.map((p: any) => p.text ?? "").join("").trim();
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    const jsonStr = (s >= 0 && e >= 0) ? text.slice(s, e + 1) : text;

    const parsed = JSON.parse(jsonStr);
    const conf = Number(parsed.confidence);
    const idx = Number(parsed.match);
    if (parsed.same !== true) return null;
    if (!Number.isFinite(conf) || conf < DUP_SEMANTIC_CONF) return null;
    if (!Number.isInteger(idx) || idx < 0 || idx >= shortlist.length) return null;

    const row = shortlist[idx];
    return { row, meters: row.meters, confidence: conf };
  } catch (_e) {
    return null; // parse/network failure -> fall through to the gate
  }
}

/* The count, for logs and app-report only. NEVER STORED — a counter column on
   submissions would be a second thing account deletion has to remember to
   decrement (#82/#124). A count that is a query cannot drift from the rows it
   counts. +1 for whoever put the pin there in the first place. */
async function secondsCount(supabase: any, submissionId: string): Promise<number> {
  const { count } = await supabase
    .from("gem_seconds")
    .select("id", { count: "exact", head: true })
    .eq("submission_id", submissionId);
  return (typeof count === "number" ? count : 0) + 1;
}

/* =========================================================================
   #344 — STORY-GATED VISIBILITY: the GEM writer.
   =========================================================================
   Resolve a gem's sourced "what it is" ONCE, here at the AI gate, and PERSIST
   it on the row (resolved_description / resolved_source) so the map's
   visibility gate becomes a cheap column read with NO live lookup — the whole
   point of #344 (a read-time resolve gives pop-in/pop-out flicker; a stored
   line does not).

   The resolver is NOT duplicated here. It lives in nearby-places
   (resolveWikiByName + the #320 AI-recall + #328 writeup-generation cascade);
   we call its `resolveWiki` action so the description logic keeps ONE home
   (the one-fact-one-home rule — the project's oldest wound).

   resolved_source is the FALSE-HIDE DEFENSE (the risk we talked through):
     a real line   -> resolved_source = place.source ('wiki'|'wikidata'|'gen'|…)
     nothing found -> resolved_source = 'none'   (checked, no story -> HIDE)
     call FAILED   -> leave BOTH null             (unchecked -> the #319 sweep
                      retries later). A transient network error must NEVER be
                      recorded as 'none', or a good gem is hidden forever
                      (blank-beats-wrong, #101/#178).

   Runs in the BACKGROUND (EdgeRuntime.waitUntil) so the submitter never waits
   on it (#344 sub-decision 2: the gate/batch pays the resolve, no user does).
   The gem is pending until an operator approves it, so the line has ample time
   to land. Only fired for approve/review gems — a rejected gem never shows, so
   resolving it would waste a lookup.

   NOTE the deliberate open decision this WRITER does not make: whether a
   source='gen' line (a #328 writeup-grounded AI line, e.g. the lore gems with
   no encyclopedia article) counts as "has a story" for the GATE is decided in
   the gate brick, not here. This writer records the source FAITHFULLY so
   either gate policy — gen-shows or sourced-only — is possible without a
   re-resolve.
   ========================================================================= */
async function resolveAndStoreDescription(
  supabase: any,
  sub: { id: string; name: string; description?: string | null; lat: number; lng: number },
): Promise<void> {
  if (typeof sub.lat !== "number" || typeof sub.lng !== "number") return;
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) return;

  let place: any = null; // reached only on a SUCCESSFUL call: object or null
  try {
    const resp = await fetch(`${base}/functions/v1/nearby-places`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // nearby-places verifies JWT (it is NOT deployed --no-verify-jwt, #13),
        // so a bearer is required; the service-role key is a valid JWT and is
        // already in this function's env — no new secret.
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify({
        action: "resolveWiki",
        name: sub.name,
        lat: sub.lat,
        lng: sub.lng,
        // the submitter's writeup is a SEARCH HINT (#318), never shown text —
        // it lets a descriptively-named gem ("Site of the Great Chicago Fire")
        // find its article, and if none exists it feeds the #328 gen rung.
        hint: sub.description || undefined,
      }),
    });
    if (!resp.ok) return;                       // HTTP error -> unchecked, leave null
    const data = await resp.json().catch(() => null);
    if (!data || !("place" in data)) return;    // malformed -> unchecked
    place = data.place;                          // {desc, source, …} or null
  } catch (_e) {
    return;                                      // network error -> unchecked, leave null
  }

  const patch = (place && typeof place.desc === "string" && place.desc.trim())
    ? { resolved_description: place.desc, resolved_source: String(place.source || "wiki") }
    : { resolved_description: null, resolved_source: "none" };

  await supabase.from("submissions").update(patch).eq("id", sub.id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // --- #3(a) helper: list models the production key can actually see --------
  if (req.method === "GET" && new URL(req.url).searchParams.has("models")) {
    try {
      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models",
        { headers: { "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")! } },
      );
      const body = await r.json();
      const names = (body?.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => String(m.name).replace(/^models\//, ""));
      return json(
        {
          pinned: MODEL,
          pinned_visible: names.includes(MODEL),
          model_source: MODEL_SOURCE,
          available: names,
        },
        r.status,
      );
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  try {
    const { id } = await req.json();
    if (!id) return json({ error: "missing id" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // #31: lat/lng/submitted_by added for the duplicate check below.
    const { data: sub, error: readErr } = await supabase
      .from("submissions")
      .select("id,name,description,category,lat,lng,submitted_by")
      .eq("id", id)
      .single();
    if (readErr || !sub) return json({ error: "submission not found" }, 404);

    /* =================================================================
       #31 — DUPLICATE CHECK RUNS BEFORE THE GATE, AND THE ORDER IS THE
       DESIGN, not an optimisation. A duplicate must not lose its vouch to
       an unrelated gate verdict, and a merge costs zero Gemini calls. A
       merged submission reports back EXACTLY like any other and carries a
       REAL status (its canonical's), with `merged_into` the sole marker;
       every map read filters `merged_into IS NULL`. The gate did not run,
       so no ai_decision/ai_status/ai_model/category is written for a
       merged row — a merged row is filtered off the map, so its (now
       absent) category is never rendered and cannot hit the #68 trap.
       ================================================================= */
    // #31 deterministic matcher first (string + proximity, zero Gemini calls).
    // #228: only when it misses, try the semantic same-place fallback — it fires
    // just one strict "same place?" call, and only when a near-miss candidate
    // exists, so the common path stays call-free.
    let dup:
      | { row: any; meters: number; via?: "semantic"; confidence?: number }
      | null = await findDuplicate(supabase, sub);
    if (!dup) {
      const sem = await findSemanticDuplicate(supabase, sub);
      if (sem) dup = { row: sem.row, meters: sem.meters, via: "semantic", confidence: sem.confidence };
    }
    if (dup) {
      const canonical = dup.row;

      /* Record the vouch. Skipped when there is no submitter to credit
         (submitted_by nullable since #82/#124) or on a self-second (one
         person submitting their own place twice is not a signal). */
      if (sub.submitted_by && sub.submitted_by !== canonical.submitted_by) {
        await supabase.from("gem_seconds").upsert(
          {
            submission_id: canonical.id,
            user_id: sub.submitted_by,
            source_submission_id: sub.id,
          },
          { onConflict: "submission_id,user_id", ignoreDuplicates: true },
        );
      }

      /* CREDIT PROMOTION (2026-08-13) — a user submission that folds into an
         UNCREDITED canonical (a seed: source seed:reddit, submitted_by NULL)
         promotes that pin to a human-credited gem by stamping the merging
         submitter onto the canonical. The positioning bet (#35) is that every
         recommendation traces to a real person; a seed a real person just
         re-found should read "Submitted by X", not stay creditless.
           - Only when the canonical has NO credit yet — the FIRST human to find
             a seed gets the credit; later duplicates are vouches (the gem_seconds
             upsert above), never overwrites.
           - `.is("submitted_by", null)` is the guard AND the race-safety: two
             concurrent merges → only the first stamps, the second no-ops.
           - Credit still resolves through submitted_by at read time
             (loadApprovedGems -> fetchGemCredits), so NO client change is needed
             and #82's anonymisation still removes it by nulling the column.
           - A canonical that is already a user gem (submitted_by set) is left
             untouched; a submitter with no id (nullable since #82/#124) can't
             promote anything. This is the credit sibling of #139 (a merged dup
             carrying better DATA than its canonical, surfaced) — here the better
             datum is the human behind it. */
      if (sub.submitted_by && !canonical.submitted_by) {
        await supabase
          .from("submissions")
          .update({ submitted_by: sub.submitted_by })
          .eq("id", canonical.id)
          .is("submitted_by", null);
      }

      const mirrored = canonical.status === "approved" ? "approved" : "pending";

      const { error: mErr } = await supabase
        .from("submissions")
        .update({
          status: mirrored,
          merged_into: canonical.id,
          ai_reviewed_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (mErr) return json({ error: mErr.message }, 500);

      return json({
        decision: mirrored === "approved" ? "approve" : "review",
        reason: dup.via === "semantic"
          ? "merged into an existing pin (semantic same-place match, gate not run)"
          : "merged into an existing pin (gate not run)",
        status: mirrored,
        duplicate: true,
        merged_into: canonical.id,
        meters: Math.round(dup.meters),
        // #228: how the match was made, so QA and the dashboard can tell a
        // deterministic fold from a semantic one, and at what confidence.
        match_via: dup.via ?? "deterministic",
        match_confidence: dup.confidence ?? null,
        recommended_by_count: await secondsCount(supabase, canonical.id),
        gate_skipped: true,
      });
    }

    // #114: the gate now also CLASSIFIES. `category` is an ordered list, most
    // confident first (#80); the FIRST valid bucket is stored. The user's own
    // category is NO LONGER fed in — the model decides. See VALID_CATEGORIES.
    const prompt =
`You review submissions for "Localy", a local-discovery app where people submit real places worth visiting (a park, shop, restaurant, historic spot, public art, or hidden gem). You do three jobs: decide whether this one should be published, choose which category it belongs in, and lightly copy-edit the text.

Reply with ONLY a JSON object:
{"decision":"approve"|"reject"|"review","category":["<best>","<next>"],"reason":"<one short sentence>","confidence":<number 0 to 1>,"name_clean":"<cleaned name>","description_clean":"<cleaned description>"}.

The description is OPTIONAL and may be blank. A submission with no description is normal — judge it on its name and location. A missing or short description is NEVER on its own a reason to reject or to send to review.

DECISION:
- "approve": a plausible, specific, real-sounding place. A coherent, on-topic description supports approval but is NOT required — approve a clearly real place even when it was submitted with just a name.
- "reject": spam, ads, gibberish, offensive or hateful content, clearly fake, not a place at all, or personal/private info. An empty description is none of these and is not a reason to reject.
- "review": anything uncertain, borderline, or hard to verify — send it to a human. Do NOT send a plausible, real-sounding place to review only because it has no description.

CATEGORY: choose the best-fitting bucket(s) for this place, MOST CONFIDENT FIRST, from EXACTLY these five values:
- "park": a park, garden, trail, or outdoor/natural space.
- "shops": a store or retail place.
- "barsrest": a bar, restaurant, cafe, or place to eat or drink.
- "history": a place notable for its past — a landmark, monument, memorial, or notable old structure — OR an ordinary place made interesting by an event, person, film, or legend attached to it (History and Lore are one category).
- "art": public visual art that is itself the thing to see — a mural, sculpture, statue, or installation.
Return an ORDERED list, most confident first; the first value is used. The hard call is history vs. art: choose "art" when the object is primarily a work of visual art, and "history" when it is a monument, memorial, or landmark valued for what it commemorates or its significance. Use only the five values above.

COPY-EDIT (name_clean, description_clean): mechanics ONLY.
- Allowed: fix capitalization (proper case for the name, sentence case for the description), fix obvious spelling and typos, normalize punctuation and spacing.
- FORBIDDEN: do NOT reword, rephrase, summarize, expand, translate, reorder clauses, or add or remove any information. Keep the user's exact wording and sentence structure.
- If it is already clean, return it unchanged. If unsure whether an edit is purely mechanical, leave it as-is.
- If you believe a factual claim is wrong, do NOT change it — that is a "review" decision, not an edit.

Name: ${sub.name}
Description: ${sub.description ?? ""}`;

    // Fail-open default. Every path below that does NOT set aiStatus = "ok"
    // lands here, and #3(c) is exactly about being able to tell those apart.
    let decision = "review";
    let reason = "defaulted to human review";
    let confidence: number | null = null;
    let aiStatus: AiStatus = "network_error";
    let httpStatus: number | null = null;
    let attempts = 0;

    // #12: copy-edit output. Stays null unless the gate call parsed cleanly AND
    // the guard accepts the value as mechanics-only. null = raw text stands.
    let nameClean: string | null = null;
    let descClean: string | null = null;
    let nameCleanWhy = "not_run";
    let descCleanWhy = "not_run";

    // #114: the AI-chosen bucket. Stays null on any fail-open path; the
    // approve_submission backstop then refuses to publish an unclassified row.
    let category: string | null = null;

    try {
      let g: Response | null = null;
      let raw = "";

      for (let attempt = 1; attempt <= 2; attempt++) {
        attempts = attempt;
        g = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")!,
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0, responseMimeType: "application/json" },
            }),
          },
        );
        raw = await g.text();
        if (g.ok || !RETRY_STATUSES.has(g.status) || attempt === 2) break;
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }

      httpStatus = g!.status;

      if (!g!.ok) {
        aiStatus = "http_error";
        reason = `gemini ${g!.status} (model ${MODEL}): ${raw.slice(0, 200)}`;
      } else {
        const data = JSON.parse(raw);
        const parts = data?.candidates?.[0]?.content?.parts ?? [];
        // Prefer non-"thought" text parts; fall back to any text.
        let text = parts.filter((p: any) => typeof p.text === "string" && !p.thought)
                        .map((p: any) => p.text).join("").trim();
        if (!text) text = parts.map((p: any) => p.text ?? "").join("").trim();
        // Strip markdown fences and isolate the JSON object.
        text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        const jsonStr = (start >= 0 && end >= 0) ? text.slice(start, end + 1) : text;
        try {
          const parsed = JSON.parse(jsonStr);
          const parsedReason = String(parsed.reason ?? "").trim().slice(0, 300);
          const conf = Number(parsed.confidence);
          if (["approve", "reject", "review"].includes(parsed.decision)) {
            aiStatus = "ok";
            decision = parsed.decision;
            // Never let a model that answered without a reason overwrite the
            // default with an empty string — a blank ai_reason reads in the
            // queue as "nobody looked at this".
            reason = parsedReason || `no reason given (decision: ${decision})`;

            // #114: category is an ORDERED list (#80); take the first value that
            // is a valid display bucket. Tolerates a bare string too. Stays null
            // if nothing usable is returned -> approve_submission backstop (#68).
            const catList = Array.isArray(parsed.category)
              ? parsed.category
              : (typeof parsed.category === "string" ? [parsed.category] : []);
            for (const c of catList) {
              if (typeof c === "string" && VALID_CATEGORIES.has(c)) { category = c; break; }
            }

            // #12: copy-edit runs only here — a coherent, on-schema answer is
            // the only place a clean value can be trusted. The guard, not this
            // branch, decides whether each value is kept; overreach -> null ->
            // raw stands. This never changes `decision`, `status` or `category`.
            const nc = safeClean(sub.name, parsed.name_clean, NAME_CLEAN_CAP);
            const dc = safeClean(sub.description, parsed.description_clean, DESC_CLEAN_CAP);
            nameClean = nc.value; nameCleanWhy = nc.why;
            descClean = dc.value; descCleanWhy = dc.why;
          } else {
            // Parsed, but `decision` was junk. Distinct from a parse failure:
            // the model was reachable and coherent, it just answered off-schema.
            aiStatus = "bad_decision";
            reason = `off-schema decision ${JSON.stringify(parsed.decision)}` +
                     (parsedReason ? ` — model said: ${parsedReason}` : "");
          }
          confidence = Number.isFinite(conf) ? conf : null;
        } catch (_p) {
          aiStatus = "parse_error";
          reason = `unparseable model output: ${text.slice(0, 200)}`;
        }
      }
    } catch (e) {
      // No HTTP status was ever obtained — DNS, TLS, timeout, missing key.
      aiStatus = "network_error";
      reason = `review error: ${String(e).slice(0, 250)}`;
    }

    const status = decision === "approve" ? "approved"
                 : decision === "reject" ? "rejected" : "pending";

    const { error: upErr } = await supabase
      .from("submissions")
      .update({
        status,
        ai_decision: decision,
        ai_reason: reason,
        // #3(c): these are what make the pending queue readable.
        ai_status: aiStatus,
        ai_http_status: httpStatus,
        ai_model: MODEL,
        // #70(B1): "secret" or "fallback".
        ai_model_source: MODEL_SOURCE,
        ai_confidence: confidence,
        ai_reviewed_at: new Date().toISOString(),
        // #114: the AI-chosen bucket is authoritative over the (now-removed)
        // #gem-category dropdown. Falls back to whatever the row already had if
        // the gate produced no valid category (fail-open): pre-dropdown-removal
        // that is the submitter's pick; after removal it is null, and the
        // approve_submission backstop (#68) holds an unclassified row out of
        // 'approved' until an operator sets one.
        category: category ?? sub.category,
        // #12: cleaned text lives in its OWN columns — the raw user words are
        // never touched here, so the original is always recoverable. null means
        // the guard declined the model's clean value and the raw text stands.
        name_clean: nameClean,
        description_clean: descClean,
      })
      .eq("id", id);
    if (upErr) return json({ error: upErr.message }, 500);

    // #344 — resolve + persist this gem's sourced description at the gate, for
    // any gem that can reach the map (approve/review; a rejected gem never
    // shows). Scheduled in the BACKGROUND so the response returns at its
    // current speed and the submitter never waits on the resolve.
    if (decision === "approve" || decision === "review") {
      const task = resolveAndStoreDescription(supabase, {
        id, name: sub.name, description: sub.description, lat: sub.lat, lng: sub.lng,
      });
      const ER = (globalThis as any).EdgeRuntime;
      if (ER && typeof ER.waitUntil === "function") ER.waitUntil(task);
      else await task; // no background runtime -> accept the added latency inline
    }

    return json({
      decision, reason, confidence, status,
      // #114: expose the stored bucket so QA can see what the gate chose.
      category: category ?? sub.category ?? null,
      ai_status: aiStatus, http_status: httpStatus,
      model: MODEL, model_source: MODEL_SOURCE, attempts,
      // #12: whether each cleaned value was applied, and the guard's verdict.
      clean: {
        name: { applied: nameClean !== null, why: nameCleanWhy },
        description: { applied: descClean !== null, why: descCleanWhy },
      },
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}