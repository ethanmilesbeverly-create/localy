-- 521_paul_cornell_bank_fix.sql — #521 (2026-10-07)
--
-- WHAT: #521's --prime-graves --commit banked gravebank:g1:paul_cornell as the WRONG
-- Paul Cornell — the British Doctor Who writer (b. 1967), a same-title namesake the
-- dry-run title eyeball could not catch. The Oak Woods pin "Paul Cornell" (41.7710,
-- -87.6021, tiles 835_-1752) is Paul Cornell (lawyer), 1822–1904, founder of Hyde
-- Park Township. This replaces that ONE bank row with the right bio.
--
-- WHY SQL, NOT A RE-PRIME: the bake keys on the pin's exact label, so the key must
-- stay paul_cornell; and the bank is monotonic (gate-tiles never overwrites a hit).
--
-- DEPLOY TARGET: Supabase SQL editor. Run the whole file once; idempotent.
-- OUTSIDE THE FILE: nothing. nearby-places holds bank hits in a per-instance memo,
-- so a warm instance may serve the old line until it recycles (minutes).
-- BACK-OUT: delete from shared_kv where key = 'gravebank:g1:paul_cornell';
--           (the pin goes back to hidden under #511).

insert into public.shared_kv (key, value, updated_at)
values (
  'gravebank:g1:paul_cornell',
  $v${"title": "Paul Cornell (lawyer)", "desc": "Paul Cornell (August 5, 1822 – March 3, 1904) was an American lawyer and Chicago real estate speculator who founded the Hyde Park Township that included most of what are now known as the south and far southeast sides of Chicago in Cook County, Illinois, United States. He turned the south side Lake Michigan lakefront area, especially the Hyde Park community area and neighboring Kenwood and Woodlawn neighborhoods, into a resort community that had its heyday from the 1850s through the early 20th century. He was also an urban planner who paved the way for and preserved many of the parks that are now in the Chicago Park District. Additionally, he was a successful entrepreneur with interests in manufacturing, cemeteries, and hotels. His modern legacy includes several large parks now in the Chicago Park District: Jackson Park, Washington Park, Midway Plaisance and Harold Washington Park. Most of the South and Southeast Sides of Chicago were developed and eventually annexed into the City of Chicago as a result of his foresight. A lengthy street and a park both bear his name.", "ts": 1791386691750}$v$,
  now()
)
on conflict (key) do update
  set value = excluded.value,
      updated_at = excluded.updated_at;

-- CHECK: expect one row, title "Paul Cornell (lawyer)", desc starting
-- "Paul Cornell (August 5, 1822 – March 3, 1904)".
select key,
       value::jsonb ->> 'title'              as title,
       left(value::jsonb ->> 'desc', 70)     as desc_start,
       length(value::jsonb ->> 'desc')       as chars
from public.shared_kv
where key = 'gravebank:g1:paul_cornell';
