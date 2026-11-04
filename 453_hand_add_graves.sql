-- 453_hand_add_graves.sql — #453 Orlando: four notable graves the graves run could not plant, added by hand (drafted 2026-11-04).
-- Supabase SQL editor (runs as postgres). Nothing outside this file: no function, no Pages, no CACHE_VERSION, no env var.
--
-- WHY BY HAND: graves-resolve.ts files a burial whose Wikidata place is a town as non-cemetery-burial (FROM ORLANDO (4)) —
-- Bob Ross ("Gotha") and Robert James Miller ("Casselberry"); Rex Beach's resting place is a college lawn, not a cemetery; and
-- Francis W. Eppes (Thomas Jefferson's grandson, state marker 846's Eppes-Shine plot) was not proposed by the run at all.
-- Each burial is stated in the person's own Wikipedia article (quoted in review_note). July Perry (state marker 1068) has no
-- article of his own — his story is the served "Ocoee massacre" pin — so he is not added.
--
-- PLACEMENT, the ring-order decision #453 carried: no existing grave moves and no rank-0 slot changes. Woodlawn and Greenwood
-- each already carry a 50 m ring (#372) with its north, north-east, east and south-east slots taken, so Bob Ross and Francis W.
-- Eppes take each ring's free WEST slot (50 m from the centre, at least 50 m from every live grave — clear of #533's 10 m hold).
-- Miller is the first grave at All Faiths, so he sits on the cemetery's own point; Beach on the Alumni House.
--
-- SHAPE: the graves-resolve.ts seed row, as 523_seed_grave_gems.sql: "Grave of <person>", the Wikipedia intro in description AND
-- resolved_description, resolved_source 'wiki', category 'history', status 'approved', submitted_by null, source
-- 'seed:wikidata-grave' (so a later crawl's #338/#384 skip treats them as loaded), city 'Orlando'. review_note carries #453.
--
-- GUARDS: a DO pre-check raises — and the editor's one implicit transaction then changes NOTHING — if any submission (any
-- status) already carries one of the four names, or a live gem naming the person sits within ~1.5 km. No begin/commit.
--
-- HOW TO RUN: paste the whole file into one SQL-editor tab and Run. The final SELECT returns four rows, "#453 inserted".
--
-- UNDO (keeps the rows): update public.submissions set status = 'rejected', review_note = review_note || ' | #453 undone'
--   where source = 'seed:wikidata-grave' and review_note like '#453 %' and status = 'approved' and merged_into is null;

do $$
declare
  n_name int;
  n_near int;
begin
  select count(*) into n_name from public.submissions s where s.name in ('Grave of Bob Ross', 'Grave of Robert James Miller', 'Grave of Rex Beach', 'Grave of Francis W. Eppes');
  if n_name <> 0 then
    raise exception '#453 pre-check: % submission(s) already carry one of the four names — already run, or added another way; nothing changed', n_name;
  end if;

  select count(*) into n_near
    from public.submissions s
   where s.status = 'approved' and s.merged_into is null
     and ((s.name ilike '%bob ross%' and abs(s.lat - 28.5352993) < 0.0135 and abs(s.lng - (-81.5119096)) < 0.0155)
       or (s.name ilike '%robert james miller%' and abs(s.lat - 28.6701516) < 0.0135 and abs(s.lng - (-81.3067461)) < 0.0155)
       or (s.name ilike '%rex beach%' and abs(s.lat - 28.5919411) < 0.0135 and abs(s.lng - (-81.3500756)) < 0.0155)
       or (s.name ilike '%eppes%' and abs(s.lat - 28.534722222) < 0.0135 and abs(s.lng - (-81.3577335)) < 0.0155));
  if n_near <> 0 then
    raise exception '#453 pre-check: % live gem(s) for one of these people already within ~1.5 km — nothing changed; read them before adding a twin', n_near;
  end if;
end $$;

insert into public.submissions
  (name, description, resolved_description, resolved_source, category,
   lat, lng, city, status, submitted_by, source, review_note)
values
  ('Grave of Bob Ross',
   $bio$Robert Norman Ross (October 29, 1942 – July 4, 1995) was an American painter and art instructor who created and hosted The Joy of Painting, an instructional television program that aired from 1983 to 1994 on PBS in the United States and CBC in Canada.
Born in Daytona Beach, Florida, Ross joined the United States Air Force in 1961, rising to the rank of master sergeant. During his time in the military, he developed a passion for oil painting. He studied the art from Bill Alexander's show The Magic of Oil Painting, and eventually his income from painting outgrew his military salary. Retiring from the Air Force in 1981, he was discovered by Annette Kowalski, who had attended one of his sessions while he was working as a tutor. She and her husband helped Ross pool together money to set up a new company: Bob Ross Inc.
In 1982, a station aired his art class as a pilot, and several PBS stations signed up for The Joy of Painting soon after. One such station, WIPB, employed him to host the show in Muncie, Indiana beginning in 1983. The show features him instructing viewers on how to create landscape art using the quick, wet-on-wet oil painting technique with a limited palette. It ran until 1994, and Ross died a year later at the age of 52.
His legacy continues as a prominent figure in popular culture, with reruns of The Joy of Painting still being broadcast. Although he intended to pass on his whole oeuvre to family members, the Kowalskis (as Bob Ross Inc.) successfully contested this in court. Bob Ross Inc. later made a deal with his half-brother Jimmie Cox to become the legal proprietors of his name and likeness.$bio$,
   $bio$Robert Norman Ross (October 29, 1942 – July 4, 1995) was an American painter and art instructor who created and hosted The Joy of Painting, an instructional television program that aired from 1983 to 1994 on PBS in the United States and CBC in Canada.
Born in Daytona Beach, Florida, Ross joined the United States Air Force in 1961, rising to the rank of master sergeant. During his time in the military, he developed a passion for oil painting. He studied the art from Bill Alexander's show The Magic of Oil Painting, and eventually his income from painting outgrew his military salary. Retiring from the Air Force in 1981, he was discovered by Annette Kowalski, who had attended one of his sessions while he was working as a tutor. She and her husband helped Ross pool together money to set up a new company: Bob Ross Inc.
In 1982, a station aired his art class as a pilot, and several PBS stations signed up for The Joy of Painting soon after. One such station, WIPB, employed him to host the show in Muncie, Indiana beginning in 1983. The show features him instructing viewers on how to create landscape art using the quick, wet-on-wet oil painting technique with a limited palette. It ran until 1994, and Ross died a year later at the age of 52.
His legacy continues as a prominent figure in popular culture, with reruns of The Joy of Painting still being broadcast. Although he intended to pass on his whole oeuvre to family members, the Kowalskis (as Bob Ross Inc.) successfully contested this in court. Bob Ross Inc. later made a deal with his half-brother Jimmie Cox to become the legal proprietors of his name and likeness.$bio$,
   'wiki', 'history',
   28.5352993, -81.5119096, 'Orlando', 'approved', null, 'seed:wikidata-grave',
   '#453 2026-11-04: hand-added grave — Woodlawn Memorial Park, Gotha — the free west slot of the cemetery''s 50 m ring (rank 0 Mike Cuellar stays on the cemetery point; north, north-east, east and south-east are taken); burial per the person''s Wikipedia article: "His remains are interred at Woodlawn Memorial Park in Gotha"'),
  ('Grave of Robert James Miller',
   $bio$Robert James Miller (October 14, 1983 – January 25, 2008) was a United States Army Special Forces soldier who posthumously received the Medal of Honor for his actions during the War in Afghanistan.$bio$,
   $bio$Robert James Miller (October 14, 1983 – January 25, 2008) was a United States Army Special Forces soldier who posthumously received the Medal of Honor for his actions during the War in Afghanistan.$bio$,
   'wiki', 'history',
   28.6701516, -81.3067461, 'Orlando', 'approved', null, 'seed:wikidata-grave',
   '#453 2026-11-04: hand-added grave — All Faiths Memorial Park, Casselberry — the cemetery''s own point (OSM way 662118016); no other grave is loaded there; burial per the person''s Wikipedia article: "He is buried at All Faiths Memorial Park in Casselberry"'),
  ('Grave of Rex Beach',
   $bio$Rex Ellingwood Beach (September 1, 1877 – December 7, 1949) was an American novelist, playwright, and Olympic water polo player. Many of his novels were adapted into films.$bio$,
   $bio$Rex Ellingwood Beach (September 1, 1877 – December 7, 1949) was an American novelist, playwright, and Olympic water polo player. Many of his novels were adapted into films.$bio$,
   'wiki', 'history',
   28.5919411, -81.3500756, 'Orlando', 'approved', null, 'seed:wikidata-grave',
   '#453 2026-11-04: hand-added grave — Rollins College, in front of the Alumni House (OSM way 539242655); burial per the person''s Wikipedia article: "He and his wife are buried in front of the Alumni house"'),
  ('Grave of Francis W. Eppes',
   $bio$Francis Wayles Eppes (September 20, 1801 – May 30, 1881) was an American citizen from Virginia who became a cotton planter in the Territory of Florida and later served as a civic leader in Tallahassee and surrounding Leon County, Florida. After reaching legal age and marrying, Eppes operated the Poplar Forest plantation which his grandfather President Thomas Jefferson had established in Bedford County, Virginia, which he inherited. However, in 1829 he moved with his family to Tallahassee, Florida. Long interested in education, in 1856 Eppes donated land and money to designate a school in Tallahassee as one of the first two state-supported seminaries, now known as Florida State University. He served as president of its board of trustees for eight years.$bio$,
   $bio$Francis Wayles Eppes (September 20, 1801 – May 30, 1881) was an American citizen from Virginia who became a cotton planter in the Territory of Florida and later served as a civic leader in Tallahassee and surrounding Leon County, Florida. After reaching legal age and marrying, Eppes operated the Poplar Forest plantation which his grandfather President Thomas Jefferson had established in Bedford County, Virginia, which he inherited. However, in 1829 he moved with his family to Tallahassee, Florida. Long interested in education, in 1856 Eppes donated land and money to designate a school in Tallahassee as one of the first two state-supported seminaries, now known as Florida State University. He served as president of its board of trustees for eight years.$bio$,
   'wiki', 'history',
   28.534722222, -81.3577335, 'Orlando', 'approved', null, 'seed:wikidata-grave',
   '#453 2026-11-04: hand-added grave — Greenwood Cemetery, Orlando — the free west slot of the cemetery''s 50 m ring (rank 0 William Thomas Bland stays; north, north-east, east and south-east are taken); state marker 846 marks the Eppes-Shine plot here; burial per the person''s Wikipedia article: "was buried at Greenwood Cemetery"');

select '#453 inserted' as result, s.name, s.status, s.resolved_source, s.category,
       round(s.lat::numeric, 7) as lat, round(s.lng::numeric, 7) as lng, s.city, s.source,
       length(s.resolved_description) as bio_chars
  from public.submissions s
 where s.review_note like '#453 %'
 order by s.name;
