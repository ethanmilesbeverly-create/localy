-- =============================================================================
-- 403_drop_google_places.sql — roadmap #403 (Google Places dropped as a description source)
-- Supabase SQL editor. DB-only. No function deploy, no APP_VERSION, no CACHE_VERSION.
-- =============================================================================
--
-- WHY: Google's Places API terms forbid caching/storing Places content (only the
-- place_id is exempt) and require Google attribution beside it. Nahgoo stored
-- Google editorial summaries permanently (the #357 resolve bank, #385's nightly
-- sweep, the gem `resolved_description` column) and showed them unattributed.
-- About 1% of lines came from Google, so the source is dropped rather than made
-- compliant.
--
-- DO THIS FIRST, OUTSIDE THIS FILE (or a live resolve can re-bank a Google line
-- between sections): Supabase -> Edge Functions -> Secrets -> DELETE
-- GOOGLE_PLACES_KEY. Every Google call in nearby-places is gated on that key,
-- so removing it makes the Places rung, the sweep and ?rank inert at once.
--
-- WHAT THIS FILE DOES
--   1. 34 seed gems whose line came from Google get a hand-written curated line
--      (written from official/public sources — NOT from the Google text).
--   2. 9 seed gems with no documented story (restaurants, bars, comedy clubs,
--      an arcade, a farm, two small galleries) are marked resolved_source='none'
--      — the story gate hides them. Reversible: give one a curated line later.
--   3. 3 notable OSM pins that the sweep had rescued get a curated row, so they
--      stay on the map (Klondike Gold Rush NHP, USS Cod, Hobie Beach).
--   4. Cut-over: unschedule the nightly sweep, delete tile rows that baked a
--      Google line in, delete every Google line in the resolve bank, delete the
--      sweep's own ledger.
--
-- RUN ORDER: 0 (read) -> 1 -> 2 -> 3 -> 4 (read), one section at a time.
-- Sections 1-3 are each one transaction; if one errors, nothing in it is written.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- SECTION 0 — BEFORE (read-only). Expect gems_places = 43, bank_places = 50,
-- tiles_with_google_line = 4, sweep_job = 1. Also check curated_descriptions'
-- columns: sections 1 and 2 insert (name, description, lat, lng) only — if any
-- OTHER column is NOT NULL without a default, stop and tell Claude.
-- -----------------------------------------------------------------------------
select
  (select count(*) from public.submissions where resolved_source = 'places')                       as gems_places,
  (select count(*) from public.shared_kv where key like 'resolve:%'
                                          and value::jsonb->>'source' = 'places')                  as bank_places,
  (select count(*) from public.shared_kv t
     where t.key ~ '^places:v[0-9]+:'
       and exists (select 1 from public.shared_kv b,
                          jsonb_array_elements(t.value::jsonb->'places') e
                   where b.key like 'resolve:%' and b.value::jsonb->>'source' = 'places'
                     and e->>'desc' = b.value::jsonb->>'desc'))                                    as tiles_with_google_line,
  (select count(*) from cron.job where jobname = 'places-sweep-nightly')                           as sweep_job;

select column_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'curated_descriptions'
order by ordinal_position;


-- -----------------------------------------------------------------------------
-- SECTION 1 — THE 43 GEMS. One transaction. Every write is guarded on
-- resolved_source = 'places', so a re-run changes nothing.
-- -----------------------------------------------------------------------------
begin;

with cur(id, description) as (values
    ('23119622-b487-4800-82eb-57789e57c046'::uuid, 'A free nature center run by Austin Parks and Recreation beside Zilker Park, with live-animal exhibits, nature trails and an outdoor fossil dig pit.'),
    ('9f9f30f6-657a-4f2d-ba51-5d97253fe86d'::uuid, 'A Chicago Park District park on a former industrial slag site near Lake Calumet, with a bike park and restored wetland habitat for birds.'),
    ('591277a8-4f0e-4dca-b230-5dec6160d43f'::uuid, 'A free neighborhood pool in Travis Heights that opened in 1937, built with New Deal WPA funds and kept warm year-round; it is named for William Stacy, who developed the neighborhood.'),
    ('5a352c58-19c7-4318-bb69-5a70efc30b3c'::uuid, 'A fenced bird sanctuary in Lincoln Park created in the early 1920s. Saved from demolition in 1968, it was later renamed for Bill Jarvis, the birder who led the volunteers who restored it.'),
    ('ff1a75d7-2724-478a-9486-d7050e9c76ef'::uuid, 'A national and state park made up of the islands of Boston Harbor, including Georges Island and its Civil War-era Fort Warren.'),
    ('05308677-01e1-4f64-b8d0-ff087980e5bd'::uuid, 'A West Seattle park and environmental learning center built in the late 1930s, home to Schurman Rock, one of the first artificial climbing rocks in the United States.'),
    ('400d157e-b363-4fb7-9181-8dcf191a677e'::uuid, 'A park in South Boston surrounding Fort Independence, a granite fort built in the mid-1800s on a site fortified since colonial times.'),
    ('e8103a5c-6909-4106-bcae-f94effd4ed09'::uuid, 'A 1919 municipal pier on Philadelphia''s Delaware River waterfront, reopened in 2018 as a public space with artist studios, exhibitions and a garden at its end.'),
    ('d21c333e-5b00-4b94-8459-f15dc7e06ba6'::uuid, 'A 60-acre woodland in New Orleans City Park, first developed in 1938 by the WPA, with trails leading to Laborde Mountain, the city''s highest point at 43 feet.'),
    ('7f95e6f8-b281-4346-b0bc-fb5f3b943d0f'::uuid, 'A public skatepark in Atlanta''s Historic Fourth Ward Park, beside the BeltLine''s Eastside Trail.'),
    ('10e0eee3-5b63-4245-b491-75ce40360419'::uuid, 'A brick-paved oceanfront promenade in Hollywood, Florida, running about two and a half miles along the beach.'),
    ('ffd36ed8-80b7-4ac2-b35c-939bb9b7f3b6'::uuid, 'The Institute of Contemporary Art''s seasonal exhibition space in a former copper pipe factory at the East Boston Shipyard, opened in 2018.'),
    ('15007f4b-7f3d-4dfe-8c20-a415fcd95cfa'::uuid, 'The riverside loop along Kelly Drive and Martin Luther King Jr. Drive on both banks of the Schuylkill River in Philadelphia, passing Boathouse Row.'),
    ('6aeb01a9-7d87-4672-966d-3694517608f9'::uuid, 'A city museum in Littleton, Colorado, with two working living-history farms portraying the 1860s and the 1890s.'),
    ('2a7f93fa-6539-464f-9d69-f19e3a5d97a0'::uuid, 'A Jefferson County Open Space park in the foothills west of Denver, with the ruins of John Brisben Walker''s 1909 home and the foundation of a planned summer White House.'),
    ('f408c43b-2c89-4e9f-ab7b-915768bbd01a'::uuid, 'A dime-museum-style collection of oddities and curiosities on Sixth Street in downtown Austin.'),
    ('e596675e-f55c-4b3e-9a28-864976da8622'::uuid, 'A Nashville whiskey distillery revived in 2014 by descendants of Charles Nelson, whose Green Brier Distillery operated in Tennessee before Prohibition.'),
    ('c40bf383-c102-4ba7-ba85-9af23103c2b1'::uuid, 'A beachfront park in Miami Beach''s North Beach neighborhood, with paths through the dunes and access to the beach.'),
    ('994d9b9c-8582-4e2f-b181-30597a69df21'::uuid, 'A Chicago Park District nature preserve on the grounds of the former Municipal Tuberculosis Sanitarium, with woodland, wetland and prairie trails.'),
    ('5e56dfb8-bc24-483e-9751-bada9f966dfc'::uuid, 'A Travis County park on a peninsula of Lake Travis, known for its limestone cliffs and lakeshore camping.'),
    ('38de421f-8cc4-49c2-9043-10edd6758fa2'::uuid, 'A free outdoor museum in Federal Way, Washington, showing bonsai from around the Pacific Rim; it began in 1989 as Weyerhaeuser''s bonsai collection.'),
    ('67b8089a-f008-409e-b8b6-305f8958c17d'::uuid, 'A west Denver park named for Francisco "Paco" Sánchez, who launched Denver''s first Spanish-language radio station in 1954 and later served as a state legislator; its playground tower is shaped like a vintage microphone.'),
    ('8e325484-9f66-4b87-bd22-e16163c9c6bc'::uuid, 'The oldest building in San Francisco, containing adobe walls from the Spanish presidio founded in 1776; it is now a free museum and cultural center.'),
    ('7a42f2a7-eb97-4435-ae79-284c417792f1'::uuid, 'A public park built on a former pier beneath the Benjamin Franklin Bridge on Philadelphia''s Delaware River waterfront, opened in 2011.'),
    ('2d625b4e-bc3c-48a5-a21d-b70c50639cb7'::uuid, 'Philadelphia''s elevated park on the former Reading Railroad City Branch viaduct; its first section opened in 2018.'),
    ('e2db7c35-0439-4eaa-adeb-9c11dd8dcf0e'::uuid, 'A concert hall inside Harvard''s Memorial Hall, the university''s Civil War memorial; the theatre opened in 1876.'),
    ('b80b45ad-4415-4403-903b-bb69e9bf5a82'::uuid, 'A swimming hole on Barton Creek in Austin''s Barton Creek Greenbelt, named for the water-carved limestone around its falls.'),
    ('19266a25-c3b1-4604-927d-172da7fba7c5'::uuid, 'Houston''s mosaic folk-art park beside the Orange Show, built by more than 300 artists from recycled materials and named for folk-art patrons John and Stephanie Smither; it opened in 2016.'),
    ('5c6f21f5-11c2-4334-bc41-35ae91e8305a'::uuid, 'A lakefront park on part of the former U.S. Steel South Works site. The mill''s massive concrete ore walls still stand, and one section is now a climbing wall.'),
    ('dbc87644-422d-41ac-866a-1202eb3935c8'::uuid, 'A trail along the sandstone bluffs of Sunset Cliffs Natural Park on San Diego''s Point Loma peninsula.'),
    ('136d0b5a-a0af-474c-bc25-cb9f4cd296ff'::uuid, 'A Philadelphia nonprofit ceramic arts center founded in 1974, with galleries, studios and classes.'),
    ('9710a956-b3be-4d2a-b915-36836b0a8a31'::uuid, 'An Atlanta restaurant serving Southern cooking since 1927, at its Cheshire Bridge Road home since the early 1960s.'),
    ('0576e728-7486-4a61-a09a-fa353217154c'::uuid, 'A public lawn and event space in Boston''s Seaport run by the Massachusetts Convention Center Authority, known for its illuminated swings.'),
    ('50b8e8b6-51fd-4d47-9f22-47c884764a67'::uuid, 'A large Fort Worth city park along the Clear Fork of the Trinity River, near downtown and the Cultural District.')
),
ins as (
  insert into public.curated_descriptions (name, description, lat, lng)
  select s.name, c.description, s.lat, s.lng
  from cur c join public.submissions s on s.id = c.id
  where s.resolved_source = 'places'
    and not exists (select 1 from public.curated_descriptions d
                    where d.name = s.name
                      and abs(d.lat - s.lat) < 0.001 and abs(d.lng - s.lng) < 0.001)
  returning 1
)
update public.submissions s
set resolved_description = c.description, resolved_source = 'curated'
from cur c
where s.id = c.id and s.resolved_source = 'places';

-- No documented story: Ghost Ranch, Windsor, Upstairs Circus, Topaz Farm, Curious Comedy Theater, ColdTowne Theater, Seattle Pinball Museum, Kettle Art Gallery, Dutch Alley Artist's Co-op
update public.submissions
set resolved_description = '', resolved_source = 'none'
where resolved_source = 'places'
  and id in (
    '30bbdc7c-5d62-424a-88c5-c4b7d6baebdf'::uuid,
    '78d00c28-b3f5-4ad4-8c59-afb836731f55'::uuid,
    'ba69ba45-ec25-4b05-bfd5-8bdabaa0c0a9'::uuid,
    'ebf1b1e3-e8c7-4310-b70e-8dc75b70be06'::uuid,
    '85cadb3a-4ecf-436e-aef1-9804f15f68a0'::uuid,
    '3632849c-6640-4079-8953-5501389371aa'::uuid,
    'c54bc628-af9e-4174-8eea-ea4fd343a1b3'::uuid,
    '29f6f19d-b4a2-427b-b448-1c32d47bab72'::uuid,
    'd0233190-370a-490c-9ffa-53a352388fd3'::uuid
  );

-- Guard: aborts (and rolls back this whole section) unless all 43 were handled.
do $$ begin
  if (select count(*) from public.submissions where resolved_source = 'places') <> 0 then
    raise exception 'gems still on Google lines — nothing written; tell Claude';
  end if;
end $$;

commit;


-- -----------------------------------------------------------------------------
-- SECTION 2 — 3 OSM PINS the sweep had rescued. Curated rows reach storyless
-- OSM pins at serve time (#362, name + 2 km), within ~5 minutes.
-- -----------------------------------------------------------------------------
begin;

insert into public.curated_descriptions (name, description, lat, lng)
select v.name, v.description, v.lat, v.lng
from (values
    ('Klondike Gold Rush National Historical Park', 'The Seattle unit of Klondike Gold Rush National Historical Park, a free National Park Service museum in Pioneer Square telling the story of the 1897-98 gold rush that made Seattle its outfitting hub.', 47.5994, -122.3319),
    ('USS Cod Submarine Memorial', 'USS Cod, a World War II Gato-class submarine preserved as a museum ship on Cleveland''s lakefront; it is a National Historic Landmark.', 41.5101, -81.6916),
    ('Hobie Beach', 'A beach along the Rickenbacker Causeway on Virginia Key in Miami, popular for windsurfing and paddling.', 25.7451, -80.176)
) as v(name, description, lat, lng)
where not exists (select 1 from public.curated_descriptions d
                  where d.name = v.name
                    and abs(d.lat - v.lat) < 0.001 and abs(d.lng - v.lng) < 0.001);

commit;


-- -----------------------------------------------------------------------------
-- SECTION 3 — CUT-OVER. Only after GOOGLE_PLACES_KEY is deleted (see top).
-- Order inside matters: tiles are matched against the bank, so tiles go first.
-- -----------------------------------------------------------------------------
begin;

-- (a) stop the nightly sweep (#385). A no-op if the job is already gone.
select cron.unschedule(jobid) from cron.job where jobname = 'places-sweep-nightly';

-- (b) tile rows that baked a Google line in (4 today). They rebuild on the next
--     visit; the pre-warm re-run picks them up too.
delete from public.shared_kv t
where t.key ~ '^places:v[0-9]+:'
  and t.key <> 'places:blocklist'
  and exists (select 1 from public.shared_kv b,
                     jsonb_array_elements(t.value::jsonb->'places') e
              where b.key like 'resolve:%' and b.value::jsonb->>'source' = 'places'
                and e->>'desc' = b.value::jsonb->>'desc');

-- (c) every Google line in the resolve bank (50 today)
delete from public.shared_kv
where key like 'resolve:%' and value::jsonb->>'source' = 'places';

-- (d) the sweep's own ledger (tried/no-match notes; no longer used)
delete from public.shared_kv where key like 'placessweep:%';

commit;


-- -----------------------------------------------------------------------------
-- SECTION 4 — AFTER (read-only). Expect every Google count 0, curated_gems up
-- by 34, hidden_gems up by 9, and the three OSM curated rows present.
-- -----------------------------------------------------------------------------
select
  (select count(*) from public.submissions where resolved_source = 'places')                       as gems_places,
  (select count(*) from public.submissions where resolved_source = 'curated')                      as curated_gems,
  (select count(*) from public.submissions where resolved_source = 'none')                         as hidden_gems,
  (select count(*) from public.shared_kv where key like 'resolve:%'
                                          and value::jsonb->>'source' = 'places')                  as bank_places,
  (select count(*) from public.shared_kv where key like 'placessweep:%')                           as sweep_ledger,
  (select count(*) from cron.job where jobname = 'places-sweep-nightly')                           as sweep_job,
  (select count(*) from public.curated_descriptions
     where name in ('Klondike Gold Rush National Historical Park',
                    'USS Cod Submarine Memorial', 'Hobie Beach'))                                  as osm_curated;

-- REVERT (gems only): there is no automatic revert to the Google lines — that
-- is the point. A wrong curated line is fixed by editing its curated row and the
-- gem's resolved_description; a hidden gem comes back with a curated line.
-- =============================================================================
