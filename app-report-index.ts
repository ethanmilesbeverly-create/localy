// =============================================================================
// app-report — read-only, token-guarded dashboard endpoint for Localy.
//
// PURPOSE. One GET returns a single JSON digest of the whole app's state so
// that Claude (or any client) can act as the dashboard on demand: submission
// volume + quality, AI-gate health, area coverage, description/story-gate
// coverage, engagement, shared content and account counts. It NEVER writes and
// NEVER returns PII.
//
// DEPLOY. supabase functions deploy app-report --no-verify-jwt
//   --no-verify-jwt is REQUIRED: a plain fetch (Claude's web_fetch, curl) has
//   no Supabase auth JWT to present. The REPORT_TOKEN secret is the guard
//   instead. Without --no-verify-jwt every request 401s at the gateway before
//   this code runs, and the token check below never gets a chance.
//
// CONFIG THAT LIVES OUTSIDE THIS FILE (call-out for the one-fact-two-target
// reflex — there are exactly two, both in the Supabase dashboard):
//   1. REPORT_TOKEN  — a secret you set (Project → Edge Functions → Secrets, or
//      `supabase secrets set REPORT_TOKEN=...`). This is the ONLY guard on the
//      endpoint; treat it like a password and rotate it if it ever leaks.
//   2. --no-verify-jwt on the deploy command (above). Not a file value, but a
//      deploy-time flag, and forgetting it looks exactly like a bad token.
//   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the
//   platform — do NOT set them by hand. GEMINI_MODEL is a project-wide secret
//   already set for review-submission; this function only READS it, to let you
//   cross-check the configured model against what actually ran (item 70).
//
// PRIVACY (item 5). Nothing here exposes a person. `submitted_by` is never
// selected. `user_state.value` and `shared_kv.value` — the blobs that hold
// passports, capture anchors and cached tiles — are never read; only keys,
// user ids (counted, never emitted) and timestamps are. Submission lat/lng ARE
// included, but those are the PUBLIC pin coordinate of a place, not a user's
// position, and coverage is reported only as grid-aggregated counts.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// Bump this string on every deployed change so QA step 1 can confirm the build.
// v1 -> v2 (2026-08-04): #138 merged-duplicate accounting + #144 no-store.
// v2 -> v3 (2026-08-07): #71 gate fail-open sensor -> ai_gate.fail_open.
// v3 -> v4 (2026-08-12): #266 pin_audit — read-only duplicate self-audit
//   (same-name clusters + pairwise distance) surfaced in the digest. PROPOSES,
//   never disposes: no write, no merge, no delete. The Photon re-geocode arm
//   and the #269 water arm are the deliberate SECOND cut (a scheduled job into
//   a pin_audit table), NOT built here — see the auditDuplicates note below.
// v4 -> v5 (2026-08-12): #266 near-dup arm. pin_audit is now { exact_name, near_name }.
//   near_name catches REWORDED same-metro dups (token-Jaccard, PROXIMITY-gated,
//   in-data, no Photon) that exact_name's identical-string match slides past.
//   Still PROPOSES only. The far+reworded case (geocode error AND reworded) and
//   the full semantic "same place?" judgement remain #228's Gemini pass.
// v5 -> v6 (2026-08-18): #278 near_name tightener. Two changes, both PROPOSE-only
//   (no write/merge/delete unchanged): (1) a generic-type-word stoplist
//   (park/pier/museum/…) folded into nameTokens so a name scores on its
//   DISTINCTIVE words only, dissolving the type-word chains that were 100% of the
//   live false positives (Race St Pier / Cherry St Pier; Frye/Seattle Art/Seattle
//   Pinball Museum both fall below the jaccard floor once the shared type word is
//   dropped); (2) a per-cluster `same_category` flag, surfaced and used in the
//   sort — containment 1.0 is only the real merge signal WITH same_category
//   (Buffalo Bayou Park Cistern ⊂ Buffalo Bayou Park is containment 1.0 but a
//   different-category sub-attraction, not a merge), so containment-1-AND-
//   same-category ranks to the very top and different-category containment sinks.
// v6 -> v7 (2026-08-18): #278 regression fix. v6's generic-type-word drop had a
//   >0 floor, which collapsed a two-word "<name> <type>" pair to a SINGLE
//   distinctive token; two different places sharing it then matched at jaccard 1.0
//   ("Penn Park" vs "Penn Museum" -> both {penn}; "Audubon Park" -> {audubon}
//   chained Aquarium/Insectarium/Zoo). v6 dissolved the pier/museum false
//   positives but introduced these. FIX: only drop a type word when >=2
//   distinctive tokens survive (see nameTokens), so a one-distinctive-token name
//   keeps its type word and stops colliding, while >=2-token names still shed it
//   and still dissolve. PROPOSE-only unchanged.
// v7 -> v8 (2026-08-31): cache-buster echo (extends #144). During a session the
//   dashboard served a STALE body — identical generated_at across two fetches, a
//   changed query param didn't take — and only a manual SQL count confirmed that
//   a shipped retire (#312) had in fact landed. no-store (#144) was already here
//   and is KEPT: the replay is a downstream CDN / fetch tool ignoring the header,
//   not this function shipping stale JSON. NEW: request_echo { cache_buster,
//   saw_params } — append ?cb=<unique> and the response reflects it back (and
//   lists the non-token param keys the function actually received), so a replayed
//   cache is visible IN THE BODY at a glance rather than needing a DB cross-check.
//   This is deliberately NOT the #144-rejected server-side age/stale flag (the
//   function is never stale at generation — age is always 0 — so such a flag
//   could never fire on a downstream replay); reflecting the CLIENT's own nonce
//   is exactly what catches that failure mode. Echo strips `token` (never leaked).
// v8 -> v9 (2026-09-03): #106 reports arm. The user liveness sensor (the "this
//   isn't here any more" report -> crowd-suppress pipeline in nearby-places) was
//   fully built and deployed but INVISIBLE here — the `reports` table was read by
//   nothing in this digest, so "has anyone ever filed a report / is any pin being
//   crowd-hidden" could only be answered in the SQL editor. NEW top-level
//   `reports` block: totals, by_reason, by_status, windows, and a `suppression`
//   view (targets at/over threshold, one-away, per-reason). It reads the SAME
//   REPORT_SUPPRESS_THRESHOLD secret and MIRRORS the reason vocab, and surfaces
//   any reason the mirror doesn't know as `unknown_reasons` — so it is the #141
//   vocabulary CROSS-CHECK ("three copies, only two check each other"), not a
//   silent fourth copy. `reported_by` is counted for DISTINCT reporters and never
//   emitted (item 5). This is the instrument that lets #106 be verified and that
//   #302/#319 automation is gated on (you can't gate an auto-actor on an unseen
//   signal); it is observability, so it does not by itself move the % .
// v9 -> v10 (2026-09-03): token-nonce cache defeat. #317 gave a DETECTOR (a ?cb=
//   echo) but not a CURE — and worse, the fetch tool strips ?cb= before the request
//   leaves, so the detector itself was unreachable from that side; a same-day replay
//   could still be read as fresh (v8 body served against a live v9, the tell being
//   the version string, not generated_at). ROOT: the replay is in the fetch tool
//   DOWNSTREAM of this function, which normalises the URL to the `token` param alone
//   — so no header/param this function adds can reach it, EXCEPT the token value,
//   which survives. FIX: the token is validated as its `<secret>` PREFIX only (split
//   on the first `~`), so a caller may append `~<nonce>` to vary the token STRING —
//   and thus the fetch tool's cache key — every request, defeating the replay at the
//   one point that reaches it. The nonce is echoed as request_echo.token_nonce (the
//   surviving-param sibling of #317's cb echo). NOTHING outside the file changes:
//   REPORT_TOKEN is unchanged (still the secret; a bare token with no `~` works
//   verbatim), no new secret, deploy is the same dashboard Code-editor paste with
//   verify-JWT OFF. This is observability plumbing, so it does NOT move the %.
// v10 -> v11 (2026-09-03): computed triage. Every alarm the digest can raise already
//   existed as a FIELD (fail_open, unknown_reasons, suppression.targets_at_or_over,
//   fallback_rows, errors[], the pin_audit merge counts) but had to be HUNTED for
//   across ~300 lines, so a daily read could miss the one that mattered. NEW top-
//   level `alerts` block (rendered near the top via an early placeholder): an `ok`
//   flag, per-level counts, and a severity-sorted `items` list (critical/warn/info)
//   DERIVED from the already-assembled report — no new DB read, no write, no state,
//   isolated in its own try/catch so a bug can't blank the digest. It also reads two
//   config facts indirectly (fallback_rows => GEMINI_MODEL unset; threshold
//   crowd_source "fallback" => REPORT_SUPPRESS_THRESHOLD unset), so the report now
//   does the outside-the-file config watch. One tunable, `backlog_warn_h` (default
//   48). NOTHING outside the file changes; observability, so it does NOT move the %.
// v11 -> v12 (2026-09-15): the DESCRIPTIONS arm — story-gate observability, built so
//   the #344 brick-5 hide-gate is never a SILENT hide. NEW top-level `descriptions`
//   section, computed from the SAME submissions pull (one scan, one home — the #266
//   pin_audit pattern), scoped to APPROVED, non-merged pins (the human/seed layer the
//   gate governs): `by_resolved_source` distribution, `has_story`, and three watch
//   sets — `would_hide` (resolved_source='none' — the pins brick 5 WOULD hide, with
//   by_category/by_source + a sample so the documented-but-unmatched ones that need a
//   curated source #318 are visible), `unresolved_null` (resolved_source null — never
//   checked, stays VISIBLE but owes a #319 resolve), and `story_but_blank` (a real
//   resolved_source with an EMPTY resolved_description — the Disney/gen-blank class
//   that would render blank rather than hide, a silent inconsistency the none-gate
//   can't catch). THREE new alerts wire these into the v11 triage block: story_gate_
//   would_hide (info, escalates to warn past desc_hide_warn so a ballooning hidden
//   set trips the morning read), descriptions_unresolved (info), story_source_but_
//   blank (warn). One tunable, `desc_hide_warn` (default 250; today's none-set ~90).
//   Fetches two more submissions columns (resolved_source, resolved_description).
//   NOTHING outside the file changes; observability, so it does NOT move the %.
// v12 -> v13 (2026-09-17): the RESCUE-QUEUE reframe of the #344/#367 story-gate
//   observability. would_hide was a hide-COUNTER; it is now a rescue QUEUE. Every
//   approved pin the gate would drop (resolved_source='none') is a HUMAN-VOUCHED
//   place (a seed mined from a Reddit city thread #57, or a user gem) — NOT junk —
//   so the operating rule is rescue-before-hide: source a description (#318 Places/
//   curated rung) instead of blindly dropping a place people actually go to. Adds
//   to `would_hide`: `rescue_candidates` (all of them — the whole set is vouched)
//   and `rescue_queue` (the FULL list up to a cap, each with a `rescue` hint naming
//   the lever — Places/curated for a seed, a write-up nudge #328 for a user gem —
//   so the list is actionable by hand, not just countable). The alert is reworded
//   from "would hide N" to "N vouched places lack a story — rescue via #318 before
//   the gate hides them". SCOPE UNCHANGED — still the gem/seed layer only.
//   NOT HERE, by design: the OSM/tile-layer `would_remove` view and the POPULARITY
//   ranking. Both belong to #367's serve-path gate in nearby-places, not this file:
//   classifying a storyless OSM tile pin needs the gate's own filler test (re-
//   implementing it here is the #141 vocab-drift trap) and tile VALUES this report
//   never reads; and the only honest popularity signal (Google Places ratings) lives
//   on nearby-places (the #365 key), not here. #367 produces both and banks them; a
//   later app-report read surfaces them — the report-first discipline #361 set, now
//   applied inside the gate's own function.
// v13 -> v14 (2026-09-17): the OSM/TILE would_remove read (#370) — the deferred
//   "later app-report read" the v12->v13 note pointed at. #369 taught nearby-places
//   to BANK, per cold tile build, the storyless OSM pins the #367 universal story-
//   gate would remove (a `wouldremove:w1:<tile>` shared_kv row: total + by_category +
//   an items[] of {id,name,category,type,lat,lng}); nothing read it. NEW top-level
//   `osm_would_remove` section: app-report reads `wouldremove:w1:%` DIRECTLY from
//   shared_kv (a targeted .like() — never the whole tile cache) and AGGREGATES it —
//   dedupe items by id across overlapping tiles, total, by_category, tiles read,
//   freshness (oldest/newest banked ts, so a thin cold-build tally reads as "not yet
//   warmed" instead of "nothing to remove"), a bounded sample. This is the OSM analog
//   of the gem `would_hide` rescue queue, so the morning read now shows BOTH removal
//   backlogs — the human/seed layer (`descriptions.would_hide`) AND the OSM/tile layer
//   (`osm_would_remove`) — side by side. NEW alert `osm_story_gate_would_remove` (info,
//   escalates to warn past `osm_remove_warn`, default 500) mirrors story_gate_would_
//   hide. THE #141 LINE HELD: app-report only AGGREGATES rows nearby-places already
//   CLASSIFIED (descIsThin ran at bank time) — the filler classifier is NOT copied
//   here. THE POPULARITY SORT stays on nearby-places too: the daily read is pure DB
//   aggregation (zero Places calls), and only an explicit `?rank=N` on THIS function
//   forwards to nearby-places' `would_remove` action (its bounded, quota-capped Places
//   lookup, the #365 key) and folds the rating-sorted queue in under `popular` — a
//   bounded, on-demand warm, never per daily read. Isolated in its own try/catch like
//   every section. NOTHING outside the file changes (SUPABASE_URL/SERVICE_KEY are the
//   already-injected pair the forward reuses); observability, so it does NOT move the %.
//
// v14 -> v15 (#350): the `reports` suppression arm was still mirroring the RETIRED
//   bogus=1 model — after #347 the serve path (nearby-places/readSuppression) rose
//   bogus's HUMAN bar to CROWD_THRESHOLD (env REPORT_SUPPRESS_THRESHOLD, default 3,
//   like gone/chain) and made a confident AI `ai_verdict='remove'` on an AI-acting
//   reason (bogus) the fast path that hides a pin on ONE report. This arm still hard-
//   coded bogus at 1 and knew nothing about the AI override, so its at/over-threshold
//   and one-away counts for bogus MISREAD (a single bogus report read as "over" when
//   the serve path no longer hides on it, and an AI-removed pin — genuinely hidden —
//   was invisible here). Fixed: bogus now reads the crowd threshold (drop the =1
//   special case), the reports read SELECTs `ai_verdict`, and an AI 'remove' on an
//   AI-acting reason folds into the suppressed set exactly as readSuppression does —
//   surfaced as `targets_ai_removed` + a `targets_suppressed` union (the true serve-
//   hidden set) + a per-entry `via` (crowd / ai / crowd+ai) in the sample, with a new
//   `pins_ai_removed` alert. This is the #141 three-copy vocab cross-check applied to
//   the THRESHOLD + AI dimensions, not just the reason set. One deploy target (this
//   function), no index.html/APP_VERSION, no CACHE_VERSION/SQL/RLS/env — the ai_*
//   columns and the AI_ACT_REASONS set are #347's, already live.
// v15 -> v16 (#353): near_name grave-honorific tightener. The wikidata-grave seeds
//   are all "Grave of <person>", so the shared honorific token "grave" rode on top
//   of a shared first name OR surname and re-flagged ~11 DIFFERENT-people pairs as
//   dups every run (George vs Bushrod Washington, the three John Eliot/Harvard/
//   Winthrop, both Vanderbilts, Barrymore/Wanamaker, …) — #278's generic-type
//   failure mode, but on the grave honorific. Fixed in nameTokens: when a name
//   carries the grave/tomb honorific PREFIX, the honorific token is dropped (like a
//   stopword) so the person's first+surname are the distinctive tokens — the shared
//   pairs fall from jaccard 0.5 to 0.33 and drop off, while a genuine same-person
//   rewording across honorifics now matches at 1.0. PROPOSE-only (this arm never
//   writes/merges); one deploy target (this function), no index.html/APP_VERSION,
//   no CACHE_VERSION/SQL/RLS/env. The #278 global generic-type set is UNTOUCHED —
//   the honorific drop is scoped to the "Grave of"/"Tomb of" prefix so a non-grave
//   place named "The Tomb" keeps its distinctive token.
// v16 -> v17 (#115): the ai_reason CONSUMER. review-submission has always written
//   submissions.ai_reason on every review — a one-sentence moderation verdict,
//   <=300 chars, with an explicit guard so it can never be blank — and NO client
//   ever read it (loadMyGems selected it once for #62, then #62 was cut). It is the
//   fourth "a value one side maintains and no side consumes" instance the roadmap
//   named, and the reason the display was cut generalises: a verdict is written for
//   the OPERATOR, not the person it is about — so its correct consumer is exactly
//   THIS operator dashboard, not the app. NEW `submissions.ai_gate.reasons`: coverage
//   (reviewed / with_reason / blank_reviewed / coverage_rate), a present/blank split
//   by ai_decision (does a reject carry a rationale as reliably as an approve?), and
//   a `sample` of the actual recent verdict TEXT — the payload that makes the column
//   CONSUMED rather than counted. NEW alert `ai_reason_blank` (info) fires ONLY if a
//   reviewed row lacks its guaranteed reason (guard bypass / pre-field row). Reuses
//   the SAME submissions pull (one scan, one home — the #266/#344 pattern); fetches
//   ONE more column (ai_reason). PRIVACY (item 5) holds: no submitted_by — the verdict
//   is about the PLACE, and the sample carries only the public name. One deploy target
//   (this function), no index.html/APP_VERSION, no CACHE_VERSION/SQL/RLS/env.
//   Observability, so it does NOT move the %.
// v17 -> v18 (#115 QA fix): the v17 `reviewed`/`sample` keyed on ai_reviewed_at, but
//   that column is ALSO stamped by non-gate tooling (the #382/#383/#318 grave-dedup,
//   coord-fix and recheck passes), so the live v17 read over-counted reviewed (61 vs
//   the true 25), reported coverage_rate 0.41, fired a FALSE ai_reason_blank alert on
//   36 non-gate-stamped seed rows whose null reason is correct, and buried the real 25
//   verdicts out of the sample. Fixed: `reviewed`, the coverage split and the sample
//   all key on ai_status (written ONLY by the gate), so reviewed == the true gate set
//   (25), with_reason == 25, blank_reviewed == 0, coverage_rate == 1, the alert is
//   silent, and the sample now carries the actual verdict TEXT. Same deploy target and
//   privacy as v17; observability, so it does NOT move the %.
// v18 -> v19 (#140): the REJECTED-RESUBMIT signal. review-submission's #31 dedup
//   matcher deliberately EXCLUDES rejected rows (a rejection was a call about THAT
//   row; folding a fresh submission into it would swallow the contribution and
//   re-litigate the decision) — correct, but it left a real signal on the floor: a
//   place rejected once and then submitted again by users is evidence the rejection
//   may have been wrong, and nothing counted it. NEW top-level `rejected_resubmits`:
//   the SAME #31 matcher (name exact-or-token-overlap + the 75 m same/wildcard-
//   category / 25 m cross-category radii — MIRRORED here, see REJ_* below) run
//   against rejected rows, counting LATER user submissions of the same place. It
//   READS ONLY and WRITES NOTHING: the action on a flagged place is a HUMAN re-look,
//   never an automatic un-reject (letting N submissions overturn a moderation call is
//   the #132 gravestone). Per anchor: the rejected row, the AI's rejection verdict
//   (ai_reason, operator-only, #115), resubmit count, the later rows' statuses, and
//   whether one of them is already LIVE (approved) — so "rejected and people keep
//   trying and it's STILL not on the map" (the actionable case) is split from "a
//   later resubmission already got approved" (the rejection was effectively reversed
//   by the gate). NEW alert `rejected_place_resubmitted` (info) fires only on the
//   actionable case at/over `rr_min` resubmits (default 2). Reuses the SAME
//   submissions pull (one scan, one home); fetches no new column. PRIVACY (item 5):
//   it counts SUBMISSIONS, not people — submitted_by is still never selected, so one
//   person resubmitting three times reads the same as three people (acceptable for a
//   propose-only re-look prompt; stated in the section's `note`). One deploy target
//   (this function), no index.html/APP_VERSION, no CACHE_VERSION/SQL/RLS/env.
//   Observability, so it does NOT move the %.
// v19 -> v20 (#393): three alerts that asked for work that wasn't there. (a) near_name
//   ranked father/son and same-plot family grave pins as its STRONGEST merge signal
//   (a father's name is fully contained in his son's "…Jr."), and the live
//   near_dup_merges_waiting alert read "14 … ready to merge" when all 14 were
//   different people. A grave-vs-grave edge now carries a `people_split` reason when
//   the names differ by a generational token (jr/sr/ii/iii/iv/younger/elder) or by a
//   full given/middle name (an initial that abbreviates the other name's token does
//   not count — "John F Kennedy" / "John Fitzgerald Kennedy" stays a candidate), and
//   a grave pin vs a non-grave place (Grave of Andrew Jackson / Andrew Jackson's
//   Hermitage) is `grave_vs_place`. A cluster whose every edge is split is marked
//   `likely_different_people`, stays LISTED (recall visible), sorts below real
//   candidates and is left out of the alert, which now says "to review", not "ready
//   to merge" (handoff §5: dump the bios first, #382). (b) exact_name drops clusters
//   with fewer than two LIVE (approved/pending, unmerged) members — three rejected
//   "Test" rows are not a merge. (c) the suppression view only counts reports on a
//   LIVE target: an open report on a gem that is already rejected/retired/merged hides
//   nothing (the serve path never serves that row), so it moves to an info-level
//   `stale_open_reports` count instead of firing pins_suppressed/pins_ai_removed (the
//   #347 test gem 16c048a2 fired both warns while already rejected). OSM targets and
//   unknown uuids are unchanged. One deploy target (this function), no index.html/
//   APP_VERSION, no CACHE_VERSION/SQL/RLS/env. Observability, so it does NOT move the %.
// v20 -> v21: the osm_story_gate_would_remove warn bar re-based from 500 to 25000.
//   500 was set (#370) when the tally was 358 storyless pins across 12 banked tiles.
//   The #292 pre-warm (2026-09-23) cold-built ~917 tiles across all 21 launch metros,
//   and every cold build banks its tally (#369), so the count read 16,677 across 938
//   tiles the next morning. Nothing new was hidden: the tally now covers the whole
//   roster instead of only the tiles people had visited. At 500 the alert was
//   permanently yellow, which trains the morning read to ignore it. 25000 leaves
//   headroom for #57 Phase B (9 more metros, roughly +40%), so a warn now means a real
//   change: a much larger roster, or a regression that stops the by-name resolve from
//   rescuing pins. Still overridable per request with ?osm_remove_warn=N. Re-base
//   again when a roster expansion is pre-warmed. One deploy target (this function),
//   no index.html/APP_VERSION, no CACHE_VERSION/SQL/RLS/env. Observability, so it
//   does NOT move the %.
// v21 -> v22 (#141): the reports arm READS the rules instead of mirroring them.
//   Until now this block held its own SUPPRESSES and AI_ACTS maps and read the
//   REPORT_SUPPRESS_THRESHOLD secret itself — a copy that only unknown_reasons
//   could catch drifting. #141 made public.report_reason_meta the ONE server-side
//   home (nearby-places reads it too), so this block now reads that table
//   (reason, suppresses, threshold, ai_acts) and derives every threshold and
//   AI-act decision from it. A failed read fails the reports section into
//   `errors` — it never falls back to a built-in copy. `threshold` changes shape:
//   {source, by_reason, ai_act_reasons, secret_ignored} replaces {crowd,
//   crowd_source, bogus, ai_act_reasons}. The `suppress_threshold_unset` info
//   alert (which fired on every run) is retired; NEW warn
//   `report_threshold_secret_ignored` fires only if REPORT_SUPPRESS_THRESHOLD is
//   set, because nothing reads it any more. `unknown_reasons` now means "a
//   report row carries a reason the table doesn't define" — impossible while the
//   reports_reason_fkey foreign key stands, so non-empty = the key was dropped.
//   One deploy target (this function, --no-verify-jwt), after the #141 SQL. No
//   index.html/APP_VERSION, no CACHE_VERSION. Observability, so it does NOT move
//   the %.
const REPORT_VERSION = "app-report-v22";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-report-token",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      // #144: this digest is generated fresh per request (generated_at = now).
      // The "byte-identical minutes apart" staleness observed 2026-07-23 was an
      // intermediary / fetch-tool replaying an OLD body, not this function
      // shipping stale JSON. no-store forbids any CDN, proxy or fetch tool from
      // caching and replaying the digest, so generated_at can be trusted as the
      // single freshness signal. (A server-side age/stale flag was REJECTED: the
      // function is never stale at generation time — age is always 0 here — so a
      // flag computed in this file could never fire on the real failure mode.)
      // v8: the COMPANION detector is request_echo — a client `?cb=` nonce
      // reflected in the body — which DOES catch a downstream replay no-store
      // was ignored by. See the REPORT_VERSION history for why that's not the
      // rejected age flag.
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
    },
  });
}

// --- small helpers -----------------------------------------------------------
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function clampNum(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function inc(map: Record<string, number>, key: string, by = 1): void {
  const k = key === null || key === undefined ? "∅null" : String(key);
  map[k] = (map[k] || 0) + by;
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function avg(nums: number[]): number | null {
  const xs = nums.filter((n) => Number.isFinite(n));
  if (!xs.length) return null;
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000;
}

// Round a coordinate to the nearest grid step so nearby pins collapse into one
// cell. step 0.05deg ~= 5.5km; caller can widen/narrow via ?grid=.
function bucket(v: number, step: number): number {
  return Math.round(v / step) * step;
}

// Great-circle distance in kilometres. Used by the #266 pin_audit to report how
// far apart two same-name pins sit — the single number that tells a co-located
// duplicate (~0 km) from a geocode-misplaced duplicate (Montrose, 3.2 km) from a
// legitimate two-metro namesake (Attaboy NYC vs Nashville, 1219 km).
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// #266: conservative name normalisation for duplicate clustering. Lowercase,
// strip diacritics, drop anything that isn't a letter/number/space, collapse
// whitespace. Deliberately NOT aggressive (no stemming, no suffix stripping):
// the seed dedup already matched on name, so exact-normalised is the safe first
// cut — the semantic "same place?" judgement is #228's later Gemini pass, not
// this read-only digest. Returns "" for an unusable name (skipped by the caller).
function normName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Page through an entire table (small dataset app; this is deliberate — no RPC,
// no view, no migration, so nothing lives outside this file). Hard cap guards
// against a runaway if the table ever grows unexpectedly large.
async function fetchAll(
  supabase: any,
  table: string,
  columns: string,
  cap = 20000,
): Promise<any[]> {
  const page = 1000;
  let from = 0;
  const out: any[] = [];
  while (from < cap) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < page) break;
    from += page;
  }
  return out;
}

// Like fetchAll, but scoped to keys under a prefix and pulling `value` too. Used
// ONLY for the small `wouldremove:w1:%` namespace (~one row per storyless-OSM
// tile) — deliberately NOT the whole shared_kv table, because `places:%` (the
// 21-day tile cache) would drag megabytes of tile blobs. summariseSharedKv keeps
// its key-only scan for the tile-cache/guide/blocklist counts; this is a separate,
// bounded value-bearing read for the one namespace app-report needs to aggregate.
async function fetchByKeyPrefix(
  supabase: any,
  prefix: string,
  cap = 20000,
): Promise<any[]> {
  const page = 1000;
  let from = 0;
  const out: any[] = [];
  while (from < cap) {
    const { data, error } = await supabase
      .from("shared_kv")
      .select("key,value,updated_at")
      .like("key", prefix + "%")
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < page) break;
    from += page;
  }
  return out;
}

// --- summarisers -------------------------------------------------------------

function summariseSubmissions(rows: any[], now: number, step: number, sampleN: number) {
  const by_status: Record<string, number> = {};
  const by_ai_decision: Record<string, number> = {};
  const by_category: Record<string, number> = {};
  const by_source: Record<string, number> = {};
  const ai_by_status: Record<string, number> = {};
  const ai_by_model: Record<string, number> = {};
  const ai_by_model_source: Record<string, number> = {};
  const ai_http: Record<string, number> = {};
  const conf_all: number[] = [];
  const conf_by_decision: Record<string, number[]> = {};

  // #138: merged-duplicate accounting. A row with merged_into != null is a
  // duplicate that Item 31 folded into a canonical pin, giving it the
  // canonical's status. Tracked separately so it never inflates approvals and
  // never reads as zero duplicate volume.
  const dup_by_mirrored_status: Record<string, number> = {};
  let merged_total = 0;

  // #71: FAIL-OPEN sensor. Counts submissions where the gate RAN and errored
  // (ai_status present and not 'ok'), which defaults the row to 'pending'. This
  // is what "nothing notices when the gate fails open" was about — a model
  // retirement makes fail_open_pending climb while everything else looks like a
  // quiet week. Kept DISTINCT from never_reviewed (ai_status null = gate never
  // invoked) and from a healthy pending (ai_status 'ok' = model sent to a human).
  const fail_open_by_ai_status: Record<string, number> = {};
  let fail_open_total = 0;
  let fail_open_pending = 0;
  let oldest_fail_open_ms: number | null = null;

  // #115: ai_reason coverage + verdict text. review-submission writes ai_reason on
  // EVERY review (a one-sentence verdict, <=300 chars, guarded so it can never be
  // blank) and NO client has ever read it — the "value one side maintains and no
  // side consumes" shape this row is the fourth instance of. Its correct (and only)
  // consumer is THIS operator dashboard: a moderation verdict is written for the
  // operator, not the person it is about (which is exactly why the user-facing
  // display was cut by directive). Tallied here, sampled below.
  let reason_reviewed = 0; // rows the gate reviewed (ai_reviewed_at set)
  let reason_present = 0; // ...of those, with a non-empty ai_reason
  let reason_blank = 0; // ...with a blank/absent reason — should be ~0 (the writer guards it)
  const reason_present_by_decision: Record<string, number> = {};
  const reason_blank_by_decision: Record<string, number> = {};

  const windows = { last_24h: 0, last_7d: 0, last_30d: 0, all_time: rows.length };
  let cleaned_count = 0;
  let never_reviewed = 0;
  let oldest_pending_ms: number | null = null;
  let missing_coords = 0;

  const cells: Record<string, { count: number; approved: number; rejected: number; pending: number }> = {};

  for (const r of rows) {
    // #138: classify merged duplicates once, then keep them OUT of the
    // place-level tallies (by_category, coverage) and out of the real-status
    // buckets (they go to a "merged" bucket in by_status instead of "approved").
    // Volume/gate tallies (windows, by_ai_decision, ai_gate) still count them,
    // because a duplicate is a real arrival the gate really saw.
    const isMerged = r.merged_into !== null && r.merged_into !== undefined;
    if (isMerged) {
      merged_total++;
      inc(dup_by_mirrored_status, r.status); // the canonical's status it mirrored
    }

    inc(by_status, isMerged ? "merged" : r.status);
    inc(by_ai_decision, r.ai_decision);
    if (!isMerged) inc(by_category, r.category);
    inc(by_source, r.source);
    inc(ai_by_status, r.ai_status);
    inc(ai_by_model, r.ai_model);
    inc(ai_by_model_source, r.ai_model_source);
    if (r.ai_http_status !== null && r.ai_http_status !== undefined) inc(ai_http, String(r.ai_http_status));

    if (typeof r.ai_confidence === "number") {
      conf_all.push(r.ai_confidence);
      const d = r.ai_decision || "∅null";
      (conf_by_decision[d] = conf_by_decision[d] || []).push(r.ai_confidence);
    }

    if (r.name_clean !== null && r.name_clean !== undefined) cleaned_count++;
    if (!r.ai_reviewed_at) never_reviewed++;

    // #115: ai_reason coverage. "reviewed" = the AI GATE actually ran, which is
    // ai_status being set — NOT ai_reviewed_at. ai_reviewed_at is ALSO stamped by
    // non-gate tooling (the recheck / merge / coord-fix passes on the grave+seed
    // layer), so keying on it over-counts "reviewed" by rows the gate never saw and
    // makes the blank check misfire (v17 read 61 reviewed / 36 "blank", all 36 being
    // non-gate-stamped seed rows whose null reason is correct). ai_status is written
    // only by the gate, so it is the honest denominator; a reviewed row should always
    // carry a reason (the write guards a blank), so a blank one is the real anomaly.
    if (r.ai_status !== null && r.ai_status !== undefined) {
      reason_reviewed++;
      const dkey = r.ai_decision || "∅null";
      const hasReason = typeof r.ai_reason === "string" && r.ai_reason.trim() !== "";
      if (hasReason) {
        reason_present++;
        inc(reason_present_by_decision, dkey);
      } else {
        reason_blank++;
        inc(reason_blank_by_decision, dkey);
      }
    }

    const created = ms(r.created_at);
    if (created !== null) {
      if (now - created <= DAY) windows.last_24h++;
      if (now - created <= 7 * DAY) windows.last_7d++;
      if (now - created <= 30 * DAY) windows.last_30d++;
    }

    if (r.status === "pending" && !isMerged && created !== null) {
      if (oldest_pending_ms === null || created < oldest_pending_ms) oldest_pending_ms = created;
    }

    // #71: a fail-open is a NON-merged row the gate scored with a non-'ok'
    // ai_status. `total` counts every one ever seen; `pending` narrows to the
    // ones still stuck in the queue right now (the live "we find out during it"
    // number — an operator who later approves/rejects one clears it from pending
    // but the ai_status stays, since the gate never re-ran). ai_status null is
    // NOT counted here: that is `never_reviewed`, a different failure (the gate
    // was never invoked at all). Merged dupes are excluded — the gate is skipped
    // for them by design (#31), so they can never be a fail-open.
    const failedOpen = !isMerged &&
      r.ai_status !== null && r.ai_status !== undefined && r.ai_status !== "ok";
    if (failedOpen) {
      fail_open_total++;
      inc(fail_open_by_ai_status, r.ai_status);
      if (r.status === "pending" && created !== null) {
        fail_open_pending++;
        if (oldest_fail_open_ms === null || created < oldest_fail_open_ms) oldest_fail_open_ms = created;
      }
    }

    // #138: a merged duplicate sits at ~the same coord as its canonical, so
    // counting it in coverage double-counts the cell and inflates approved.
    if (!isMerged) {
      if (typeof r.lat === "number" && typeof r.lng === "number") {
        const key = `${bucket(r.lat, step).toFixed(3)},${bucket(r.lng, step).toFixed(3)}`;
        const c = (cells[key] = cells[key] || { count: 0, approved: 0, rejected: 0, pending: 0 });
        c.count++;
        if (r.status === "approved") c.approved++;
        else if (r.status === "rejected") c.rejected++;
        else if (r.status === "pending") c.pending++;
      } else {
        missing_coords++;
      }
    }
  }

  const conf_by_decision_avg: Record<string, number | null> = {};
  for (const k of Object.keys(conf_by_decision)) conf_by_decision_avg[k] = avg(conf_by_decision[k]);

  const coverage = Object.entries(cells)
    .map(([cell, v]) => {
      const [lat, lng] = cell.split(",").map(Number);
      const decided = v.approved + v.rejected;
      return {
        cell,
        center: { lat, lng },
        count: v.count,
        approved: v.approved,
        rejected: v.rejected,
        pending: v.pending,
        approve_rate: decided ? Math.round((v.approved / decided) * 100) / 100 : null,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);

  const recent = [...rows]
    .sort((a, b) => (ms(b.created_at) || 0) - (ms(a.created_at) || 0))
    .slice(0, sampleN)
    .map((r) => ({
      id: r.id,
      name: r.name_clean || r.name,
      category: r.category,
      status: r.status,
      source: r.source,
      merged_into: r.merged_into ?? null, // #138: non-null flags this row as a merged duplicate
      ai_decision: r.ai_decision,
      ai_status: r.ai_status,
      ai_confidence: r.ai_confidence,
      cell:
        typeof r.lat === "number" && typeof r.lng === "number"
          ? `${bucket(r.lat, step).toFixed(3)},${bucket(r.lng, step).toFixed(3)}`
          : null,
      created_at: r.created_at,
    }));

  // #115: the actual verdict TEXT for the most-recent GATE reviews (ai_status set —
  // the same honest signal the tally uses; filtering on ai_reviewed_at alone buries
  // the real verdicts under non-gate-stamped seed rows whose reason is legitimately
  // null). Newest review first; NO submitted_by / lat / lng (item 5) — name is the
  // public place name (already in recent_sample).
  const reason_sample = [...rows]
    .filter((r) => r.ai_status !== null && r.ai_status !== undefined)
    .sort((a, b) => (ms(b.ai_reviewed_at) || ms(b.created_at) || 0) - (ms(a.ai_reviewed_at) || ms(a.created_at) || 0))
    .slice(0, sampleN)
    .map((r) => ({
      id: r.id,
      name: r.name_clean || r.name,
      category: r.category,
      ai_decision: r.ai_decision,
      ai_status: r.ai_status,
      ai_reason: r.ai_reason ?? null,
      ai_reviewed_at: r.ai_reviewed_at,
    }));

  return {
    total: rows.length, // all arrivals (distinct places + merged duplicates)
    by_status, // #138: merged dupes are a "merged" bucket here, NOT "approved"
    by_ai_decision,
    by_category, // #138: place-level — excludes merged duplicates
    by_source,
    windows,
    duplicates: {
      // #138: the dedup health metric. merged_total is how many duplicate
      // submissions arrived and were folded (Item 31); it must never read 0 when
      // merges have happened. by_mirrored_status shows which canonical status
      // each dupe inherited. distinct_places = total minus the duplicates.
      merged_total,
      distinct_places: rows.length - merged_total,
      by_mirrored_status: dup_by_mirrored_status,
      merge_rate: rows.length ? Math.round((merged_total / rows.length) * 1000) / 1000 : 0,
    },
    backlog: {
      pending: by_status["pending"] || 0,
      oldest_pending_age_hours:
        oldest_pending_ms === null ? null : Math.round(((now - oldest_pending_ms) / HOUR) * 10) / 10,
      never_reviewed, // ai_reviewed_at is null — gate never ran / failed open
    },
    ai_gate: {
      by_ai_status: ai_by_status,
      by_model: ai_by_model,
      by_model_source: ai_by_model_source, // watch for "fallback" (item 70): GEMINI_MODEL unset
      fallback_rows: ai_by_model_source["fallback"] || 0,
      http_status_distribution: ai_http,
      avg_confidence: avg(conf_all),
      avg_confidence_by_decision: conf_by_decision_avg,
      cleaned_count, // rows where the copy-editor produced a name_clean (item 12)
      // #71: the fail-open sensor. `total` = every non-merged row the gate scored
      // with a non-'ok' ai_status (http_error / parse_error / bad_decision /
      // network_error). `pending` = how many of those are STILL stuck in the queue
      // right now — the live signal; a model retirement makes it climb while the
      // rest of the digest reads like a slow week. `oldest_pending_age_hours` is
      // how long the currently-stuck fail-opens have waited (climbs during an
      // outage). `by_ai_status` is the failure breakdown, and it excludes 'ok', so
      // an empty object here means the gate has not failed open. This does NOT
      // include never_reviewed (ai_status null) — that is `backlog.never_reviewed`,
      // a distinct failure (gate never invoked rather than invoked-and-errored).
      fail_open: {
        total: fail_open_total,
        pending: fail_open_pending,
        oldest_pending_age_hours:
          oldest_fail_open_ms === null ? null : Math.round(((now - oldest_fail_open_ms) / HOUR) * 10) / 10,
        by_ai_status: fail_open_by_ai_status,
      },
      // #115: ai_reason — the moderation-verdict text, previously write-only.
      // `reviewed` is the consumable universe: rows the AI GATE ran on, keyed on
      // ai_status (the gate-only signal) NOT ai_reviewed_at (which non-gate recheck/
      // merge/coord-fix tooling also stamps). The app is seed-dominated and seeds
      // skip the gate, so this is small and equals the true gate set. `with_reason`/
      // `blank_reviewed` are its coverage split; blank_reviewed should stay 0 (the
      // writer guards against an empty reason), so a nonzero is a guard bypass — the
      // `ai_reason_blank` alert fires on it. `*_by_decision` answers whether a reject
      // carries a rationale as reliably as an approve. `sample` is the actual recent
      // verdict TEXT (no submitted_by — item 5).
      reasons: {
        reviewed: reason_reviewed,
        with_reason: reason_present,
        blank_reviewed: reason_blank,
        coverage_rate: reason_reviewed ? Math.round((reason_present / reason_reviewed) * 1000) / 1000 : null,
        present_by_decision: reason_present_by_decision,
        blank_by_decision: reason_blank_by_decision,
        sample: reason_sample,
      },
    },
    coverage: {
      grid_deg: step,
      cells_reported: coverage.length,
      missing_coords,
      cells: coverage,
    },
    recent_sample: recent,
  };
}

// v12: the DESCRIPTIONS / story-gate observability arm. Reuses the SAME submissions
// rows summariseSubmissions scanned (one pull, one home — the #266 pin_audit pattern)
// so it adds NO DB read. Scoped to APPROVED, non-merged pins, because the #344
// story-gate governs exactly that set (a merged dupe inherits its canonical's status
// and sits on the canonical's coord, so it must not be counted — same #138 rule
// summariseSubmissions applies to coverage). This exists so brick 5's hide-gate is
// never a SILENT hide: `would_hide` is the pins it WOULD drop today (they are NOT
// hidden yet — no client reads resolved_source until brick 5), with a sample so the
// documented-but-unmatched ones (Capone/Obama and kin, the #318 curated-source
// candidates) are eyeball-able; `story_but_blank` catches the opposite silent failure
// — a real resolved_source with EMPTY text, which would render blank rather than hide
// (the Disney/gen-blank class the none-gate can't see).
// v13: name the lever for a would-hide pin so the rescue_queue is actionable, not
// just a list. Every would-hide pin is human-vouched (the gate governs the gem/seed
// layer), so the hint is always a rescue route, never "drop it":
//   seed:*   -> a mined recommendation with no write-up; the lever is a SOURCE
//              (#318 Google-Places / curated rung — the #365 path that already
//              flipped 45 of these). Places also carries the popularity signal the
//              rescue ranking wants, which is why the ranking lives on nearby-places.
//   user gem -> a person vouched but wrote nothing resolvable; source it (#318) or
//              nudge the submitter for a line the #328 generator can ground on.
function rescueHint(source: string | null | undefined): string {
  const s = String(source || "");
  if (s.startsWith("seed:")) return "seed (human-recommended, no write-up) — source a description via #318 Places/curated";
  return "user gem — source a description (#318) or nudge the submitter for a write-up (#328)";
}
// Cap on the emitted rescue_queue array so the JSON stays bounded. Comfortably above
// today's ~44; past this the set is a warn-level problem (the desc_hide_warn alert)
// and the queue is triaged in batches, so the sample + counts carry it.
const RESCUE_QUEUE_MAX = 250;

function summariseDescriptions(rows: any[], sampleN: number, step: number) {
  const by_resolved_source: Record<string, number> = {};
  const hide_by_category: Record<string, number> = {};
  const hide_by_source: Record<string, number> = {};
  const null_by_category: Record<string, number> = {};
  const hideSample: any[] = [];
  const nullSample: any[] = [];
  const blankSample: any[] = [];
  const rescueQueue: any[] = []; // v13: the FULL would-hide set (capped) — a rescue backlog, not a hide count
  let total_approved = 0;
  let has_story = 0;
  let would_hide = 0;
  let rescue_candidates = 0; // v13: would-hide pins that are human-vouched (= all of them, the gem/seed layer)
  let unresolved_null = 0;
  let story_but_blank = 0;

  for (const r of rows) {
    const isMerged = r.merged_into !== null && r.merged_into !== undefined;
    if (isMerged || r.status !== "approved") continue; // the gate governs approved, non-merged pins
    total_approved++;

    const rs =
      r.resolved_source === null || r.resolved_source === undefined
        ? "∅null"
        : String(r.resolved_source);
    inc(by_resolved_source, rs);

    const cell =
      typeof r.lat === "number" && typeof r.lng === "number"
        ? `${bucket(r.lat, step).toFixed(3)},${bucket(r.lng, step).toFixed(3)}`
        : null;
    const name = r.name_clean || r.name;

    if (rs === "none") {
      // WOULD be hidden once the client gate flips (#344 brick 5, live) — but every
      // one is a human-vouched place, so it's a RESCUE candidate first, a hide last.
      would_hide++;
      rescue_candidates++;
      inc(hide_by_category, r.category);
      inc(hide_by_source, r.source);
      if (hideSample.length < sampleN) {
        hideSample.push({ id: r.id, name, category: r.category, source: r.source, cell });
      }
      // v13: the actionable queue — the FULL set (capped), each with the lever to
      // rescue it, so the ones people actually go to (Acorn Street, View Boston, …)
      // get a sourced description instead of being silently dropped.
      if (rescueQueue.length < RESCUE_QUEUE_MAX) {
        rescueQueue.push({ id: r.id, name, category: r.category, source: r.source, cell, rescue: rescueHint(r.source) });
      }
    } else if (rs === "∅null") {
      // Never checked: stays VISIBLE (the gate hides 'none', not null), but owes a
      // resolve — the #319 sweep's backlog. Surfaced so it can't grow unnoticed.
      unresolved_null++;
      inc(null_by_category, r.category);
      if (nullSample.length < sampleN) {
        nullSample.push({ id: r.id, name, category: r.category, source: r.source, cell });
      }
    } else {
      // Claims a resolved story. Verify it actually has TEXT — a source set with an
      // empty description is the Disney/gen-blank silent failure: the gate would SHOW
      // it (source != 'none') but there's nothing to show, so it renders blank.
      has_story++;
      const rd = r.resolved_description;
      if (rd === null || rd === undefined || String(rd).trim() === "") {
        story_but_blank++;
        if (blankSample.length < sampleN) {
          blankSample.push({ id: r.id, name, category: r.category, resolved_source: rs, cell });
        }
      }
    }
  }

  return {
    scope: "approved, non-merged submissions — the human/seed layer the #344 story-gate governs",
    total_approved,
    by_resolved_source,
    has_story,
    would_hide: {
      // resolved_source='none' — the #344 client gate hides these. Every one is
      // human-vouched, so treat this as a RESCUE backlog: source a description
      // (#318) before dropping. by_source is always seed:*/user — never junk.
      total: would_hide,
      rescue_candidates, // = total: the whole set is vouched, so all are rescuable
      by_category: hide_by_category,
      by_source: hide_by_source,
      // v13: the FULL would-hide list (capped at RESCUE_QUEUE_MAX), each with a
      // `rescue` lever — this is the queue to work, not the ?sample=N slice.
      rescue_queue: rescueQueue,
      rescue_queue_capped: would_hide > rescueQueue.length,
      sample: hideSample, // kept for the alert detail; the full set is rescue_queue
    },
    unresolved_null: {
      // resolved_source null — never checked; visible today, owes a #319 resolve.
      total: unresolved_null,
      by_category: null_by_category,
      sample: nullSample,
    },
    story_but_blank: {
      // resolved_source set but resolved_description empty — renders blank, not hidden.
      total: story_but_blank,
      sample: blankSample,
    },
  };
}

// --- #370: the OSM/tile-layer would_remove backlog ---------------------------
//
// The OSM analog of summariseDescriptions.would_hide. That arm is submissions-
// scoped, so it can only see the human/seed layer; the OSM/tile pins never touch
// `submissions`. #369 taught nearby-places (the only function that reads the tile
// store and can run the gate's own filler test) to BANK, per cold tile build, the
// storyless OSM pins the #367 universal story-gate would remove — one shared_kv row
// per tile at `wouldremove:w1:<tile>`, value {v,tile,ts,cacheVersion,total,
// by_category,items:[{id,name,category,type,lat,lng}]}. This reads those banked rows
// and AGGREGATES them into one view, so the morning read shows the OSM removal
// backlog alongside the gem rescue queue.
//
// SAFETY / #141: this only SUMS rows nearby-places already classified — the
// descIsThin filler test ran at BANK time, in the gate's own function; it is NOT
// re-implemented here (re-implementing the classifier is exactly the vocab-drift
// trap #141 names). Aggregation of already-classified rows is the safe part the
// #370 row blesses for app-report.
//
// FRESHNESS: a tile only banks a row when it COLD-builds, so an empty/thin tally
// most often means the metros simply haven't been cold-built since #369 deployed,
// NOT that there's nothing to remove. `tiles`, `oldest_hours` and `newest_hours`
// make that legible — 0 tiles reads as "not yet warmed", not "clean".
//
// POPULARITY: NOT computed here. The daily read is pure DB aggregation (zero Places
// calls). The rating-sorted "which busy pins to rescue first" queue lives on
// nearby-places' `would_remove?rank=N` action (its bounded, quota-capped Places
// lookup, the #365 key); the handler forwards to it ONLY when an explicit ?rank=N
// is passed to this function, and folds the result in under `popular`.
function summariseOsmWouldRemove(rows: any[], now: number, sampleN: number) {
  const by_category: Record<string, number> = {};
  const byId = new Map<string, any>(); // dedupe across overlapping tiles (a pin can sit in several)
  let tiles = 0;
  let banked_total_sum = 0; // sum of each tile row's own `total` (pre-dedup) — a sanity cross-check
  let oldest_ms: number | null = null;
  let newest_ms: number | null = null;
  let cacheVersion: string | null = null;

  for (const r of rows) {
    let o: any;
    try {
      o = JSON.parse(r.value);
    } catch (_) {
      continue;
    }
    if (!o) continue;
    tiles++;
    banked_total_sum += Number(o.total) || 0;
    if (o.cacheVersion && !cacheVersion) cacheVersion = String(o.cacheVersion);
    const t = typeof o.ts === "number" ? o.ts : ms(r.updated_at);
    if (t !== null && t !== undefined) {
      if (oldest_ms === null || t < oldest_ms) oldest_ms = t;
      if (newest_ms === null || t > newest_ms) newest_ms = t;
    }
    for (const it of o.items || []) {
      if (!it || it.id == null) continue;
      if (!byId.has(it.id)) byId.set(it.id, { ...it, tile: o.tile });
    }
  }

  const items = [...byId.values()];
  for (const it of items) inc(by_category, it.category || "?");
  const sample = items.slice(0, sampleN);

  return {
    scope:
      "storyless OSM/tile pins the #367 universal story-gate would remove — the OSM analog of descriptions.would_hide (which is submissions-scoped and can't see this layer)",
    source: "wouldremove:w1:<tile> rows banked by nearby-places on cold tile builds (#369)",
    version: "w1",
    tiles, // banked tile rows read; 0 = not yet warmed (no metro cold-built since #369), NOT "nothing to remove"
    cache_version: cacheVersion, // the CACHE_VERSION the tally was banked under (drift check vs shared_content.tile_cache_versions)
    total: items.length, // storyless OSM pins, DEDUPED by id across overlapping tiles
    banked_total_sum, // pre-dedup sum across tiles (>= total; the gap is cross-tile overlap)
    by_category,
    freshness: {
      oldest_hours:
        oldest_ms === null ? null : Math.round(((now - oldest_ms) / HOUR) * 10) / 10,
      newest_hours:
        newest_ms === null ? null : Math.round(((now - newest_ms) / HOUR) * 10) / 10,
    },
    sample, // {id,name,category,type,lat,lng,tile}; the full ranked backlog is nearby-places would_remove?rank=N (see `popular`)
    note:
      tiles === 0
        ? "no wouldremove:w1: rows banked yet — a tile banks its tally only on a COLD build, so warm/undisturbed metros show nothing here until they next cold-build (or a nearby-places would_remove read is run). Not 'clean'."
        : "aggregated from banked rows only (zero Places calls). For the rating-sorted rescue order, pass ?rank=N to fold in nearby-places' would_remove queue under `popular`.",
    // popular: filled by the handler ONLY when ?rank=N is passed (a bounded, on-demand
    // forward to nearby-places' Places-ranked would_remove action — never a daily-read cost).
  };
}

function summariseUserState(rows: any[], now: number) {
  const users = new Set<string>();
  const by_key: Record<string, number> = {}; // one row per (user,key) => users holding that key
  const lastSeen: Record<string, number> = {};

  for (const r of rows) {
    if (r.user_id) users.add(r.user_id);
    inc(by_key, r.key);
    const t = ms(r.updated_at);
    if (t !== null && r.user_id) {
      lastSeen[r.user_id] = Math.max(lastSeen[r.user_id] || 0, t);
    }
  }

  let active_7d = 0;
  let active_30d = 0;
  for (const uid of Object.keys(lastSeen)) {
    if (now - lastSeen[uid] <= 7 * DAY) active_7d++;
    if (now - lastSeen[uid] <= 30 * DAY) active_30d++;
  }

  return {
    users_with_state: users.size,
    total_rows: rows.length,
    active_users_7d: active_7d,
    active_users_30d: active_30d,
    // Engagement funnel — how many users have reached each stage. Keys are the
    // private user_state keys the app writes.
    users_with_key: {
      has_captured_once: by_key["has-captured-once"] || 0,
      progress: by_key["progress"] || 0,
      stats: by_key["stats"] || 0,
      unlocked_achievements: by_key["unlocked-achievements"] || 0,
      my_hunts: by_key["my-hunts"] || 0,
      gem_submissions: by_key["gem-submissions"] || 0,
      capture_anchor: by_key["capture-anchor"] || 0,
    },
    all_keys_seen: by_key,
  };
}

function summariseSharedKv(rows: any[], now: number) {
  let guides = 0;
  let tile_cache = 0;
  let blocklist = 0;
  let other = 0;
  const cache_versions: Record<string, number> = {};
  let newest_guide_ms: number | null = null;

  for (const r of rows) {
    const key: string = r.key || "";
    if (key.startsWith("hunt-code:")) {
      guides++;
      const t = ms(r.updated_at);
      if (t !== null && (newest_guide_ms === null || t > newest_guide_ms)) newest_guide_ms = t;
    } else if (key === "places:blocklist") {
      blocklist++;
    } else if (key.startsWith("places:")) {
      tile_cache++;
      // key shape: places:<CACHE_VERSION>:<tile>
      const parts = key.split(":");
      if (parts.length >= 2) inc(cache_versions, parts[1]);
    } else {
      other++;
    }
  }

  return {
    total_keys: rows.length,
    shared_guides: guides,
    newest_guide_age_hours:
      newest_guide_ms === null ? null : Math.round(((now - newest_guide_ms) / HOUR) * 10) / 10,
    tile_cache_rows: tile_cache,
    tile_cache_versions: cache_versions, // >1 version lingering = stale cache buildup
    blocklist_rows: blocklist,
    other_keys: other,
  };
}

// --- #106: user liveness reports (the "this isn't here any more" sensor) ------
// The report -> suppress pipeline lives in nearby-places (readSuppression):
// distinct `reported_by` are counted per (target_id, reason) over OPEN rows, and
// a target is crowd-hidden when any suppressing reason clears its own threshold.
// Nothing surfaced whether that sensor has ever fired — the table was invisible
// in this digest — so this block reads `reports` and reports the crowd signal.
//
// #141 (v22) — THIS BLOCK NO LONGER MIRRORS THE RULES. It reads them from
// public.report_reason_meta, the one server-side home nearby-places also reads,
// so the three points below now hold by construction. Kept as history: they
// were how v9–v21 tried not to become a silent extra copy (the #141/#155/#25
// divergence problem — "the vocabulary has three copies and only two check each
// other"):
//   1. THRESHOLD is read from the SAME secret the serve path reads
//      (REPORT_SUPPRESS_THRESHOLD), with the SAME default 3. #350: bogus is NO
//      LONGER a =1 special case — #347 retired that floor and raised bogus's
//      human bar to the crowd threshold (like gone/chain), so every suppressing
//      reason reads the same crowd number here, and it can never drift from the
//      number that actually suppresses.
//   2. THE AI-REMOVE FAST PATH is mirrored too (#347/#350). A confident
//      `ai_verdict='remove'` on an AI-acting reason (bogus — AI_ACT_REASONS)
//      hides a pin on ONE report regardless of crowd count, so this arm folds
//      those targets into the suppressed set exactly as readSuppression does and
//      surfaces them distinctly (`targets_ai_removed`, `via:"ai"`) — otherwise a
//      genuinely-hidden pin would be invisible in the dashboard.
//   3. The REASON VOCAB is mirrored as SUPPRESSES, and any reason found in the
//      table that this mirror does NOT know is surfaced in `unknown_reasons`. An
//      empty array means dashboard, client and serve path still agree; a
//      non-empty one is the drift alarm #141 says is missing. This block is a
//      CHECKER of the vocabulary (and now the threshold + AI dimensions), not an
//      unchecked fourth copy.
//
// PRIVACY (item 5): `reported_by` is read ONLY to count DISTINCT reporters and is
// NEVER emitted — the same stance user_state takes with user_id. `target_id` is a
// public pin id (submissions.id is already emitted in recent_sample), so it is
// safe to surface in the sample.
//
// SUPPRESSION is derived from OPEN reports only (dismiss_report flips a row out of
// `open`, exactly as the serve path filters on status='open'). #350: the serve path
// now hides a pin two ways — the CROWD bar cleared (`targets_at_or_over`) OR a
// confident AI 'remove' on one report (`targets_ai_removed`) — so `targets_suppressed`
// is the UNION, the true serve-hidden set, matching what readSuppression puts in its
// `ids`. The one thing this reports-table-only read still can't see is the operator
// `exempt`/`ids` override in the blocklist (one table, one home — the isolation every
// other section keeps), so `targets_suppressed` means "the reports say this is hidden",
// not an absolute guarantee an exempt pin isn't forced back up; the `note` says so.
// #393 — `liveGem`: gem uuid -> true (approved and unmerged, i.e. actually served)
// or false (rejected / retired / pending / merged). A report whose target is a gem
// NOT served hides nothing; it is counted as stale instead of suppressed. OSM ids
// and uuids missing from the map (null map = submissions read failed) are treated
// exactly as before.
function summariseReports(rows: any[], metaRows: any[], now: number, sampleN: number, liveGem: Map<string, boolean> | null = null) {
  // #141 — the rules come from public.report_reason_meta (read by the caller),
  // the same rows nearby-places validates, suppresses and AI-acts against. No
  // built-in copy: an empty or failed read throws, and the section lands in
  // `errors` rather than reporting numbers from a guess.
  const SUPPRESSES: Record<string, boolean> = {};
  const AI_ACTS: Record<string, boolean> = {};
  const THRESHOLDS: Record<string, number> = {};
  for (const m of metaRows || []) {
    if (!m || typeof m.reason !== "string" || !m.reason) continue;
    const sup = m.suppresses === true;
    SUPPRESSES[m.reason] = sup;
    AI_ACTS[m.reason] = sup && m.ai_acts === true;
    const t = Number(m.threshold);
    if (sup && Number.isInteger(t) && t >= 1) THRESHOLDS[m.reason] = t;
  }
  if (!Object.keys(SUPPRESSES).length) throw new Error("report_reason_meta returned no reasons");
  // A suppressing reason with no usable bar never crowd-hides (the serve path
  // treats it the same way); the table's CHECKs make that row impossible.
  const thresholdFor = (reason: string): number =>
    SUPPRESSES[reason] && THRESHOLDS[reason] !== undefined ? THRESHOLDS[reason] : Infinity;
  // Nothing reads this secret any more (#141); report it only so a stale one
  // left in Edge Functions → Secrets gets noticed and deleted.
  const secret_ignored = String(Deno.env.get("REPORT_SUPPRESS_THRESHOLD") || "").trim() !== "";

  const by_reason: Record<string, number> = {};
  const by_status: Record<string, number> = {};
  const windows = { last_24h: 0, last_7d: 0, last_30d: 0, all_time: rows.length };
  const distinctTargets = new Set<string>();
  const distinctReporters = new Set<string>();
  const unknownReasons = new Set<string>();

  // distinct reporters per (target, reason) over OPEN rows only — the serve key.
  const openByTargetReason = new Map<string, Set<string>>();
  // #350 — targets an AI 'remove' verdict hides on one report (AI_ACT_REASONS),
  // held as target\0reason pairs so by_reason can attribute the removal. Mirrors
  // readSuppression's aiRemoveIds — collected regardless of reporter count, since
  // the AI verdict is an ADDITIONAL way in, never gated on the crowd bar.
  const aiRemovePairs = new Set<string>();
  const aiRemoveTargets = new Set<string>();
  // #393 — open reports on a gem that is no longer served.
  const staleTargets = new Set<string>();
  const staleSample: Array<{ target_id: string; reason: string; ai_verdict: string | null }> = [];
  const isDeadGem = (tid: string) => !!liveGem && liveGem.has(tid) && liveGem.get(tid) === false;

  for (const r of rows) {
    if (!r) continue;
    const reason = r.reason === null || r.reason === undefined ? "∅null" : String(r.reason);
    const status = r.status === null || r.status === undefined ? "∅null" : String(r.status);
    inc(by_reason, reason);
    inc(by_status, status);
    if (r.target_id) distinctTargets.add(String(r.target_id));
    if (r.reported_by) distinctReporters.add(String(r.reported_by));
    if (reason !== "∅null" && !(reason in SUPPRESSES)) unknownReasons.add(reason);

    const t = ms(r.created_at);
    if (t !== null) {
      const age = now - t;
      if (age <= DAY) windows.last_24h++;
      if (age <= 7 * DAY) windows.last_7d++;
      if (age <= 30 * DAY) windows.last_30d++;
    }

    if (status === "open" && r.target_id && isDeadGem(String(r.target_id))) {
      // #393 — nothing to hide: the serve path never serves this row. Close the
      // report with resolve_report (upheld) or dismiss_report to clear it.
      if (!staleTargets.has(String(r.target_id)) && staleSample.length < sampleN) {
        staleSample.push({ target_id: String(r.target_id), reason, ai_verdict: r.ai_verdict ?? null });
      }
      staleTargets.add(String(r.target_id));
      continue;
    }
    if (status === "open" && r.target_id && r.reported_by && SUPPRESSES[reason]) {
      const k = String(r.target_id) + "\u0000" + reason;
      let s = openByTargetReason.get(k);
      if (!s) { s = new Set<string>(); openByTargetReason.set(k, s); }
      s.add(String(r.reported_by));
    }
    // #347/#350 — a confident AI 'remove' on an AI-acting reason hides the pin
    // on ONE report, regardless of reporter count. Same condition as the serve
    // path (reason in AI_ACT_REASONS, ai_verdict === "remove", row open).
    if (status === "open" && r.target_id && AI_ACTS[reason] && r.ai_verdict === "remove") {
      aiRemovePairs.add(String(r.target_id) + "\u0000" + reason);
      aiRemoveTargets.add(String(r.target_id));
    }
  }

  // Roll the (target,reason) distinct counts up into the suppression view.
  type PerReason = { at_or_over: number; one_away: number; max_distinct: number; ai_removed: number };
  const perReason: Record<string, PerReason> = {};
  const mkPerReason = (reason: string): PerReason => {
    if (!perReason[reason]) perReason[reason] = { at_or_over: 0, one_away: 0, max_distinct: 0, ai_removed: 0 };
    return perReason[reason];
  };
  type SampleEntry = { target_id: string; reason: string; distinct_reporters: number; threshold: number; via: string; ai_verdict?: string };
  const sampleEntries: SampleEntry[] = [];
  const atOverSet = new Set<string>();
  const oneAwaySet = new Set<string>();
  // bogus/gone/chain distinct-reporter count per (target,reason), so an AI-removed
  // pin below the crowd bar can still report how many humans had flagged it.
  const distinctByTargetReason: Record<string, number> = {};

  openByTargetReason.forEach((set, k) => {
    const sep = k.indexOf("\u0000");
    const target = k.slice(0, sep);
    const reason = k.slice(sep + 1);
    const n = set.size;
    const th = thresholdFor(reason);
    const pr = mkPerReason(reason);
    distinctByTargetReason[k] = n;
    if (n > pr.max_distinct) pr.max_distinct = n;
    if (n >= th) {
      pr.at_or_over++;
      atOverSet.add(target);
      sampleEntries.push({ target_id: target, reason, distinct_reporters: n, threshold: th, via: "crowd" });
    } else if (n === th - 1) {
      pr.one_away++;
      oneAwaySet.add(target);
    }
  });

  // #347/#350 — fold the AI-remove targets in exactly as readSuppression does: a
  // confident 'remove' hides the pin regardless of the crowd count, so it belongs
  // in the suppressed set, is never merely "one away", and is marked via:"ai" so
  // the operator sees the hide is AI-driven (a lone report yanked a real pin — the
  // sensitive case #347 created) rather than crowd-driven.
  aiRemovePairs.forEach((k) => {
    const sep = k.indexOf("\u0000");
    const target = k.slice(0, sep);
    const reason = k.slice(sep + 1);
    const n = distinctByTargetReason[k] || 0;
    const pr = mkPerReason(reason);
    pr.ai_removed++;
    if (n > pr.max_distinct) pr.max_distinct = n;
    const existing = sampleEntries.find((x) => x.target_id === target && x.reason === reason);
    if (existing) {
      existing.via = existing.via === "crowd" ? "crowd+ai" : existing.via;
      existing.ai_verdict = "remove";
    } else {
      sampleEntries.push({ target_id: target, reason, distinct_reporters: n, threshold: thresholdFor(reason), via: "ai", ai_verdict: "remove" });
    }
  });
  // An AI-removed pin is suppressed, so drop it from the "one away" set.
  aiRemoveTargets.forEach((t) => oneAwaySet.delete(t));
  // The true serve-hidden set = crowd bar cleared ∪ AI 'remove' (the serve path's `ids`).
  const suppressedSet = new Set<string>([...atOverSet, ...aiRemoveTargets]);

  // Most-suppressed/most-reported first so the actionable pins lead the sample. No
  // reporter ids. AI-driven hides tie-break ahead of crowd at equal counts (they
  // are the ones a single report removed).
  const viaRank = (v: string) => (v === "crowd" ? 0 : 1);
  sampleEntries.sort((a, b) => (b.distinct_reporters - a.distinct_reporters) || (viaRank(b.via) - viaRank(a.via)));

  return {
    total: rows.length,
    distinct_targets: distinctTargets.size,
    distinct_reporters: distinctReporters.size,
    by_reason,
    by_status,
    // #141 drift alarm. Since v22: a report row whose reason report_reason_meta
    // doesn't define. The reports_reason_fkey foreign key makes that impossible,
    // so non-empty means the key was dropped.
    unknown_reasons: [...unknownReasons].sort(),
    windows,
    // #141 (v22) — per-reason bars straight from report_reason_meta; ai_act_reasons
    // names the reasons whose confident AI 'remove' hides on one report (#347).
    threshold: {
      source: "report_reason_meta",
      by_reason: THRESHOLDS,
      ai_act_reasons: Object.keys(AI_ACTS).filter((k) => AI_ACTS[k]),
      secret_ignored,
    },
    suppression: {
      note:
        "Derived from OPEN reports only, distinct reporters per (target,reason). " +
        "targets_suppressed = the serve-hidden set = at_or_over (crowd bar cleared) " +
        "∪ ai_removed (a confident AI 'remove' on one report, #347). The serve path " +
        "ALSO honours an operator exempt/ids override (in the blocklist) that this " +
        "reports-only read does not consult, so targets_suppressed is what the reports " +
        "say is hidden, not an absolute guarantee an exempt pin isn't forced back up.",
      suppressing_reasons: Object.keys(SUPPRESSES).filter((k) => SUPPRESSES[k]),
      ai_act_reasons: Object.keys(AI_ACTS).filter((k) => AI_ACTS[k]),
      open_suppressing_pairs: openByTargetReason.size,
      targets_at_or_over: atOverSet.size,     // crowd bar cleared
      targets_ai_removed: aiRemoveTargets.size, // hidden by a confident AI 'remove' on one report (#347)
      targets_suppressed: suppressedSet.size,   // the union — what the serve path hides
      targets_one_away: oneAwaySet.size,
      by_reason: perReason,
      sample: sampleEntries.slice(0, sampleN),
      // #393 — open reports on a gem that is no longer served (rejected / retired /
      // pending / merged). Excluded from every count above; close them to clear.
      stale_open_reports: { targets: staleTargets.size, sample: staleSample },
    },
  };
}

async function summariseAuth(supabase: any, now: number) {
  const perPage = 1000;
  let page = 1;
  let total = 0;
  let confirmed = 0;
  let signups_7d = 0;
  let signups_30d = 0;

  // paginate auth.admin.listUsers — never emits any email or id
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);
    const list = (data && data.users) || [];
    for (const u of list) {
      total++;
      if (u.email_confirmed_at) confirmed++;
      const created = ms(u.created_at);
      if (created !== null) {
        if (now - created <= 7 * DAY) signups_7d++;
        if (now - created <= 30 * DAY) signups_30d++;
      }
    }
    if (list.length < perPage) break;
    page++;
    if (page > 100) break; // hard stop
  }

  return {
    total_users: total,
    email_confirmed: confirmed,
    email_unconfirmed: total - confirmed, // item 69 signal (confirmation currently off)
    signups_7d,
    signups_30d,
  };
}

// #266: the pin self-audit — DUPLICATE arm (first cut).
//
// This is the automated form of montrose-inspect.sql Part B: cluster every
// non-merged submission by normalised name, and for any name held by 2+ pins,
// report the members and how far apart they sit. A geocode failure produces a
// same-name pin FAR from its twin (Montrose: 3.2 km), which the seed pipeline's
// ~90 m proximity dedup structurally cannot catch (#31/#57/#267) — so this check
// is deliberately NOT proximity-gated. Distance is REPORTED, not used to gate,
// so the operator reads it and disposes via merge_submissions / reject_submission
// (#74/#38). It PROPOSES; it never writes, merges or deletes (#266's core rule —
// geocoders are fallible and famous word-of-mouth places are often absent from
// them, so an auto-fixer would occasionally "correct" a good pin into a worse
// one; the #267 run caught the real Montrose dup AND correctly left the 1219 km
// Attaboy namesake alone — that false positive is why a human disposes).
//
// The namesake cutoff (metroKm) is how we separate a misplaced duplicate from a
// legitimate two-metro namesake WITHOUT assuming a `city` column exists: if the
// NEAREST pair in a name-cluster is farther apart than metroKm, every member is
// in a different metro and it's treated as a namesake, not a duplicate (dropped,
// counted in excluded_far_namesakes). Both thresholds are query-tunable, never a
// magic number (#266: "keep it tunable").
//
// NOT BUILT HERE (the deliberate SECOND cut, per #266's "cheapest first cut"):
//   - the MISPLACEMENT arm that re-geocodes each name via Photon and flags a pin
//     that disagrees with its stored coordinate. That is ~N external calls per
//     report load against an unkeyed geocoder (#89) on a read endpoint that
//     "NEVER writes" — it belongs in a scheduled pg_cron job (#126) writing to a
//     pin_audit table, not inline here. A same-name-far duplicate already carries
//     the geocode-error signal for the DUPLICATED case; the single-pin case waits.
//   - the #269 WATER/reachability arm (a pin inside a natural=water polygon).
// Both are scoped on #266/#269 and should land as the pin_audit-table cut.
function auditDuplicates(
  rows: any[],
  opts: { metroKm: number; coloKm: number; cap: number },
) {
  // Group non-merged, coordinate-bearing rows by normalised name.
  const groups: Record<string, any[]> = {};
  let considered = 0;
  for (const r of rows) {
    const isMerged = r.merged_into !== null && r.merged_into !== undefined;
    if (isMerged) continue; // a merged dupe is already resolved — don't re-flag it
    if (typeof r.lat !== "number" || typeof r.lng !== "number") continue;
    const key = normName(r.name_clean || r.name);
    if (!key) continue;
    considered++;
    (groups[key] = groups[key] || []).push(r);
  }

  let clusters_total = 0;
  let excluded_far_namesakes = 0;
  let excluded_dead = 0; // #393 — clusters with fewer than two live members
  const clusters: any[] = [];

  for (const key of Object.keys(groups)) {
    const members = groups[key];
    if (members.length < 2) continue;
    clusters_total++;
    // #393 — a cluster is only a merge candidate if at least TWO of its pins are
    // still live (approved or pending; merged rows were skipped above). Three
    // rejected "Test" rows are nothing on the map and nothing to merge.
    const liveCount = members.filter((m: any) => m.status === "approved" || m.status === "pending").length;
    if (liveCount < 2) { excluded_dead++; continue; }

    // Nearest and farthest pair distances across the cluster. Nearest is the
    // duplicate signal: if the two closest same-name pins are still farther apart
    // than metroKm, they're all in different metros — a namesake, not a dup.
    let nearest = Infinity;
    let farthest = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const d = haversineKm(members[i].lat, members[i].lng, members[j].lat, members[j].lng);
        if (d < nearest) nearest = d;
        if (d > farthest) farthest = d;
      }
    }
    if (nearest > opts.metroKm) {
      excluded_far_namesakes++;
      continue;
    }

    clusters.push({
      name: members[0].name_clean || members[0].name,
      norm: key,
      count: members.length,
      // <= coloKm apart = co-located plain duplicate; > coloKm (up to metroKm) =
      // same-metro but displaced, the Montrose class worth a human look.
      kind: nearest <= opts.coloKm ? "colocated" : "displaced",
      nearest_pair_km: Math.round(nearest * 100) / 100,
      farthest_pair_km: Math.round(farthest * 100) / 100,
      members: members
        .map((m: any) => ({
          id: m.id,
          category: m.category,
          status: m.status,
          source: m.source,
          lat: typeof m.lat === "number" ? Math.round(m.lat * 1e6) / 1e6 : null,
          lng: typeof m.lng === "number" ? Math.round(m.lng * 1e6) / 1e6 : null,
        }))
        .sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    });
  }

  // Tightest clusters first: co-located dups (~0 km) top the list, then the
  // displaced same-metro dups. Cap the emitted list; the counts above are the
  // full totals so a truncated list still reports honest volume.
  clusters.sort((a, b) => a.nearest_pair_km - b.nearest_pair_km);
  const shown = clusters.slice(0, opts.cap);

  return {
    method: "duplicate-name-cluster (montrose-inspect Part B, automated)",
    note:
      "PROPOSES only — no write/merge/delete. Dispose via merge_submissions/reject_submission. " +
      "Misplacement (Photon) + water (#269) arms are the deferred pin_audit-table cut, not run here.",
    params: { metro_km: opts.metroKm, colocated_km: opts.coloKm, cap: opts.cap },
    considered, // non-merged, coordinate-bearing pins that entered clustering
    name_clusters_2plus: clusters_total, // names shared by 2+ pins, before namesake filter
    flagged: clusters.length, // clusters kept after dropping far namesakes
    colocated: clusters.filter((c) => c.kind === "colocated").length,
    displaced: clusters.filter((c) => c.kind === "displaced").length,
    excluded_far_namesakes, // 2+ same-name pins all in different metros (e.g. Attaboy)
    excluded_dead, // #393 — same-name clusters with <2 live (approved/pending) pins
    shown: shown.length,
    clusters: shown,
  };
}

// #266 near-dup arm: tokens for lexical overlap. Splits the normalised name on
// spaces and drops a small stopword set so "Mr Beef" and "Mr Beef ON Orleans"
// score on their DISTINCTIVE words, not the glue. Returns a Set; a name that is
// all-stopwords yields an empty set and is skipped by the caller.
const NEAR_STOPWORDS = new Set([
  "the", "a", "an", "of", "on", "at", "in", "and", "or", "to", "for",
  "de", "la", "el", "le", "du", "des", "los", "las",
]);
// #278 — GENERIC PLACE-TYPE WORDS. Every live near_name false positive chained on
// one of these shared type words while the DISTINCTIVE token diverged (Race/Cherry
// "Pier"; Frye/Seattle-Art/Seattle-Pinball "Museum"; Buffalo Bayou "Park"). Raising
// the jaccard floor can't fix it — those pairs have HIGH lexical overlap — so the
// fix is to score a name on its distinctive words and let the type word carry no
// weight. Kept DELIBERATELY TIGHT (the words actually observed to chain, plus the
// unambiguous type words #278 enumerates): a distinctive brand token must never
// land here, so words that can be a real name (house, room, club, hall, brewing,
// garden, gallery, market) are LEFT OUT — the propose-only audit prefers a
// surfaced false positive over a swallowed real dup. Extend one word at a time
// against a live near_name run, never speculatively.
const NEAR_GENERIC_TYPE = new Set([
  "park", "pier", "museum", "bar", "grill", "cafe", "restaurant", "kitchen",
  "co", "company", "tavern", "pub", "diner", "bistro",
]);
// #353 — GRAVE/TOMB HONORIFIC PREFIX. The #310/#335 wikidata-grave seeds are all
// named "Grave of <person>", so the honorific "grave" is a shared token on EVERY
// grave pin — the exact #278 failure mode, but the type word ("of" is already a
// stopword) rides on TOP of a shared first name OR surname while the DISTINCTIVE
// person token diverges: "Grave of George Washington" vs "Grave of Bushrod
// Washington" both tokenise to {grave, <first>, washington}, so the shared
// {grave, washington} scores jaccard 0.5 and the near_name arm re-flags ~11
// different-people pairs EVERY run (George/Bushrod; the three John Eliot/Harvard/
// Winthrop; both Vanderbilts; Barrymore/Wanamaker; …). #278's global generic-type
// drop can't own "grave"/"tomb" (a non-grave place could legitimately be named
// "The Tomb"), so the honorific is dropped ONLY when the name carries the grave/
// tomb honorific PREFIX — treating the person's first+surname as the distinctive
// tokens, exactly #353. This is precision AND recall: a real same-person rewording
// across honorifics ("Grave of John Smith" vs "Tomb of John Smith") now matches at
// jaccard 1.0 instead of being diluted by the differing honorific, while the
// different-people same-surname/same-first-name pairs fall to 0.33 and drop off.
const GRAVE_HONORIFIC_TOKENS = new Set(["grave", "tomb", "gravesite"]);
const GRAVE_HONORIFIC_PREFIX_RE = /^(grave|tomb|gravesite)\s+of\s+/;
// Distinctive tokens: drop stopwords, then drop generic type words — but only when
// AT LEAST TWO distinctive tokens survive. This >=2 floor is load-bearing and was
// paid for by a live regression: with a >0 floor, a two-word "<name> <type>" pair
// collapses to a SINGLE distinctive token, and two DIFFERENT places that share
// that token then match at jaccard 1.0 — "Penn Park" and "Penn Museum" both became
// {penn}; "Audubon Park" became {audubon} and chained the Aquarium/Insectarium/Zoo.
// Keeping the type word for a one-distinctive-token name is what separates them:
// {penn,park} vs {penn,museum} is jaccard 0.33, no longer flagged. Names with >=2
// distinctive tokens ("Seattle Art Museum" -> {seattle,art}, "Race Street Pier" ->
// {race,street}) still shed the type word and still dissolve as intended. The cost
// is accepted and correct for a propose-only audit: a genuine "<X> <type>" vs
// "<X> <type> <city>" dup ("Millennium Park" / "Millennium Park Chicago") may go
// unflagged here — a MISSED proposal is recoverable (the operator, or #228's
// semantic pass, still catches it), a false-positive FLOOD makes the audit
// useless. Single caller (auditNearNames), so the token policy lives here.
function nameTokens(norm: string): Set<string> {
  // #353 — a grave/tomb honorific PREFIX ("grave of …") makes its honorific token
  // ("grave"/"tomb"/"gravesite") non-distinctive for THIS name only, so a shared
  // surname/first-name can't be padded over the floor by the shared honorific.
  const graveHonorific = GRAVE_HONORIFIC_PREFIX_RE.test(norm);
  const kept = new Set<string>();       // stopwords (+ grave honorific) removed, type words still in
  for (const t of norm.split(" ")) {
    if (!t || NEAR_STOPWORDS.has(t)) continue;
    if (graveHonorific && GRAVE_HONORIFIC_TOKENS.has(t)) continue; // #353
    kept.add(t);
  }
  const distinctive = new Set<string>();
  for (const t of kept) if (!NEAR_GENERIC_TYPE.has(t)) distinctive.add(t);
  return distinctive.size >= 2 ? distinctive : kept;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}
function containment(a: Set<string>, b: Set<string>): number {
  // fraction of the SHORTER name's tokens present in the longer — ~1.0 means one
  // name is the other plus extra words ("Mr Beef" ⊂ "Mr Beef on Orleans").
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let inter = 0;
  for (const t of small) if (big.has(t)) inter++;
  return inter / small.size;
}

// #393 — DIFFERENT PEOPLE, SAME NAME SHAPE. The wikidata-grave seeds put family
// in one plot and fathers/sons in one cemetery, and their names nest: "Grave of
// Leland Stanford" sits inside "Grave of Leland Stanford, Jr.", "Grave of Jay Gould"
// inside "Grave of George Jay Gould". Token containment reads that as the strongest
// reworded-dup signal, which is exactly backwards for people. For a GRAVE-vs-GRAVE
// pair (both carry the honorific prefix; nameTokens has already dropped it) the
// pair is split when (1) the generational tokens differ (jr vs none, ii vs iv), or
// (2) either name keeps a full token the other lacks — after pairing an initial
// with the other side's token it abbreviates (f ↔ fitzgerald), so a middle-initial
// rewording of ONE person is still proposed. For a grave pin vs a NON-grave name,
// the pair is split when the non-grave name carries no burial word: that is a
// person's grave and a place named after them (Hermitage vs Grave of Andrew
// Jackson), not two copies of one pin. Non-grave pairs are untouched (#278 owns
// them). Cost, stated: a genuine same-person dup whose second copy adds a full
// middle name ("Wyatt Earp" / "Wyatt Berry Stapp Earp") is demoted too — it is
// still LISTED, just not alerted; #378's per-QID collapse already stops the loader
// minting those.
const GEN_TOKENS = new Set(["jr", "sr", "junior", "senior", "i", "ii", "iii", "iv", "v", "younger", "elder"]);
const BURIAL_WORDS_RE = /\b(grave|graves|gravesite|tomb|burial|buried|mausoleum|crypt|cemetery)\b/;
function peopleSplit(aNorm: string, aToks: Set<string>, bNorm: string, bToks: Set<string>): string | null {
  const aGrave = GRAVE_HONORIFIC_PREFIX_RE.test(aNorm);
  const bGrave = GRAVE_HONORIFIC_PREFIX_RE.test(bNorm);
  if (aGrave !== bGrave) {
    const other = aGrave ? bNorm : aNorm;
    return BURIAL_WORDS_RE.test(other) ? null : "grave_vs_place";
  }
  if (!aGrave) return null;
  const genA = [...aToks].filter((t) => GEN_TOKENS.has(t)).sort().join(",");
  const genB = [...bToks].filter((t) => GEN_TOKENS.has(t)).sort().join(",");
  if (genA !== genB) return "generational";
  const uA = [...aToks].filter((t) => !bToks.has(t) && !GEN_TOKENS.has(t));
  const uB = [...bToks].filter((t) => !aToks.has(t) && !GEN_TOKENS.has(t));
  // pair an initial on one side with a token it abbreviates on the other
  const pairOff = (xs: string[], ys: string[]) => {
    for (let i = xs.length - 1; i >= 0; i--) {
      if (xs[i].length !== 1) continue;
      const j = ys.findIndex((y) => y.length > 1 && y[0] === xs[i]);
      if (j >= 0) { xs.splice(i, 1); ys.splice(j, 1); }
    }
  };
  pairOff(uA, uB); pairOff(uB, uA);
  const full = (xs: string[]) => xs.some((t) => t.length > 1);
  return full(uA) || full(uB) ? "different_given_names" : null;
}

// #266 near-dup arm: REWORDED same-place duplicates within a metro.
//
// exact_name only catches identical strings. This catches "Mr Beef" vs "Mr Beef
// on Orleans" vs "Mr. Beef" — same place, different wording — via token-Jaccard
// on the distinctive words. It is the opposite of exact_name on gating: a
// reworded duplicate of ONE place sits on top of itself, so this arm IS
// proximity-gated (default 2 km). Two pins that merely share a generic word far
// apart ("Central Park" NYC vs "Central Park Bar" Denver) are different places
// and are never compared. Pairs whose normalised names are IDENTICAL are skipped
// — those are exact_name's job, not a second report of the same thing.
//
// Comparisons are limited to a coarse geo cell (so it's not O(n^2) over the whole
// set) and then a real haversine proximity check inside the cell. Pairs passing
// (jaccard >= threshold AND distance <= proxKm AND not identical) are unioned into
// clusters. Everything is REPORTED, nothing acted on (#266 propose-never-dispose).
//
// SCOPE BOUNDARY (honest): this is LEXICAL overlap. It will NOT catch a fully
// reworded name that shares no distinctive token ("Mr Beef" vs "Al's #1 Italian
// Beef") — that is a semantic judgement, #228's Gemini pass. Nor the far+reworded
// case (a reworded dup that ALSO geocode-misplaced far away): non-proximity token
// matching explodes on generic words, so that case is left to #228 too. Some
// same-neighbourhood-different-place pairs will surface as false positives
// ("Lincoln Park Zoo" vs "Lincoln Park Conservatory") — that is why a human
// disposes; the containment score and the distinct names make them easy to reject.
function auditNearNames(
  rows: any[],
  opts: { proxKm: number; jaccard: number; cap: number },
) {
  // Prepare candidate pins with a normalised name, token set, and a coarse cell.
  const CELL = 0.1; // ~11 km — a 2 km near-dup pair fits inside a 3x3 neighbourhood.
  type P = { r: any; norm: string; toks: Set<string>; cLat: number; cLng: number };
  const byCell: Record<string, P[]> = {};
  const cellKey = (clat: number, clng: number) => `${clat.toFixed(2)},${clng.toFixed(2)}`;
  let considered = 0;
  for (const r of rows) {
    const isMerged = r.merged_into !== null && r.merged_into !== undefined;
    if (isMerged) continue;
    if (typeof r.lat !== "number" || typeof r.lng !== "number") continue;
    const norm = normName(r.name_clean || r.name);
    if (!norm) continue;
    const toks = nameTokens(norm);
    if (toks.size === 0) continue;
    const cLat = bucket(r.lat, CELL);
    const cLng = bucket(r.lng, CELL);
    considered++;
    (byCell[cellKey(cLat, cLng)] = byCell[cellKey(cLat, cLng)] || []).push({ r, norm, toks, cLat, cLng });
  }

  // Union-find over qualifying pairs, cell by cell.
  const parent: Record<string, string> = {};
  const find = (x: string): string => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a: string, b: string) => { parent[find(a)] = find(b); };
  const edges: Record<string, { jac: number; con: number; km: number; split: string | null }> = {};
  let pairs_qualified = 0;

  // Register every candidate in the union-find up front.
  const allPins: P[] = [];
  for (const k of Object.keys(byCell)) for (const p of byCell[k]) { parent[p.r.id] = p.r.id; allPins.push(p); }

  // For each pin, compare against pins in its own cell and the 8 neighbours, only
  // when the other id sorts higher (so each unordered pair is evaluated once and
  // a pair straddling a cell boundary is never missed).
  for (const A of allPins) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucketList = byCell[cellKey(A.cLat + dx * CELL, A.cLng + dy * CELL)];
        if (!bucketList) continue;
        for (const B of bucketList) {
          if (!(B.r.id > A.r.id)) continue; // ordered + skips self
          if (A.norm === B.norm) continue; // identical -> exact_name's job
          const jac = jaccard(A.toks, B.toks);
          if (jac < opts.jaccard) continue;
          const km = haversineKm(A.r.lat, A.r.lng, B.r.lat, B.r.lng);
          if (km > opts.proxKm) continue;
          pairs_qualified++;
          edges[A.r.id + "|" + B.r.id] = {
            jac: Math.round(jac * 100) / 100,
            con: Math.round(containment(A.toks, B.toks) * 100) / 100,
            km: Math.round(km * 100) / 100,
            split: peopleSplit(A.norm, A.toks, B.norm, B.toks), // #393
          };
          union(A.r.id, B.r.id);
        }
      }
    }
  }

  // Assemble clusters from union-find roots that have >= 2 members touched by an
  // edge. Build a quick id -> row map from the candidate pins.
  const rowById: Record<string, P> = {};
  for (const cell of Object.keys(byCell)) for (const p of byCell[cell]) rowById[p.r.id] = p;
  const touched = new Set<string>();
  for (const k of Object.keys(edges)) { const [a, b] = k.split("|"); touched.add(a); touched.add(b); }

  const groups: Record<string, string[]> = {};
  for (const id of touched) (groups[find(id)] = groups[find(id)] || []).push(id);

  const clusters: any[] = [];
  for (const root of Object.keys(groups)) {
    const ids = groups[root];
    if (ids.length < 2) continue;
    // cluster stats: top edge jaccard/containment, and the widest pair span.
    let top_jaccard = 0, top_containment = 0, span_km = 0;
    let edgeCount = 0, splitCount = 0; // #393
    const splitReasons = new Set<string>();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const e = edges[ids[i] + "|" + ids[j]] || edges[ids[j] + "|" + ids[i]];
        if (e) {
          if (e.jac > top_jaccard) top_jaccard = e.jac; if (e.con > top_containment) top_containment = e.con;
          edgeCount++;
          if (e.split) { splitCount++; splitReasons.add(e.split); }
        }
        const pa = rowById[ids[i]], pb = rowById[ids[j]];
        const km = haversineKm(pa.r.lat, pa.r.lng, pb.r.lat, pb.r.lng);
        if (km > span_km) span_km = km;
      }
    }
    const members = ids.map((id) => rowById[id].r);
    const names = Array.from(new Set(members.map((m: any) => m.name_clean || m.name)));
    // #278 — same_category is what turns containment 1.0 into a real merge signal.
    // Containment 1.0 alone is NOT enough: "Buffalo Bayou Park Cistern" contains
    // "Buffalo Bayou Park" but is a different-category sub-attraction. True when
    // every member shares one non-null category; a null category (a user row not
    // yet gated) makes it false, which is the safe side (surface, don't auto-rank).
    const cats = members.map((m: any) => m.category);
    const same_category = cats.every((c: any) => c != null && c === cats[0]);
    clusters.push({
      names, // the distinct raw names — the money shot for a human ("Mr Beef" / "Mr Beef on Orleans")
      count: members.length,
      top_jaccard,
      top_containment, // ~1.0 = one name is the other + extra words (strongest signal)
      same_category,   // #278 — containment 1.0 is a merge signal ONLY when this is true
      // #393 — every edge in the cluster is a people/place split: listed for recall,
      // sorted below real candidates, never counted by near_dup_merges_waiting.
      likely_different_people: edgeCount > 0 && splitCount === edgeCount,
      split_reasons: [...splitReasons].sort(),
      span_km: Math.round(span_km * 100) / 100,
      members: members
        .map((m: any) => ({
          id: m.id,
          name: m.name_clean || m.name,
          category: m.category,
          status: m.status,
          source: m.source,
          lat: typeof m.lat === "number" ? Math.round(m.lat * 1e6) / 1e6 : null,
          lng: typeof m.lng === "number" ? Math.round(m.lng * 1e6) / 1e6 : null,
        }))
        .sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    });
  }

  // #278 — real merges first: a cluster whose names are containment-1.0 AND share a
  // category is the strongest same-place signal (a reworded dup: "Mr Beef" /
  // "Mr Beef on Orleans", both barsrest). It ranks above everything, so the
  // operator sees the true merges at the top and the different-category
  // containment matches (the Buffalo Cistern/Park shape) sink below them. After
  // that, strongest lexical match first (containment then jaccard), tightest span
  // as the final tiebreak.
  const isStrong = (c: any) => (c.top_containment >= 0.99 && c.same_category && !c.likely_different_people ? 1 : 0); // #393
  clusters.sort((a, b) =>
    isStrong(b) - isStrong(a) ||
    b.top_containment - a.top_containment || b.top_jaccard - a.top_jaccard || a.span_km - b.span_km
  );
  const shown = clusters.slice(0, opts.cap);

  return {
    method: "near-name token-Jaccard within a metro (proximity-gated, distinctive-token, #278)",
    note:
      "PROPOSES only — no write/merge/delete. LEXICAL overlap on DISTINCTIVE tokens " +
      "(#278: generic type words park/pier/museum/… carry no weight). Sorted so " +
      "containment-1.0-AND-same_category (the real reworded-dup signal) ranks first; " +
      "a high-containment cluster with same_category:false is a different-category " +
      "sub-attraction (e.g. a Cistern inside a Park), not a merge — reject it. " +
      "Fully-reworded or far+reworded dups are #228's semantic pass, not this. " +
      "#393: likely_different_people = every edge is a generational / different-given-name " +
      "grave pair or a grave vs a place named for the person — listed, not alerted. " +
      "Before merging anything here, compare resolved_description bios (#382).",
    params: { prox_km: opts.proxKm, jaccard_min: opts.jaccard, cell_deg: CELL, cap: opts.cap },
    considered,
    pairs_qualified,
    flagged: clusters.length,
    likely_different_people: clusters.filter((c) => c.likely_different_people).length, // #393
    shown: shown.length,
    clusters: shown,
  };
}

// #140 — REJECTED-RESUBMIT signal. A MIRROR of review-submission's #31 findDuplicate
// matcher (dupNormName / dupTokens / dupTokenRatio + the DUP_* radii), run here
// against REJECTED rows instead of approved+pending. THIS IS A COPY (the #141 shape):
// if the #31 constants or token rules change in review-submission, change REJ_* here
// too, or this signal quietly drifts from what the gate actually merges on. The
// divergence is harmless in the safe direction (a missed flag is a missed eyeball,
// never a write) — which is why a copy is acceptable for a read-only report.
const REJ_SAME_CAT_M = 75;   // mirrors DUP_SAME_CAT_M (#54's radius, same/null category)
const REJ_CROSS_CAT_M = 25;  // mirrors DUP_CROSS_CAT_M (one place, two buckets)
const REJ_TOKEN_RATIO = 0.6; // mirrors DUP_TOKEN_RATIO (shared / min(tokens))
const REJ_STOPWORDS = new Set(["the", "a", "an", "of", "at", "in", "on", "and", "or", "to", "for"]);
function rejNormName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function rejTokens(s: string | null | undefined): Set<string> {
  return new Set(
    (s ?? "").toLowerCase()
      .replace(/['\u2019]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !REJ_STOPWORDS.has(t)),
  );
}
function rejTokenRatio(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}
function rejNameHit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = rejNormName(a), nb = rejNormName(b);
  if (na && na === nb) return true;
  return rejTokenRatio(rejTokens(a), rejTokens(b)) >= REJ_TOKEN_RATIO;
}

// ANCHORS = every rejected, un-merged row (user rejections AND retired seeds — a
// retired seed that users keep submitting is the same "was the call right?" signal,
// split out by anchor_source so the two read separately). RESUBMITS = LATER rows
// (created after the anchor) whose source is 'user' (only a person's submission is
// evidence; a seed load is not), matched by the #31 rule. A later row MERGED INTO the
// anchor is excluded — that vouch landed while the anchor was still live (a seed
// before its retirement), so it isn't a resubmission of a rejected place.
function summariseRejectedResubmits(rows: any[], opts: { minResubmits: number; cap: number }) {
  const anchors = rows.filter((r) => r && r.status === "rejected" && !r.merged_into &&
    typeof r.lat === "number" && typeof r.lng === "number");
  const users = rows.filter((r) => r && r.source === "user" &&
    typeof r.lat === "number" && typeof r.lng === "number");
  const rejected_by_source: Record<string, number> = {};
  for (const a of anchors) inc(rejected_by_source, a.source);

  let resubmits_total = 0;
  const by_later_status: Record<string, number> = {};
  const clusters: any[] = [];
  // Oldest anchor first, and an anchor that is ITSELF a counted resubmission of an
  // older rejected anchor is skipped — otherwise a chain (rejected, resubmitted and
  // rejected again, resubmitted again) lists the same place twice.
  anchors.sort((x, y) => (ms(x.created_at) ?? 0) - (ms(y.created_at) ?? 0));
  const counted = new Set<string>();
  for (const a of anchors) {
    if (counted.has(a.id)) continue;
    const aT = ms(a.created_at) ?? 0;
    const hits: any[] = [];
    for (const u of users) {
      if (u.id === a.id) continue;
      if (u.merged_into && u.merged_into === a.id) continue;
      const uT = ms(u.created_at);
      if (uT === null || uT <= aT) continue;
      const m = haversineKm(a.lat, a.lng, u.lat, u.lng) * 1000;
      if (m > REJ_SAME_CAT_M) continue;
      const nameHit =
        rejNameHit(u.name, a.name_clean || a.name) || rejNameHit(u.name, a.name) ||
        rejNameHit(u.name_clean, a.name_clean || a.name);
      if (!nameHit) continue;
      const catOk = a.category == null || u.category == null || a.category === u.category;
      if (!(catOk ? m <= REJ_SAME_CAT_M : m <= REJ_CROSS_CAT_M)) continue;
      hits.push({ u, m });
    }
    if (!hits.length) continue;
    for (const h of hits) counted.add(h.u.id);
    resubmits_total += hits.length;
    const later_statuses: Record<string, number> = {};
    for (const h of hits) { inc(later_statuses, h.u.status); inc(by_later_status, h.u.status); }
    const now_live = hits.some((h) => h.u.status === "approved" && !h.u.merged_into);
    let last = 0;
    for (const h of hits) last = Math.max(last, ms(h.u.created_at) ?? 0);
    clusters.push({
      anchor_id: a.id,
      name: a.name_clean || a.name,
      category: a.category ?? null,
      anchor_source: a.source ?? null,
      rejected_row_created_at: a.created_at,
      rejection_reason: a.ai_reason ?? null, // the gate's verdict (operator-only, #115); null for a retired seed
      resubmits: hits.length,
      later_statuses,
      now_live, // true => a later resubmission is already approved; the rejection was effectively reversed
      last_resubmit_at: last ? new Date(last).toISOString() : null,
      max_m: Math.round(Math.max(...hits.map((h) => h.m))),
      later_names: [...new Set(hits.map((h) => h.u.name_clean || h.u.name))].slice(0, 5),
    });
  }
  // Actionable first: not yet live, most resubmits, most recent.
  clusters.sort((x, y) =>
    (Number(x.now_live) - Number(y.now_live)) ||
    (y.resubmits - x.resubmits) ||
    String(y.last_resubmit_at).localeCompare(String(x.last_resubmit_at)));
  const flagged = clusters.filter((c) => !c.now_live && c.resubmits >= opts.minResubmits);
  return {
    note: "A place rejected once and then submitted again by users — evidence the rejection MAY have been wrong. PROPOSE-only: the action is a human re-look (pending_review / approve_submission), NEVER an automatic un-reject. Counts SUBMISSIONS, not people (submitted_by is never read), so one person resubmitting reads like several. Matcher mirrors review-submission's #31 rule.",
    params: { min_resubmits: opts.minResubmits, same_cat_m: REJ_SAME_CAT_M, cross_cat_m: REJ_CROSS_CAT_M, token_ratio: REJ_TOKEN_RATIO },
    rejected_rows: anchors.length,
    rejected_by_source,
    anchors_with_resubmits: clusters.length,
    resubmits_total,
    by_later_status,
    still_rejected_with_resubmits: clusters.filter((c) => !c.now_live).length,
    flagged: flagged.length, // not live AND >= min_resubmits — what the alert fires on
    clusters: clusters.slice(0, opts.cap),
    clusters_capped: clusters.length > opts.cap,
  };
}


// --- v11: computed triage ("alerts") -----------------------------------------
//
// PURPOSE. Turn the morning read from "scan every section" into "read five lines."
// Every signal below already exists as a FIELD elsewhere in the digest; this block
// only DERIVES from the assembled `report` object — it does NO new DB read, NO
// write, and holds NO state. It runs LAST (all sections present) but renders FIRST
// (the `alerts:null` placeholder near the top holds its position). It is isolated
// in its own try/catch at the call site, so a bug here can never blank the digest —
// exactly the per-section isolation every other block keeps.
//
// LEVELS. critical = something is broken or actively wrong (a section failed to
// read; the AI gate failed open and rows are stuck). warn = needs attention soon
// (vocab drift, pins crowd-suppressed, model running on a fallback, an aging review
// backlog). info = worth knowing / actionable-but-not-urgent (merges waiting, a
// config default in force). `ok` is true ONLY when nothing critical or warn fired.
//
// This is observability on an operator surface (the #71/#125/#144/#266/#317 line),
// so it does NOT by itself move the %. It reads config INDIRECTLY (fallback_rows =>
// GEMINI_MODEL may be unset; threshold.secret_ignored => a REPORT_SUPPRESS_THRESHOLD
// secret nothing reads since #141), so the report now does the outside-the-file
// config watch for you — but it changes nothing about how the function is deployed.
function computeAlerts(report: Record<string, any>, opts: { backlogWarnH: number; descHideWarn: number; osmRemoveWarn: number }) {
  const items: Array<{ level: string; code: string; message: string; detail?: unknown }> = [];
  const push = (level: string, code: string, message: string, detail?: unknown) =>
    items.push(detail === undefined ? { level, code, message } : { level, code, message, detail });

  // A section failed to read (top-level errors[] is non-empty). CRITICAL — the rest
  // of the digest is partial, so every other alert below may be understated.
  const errs = Array.isArray(report.errors) ? report.errors : [];
  if (errs.length) push("critical", "section_read_error", `${errs.length} report section(s) failed to read`, errs);

  const subs = report.submissions || {};
  const gate = subs.ai_gate || {};
  const fo = gate.fail_open || {};
  // #71 fail-open. pending>0 is the live emergency (rows stuck after the gate
  // errored); total>0 with pending 0 is a healed historical blip worth noting.
  if ((fo.pending || 0) > 0) {
    push("critical", "fail_open_pending",
      `${fo.pending} submission(s) stuck pending after the AI gate failed open`,
      { oldest_pending_age_hours: fo.oldest_pending_age_hours, by_ai_status: fo.by_ai_status });
  } else if ((fo.total || 0) > 0) {
    push("warn", "fail_open_seen",
      `${fo.total} submission(s) hit an AI-gate error historically (none stuck now)`,
      { by_ai_status: fo.by_ai_status });
  }
  // item 70: model ran on the fallback (GEMINI_MODEL likely unset).
  if ((gate.fallback_rows || 0) > 0) {
    push("warn", "ai_model_fallback",
      `${gate.fallback_rows} submission(s) scored on a FALLBACK model — GEMINI_MODEL may be unset`);
  }
  // #115: ai_reason coverage. The verdict text is written on every review with a
  // guard against a blank, so a reviewed row carrying NO reason means the guard was
  // bypassed or the row predates the field — an eyeball, not an emergency (info).
  const reasons = gate.reasons || {};
  if ((reasons.blank_reviewed || 0) > 0) {
    push("info", "ai_reason_blank",
      `${reasons.blank_reviewed} reviewed submission(s) carry no AI verdict text (ai_reason blank) — the writer guards against this, so check the gate isn't dropping it`,
      { reviewed: reasons.reviewed, with_reason: reasons.with_reason, by_decision: reasons.blank_by_decision });
  }

  // Human-review backlog. info by default; warn once the oldest crosses the tunable.
  const backlog = subs.backlog || {};
  if ((backlog.pending || 0) > 0) {
    const age = backlog.oldest_pending_age_hours;
    const level = age != null && age > opts.backlogWarnH ? "warn" : "info";
    push(level, "review_backlog",
      `${backlog.pending} submission(s) pending human review${age != null ? `, oldest ${age}h` : ""}`,
      { oldest_pending_age_hours: age, warn_over_h: opts.backlogWarnH });
  }

  // #106/#141 reports arm.
  const rep = report.reports || {};
  const unknown = Array.isArray(rep.unknown_reasons) ? rep.unknown_reasons : [];
  if (unknown.length) {
    push("warn", "report_vocab_drift",
      `report table holds ${unknown.length} reason(s) this dashboard doesn't know: ${unknown.join(", ")}`,
      unknown);
  }
  const supp = rep.suppression || {};
  const crowdOver = supp.targets_at_or_over || 0;
  const aiRemoved = supp.targets_ai_removed || 0;
  const suppressedTotal = supp.targets_suppressed != null ? supp.targets_suppressed : (crowdOver + aiRemoved);
  if (suppressedTotal > 0) {
    push("warn", "pins_suppressed",
      `${suppressedTotal} pin(s) suppressed at serve time (${crowdOver} crowd at/over threshold, ${aiRemoved} AI 'remove') — review whether each is genuinely gone/bogus`,
      { by_reason: supp.by_reason, sample: supp.sample });
  }
  // #350 — a lone AI 'remove' can hide a real pin (#347's fast path), so call it
  // out on its own: this is the single-report removal the operator most wants to
  // eyeball, distinct from a crowd that voted a pin down.
  if (aiRemoved > 0) {
    push("warn", "pins_ai_removed",
      `${aiRemoved} pin(s) hidden by a confident AI 'remove' on a single content report (#347) — confirm each is genuinely obscene/spam, a lone report can still remove`);
  }
  const stale = supp.stale_open_reports || {};
  if ((stale.targets || 0) > 0) {
    push("info", "stale_open_reports",
      `${stale.targets} open report(s) target a gem that is no longer on the map (rejected / retired / pending / merged) — nothing is hidden; close each with resolve_report or dismiss_report (#393)`,
      stale.sample);
  }
  if ((supp.targets_one_away || 0) > 0) {
    push("info", "pins_near_suppression", `${supp.targets_one_away} pin(s) one report away from crowd suppression`);
  }
  // #141 (v22) — `suppress_threshold_unset` retired (it fired on every run; the
  // bars now live in report_reason_meta). The one config fact left to watch is a
  // stale secret nothing reads.
  const thr = rep.threshold || {};
  if (thr.secret_ignored === true) {
    push("warn", "report_threshold_secret_ignored",
      "REPORT_SUPPRESS_THRESHOLD is set but nothing reads it since #141 — thresholds live in report_reason_meta. Delete the secret so nobody tunes a dead knob.",
      { by_reason: thr.by_reason });
  }

  // #266 pin_audit — merges waiting for an operator (propose-only; these are safe,
  // actionable cleanups, hence info not warn).
  const pa = report.pin_audit || {};
  const exact = pa.exact_name || {};
  if ((exact.colocated || 0) > 0) {
    push("info", "duplicate_merges_waiting",
      `${exact.colocated} co-located exact-name duplicate cluster(s) with 2+ live pins — review, then merge`,
      { flagged: exact.flagged });
  }
  const near = pa.near_name || {};
  const nearClusters = Array.isArray(near.clusters) ? near.clusters : [];
  // Only the strong signal: containment ~1.0 AND same_category (the real reworded
  // dup, per #278) — a different-category high-containment pair is a sub-attraction,
  // not a merge, and must NOT raise an alert.
  // #393 — and not a likely-different-people cluster (father/son, same-plot family,
  // a grave vs the place named for the person). Worded as REVIEW, not merge.
  const strongNear = nearClusters.filter((c: any) => c && c.top_containment >= 0.99 && c.same_category && !c.likely_different_people).length;
  if (strongNear > 0) {
    push("info", "near_dup_merges_waiting",
      `${strongNear} reworded same-category duplicate candidate(s) to review — compare the bios before merging (#382)`);
  }

  // v12 descriptions / #344 story-gate preview. These make the hide-gate NON-silent:
  // would_hide is what brick 5 WOULD drop (info while small; warn past the tunable so
  // a growing hidden set surfaces on the morning read — the "hidden and we don't know
  // it" concern); story_but_blank is the opposite silent failure (a source set but no
  // text — renders blank, not hidden); unresolved_null is the never-checked backlog
  // that stays visible but owes a #319 resolve.
  const desc = report.descriptions || {};
  const wh = desc.would_hide || {};
  if ((wh.total || 0) > 0) {
    const level = (wh.total || 0) > opts.descHideWarn ? "warn" : "info";
    push(level, "story_gate_would_hide",
      `${wh.total} vouched place(s) have no resolved story (resolved_source='none') — the #344 story-gate hides these. Every one is human-recommended, so RESCUE before hiding: source a description via #318 (Places/curated) — see rescue_queue for the full list and the lever per pin`,
      { by_category: wh.by_category, by_source: wh.by_source, warn_over: opts.descHideWarn, rescue_queue: wh.rescue_queue, rescue_queue_capped: wh.rescue_queue_capped });
  }
  const sbk = desc.story_but_blank || {};
  if ((sbk.total || 0) > 0) {
    push("warn", "story_source_but_blank",
      `${sbk.total} approved pin(s) claim a resolved story (resolved_source set) but have an EMPTY resolved_description — they render BLANK rather than hide (the Disney/gen-blank class the none-gate can't catch)`,
      { sample: sbk.sample });
  }
  const un = desc.unresolved_null || {};
  if ((un.total || 0) > 0) {
    push("info", "descriptions_unresolved",
      `${un.total} approved pin(s) never resolved a description (resolved_source null) — visible today, but owe a resolve (#319 sweep)`,
      { by_category: un.by_category });
  }

  // #370: the OSM/tile-layer removal backlog — the sibling of story_gate_would_hide,
  // so the morning read shows BOTH the gem/seed layer and the OSM layer. info while
  // small; warn past osm_remove_warn so a growing storyless-OSM set surfaces. Banked
  // by nearby-places on cold builds (#369); this only reads/aggregates it. tiles===0
  // is "not yet warmed", not an alert — no warm, no signal, so it stays quiet.
  const owr = report.osm_would_remove || {};
  if ((owr.total || 0) > 0) {
    const level = (owr.total || 0) > opts.osmRemoveWarn ? "warn" : "info";
    push(level, "osm_story_gate_would_remove",
      `${owr.total} storyless OSM/tile pin(s) across ${owr.tiles || 0} banked tile(s) — the #367 universal story-gate removes these on the live serve path. The OSM analog of the gem rescue queue: cross-reference the busy ones (pass ?rank=N for the Places-ranked order) and source a description (#318 curated/Places, or seed into the human layer) for the ones worth keeping`,
      { by_category: owr.by_category, tiles: owr.tiles, freshness: owr.freshness, warn_over: opts.osmRemoveWarn, sample: owr.sample });
  }

  // #140: a rejected place users keep submitting and that is STILL not live. info —
  // a re-look prompt, never an emergency and never an auto-action (#132).
  const rr = report.rejected_resubmits || {};
  if ((rr.flagged || 0) > 0) {
    const flaggedList = (Array.isArray(rr.clusters) ? rr.clusters : [])
      .filter((c: any) => c && !c.now_live && c.resubmits >= ((rr.params || {}).min_resubmits || 2))
      .map((c: any) => ({ anchor_id: c.anchor_id, name: c.name, anchor_source: c.anchor_source, resubmits: c.resubmits, rejection_reason: c.rejection_reason }));
    push("info", "rejected_place_resubmitted",
      `${rr.flagged} rejected place(s) re-submitted ${(rr.params || {}).min_resubmits || 2}+ times and still not live — the rejection may have been wrong; re-look by hand (never auto-un-reject)`,
      flaggedList);
  }

  const counts = { critical: 0, warn: 0, info: 0 };
  for (const it of items) counts[it.level as keyof typeof counts] = (counts[it.level as keyof typeof counts] || 0) + 1;
  // Most severe first so the eye lands on what matters; stable within a level.
  const order: Record<string, number> = { critical: 0, warn: 1, info: 2 };
  items.sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));

  return {
    ok: counts.critical === 0 && counts.warn === 0, // true => nothing needs you today
    counts,
    items,
  };
}

// --- handler -----------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);

  const expected = Deno.env.get("REPORT_TOKEN");
  if (!expected) {
    return json({ error: "REPORT_TOKEN is not set — configure the secret before using this endpoint." }, 500);
  }

  const url = new URL(req.url);
  // v10: the token may carry a throwaway nonce suffix — `<secret>~<nonce>` — so the
  // token STRING varies per request without the secret changing. This is the one
  // lever that reaches a DOWNSTREAM fetch-tool cache: web_fetch normalises this URL
  // down to the `token` param alone (the #144/#317 replay — every other param,
  // including ?cb=, is stripped before the request leaves this side), so `token` is
  // the only value that can differ enough to miss a replay cache. We validate ONLY
  // the part before the first `~` against the secret; anything after it is ignored
  // for auth and echoed back as `token_nonce` so a fresh read is self-evident in the
  // body. `~` is safe: a URL-unreserved char that never appears in the base64url
  // REPORT_TOKEN. A BARE token (no `~`) is unchanged — split[0] IS the whole token,
  // so existing callers and the `x-report-token` header path keep working verbatim.
  const rawToken = req.headers.get("x-report-token") || url.searchParams.get("token") || "";
  const tokenParts = rawToken.split("~");
  const provided = tokenParts[0];
  const tokenNonce = tokenParts.length > 1 ? tokenParts.slice(1).join("~") : null;
  if (provided !== expected) return json({ error: "unauthorized" }, 401);

  const step = clampNum(parseFloat(url.searchParams.get("grid") || "0.05"), 0.005, 5, 0.05);
  const sampleN = clampNum(parseInt(url.searchParams.get("sample") || "25", 10), 0, 200, 25);
  // #266 pin_audit tunables (query-overridable, never magic numbers):
  //   dup_metro_km  — nearest-pair cutoff above which a same-name cluster is a
  //                   namesake, not a duplicate (default 40 km; Montrose is 3.2).
  //   dup_colo_km   — at/under this, the cluster is a co-located plain duplicate
  //                   rather than a displaced one (default 0.15 km = 150 m).
  //   audit=0       — skip the duplicate audit entirely.
  const dupMetroKm = clampNum(parseFloat(url.searchParams.get("dup_metro_km") || "40"), 0.5, 500, 40);
  const dupColoKm = clampNum(parseFloat(url.searchParams.get("dup_colo_km") || "0.15"), 0.01, 50, 0.15);
  const runAudit = (url.searchParams.get("audit") || "1") !== "0";
  // #266 near-dup arm tunables:
  //   nd_prox_km  — max distance between two reworded names to be the same place
  //                 (default 2 km; a same-place dup sits on itself).
  //   nd_jaccard  — min token-overlap to flag (default 0.5; "mr beef" vs
  //                 "mr beef on orleans" = 0.5).
  //   near=0      — skip only the near-dup arm (exact_name still runs).
  const ndProxKm = clampNum(parseFloat(url.searchParams.get("nd_prox_km") || "2"), 0.05, 50, 2);
  const ndJaccard = clampNum(parseFloat(url.searchParams.get("nd_jaccard") || "0.5"), 0.1, 1, 0.5);
  const runNear = (url.searchParams.get("near") || "1") !== "0";
  // v11 alerts tunable (query-overridable, never a magic number):
  //   backlog_warn_h — a human-review backlog older than this many hours escalates
  //                    the review_backlog alert from info to warn (default 48).
  const backlogWarnH = clampNum(parseFloat(url.searchParams.get("backlog_warn_h") || "48"), 1, 8760, 48);
  // v12 descriptions tunable (query-overridable, never a magic number):
  //   desc_hide_warn — the #344 story-gate would-hide count (resolved_source='none')
  //                    escalates the story_gate_would_hide alert from info to warn
  //                    above this (default 250; today's none-set is ~90, so a
  //                    ballooning silent-hide set trips the morning read).
  const descHideWarn = clampNum(parseInt(url.searchParams.get("desc_hide_warn") || "250", 10), 1, 100000, 250);
  // #140 rejected_resubmits tunable (query-overridable, never a magic number):
  //   rr_min — a rejected place needs at least this many LATER user resubmissions
  //            (and no approved one) to raise the rejected_place_resubmitted alert
  //            (default 2 — one resubmission is noise, two is a pattern).
  const rrMin = clampNum(parseInt(url.searchParams.get("rr_min") || "2", 10), 1, 1000, 2);
  // #370 osm_would_remove tunables:
  //   osm_remove_warn — the storyless-OSM count above which osm_story_gate_would_remove
  //                     escalates info -> warn (default 25000 since v21; was 500 until
  //                     the #292 pre-warm banked the whole 21-metro roster at ~16.7k.
  //                     Far higher than desc_hide_warn because the OSM layer is far
  //                     larger and removal there is the designed #367 behaviour, not a
  //                     rescue backlog to clear by hand. Re-base after a roster expansion
  //                     is pre-warmed, or the alert goes permanently yellow again).
  const osmRemoveWarn = clampNum(parseInt(url.searchParams.get("osm_remove_warn") || "25000", 10), 1, 1000000, 25000);
  //   rank — 0 (default) = daily read, pure DB aggregation, ZERO Places calls. >0 =
  //          forward that N to nearby-places' would_remove action for the bounded,
  //          quota-capped Places-ranked queue, folded in under osm_would_remove.popular.
  //          Capped at 40 (nearby-places' own WOULDREMOVE_RANK_MAX) so a stray large
  //          value can't ask for an unbounded Places spend.
  const osmRank = clampNum(parseInt(url.searchParams.get("rank") || "0", 10), 0, 40, 0);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not injected" }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const now = Date.now();
  const errors: string[] = [];

  // v8: cache-buster echo. `saw_params` is every query key the function actually
  // received EXCEPT token (never echoed). If you append ?cb=abc and the response
  // shows cache_buster:"abc" AND "cb" in saw_params, this is a fresh run; if the
  // cb is missing or stale, you're reading a replayed cache (the #144 failure
  // mode) — not a shipped-vs-live discrepancy. Token is filtered so it never leaks.
  const echoKeys = [...url.searchParams.keys()].filter((k) => k !== "token");

  const report: Record<string, unknown> = {
    report_version: REPORT_VERSION,
    generated_at: new Date().toISOString(),
    params: { grid_deg: step, sample: sampleN },
    request_echo: {
      cache_buster: url.searchParams.get("cb"),
      // v10: the SURVIVING-param freshness signal. Unlike `cache_buster` (a ?cb=
      // query param the fetch tool strips), this nonce rides INSIDE the token value,
      // which survives normalisation — so if `token_nonce` reflects the value you
      // sent on THIS request, you are reading a fresh generation, not a replay.
      // null = a bare token with no `~<nonce>` suffix. Never contains the secret
      // (only the part AFTER the first `~` is captured; the secret is tokenParts[0]).
      token_nonce: tokenNonce,
      saw_params: echoKeys,
    },
    ai_config: { configured_model: Deno.env.get("GEMINI_MODEL") || null },
    // v11: computed triage, filled AFTER every section is assembled (see the tail
    // of the handler). Declared here as a placeholder so it renders near the TOP of
    // the JSON — reassigning an existing key keeps its insertion position — which is
    // the whole point: the morning read is the `alerts` block, not a scan of 300
    // lines. null only if the alerts pass itself threw (surfaced in `errors`).
    alerts: null,
  };

  // #393 — the reports arm needs each gem's served/not-served state, from the SAME
  // submissions pull (one scan). null if that read failed → reports behave as before.
  let liveGem: Map<string, boolean> | null = null;
  try {
    const subs = await fetchAll(
      supabase,
      "submissions",
      "id,name,name_clean,category,status,source,lat,lng,created_at,ai_decision,ai_status,ai_http_status,ai_model,ai_model_source,ai_confidence,ai_reason,ai_reviewed_at,merged_into,resolved_source,resolved_description",
    );
    report.submissions = summariseSubmissions(subs, now, step, sampleN);
    liveGem = new Map<string, boolean>();
    for (const r of subs) {
      if (r && r.id) liveGem.set(String(r.id), r.status === "approved" && (r.merged_into === null || r.merged_into === undefined));
    }
    // v12: the descriptions / story-gate arm reuses the SAME subs pull (one scan,
    // one home — the #266 pin_audit pattern) and is isolated in its own try so a bug
    // in it can never blank the rest of the submissions digest.
    try {
      report.descriptions = summariseDescriptions(subs, sampleN, step);
    } catch (e) {
      errors.push("descriptions: " + (e as Error).message);
    }
    // #140: the rejected-resubmit signal reuses the SAME subs pull (one scan, one
    // home) and is isolated so a bug in it can never blank the submissions digest.
    try {
      report.rejected_resubmits = summariseRejectedResubmits(subs, { minResubmits: rrMin, cap: Math.max(sampleN, 10) });
    } catch (e) {
      errors.push("rejected_resubmits: " + (e as Error).message);
    }
    // #266: the duplicate self-audit reuses the SAME subs pull (one scan, one
    // home) and is isolated in this try so a bug in it can never blank the rest
    // of the submissions digest. audit=0 skips it.
    if (runAudit) {
      try {
        const exact_name = auditDuplicates(subs, { metroKm: dupMetroKm, coloKm: dupColoKm, cap: 80 });
        const pin_audit: Record<string, unknown> = { exact_name };
        // #266 near-dup arm — reworded same-metro dups exact_name can't see.
        if (runNear) {
          pin_audit.near_name = auditNearNames(subs, { proxKm: ndProxKm, jaccard: ndJaccard, cap: 80 });
        }
        report.pin_audit = pin_audit;
      } catch (e) {
        errors.push("pin_audit: " + (e as Error).message);
      }
    }
  } catch (e) {
    errors.push("submissions: " + (e as Error).message);
  }

  try {
    // #106: the user liveness reports. Its own try/catch so a schema surprise
    // (e.g. a missing column) surfaces in `errors` and can never blank the rest
    // of the digest — the same isolation pin_audit and every section keep.
    // #350 — ai_verdict is SELECTED so the suppression view can mirror #347's
    // AI-remove fast path (a confident 'remove' hides a pin on one report). The
    // ai_* columns are #347's, server-write-only; this read is service-role.
    // #141 (v22) — the rules are read, not mirrored: the same table nearby-places
    // validates and suppresses against. Read first; a failure fails this section.
    const metaRows = await fetchAll(supabase, "report_reason_meta", "reason,suppresses,threshold,ai_acts");
    const rows = await fetchAll(supabase, "reports", "target_id,reported_by,reason,status,created_at,ai_verdict");
    report.reports = summariseReports(rows, metaRows, now, sampleN, liveGem);
  } catch (e) {
    errors.push("reports: " + (e as Error).message);
  }

  try {
    const rows = await fetchAll(supabase, "user_state", "user_id,key,updated_at");
    report.engagement = summariseUserState(rows, now);
  } catch (e) {
    errors.push("user_state: " + (e as Error).message);
  }

  try {
    const rows = await fetchAll(supabase, "shared_kv", "key,updated_at");
    report.shared_content = summariseSharedKv(rows, now);
  } catch (e) {
    errors.push("shared_kv: " + (e as Error).message);
  }

  // #370: the OSM/tile-layer would_remove backlog. A SEPARATE, bounded value-bearing
  // read of just the `wouldremove:w1:%` namespace (summariseSharedKv above stays a
  // key-only scan — pulling every `places:%` tile blob's value would be megabytes),
  // then pure aggregation. Own try/catch, so a parse/read surprise can never blank the
  // rest of the digest — the isolation every section keeps.
  try {
    const wrRows = await fetchByKeyPrefix(supabase, "wouldremove:w1:");
    const osm = summariseOsmWouldRemove(wrRows, now, sampleN);
    // Popularity is OPT-IN only: on ?rank=N, forward to nearby-places' would_remove
    // action (the one home of the Places-ranked queue — this file never calls Places
    // itself) and fold the rating-sorted queue in under `popular`. Nested try so a
    // nearby-places hiccup leaves the aggregated section intact and just notes it.
    if (osmRank > 0) {
      try {
        const res = await fetch(SUPABASE_URL + "/functions/v1/nearby-places", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + SERVICE_KEY,
            "apikey": SERVICE_KEY,
          },
          body: JSON.stringify({ action: "would_remove", rank: osmRank }),
        });
        if (res.ok) {
          const nr = await res.json();
          (osm as any).popular = {
            source: "nearby-places would_remove?rank=" + osmRank,
            would_remove_version: nr && nr.wouldRemoveVersion,
            key_present: nr && nr.key_present, // is GOOGLE_PLACES_KEY set on nearby-places
            ranked: (nr && nr.ranked) || 0, // pins that got a live Places rating this call
            rank_debug: nr && nr.rank_debug, // rated/noresult/namereject/offpin/httpNNN — quota vs guard at a glance
            queue: nr && Array.isArray(nr.queue) ? nr.queue.slice(0, sampleN) : [],
          };
        } else {
          (osm as any).popular = { error: "nearby-places would_remove HTTP " + res.status };
        }
      } catch (fe) {
        (osm as any).popular = { error: "nearby-places would_remove: " + (fe as Error).message };
      }
    }
    report.osm_would_remove = osm;
  } catch (e) {
    errors.push("osm_would_remove: " + (e as Error).message);
  }

  try {
    report.accounts = await summariseAuth(supabase, now);
  } catch (e) {
    errors.push("auth: " + (e as Error).message);
  }

  report.errors = errors; // empty array = every section read cleanly

  // v11: compute the triage LAST (every section is present) and fill the early
  // placeholder. Isolated so a bug in the derivation can never blank the digest —
  // it surfaces in errors and leaves alerts as an explicit failure marker instead.
  try {
    report.alerts = computeAlerts(report, { backlogWarnH, descHideWarn, osmRemoveWarn });
  } catch (e) {
    errors.push("alerts: " + (e as Error).message);
    report.alerts = { ok: false, counts: { critical: 0, warn: 0, info: 0 }, items: [], error: (e as Error).message };
  }

  return json(report);
});
