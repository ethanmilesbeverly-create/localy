-- 532_courthouse_restore.sql — #532 part 4b-1 (2026-10-26): undo one wrong story attach.
-- WHAT HAPPENED: the --commit of names-532-bergen-westchester-5.txt re-judged the "Bergen County Court House" line
-- (marked `| new`). Gemini returned canonicalName "Site of the Court-House & Jail" for it, and seed-resolve.ts's #429
-- own-seed check compares the line against BOTH its own name and Gemini's canonicalName — so it took that #500 gem
-- (the 1780 courthouse site, 52 m away) as the line's "own seed" and PATCHed the 1909 Gordon courthouse sentence into
-- the gem's resolved_description. The courthouse itself got no pin. The gem's `description` and its #500
-- curated_descriptions row were NOT touched (the attach PATCHes resolved_description + resolved_source only).
-- FIX: copy the gem's untouched `description` (the #500 sentence: "Bergen County's court-house and jail stood here
-- until the British burned them in 1780.") back into resolved_description.
-- RUN: the SQL editor, this whole file in its own tab. Step 1 shows the state; step 2 restores it.
-- EXPECT: step 1 → 1 row, description = the 1780 sentence, resolved_description starting "James Riely Gordon".
--         step 2 → 1 row returned, resolved_description = the 1780 sentence. A re-run of step 2 returns 0 rows.
-- BACK-OUT: not needed — the guard below only matches the wrongly attached text.

-- Step 1: look first.
select id, name, lat, lng, description, resolved_description, resolved_source
from public.submissions
where name = 'Site of the Court-House & Jail'
  and submitted_by is null
  and status = 'approved';

-- Step 2: restore.
update public.submissions
set resolved_description = description
where name = 'Site of the Court-House & Jail'
  and submitted_by is null
  and status = 'approved'
  and resolved_description like 'James Riely Gordon%'
  and description like 'Bergen County''s court-house and jail stood here%'
returning id, name, resolved_description;
