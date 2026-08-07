// =============================================================================
// capture-verify — Nahgoo leaderboard PHASE 1: the verification engine (#249).
//
// PURPOSE. The one place a capture becomes a TRUSTED stamp. The phone never
// reports a score — it POSTs a capture ATTEMPT (a pin id + the device's GPS +
// a timestamp) and THIS function decides whether it counts, then banks a
// per-user server-trusted count in leaderboard_scores. This is the honest form
// of a capture count (#127): the trust boundary lives on the server, not the
// device. The private on-device passport is untouched and is NOT read here.
//
// THE RULE, for EVERY pin type: the server proves the place is REAL and proves
// the device was within range of it. The client's carried pin coordinates are
// IGNORED — for a gem we read the authoritative coordinate from `submissions`;
// for a real (OSM/Wikipedia) pin we re-resolve it via the `nearby-places`
// function at the device's location. A shared `?spot=` pin (#26) carries its
// own coords in the URL; those are exactly the coords we refuse to trust, so a
// spot is re-resolved the same way. Trusting carried coords would be a wide-open
// forgery hole.
//
// WHAT THE SERVER CANNOT DO (state it honestly). A web app cannot cryptograph-
// ically prove location: GPS is browser-reported and spoofable on a rooted
// device. This function beats (a) editing the count (the server owns it),
// (b) claiming a pin that does not exist (existence check), (c) teleport /
// impossible speed (physics gate), and (d) trusting a shared pin's carried
// coords (re-resolve). Feeding a plausible fake GPS at a real place is the
// residual ceiling — capture_log is the reversible trail that lets an anomalous
// entry be frozen after the fact (record-now-judge-later, #4/#40c).
//
// DEPLOY. supabase functions deploy capture-verify
//   Deploy WITH jwt verification (i.e. do NOT pass --no-verify-jwt): the caller
//   is an authenticated user and we resolve their id from the session JWT. A
//   capture with no session is rejected — a stamp must belong to someone.
// DEPLOY ORDER (§2): 249_leaderboard_engine.sql (the two tables) must exist
//   BEFORE this function is invoked; the index.html capture-path wiring is a
//   LATER pass and must ship AFTER this function (client fails soft until then —
//   captures still work locally, they just don't score).
//
// CONFIG OUTSIDE THIS FILE. None to set by hand. SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are all auto-injected by the
//   platform. (The anon key is used only to call the sibling nearby-places
//   function, which requires an Authorization bearer — it is NOT --no-verify-jwt.)
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// Bump on every deployed change so QA step 1 can confirm the running build.
const ENGINE_VERSION = "capture-verify-v1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// --- tunables (STARTING numbers — re-derive from capture_log, do not treat as
// settled). Every one of these is a threshold the log lets you tighten later. --
//
// Client capture gate tops out at 75 m (effectiveCaptureRange: floor
// FOUND_THRESHOLD_M=25, widened to GPS accuracy, capped 75). The server radius
// sits ABOVE that ceiling plus slack for the difference between the client's pin
// coord and the server's authoritative coord (real pins re-resolve to an OSM
// centroid that can differ from what the client drew). Deliberately generous so
// a legitimately-gated capture is never rejected; it only catches gross spoofs.
const SERVER_CAPTURE_RADIUS_M = 150;
const MAX_SPEED_MPS = 300;          // ~670 mph — allows a real flight, kills teleport. Rejects IMPOSSIBLE, never merely fast.
const BURST_WINDOW_MS = 10 * 60 * 1000; // 10 min
const BURST_MAX = 20;               // >20 verified-or-pending captures in the window -> FLAG (held, not counted)

const GEM_PREFIX = "catgem";        // gemToPoint mints 'catgem'<submissions.id> (#149; lore routed through it too)

// --- geo ---------------------------------------------------------------------
function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Normalised token set for the real-pin name-match fallback (when an exact id
// match is unavailable — e.g. a re-encoded shared spot). Mirrors the app's
// name-subset spirit (#54) without importing it.
function nameTokens(s: string): Set<string> {
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}
function nameMatch(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.size || !tb.size) return false;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  // one name's meaningful tokens are (mostly) a subset of the other's
  return overlap >= Math.min(ta.size, tb.size);
}

function pinTypeOf(pinId: string, gemSubmissionId: unknown): string {
  if (gemSubmissionId || pinId.startsWith(GEM_PREFIX)) return "gem";
  if (pinId.startsWith("osm_")) return "osm";
  if (pinId.startsWith("wiki_") || pinId.startsWith("wikiname_")) return "wiki";
  if (pinId.startsWith("spot_") || pinId.startsWith("spot")) return "spot";
  return "real"; // unknown non-gem shape still resolves through nearby-places
}

// --- authoritative resolution ------------------------------------------------
type Resolved =
  | { ok: true; lat: number; lng: number }
  | { ok: false; reason: string; soft?: boolean }; // soft=true -> FLAG (transient), not REJECT

async function resolveGem(supabase: any, pinId: string, gemSubmissionId: unknown): Promise<Resolved> {
  const subId = gemSubmissionId != null && gemSubmissionId !== ""
    ? String(gemSubmissionId)
    : pinId.slice(GEM_PREFIX.length);
  if (!subId) return { ok: false, reason: "gem_id_missing" };
  const { data, error } = await supabase
    .from("submissions")
    .select("id,lat,lng,status,merged_into")
    .eq("id", subId)
    .maybeSingle();
  if (error) return { ok: false, reason: "gem_lookup_failed", soft: true };
  if (!data) return { ok: false, reason: "gem_not_found" };
  if (data.status !== "approved") return { ok: false, reason: "gem_not_approved" };
  if (typeof data.lat !== "number" || typeof data.lng !== "number") {
    return { ok: false, reason: "gem_no_coords" };
  }
  return { ok: true, lat: data.lat, lng: data.lng };
}

async function resolveReal(
  baseUrl: string,
  anonKey: string,
  pinId: string,
  name: string,
  deviceLat: number,
  deviceLng: number,
): Promise<Resolved> {
  // Re-resolve the pin server-side by asking nearby-places what real places
  // exist at the device's location. nearby-places is NOT --no-verify-jwt, so it
  // requires an Authorization bearer — the anon key satisfies it.
  let places: any[] = [];
  try {
    const res = await fetch(`${baseUrl}/functions/v1/nearby-places`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${anonKey}`,
        "apikey": anonKey,
      },
      body: JSON.stringify({ lat: deviceLat, lng: deviceLng }),
    });
    if (!res.ok) return { ok: false, reason: "resolve_http_" + res.status, soft: true };
    const data = await res.json();
    places = Array.isArray(data?.places) ? data.places : [];
  } catch (_e) {
    return { ok: false, reason: "resolve_unavailable", soft: true };
  }

  // Strong path: exact id match on a real place nearby-places returned.
  const byId = places.find((p) => p && p.id === pinId && typeof p.lat === "number" && typeof p.lng === "number");
  if (byId) return { ok: true, lat: byId.lat, lng: byId.lng };

  // Fallback: a real place whose name matches AND sits within the capture radius
  // of the device. (Covers a re-encoded shared spot whose id didn't survive.)
  const byName = places.find(
    (p) =>
      p && typeof p.lat === "number" && typeof p.lng === "number" &&
      nameMatch(name, p.name) &&
      haversine(deviceLat, deviceLng, p.lat, p.lng) <= SERVER_CAPTURE_RADIUS_M,
  );
  if (byName) return { ok: true, lat: byName.lat, lng: byName.lng };

  // The place the client claims does not exist at this location -> fabricated.
  return { ok: false, reason: "place_not_found" };
}

// --- handler -----------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only", engineVersion: ENGINE_VERSION }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    return json({ error: "supabase env not injected", engineVersion: ENGINE_VERSION }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // --- identify the user from the session JWT (a stamp must belong to someone) -
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "no_session", engineVersion: ENGINE_VERSION }, 401);
  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
  const user = userData?.user;
  if (userErr || !user) return json({ error: "no_session", engineVersion: ENGINE_VERSION }, 401);

  // --- parse + validate the claim ---------------------------------------------
  const body = await req.json().catch(() => ({}));
  const pinId: string = typeof body?.pinId === "string" ? body.pinId : "";
  const name: string = typeof body?.name === "string" ? body.name : "";
  const deviceLat = Number(body?.deviceLat);
  const deviceLng = Number(body?.deviceLng);
  const gemSubmissionId = body?.gemSubmissionId; // present for gem / gem-backed spot pins
  const cap = body?.cap ?? null;                 // #4 integrity blob, stored raw
  if (!pinId || !Number.isFinite(deviceLat) || !Number.isFinite(deviceLng)) {
    return json({ error: "pinId, deviceLat, deviceLng required", engineVersion: ENGINE_VERSION }, 400);
  }

  const pinType = pinTypeOf(pinId, gemSubmissionId);
  const now = Date.now();

  // --- resolve authoritative coordinates (never the client's carried coords) --
  const resolved: Resolved = (pinType === "gem")
    ? await resolveGem(supabase, pinId, gemSubmissionId)
    : await resolveReal(SUPABASE_URL, ANON_KEY, pinId, name, deviceLat, deviceLng);

  // A row is written for EVERY outcome (the reversible trail). This helper logs
  // and returns the response in one place so no path forgets to record.
  const logAndRespond = async (
    status: "verified" | "rejected" | "flagged",
    reason: string | null,
    authLat: number | null,
    authLng: number | null,
    distance_m: number | null,
    speed_mps: number | null,
    is_new_pin: boolean,
    distinctPins: number,
    httpStatus = 200,
  ) => {
    await supabase.from("capture_log").insert({
      user_id: user.id,
      pin_id: pinId,
      pin_type: pinType,
      authoritative_lat: authLat,
      authoritative_lng: authLng,
      reported_lat: deviceLat,
      reported_lng: deviceLng,
      distance_m,
      speed_mps,
      status,
      reason,
      is_new_pin,
      cap,
    });
    return json({ engineVersion: ENGINE_VERSION, status, reason, distinctPins }, httpStatus);
  };

  // Load the user's current score row up front (its count is returned on every
  // outcome, and its last_* powers the physics gate on the verified path).
  const { data: scoreRow } = await supabase
    .from("leaderboard_scores")
    .select("distinct_pins,last_lat,last_lng,last_at")
    .eq("user_id", user.id)
    .maybeSingle();
  const currentCount: number = scoreRow?.distinct_pins ?? 0;

  if (!resolved.ok) {
    // soft = a transient resolution failure (nearby-places down, gem lookup
    // errored) -> FLAG and hold, do not punish a possibly-real capture as a
    // rejection. Hard failure (place_not_found, gem_not_approved) -> REJECT.
    const status = resolved.soft ? "flagged" : "rejected";
    return await logAndRespond(status, resolved.reason, null, null, null, null, false, currentCount);
  }

  const authLat = resolved.lat;
  const authLng = resolved.lng;
  const distance_m = haversine(deviceLat, deviceLng, authLat, authLng);

  // --- distance gate: device must be within range of the AUTHORITATIVE pin ----
  if (distance_m > SERVER_CAPTURE_RADIUS_M) {
    return await logAndRespond("rejected", "out_of_range", authLat, authLng, distance_m, null, false, currentCount);
  }

  // --- physics gate: speed from this user's previous VERIFIED capture ---------
  let speed_mps: number | null = null;
  if (scoreRow?.last_lat != null && scoreRow?.last_lng != null && scoreRow?.last_at) {
    const lastMs = Date.parse(scoreRow.last_at);
    const dt = (now - lastMs) / 1000;
    if (Number.isFinite(dt) && dt > 0) {
      const moved = haversine(scoreRow.last_lat, scoreRow.last_lng, deviceLat, deviceLng);
      speed_mps = moved / dt;
      if (speed_mps > MAX_SPEED_MPS) {
        return await logAndRespond("rejected", "impossible_speed", authLat, authLng, distance_m, speed_mps, false, currentCount);
      }
    }
  }

  // --- burst gate: too many captures in the window -> FLAG (held, not counted) -
  const windowStart = new Date(now - BURST_WINDOW_MS).toISOString();
  const { count: recentCount } = await supabase
    .from("capture_log")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .in("status", ["verified", "flagged"])
    .gte("created_at", windowStart);
  if ((recentCount ?? 0) >= BURST_MAX) {
    return await logAndRespond("flagged", "burst", authLat, authLng, distance_m, speed_mps, false, currentCount);
  }

  // --- dedup: already VERIFIED this pin? Count it verified, but not distinct ---
  const { data: priorVerified } = await supabase
    .from("capture_log")
    .select("id")
    .eq("user_id", user.id)
    .eq("pin_id", pinId)
    .eq("status", "verified")
    .limit(1);
  const isNewPin = !(priorVerified && priorVerified.length > 0);

  // --- accept: bank it. Update the score + physics-gate state atomically-ish. --
  const newCount = currentCount + (isNewPin ? 1 : 0);
  await supabase.from("leaderboard_scores").upsert(
    {
      user_id: user.id,
      distinct_pins: newCount,
      last_lat: deviceLat,
      last_lng: deviceLng,
      last_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    },
    { onConflict: "user_id" },
  );

  return await logAndRespond("verified", isNewPin ? "new_pin" : "repeat_pin", authLat, authLng, distance_m, speed_mps, isNewPin, newCount);
});
