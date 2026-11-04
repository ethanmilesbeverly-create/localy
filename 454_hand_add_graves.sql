-- 454_hand_add_graves.sql — #454 Charlotte: two notable graves the graves run could not plant, added by hand (drafted 2026-11-04).
-- Supabase SQL editor (runs as postgres). Nothing outside this file: no function, no Pages, no CACHE_VERSION, no env var.
--
-- RUN ORDER: AFTER the Mac's `graves-resolve.ts --from-records --commit` (62 rows) — Finley's slot is chosen against the ring
-- that commit creates at Rose Hill. Running it first changes nothing about the coordinates, but read it in that order.
--
-- WHY BY HAND (FROM ORLANDO (4) and (7)): graves-resolve.ts filed both as non-cemetery-burial because Wikidata gives a town,
-- not a cemetery — Abraham Alexander ("Charlotte") and David E. Finley ("York") — while each person's own Wikipedia article
-- names the burial ground (quoted in review_note). The run's other four non-cemetery-burial rows get no grave:
--   William Lander (article: "Lincolnton" only), John Van Alstyne Weaver (article silent), Crash Holly (article: "China Grove"
--   only, no cemetery) — no named burial ground, nothing to place; Bonnie Ethel Cone is interred in the Van Landingham Glen
--   on the UNC Charlotte campus, where the HIDDEN OSM pin "Bonnie Cone Memorial" (osm_way169460851) already stands and its
--   containing tile stores it, so her story goes into #454's story batch as a curated row on that pin — not a twin grave pin.
--
-- PLACEMENT (no existing grave moves, no rank-0 slot changes):
--   Abraham Alexander — Sugar Creek Presbyterian Church, Charlotte (OSM way 397366508). No grave is loaded there, so he sits on
--     the church's own point (the graveyard is on the church grounds; OSM maps no separate cemetery).
--   David E. Finley — Rose Hill Cemetery, York SC. The commit puts Alexander S. Wallace (rank 0) on 34.9931, -81.2361 and Isaac
--     Donnom Witherspoon (rank 1) on the ring's north slot; Finley takes the ring's free WEST slot (#372: 50 m, angle 270°) —
--     50 m from Wallace, ~71 m from Witherspoon, clear of #533's 10 m hold. Rose Hill is outside the 42-tile box but inside the
--     ±40 km grave square; no box owns York County, so it loads under Charlotte (Bergen (4)).
--
-- SHAPE: the graves-resolve.ts seed row, as 453_hand_add_graves.sql: "Grave of <person>", the Wikipedia intro in description AND
-- resolved_description, resolved_source 'wiki', category 'history', status 'approved', submitted_by null, source
-- 'seed:wikidata-grave' (so a later crawl's #338/#384 skip treats them as loaded), city 'Charlotte'. review_note carries #454.
--
-- GUARDS: a DO pre-check raises — and the editor's one implicit transaction then changes NOTHING — if any submission (any
-- status) already carries one of the two names, or a live gem naming the person sits within ~1.5 km. No begin/commit.
--
-- HOW TO RUN: paste the whole file into one SQL-editor tab and Run. The final SELECT returns two rows:
--   Grave of Abraham Alexander · Grave of David E. Finley. "Success. No rows returned" means the guard skipped — read why.
--
-- UNDO (keeps the rows): update public.submissions set status = 'rejected', review_note = review_note || ' | #454 undone'
--   where source = 'seed:wikidata-grave' and review_note like '#454 %' and status = 'approved' and merged_into is null;

do $$
declare
  n_name int;
  n_near int;
begin
  select count(*) into n_name from public.submissions s where s.name in ('Grave of Abraham Alexander', 'Grave of David E. Finley');
  if n_name <> 0 then
    raise exception '#454 pre-check: % submission(s) already carry one of the two names — already run, or added another way; nothing changed', n_name;
  end if;

  select count(*) into n_near
    from public.submissions s
   where s.status = 'approved' and s.merged_into is null
     and ((s.name ilike '%abraham alexander%' and abs(s.lat - 35.259091) < 0.0135 and abs(s.lng - (-80.7958503)) < 0.0165)
       or (s.name ilike '%finley%' and abs(s.lat - 34.9931) < 0.0135 and abs(s.lng - (-81.2366483)) < 0.0165));
  if n_near <> 0 then
    raise exception '#454 pre-check: % live gem(s) for one of these people already within ~1.5 km — nothing changed; read them before adding a twin', n_near;
  end if;
end $$;

insert into public.submissions
  (name, description, resolved_description, resolved_source, category,
   lat, lng, city, status, submitted_by, source, review_note)
values
  ('Grave of Abraham Alexander',
   $bio$Abraham Alexander (December 9, 1717 – April 23, 1786) was a public figure in Mecklenburg County, North Carolina, during the American Revolution. He chaired the meetings that produced the radical Mecklenburg Resolves and, allegedly, the Mecklenburg Declaration of Independence.$bio$,
   $bio$Abraham Alexander (December 9, 1717 – April 23, 1786) was a public figure in Mecklenburg County, North Carolina, during the American Revolution. He chaired the meetings that produced the radical Mecklenburg Resolves and, allegedly, the Mecklenburg Declaration of Independence.$bio$,
   'wiki', 'history',
   35.259091, -80.7958503, 'Charlotte', 'approved', null, 'seed:wikidata-grave',
   '#454 2026-11-04: hand-added grave — Sugar Creek Presbyterian Church, Charlotte — the church''s own point (OSM way 397366508); no other grave is loaded there; burial per the person''s Wikipedia article: "He is buried with his wife Dorcas in the graveyard at Sugar Creek Presbyterian Church in Charlotte"'),
  ('Grave of David E. Finley',
   $bio$David E. Finley (February 28, 1861 – January 26, 1917) was a United States representative from South Carolina. He was born in Trenton, Arkansas. He attended the public schools of Rock Hill, South Carolina, and Ebenezer, South Carolina and was graduated from the law department of South Carolina College (now the University of South Carolina) at Columbia, South Carolina, in 1885. He was admitted to the bar in 1886 and commenced practice in York, South Carolina.
Finley was member of the South Carolina House of Representatives 1890–1891. He also served in the South Carolina Senate 1892–1896. He served as a trustee of the University of South Carolina 1890–1896. He was elected as a Democrat to the Fifty-sixth and to the eight succeeding Congresses and served from March 4, 1899, until his death. Prior to dying, he had been reelected to the Sixty-fifth Congress. He died in Charlotte, North Carolina, on January 26, 1917, and was buried in Rose Hill Cemetery, York, South Carolina.
Finley's son, David E. Finley, Jr., a prominent cultural leader in the United States in the 20th century, served as the first director of the National Gallery of Art and the founding chairman of the National Trust for Historic Preservation.$bio$,
   $bio$David E. Finley (February 28, 1861 – January 26, 1917) was a United States representative from South Carolina. He was born in Trenton, Arkansas. He attended the public schools of Rock Hill, South Carolina, and Ebenezer, South Carolina and was graduated from the law department of South Carolina College (now the University of South Carolina) at Columbia, South Carolina, in 1885. He was admitted to the bar in 1886 and commenced practice in York, South Carolina.
Finley was member of the South Carolina House of Representatives 1890–1891. He also served in the South Carolina Senate 1892–1896. He served as a trustee of the University of South Carolina 1890–1896. He was elected as a Democrat to the Fifty-sixth and to the eight succeeding Congresses and served from March 4, 1899, until his death. Prior to dying, he had been reelected to the Sixty-fifth Congress. He died in Charlotte, North Carolina, on January 26, 1917, and was buried in Rose Hill Cemetery, York, South Carolina.
Finley's son, David E. Finley, Jr., a prominent cultural leader in the United States in the 20th century, served as the first director of the National Gallery of Art and the founding chairman of the National Trust for Historic Preservation.$bio$,
   'wiki', 'history',
   34.9931, -81.2366483, 'Charlotte', 'approved', null, 'seed:wikidata-grave',
   '#454 2026-11-04: hand-added grave — Rose Hill Cemetery, York SC — the free west slot of the cemetery''s 50 m ring (rank 0 Alexander S. Wallace stays on the cemetery point; north is Isaac Donnom Witherspoon); burial per the person''s Wikipedia article: "was buried in Rose Hill Cemetery, York, South Carolina"');

select name, '#454 inserted' as note
  from public.submissions
 where name in ('Grave of Abraham Alexander', 'Grave of David E. Finley')
   and review_note like '#454 %'
 order by name;
