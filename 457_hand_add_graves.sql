-- 457_hand_add_graves.sql — #457 Columbus: two notable graves the graves run could not plant, added by hand (drafted 2026-11-05).
-- Supabase SQL editor (runs as postgres). Nothing outside this file: no function, no Pages, no CACHE_VERSION, no env var.
--
-- RUN ORDER: AFTER the Mac's `graves-resolve.ts --from-records --commit` (84 rows, done 2026-11-05) — Gillars's slot is chosen
-- against the ring that commit created at Saint Joseph Cemetery, Lockbourne.
--
-- WHY BY HAND (FROM ORLANDO (4) and (7)): graves-resolve.ts filed both as non-cemetery-burial because Wikidata gives a town,
-- not a cemetery — Mildred Gillars ("Lockbourne") and Joseph O. Gregg ("Lithopolis") — while each person's own Wikipedia
-- article names the burial ground (quoted in review_note). The run's other three non-cemetery-burial rows get no grave:
--   David Orbansky (article: reinterred at Walnut Hills United Jewish Cemetery, Cincinnati — outside this square),
--   Benson W. Hough (article: "interred in Berkshire Township" — no burial ground named), Martha Wise (article silent).
-- Gillars is kept on fact, not reputation (FROM SAN ANTONIO (4)); her bio says who she was.
--
-- PLACEMENT (no existing grave moves, no rank-0 slot changes):
--   Mildred Gillars — Saint Joseph Cemetery, Lockbourne. The commit put Chalmers Wylie (rank 0) on 39.8244, -82.9983 and
--     Ready / Duffy / Janowicz / Carr on the ring's N / NE / E / SE slots; Gillars takes the free WEST slot (#372: 50 m,
--     angle 270°) — 50 m from Wylie, ~71 m from Ready, ~92 m from Carr, clear of #533's 10 m hold.
--   Joseph O. Gregg — Lithopolis Cemetery (OSM way 1204770606). No grave is loaded there, so he sits on the cemetery's own
--     point. The nearest live grave is Mabel Wagnalls's distinct plot, ~88 m away.
--
-- SHAPE: the graves-resolve.ts seed row, as 454_hand_add_graves.sql: "Grave of <person>", the Wikipedia intro in description AND
-- resolved_description, resolved_source 'wiki', category 'history', status 'approved', submitted_by null, source
-- 'seed:wikidata-grave' (so a later crawl's #338/#384 skip treats them as loaded), city 'Columbus'. review_note carries #457.
--
-- GUARDS: a DO pre-check raises — and the editor's one implicit transaction then changes NOTHING — if any submission (any
-- status) already carries one of the two names, or a live gem naming the person sits within ~1.5 km. No begin/commit.
--
-- HOW TO RUN: paste the whole file into one SQL-editor tab and Run. The final SELECT returns two rows:
--   Grave of Joseph O. Gregg · Grave of Mildred Gillars. "Success. No rows returned" means the guard skipped — read why.
--
-- UNDO (keeps the rows): update public.submissions set status = 'rejected', review_note = review_note || ' | #457 undone'
--   where source = 'seed:wikidata-grave' and review_note like '#457 %' and status = 'approved' and merged_into is null;

do $$
declare
  n_name int;
  n_near int;
begin
  select count(*) into n_name from public.submissions s where s.name in ('Grave of Mildred Gillars', 'Grave of Joseph O. Gregg');
  if n_name <> 0 then
    raise exception '#457 pre-check: % submission(s) already carry one of the two names — already run, or added another way; nothing changed', n_name;
  end if;

  select count(*) into n_near
    from public.submissions s
   where s.status = 'approved' and s.merged_into is null
     and ((s.name ilike '%gillars%' and abs(s.lat - 39.8244) < 0.0135 and abs(s.lng - (-82.9988848)) < 0.0175)
       or (s.name ilike '%gregg%' and abs(s.lat - 39.798827) < 0.0135 and abs(s.lng - (-82.8066662)) < 0.0175));
  if n_near <> 0 then
    raise exception '#457 pre-check: % live gem(s) for one of these people already within ~1.5 km — nothing changed; read them before adding a twin', n_near;
  end if;
end $$;

insert into public.submissions
  (name, description, resolved_description, resolved_source, category,
   lat, lng, city, status, submitted_by, source, review_note)
values
  ('Grave of Mildred Gillars',
   $bio$Mildred Elizabeth Gillars (née Sisk; November 29, 1900 – June 25, 1988) was an American broadcaster employed by Nazi Germany to disseminate Axis propaganda during World War II. Following her capture in post-war Berlin, Gillars became the first woman to be convicted of treason against the United States. In March 1949, she was sentenced to ten to thirty years' imprisonment. Gillars was paroled in 1961. Along with Rita Zucca she was nicknamed "Axis Sally".$bio$,
   $bio$Mildred Elizabeth Gillars (née Sisk; November 29, 1900 – June 25, 1988) was an American broadcaster employed by Nazi Germany to disseminate Axis propaganda during World War II. Following her capture in post-war Berlin, Gillars became the first woman to be convicted of treason against the United States. In March 1949, she was sentenced to ten to thirty years' imprisonment. Gillars was paroled in 1961. Along with Rita Zucca she was nicknamed "Axis Sally".$bio$,
   'wiki', 'history',
   39.8244, -82.9988848, 'Columbus', 'approved', null, 'seed:wikidata-grave',
   '#457 2026-11-05: hand-added grave — Saint Joseph Cemetery, Lockbourne — the free west slot of the cemetery''s 50 m ring (rank 0 Chalmers Wylie stays on the cemetery point; N/NE/E/SE are Ready, Duffy, Janowicz, Carr); burial per the person''s Wikipedia article: "She is buried at Saint Joseph Cemetery in Lockbourne, Ohio"'),
  ('Grave of Joseph O. Gregg',
   $bio$Joseph Olds Gregg (January 5, 1841 - February 25, 1930) was a Union Army soldier in the American Civil War who received the U.S. military's highest decoration, the Medal of Honor.
Gregg was born in Lithopolis, Ohio on January 5, 1841. He was awarded the Medal of Honor, for extraordinary heroism shown on June 16, 1864, while serving as a Private with Company F, 133rd Ohio Infantry, near the Richmond and Petersburg Ry., Virginia. His Medal of Honor was issued on May 13, 1899.
Gregg died at the age of 89, on February 25, 1930, and was buried at Lithopolis Cemetery in Lithopolis, Ohio.$bio$,
   $bio$Joseph Olds Gregg (January 5, 1841 - February 25, 1930) was a Union Army soldier in the American Civil War who received the U.S. military's highest decoration, the Medal of Honor.
Gregg was born in Lithopolis, Ohio on January 5, 1841. He was awarded the Medal of Honor, for extraordinary heroism shown on June 16, 1864, while serving as a Private with Company F, 133rd Ohio Infantry, near the Richmond and Petersburg Ry., Virginia. His Medal of Honor was issued on May 13, 1899.
Gregg died at the age of 89, on February 25, 1930, and was buried at Lithopolis Cemetery in Lithopolis, Ohio.$bio$,
   'wiki', 'history',
   39.798827, -82.8066662, 'Columbus', 'approved', null, 'seed:wikidata-grave',
   '#457 2026-11-05: hand-added grave — Lithopolis Cemetery — the cemetery''s own point (OSM way 1204770606); no other grave is loaded there; burial per the person''s Wikipedia article: "was buried at Lithopolis Cemetery in Lithopolis, Ohio"');

select name, '#457 inserted' as note
  from public.submissions
 where name in ('Grave of Mildred Gillars', 'Grave of Joseph O. Gregg')
   and review_note like '#457 %'
 order by name;
