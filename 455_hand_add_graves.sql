-- 455_hand_add_graves.sql — #455 Cincinnati: four notable graves the graves run could not plant, added by hand (drafted 2026-11-06).
-- Supabase SQL editor (runs as postgres). Nothing outside this file: no function, no Pages, no CACHE_VERSION, no env var.
--
-- RUN ORDER: AFTER the Mac's `graves-resolve.ts --from-records --commit` (142 rows) — Orbansky's and Ackerman's slots are chosen
-- against the rings that commit creates (Walnut Hills United Jewish Cemetery; Saint Mary's Cemetery, Fort Mitchell). The DO block
-- refuses to run until both rings' rank-0 graves are live.
--
-- WHY BY HAND (FROM ORLANDO (4) and (7)): graves-resolve.ts filed Ackerman, Taft and Bunning as non-cemetery-burial (Wikidata gives
-- a town), and never proposed Orbansky here (his Wikidata burial is "Columbus" — the #455 hand-add lead from #457), while each
-- person's own Wikipedia article names the burial ground (quoted in review_note). The run's other non-cemetery-burial rows get no
-- grave: Greg J. Holbrock ("St. Stephens Mausoleum", Hamilton — OSM maps no such point), Fred Baur (article: a grave in
-- Springfield Township, no cemetery named), Lucy Montz (an unlocated family cemetery, Warsaw KY), Buck Ewing, George J. Austin,
-- Vactor Tousey Chambers and Eliza Archard Conner (articles silent). The #442 namesake William Brown (soldier, 1759–1808,
-- Fulton-Presbyterian Cemetery) is NOT added: his own Wikipedia pin is already stored 135 m from the cemetery, so a grave would twin it.
--
-- PLACEMENT (no existing grave moves, no rank-0 slot changes; #372's ring is 50 m, 45° slots, ranks 1–4 on N/NE/E/SE):
--   David Orbansky — the SOUTH slot at Walnut Hills United Jewish Cemetery (39.13991236, -84.471968669), 50 m from Wise, ~38 m from Philipson.
--   Richard Henry Ackerman — the NORTH-EAST slot at Saint Mary's Cemetery, Fort Mitchell (39.0442176, -84.5495911), 50 m from Howard, ~38 m from Heving.
--   Robert A. Taft — Indian Hill Church (39.174787, -84.344957); no stored pin within 220 m, no gem.
--   Jim Bunning — Saint Stephen's Cemetery, Fort Thomas (39.051363, -84.451105); no stored pin within 250 m, no gem.
--
-- SHAPE: the graves-resolve.ts seed row, as 457_hand_add_graves.sql: "Grave of <person>", the Wikipedia intro in description AND
-- resolved_description, resolved_source 'wiki', category 'history', status 'approved', submitted_by null, source
-- 'seed:wikidata-grave' (so a later crawl's #338/#384 skip treats them as loaded), city 'Cincinnati'. review_note carries #455.
--
-- GUARDS: a DO pre-check raises — and the editor's one implicit transaction then changes NOTHING — if either ring's rank-0 grave is
-- not live yet, if any submission (any status) already carries one of the four names, or if a live gem naming the person sits
-- within ~1.5 km. No begin/commit.
--
-- HOW TO RUN: paste the whole file into one SQL-editor tab and Run. The final SELECT returns four rows:
--   Grave of David Orbansky · Grave of Jim Bunning · Grave of Richard Henry Ackerman · Grave of Robert A. Taft.
--   "Success. No rows returned" means the guard skipped — read why.
--
-- UNDO (keeps the rows): update public.submissions set status = 'rejected', review_note = review_note || ' | #455 undone'
--   where source = 'seed:wikidata-grave' and review_note like '#455 %' and status = 'approved' and merged_into is null;

do $$
declare
  n_ring int;
  n_name int;
  n_near int;
begin
  select count(*) into n_ring from public.submissions s
   where s.status = 'approved' and s.merged_into is null
     and s.name in ('Grave of Isaac Mayer Wise', 'Grave of Francis William Howard');
  if n_ring <> 2 then
    raise exception '#455 pre-check: % of 2 ring-centre graves live (Isaac Mayer Wise, Francis William Howard) — run the graves --from-records --commit first; nothing changed', n_ring;
  end if;

  select count(*) into n_name from public.submissions s where s.name in ('Grave of David Orbansky', 'Grave of Richard Henry Ackerman', 'Grave of Robert A. Taft', 'Grave of Jim Bunning');
  if n_name <> 0 then
    raise exception '#455 pre-check: % submission(s) already carry one of the four names — already run, or added another way; nothing changed', n_name;
  end if;

  select count(*) into n_near
    from public.submissions s
   where s.status = 'approved' and s.merged_into is null
     and ((s.name ilike '%orbansky%' and abs(s.lat - 39.13991236) < 0.0135 and abs(s.lng - (-84.471968669)) < 0.0175)
       or (s.name ilike '%ackerman%' and abs(s.lat - 39.0442176) < 0.0135 and abs(s.lng - (-84.5495911)) < 0.0175)
       or (s.name ilike '%taft%' and abs(s.lat - 39.174787) < 0.0135 and abs(s.lng - (-84.344957)) < 0.0175)
       or (s.name ilike '%bunning%' and abs(s.lat - 39.051363) < 0.0135 and abs(s.lng - (-84.451105)) < 0.0175));
  if n_near <> 0 then
    raise exception '#455 pre-check: % live gem(s) for one of these people already within ~1.5 km — nothing changed; read them before adding a twin', n_near;
  end if;
end $$;

insert into public.submissions
  (name, description, resolved_description, resolved_source, category,
   lat, lng, city, status, submitted_by, source, review_note)
values
  ('Grave of David Orbansky',
   $bio$David Orbansky or 'Urbansky' was a Union Army soldier during the American Civil War. He earned the Medal of Honor for his gallantry in action against enemy Confederate States Army forces in the Battle of Shiloh, Tennessee, in 1862 and again at the Siege of Vicksburg, Mississippi, in 1863, as well as other actions. During the Vicksburg campaign, Urbansky rushed onto the battlefield to pick up his commander and under enemy fire, made it back to the Union line. He was buried at Piqua’s Cedar Hill Jewish cemetery and later reinterred at Walnut Hills United Jewish Cemetery in Evanston, Ohio, a neighborhood in the city of Cincinnati.$bio$,
   $bio$David Orbansky or 'Urbansky' was a Union Army soldier during the American Civil War. He earned the Medal of Honor for his gallantry in action against enemy Confederate States Army forces in the Battle of Shiloh, Tennessee, in 1862 and again at the Siege of Vicksburg, Mississippi, in 1863, as well as other actions. During the Vicksburg campaign, Urbansky rushed onto the battlefield to pick up his commander and under enemy fire, made it back to the Union line. He was buried at Piqua’s Cedar Hill Jewish cemetery and later reinterred at Walnut Hills United Jewish Cemetery in Evanston, Ohio, a neighborhood in the city of Cincinnati.$bio$,
   'wiki', 'history',
   39.13991236, -84.471968669, 'Cincinnati', 'approved', null, 'seed:wikidata-grave',
   '#455 2026-11-06: hand-added grave — Walnut Hills United Jewish Cemetery, Evanston — the free SOUTH slot of the cemetery''s 50 m ring (rank 0 Isaac Mayer Wise stays on the cemetery point; N/NE/E/SE are Middleton, Lilienthal, Landsberger, Philipson); a lead from #457''s graves run (Wikidata burial "Columbus"); burial per the person''s Wikipedia article: "later reinterred at Walnut Hills United Jewish Cemetery in Evanston, Ohio"'),
  ('Grave of Richard Henry Ackerman',
   $bio$Richard Henry Ackerman, C.S.Sp. (August 30, 1903 – November 18, 1992) was an American Latin Catholic prelate of the Catholic Church. He served as bishop of the Diocese of Covington in Kentucky from 1960 to 1978. He previously served as an auxiliary bishop of the Diocese of San Diego in California from 1956 to 1960. Ackerman was a member of the Congregation of the Holy Ghost (Holy Ghost Fathers).$bio$,
   $bio$Richard Henry Ackerman, C.S.Sp. (August 30, 1903 – November 18, 1992) was an American Latin Catholic prelate of the Catholic Church. He served as bishop of the Diocese of Covington in Kentucky from 1960 to 1978. He previously served as an auxiliary bishop of the Diocese of San Diego in California from 1956 to 1960. Ackerman was a member of the Congregation of the Holy Ghost (Holy Ghost Fathers).$bio$,
   'wiki', 'history',
   39.0442176, -84.5495911, 'Cincinnati', 'approved', null, 'seed:wikidata-grave',
   '#455 2026-11-06: hand-added grave — Saint Mary''s Cemetery, Fort Mitchell — the free NORTH-EAST slot of the cemetery''s 50 m ring (rank 0 Francis William Howard stays on the cemetery point; N is Joe Heving); Wikidata burial "Fort Mitchell" (non-cemetery-burial); burial per the person''s Wikipedia article: "was buried at St. Mary Cemetery in Fort Mitchell, Kentucky"'),
  ('Grave of Robert A. Taft',
   $bio$Robert Alphonso Taft Sr. (September 8, 1889 – July 31, 1953) was an American politician and lawyer who represented Ohio in the United States Senate from 1939 until his death in 1953. A member of the Republican Party, he briefly served as Senate majority leader and was a leader of the conservative coalition of Republicans and conservative Democrats who blocked expansion of the New Deal. Often referred to as "Mr. Republican", he co-sponsored the Taft–Hartley Act of 1947, which banned closed shops, created the framework of right-to-work states, and tightened other regulations on labor unions and practices.
Taft was a scion of the Taft political family; he was the elder son of William Howard Taft, the 27th president of the United States and 10th chief justice of the United States. Born in Cincinnati, Ohio, he pursued a legal career after graduating from Harvard Law School in 1913 and co-founded the law firm Taft Stettinius & Hollister with his brother Charles Phelps Taft II. Taft served in the Ohio House of Representatives from 1921 to 1931 and in the Ohio Senate from 1931 to 1933. Though he lost re-election in 1932, he remained a powerful force in state and local politics.
After winning election to the Senate in 1938 over incumbent Democrat Robert J. Bulkley, Taft repeatedly sought the Republican presidential nomination, often battling for control of the party with the moderate faction of Republicans led by Thomas E. Dewey. He also emerged as a prominent non-interventionist and opposed U.S. involvement in World War II prior to the 1941 Japanese attack on Pearl Harbor. Taft's non-interventionist stances damaged his 1940 candidacy, and the 1940 Republican National Convention nominated Wendell Willkie. Taft sought the presidency again in 1948, but he lost to Dewey at the 1948 Republican National Convention. He opposed the creation of NATO and criticized President Harry Truman's handling of the Korean War.
Taft again sought the presidential nomination a third time in 1952, and was widely viewed as the front-runner. However, Dewey and other moderates convinced General Dwight D. Eisenhower to enter the race, and Eisenhower narrowly prevailed at the 1952 Republican National Convention and went on to win the 1952 presidential election. Taft was elected Senate majority leader in 1953 but died of a cerebral hemorrhage while being treated for pancreatic cancer later that year. A 1957 Senate committee named Taft as one of America's five greatest senators, along with Henry Clay, Daniel Webster, John C. Calhoun, and Robert M. La Follette Sr.—portraits of the "famous five" are displayed in the Senate Reception Room.$bio$,
   $bio$Robert Alphonso Taft Sr. (September 8, 1889 – July 31, 1953) was an American politician and lawyer who represented Ohio in the United States Senate from 1939 until his death in 1953. A member of the Republican Party, he briefly served as Senate majority leader and was a leader of the conservative coalition of Republicans and conservative Democrats who blocked expansion of the New Deal. Often referred to as "Mr. Republican", he co-sponsored the Taft–Hartley Act of 1947, which banned closed shops, created the framework of right-to-work states, and tightened other regulations on labor unions and practices.
Taft was a scion of the Taft political family; he was the elder son of William Howard Taft, the 27th president of the United States and 10th chief justice of the United States. Born in Cincinnati, Ohio, he pursued a legal career after graduating from Harvard Law School in 1913 and co-founded the law firm Taft Stettinius & Hollister with his brother Charles Phelps Taft II. Taft served in the Ohio House of Representatives from 1921 to 1931 and in the Ohio Senate from 1931 to 1933. Though he lost re-election in 1932, he remained a powerful force in state and local politics.
After winning election to the Senate in 1938 over incumbent Democrat Robert J. Bulkley, Taft repeatedly sought the Republican presidential nomination, often battling for control of the party with the moderate faction of Republicans led by Thomas E. Dewey. He also emerged as a prominent non-interventionist and opposed U.S. involvement in World War II prior to the 1941 Japanese attack on Pearl Harbor. Taft's non-interventionist stances damaged his 1940 candidacy, and the 1940 Republican National Convention nominated Wendell Willkie. Taft sought the presidency again in 1948, but he lost to Dewey at the 1948 Republican National Convention. He opposed the creation of NATO and criticized President Harry Truman's handling of the Korean War.
Taft again sought the presidential nomination a third time in 1952, and was widely viewed as the front-runner. However, Dewey and other moderates convinced General Dwight D. Eisenhower to enter the race, and Eisenhower narrowly prevailed at the 1952 Republican National Convention and went on to win the 1952 presidential election. Taft was elected Senate majority leader in 1953 but died of a cerebral hemorrhage while being treated for pancreatic cancer later that year. A 1957 Senate committee named Taft as one of America's five greatest senators, along with Henry Clay, Daniel Webster, John C. Calhoun, and Robert M. La Follette Sr.—portraits of the "famous five" are displayed in the Senate Reception Room.$bio$,
   'wiki', 'history',
   39.174787, -84.344957, 'Cincinnati', 'approved', null, 'seed:wikidata-grave',
   '#455 2026-11-06: hand-added grave — Indian Hill Episcopal Church Cemetery — Indian Hill Church''s own point (OSM way 75211651; OSM maps no separate churchyard); no other grave is loaded there; Wikidata burial "Cincinnati" (non-cemetery-burial); burial per the person''s Wikipedia article: "buried in a private ceremony at Indian Hill Episcopal Church Cemetery"'),
  ('Grave of Jim Bunning',
   $bio$James Paul David Bunning (October 23, 1931 – May 26, 2017) was an American professional baseball pitcher and politician from Kentucky who served in both chambers of the United States Congress, a member of the United States House of Representatives from 1987 to 1999 and a member of the United States Senate from 1999 to 2011. He is the only Major League Baseball athlete to have been elected to both the United States Senate and the National Baseball Hall of Fame to date.
Bunning pitched from 1955 to 1971 for the Detroit Tigers, Philadelphia Phillies, Pittsburgh Pirates, and Los Angeles Dodgers. When Bunning retired, he had the second-highest total career strikeouts in Major League history; he currently ranks 22nd. As a member of the Phillies, Bunning pitched the seventh perfect game in Major League Baseball history on June 21, 1964, the first game of a Father's Day doubleheader at Shea Stadium, against the New York Mets. It was the first perfect game in the National League since 1880. Bunning was inducted into the National Baseball Hall of Fame and Museum in 1996 after election by the Hall's Veterans Committee.
After retiring from baseball, Bunning returned to his native northern Kentucky and was elected to the Fort Thomas city council, then the Kentucky Senate, in which he served as minority leader. In 1983, Bunning was the Republican nominee for governor of Kentucky. In 1986, Bunning was elected to the House of Representatives from Kentucky's 4th congressional district, and served in the House from 1987 to 1999. He was elected to the Senate from Kentucky in 1998, and served two terms as the Republican junior U.S. senator. In July 2009, he announced that he would not run for re-election the following year. Bunning gave his farewell speech to the Senate on December 9, 2010, and was succeeded by fellow Republican Rand Paul on January 3, 2011.$bio$,
   $bio$James Paul David Bunning (October 23, 1931 – May 26, 2017) was an American professional baseball pitcher and politician from Kentucky who served in both chambers of the United States Congress, a member of the United States House of Representatives from 1987 to 1999 and a member of the United States Senate from 1999 to 2011. He is the only Major League Baseball athlete to have been elected to both the United States Senate and the National Baseball Hall of Fame to date.
Bunning pitched from 1955 to 1971 for the Detroit Tigers, Philadelphia Phillies, Pittsburgh Pirates, and Los Angeles Dodgers. When Bunning retired, he had the second-highest total career strikeouts in Major League history; he currently ranks 22nd. As a member of the Phillies, Bunning pitched the seventh perfect game in Major League Baseball history on June 21, 1964, the first game of a Father's Day doubleheader at Shea Stadium, against the New York Mets. It was the first perfect game in the National League since 1880. Bunning was inducted into the National Baseball Hall of Fame and Museum in 1996 after election by the Hall's Veterans Committee.
After retiring from baseball, Bunning returned to his native northern Kentucky and was elected to the Fort Thomas city council, then the Kentucky Senate, in which he served as minority leader. In 1983, Bunning was the Republican nominee for governor of Kentucky. In 1986, Bunning was elected to the House of Representatives from Kentucky's 4th congressional district, and served in the House from 1987 to 1999. He was elected to the Senate from Kentucky in 1998, and served two terms as the Republican junior U.S. senator. In July 2009, he announced that he would not run for re-election the following year. Bunning gave his farewell speech to the Senate on December 9, 2010, and was succeeded by fellow Republican Rand Paul on January 3, 2011.$bio$,
   'wiki', 'history',
   39.051363, -84.451105, 'Cincinnati', 'approved', null, 'seed:wikidata-grave',
   '#455 2026-11-06: hand-added grave — Saint Stephen''s Cemetery, Fort Thomas — the cemetery''s own point (OSM way 1115550985); no other grave is loaded there; Wikidata burial "Fort Thomas" (non-cemetery-burial); burial per the person''s Wikipedia article: "was interred at St. Stephen Cemetery in Campbell County, Kentucky"');

select name, '#455 inserted' as note
  from public.submissions
 where name in ('Grave of David Orbansky', 'Grave of Richard Henry Ackerman', 'Grave of Robert A. Taft', 'Grave of Jim Bunning')
   and review_note like '#455 %'
 order by name;
