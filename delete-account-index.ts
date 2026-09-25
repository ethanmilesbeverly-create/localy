import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/* =========================================================================
   #82 — DELETE MY ACCOUNT (full erasure), the mechanism behind the promise
   #5's privacy.html already made.
   =========================================================================
   Decisions this encodes (agreed 2026-07-22):
   - Approved gems: ANONYMISE, don't cascade. The pin is a real place other
     people navigate to, so it stays; the identity link (submitted_by) is
     dropped. #23: an anonymised gem must render NO credit line, never
     "Submitted by Unknown".
   - Shared guide codes: KEEP redeeming. A code already texted to someone is
     the recipient's now — the hunt-code: rows in shared_kv are deliberately
     NOT touched here (#84).
   - Scope: real erasure — the auth.users row (the email #69 is about) goes,
     not just local data.

   WHO is being deleted is derived from the caller's JWT, NEVER from the body.
   The client sends an empty body on purpose; a body-supplied uid would let any
   signed-in user delete anyone.

   ORDER IS LOAD-BEARING and is what makes this correct regardless of the
   submissions FK's ON DELETE behaviour (which nobody has verified):
     1. anonymise submissions  -> nothing references uid any more
     2. delete user_state      -> capture history gone, EXPLICITLY (see below)
     3. delete the auth user    -> account gone
   Because step 1 runs first, a submitted_by FK with ON DELETE CASCADE can't
   take the gems with it in step 3, and one with RESTRICT/NO ACTION can't block
   step 3. Step 2 is explicit rather than left to a user_state cascade so that
   "account gone, location history still in the table" — the exact orphaned
   record #5 exists to prevent — cannot happen even if that FK carries no
   cascade. Every step is idempotent, so a client retry after a partial failure
   is safe.

   DEPLOY NOTES (outside this file):
   - Deploy separately: `supabase functions deploy delete-account`. Shipping
     index.html alone does NOT create or update this function.
   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected into Supabase
     Edge Functions; the service-role key is required for auth.admin.deleteUser.
   - submissions.submitted_by MUST be nullable for step 1. If it is NOT NULL,
     run once before deploying:
       ALTER TABLE public.submissions ALTER COLUMN submitted_by DROP NOT NULL;
   ========================================================================= */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ ok: false, error: "not authenticated" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Validate the token and read the caller's uid off it. This is the only
  // source of the identity being deleted.
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const uid = userData?.user?.id;
  if (userErr || !uid) return json({ ok: false, error: "invalid session" }, 401);

  // 1. Anonymise approved gems — keep the place, drop the identity AND the take.
  //    #324 — nulling submitted_by alone was not enough. For a source='user' gem,
  //    `description` IS the submitter's typed TAKE (#315 keeps it in the record
  //    but the card never displays it). The card's take-hide (#323) keys on the
  //    canonical record HAVING a submitter; once step 1 nulls submitted_by, the
  //    gem reads as a no-submitter seed, so the hide stops firing and the stored
  //    take would surface as if it were a sourced line. Decision (option 2 of
  //    #324, the #82-intent fit): BLANK the take here — keep the pin + its
  //    name/coords so it stays navigable (#84) and still resolves a SOURCED
  //    "what it is" by name at read time (#54), while the person's own words are
  //    erased (the #5/#82 GDPR obligation). Blank description_clean too, or the
  //    sanitised copy (#12) survives — and it is in #276's client-readable
  //    allowlist, so leaving it would leak the take through that column. A gem
  //    that relied on the writeup as a resolve HINT (#318/#320/#328) correctly
  //    goes blank-or-name-sourced after this: a line grounded on the erased text
  //    should not persist. If the product ever reverses to option 1 (RETIRE the
  //    gems) or option 3 (ACCEPT), this is the one line to change.
  {
    const { error } = await admin
      .from("submissions")
      .update({ submitted_by: null, description: null, description_clean: null })
      .eq("submitted_by", uid);
    if (error) {
      // The common cause of a failure here is a NOT NULL constraint on
      // submitted_by — see the DEPLOY NOTES above.
      return json({ ok: false, step: "anonymise", error: error.message }, 500);
    }
  }

  // 2. Delete capture history explicitly (not via a cascade nobody verified).
  {
    const { error } = await admin
      .from("user_state")
      .delete()
      .eq("user_id", uid);
    if (error) return json({ ok: false, step: "user_state", error: error.message }, 500);
  }

  // NOT TOUCHED, by decision: shared_kv hunt-code: entries. A guide you've
  // already shared keeps working for whoever you sent it to (#82 / #84).

  // 3. Remove the account itself.
  {
    const { error } = await admin.auth.admin.deleteUser(uid);
    if (error) return json({ ok: false, step: "auth", error: error.message }, 500);
  }

  return json({ ok: true });
});