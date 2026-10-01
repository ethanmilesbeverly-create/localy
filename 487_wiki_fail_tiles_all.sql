-- 487_wiki_fail_tiles_all.sql — #487 (2026-10-01). Run in the Supabase SQL editor.
-- Safe to run now: nearby-places already carries WIKI_FAIL_VERSION "486-wiki-fail-nocache-v1"
-- (#486), so a deleted tile can no longer be re-cached without its Wikipedia pins.
--
-- What it is: #486's audit (486_wiki_fail_tiles.sql block 1) found 107 v34 tile rows with OSM
-- pins and ZERO Wikipedia pins. #486 cleaned the 18 St. Louis rows; this file cleans the rest
-- (~89, across 16 metros plus 2 rural tiles), mostly cached by the 9/23 pre-warm and the 9/29
-- Phase B runs while Wikipedia was throttling. Tile rows live in public.shared_kv under
-- 'places:<CACHE_VERSION>:<tile>', value = JSON.stringify({ts, places}); the parse reads it as
-- text, a jsonb object or a jsonb string (same as #486). Tile key = round(coord / 0.05), so a
-- tile's centre is key * 0.05 (nearby-places REAL_TILE_DEG = prewarm-tiles TILE_DEG).
--
-- The roster below mirrors prewarm-tiles.ts / gate-tiles.ts (25 metros since #445). It is used
-- only to LABEL tiles here — it is not a fourth roster copy to keep in step; a stale list here
-- just mislabels a tile, it changes nothing live.
--
-- Four blocks. Run them one at a time and read each result before the next.
--   1) AUDIT    (read-only) every hole, labelled with its nearest roster metro.
--   2) SUMMARY  (read-only) holes per metro + the gate command each metro needs after the warm.
--   3) DELETE   every row block 1 lists. A genuine zero just rebuilds the same.
--   4) CHECK    = re-run block 1 AFTER the pre-warm: expect only open-country/offshore tiles.

-- 1) AUDIT (read-only). Expect ~89 rows: Detroit 15, Seattle 11, Baltimore 10, Philadelphia 10,
--    Los Angeles 9, New York 9, Washington, D.C. 6, Atlanta 4, Boston 4, Nashville 2,
--    New Orleans 2, Denver/Phoenix/Portland/St. Paul/San Diego 1 each, and 2 tiles outside every
--    box (886_-1712 Michigan, 806_-1982 Nebraska). Zero St. Louis rows (cleaned under #486).
with roster(name, lat, lng) as (values
  ('Chicago', 41.8781, -87.6298), ('New York', 40.7128, -74.0060), ('San Francisco', 37.7749, -122.4194),
  ('Seattle', 47.6062, -122.3321), ('Portland', 45.5152, -122.6784), ('Denver', 39.7392, -104.9903),
  ('Boston', 42.3601, -71.0589), ('Washington, D.C.', 38.9072, -77.0369), ('Philadelphia', 39.9526, -75.1652),
  ('Atlanta', 33.7490, -84.3880), ('Houston', 29.7604, -95.3698), ('Austin', 30.2672, -97.7431),
  ('Dallas', 32.7767, -96.7970), ('Fort Worth', 32.7555, -97.3308), ('Nashville', 36.1627, -86.7816),
  ('New Orleans', 29.9511, -90.0715), ('Miami', 25.7617, -80.1918), ('San Diego', 32.7157, -117.1611),
  ('Phoenix', 33.4484, -112.0740), ('Minneapolis', 44.9778, -93.2650), ('St. Paul', 44.9537, -93.0900),
  ('Los Angeles', 34.0522, -118.2437), ('Detroit', 42.3314, -83.0458), ('Baltimore', 39.2904, -76.6122),
  ('St. Louis', 38.6270, -90.1994)
),
rows as (
  select key,
         case when jsonb_typeof(value::jsonb) = 'string' then (value::jsonb #>> '{}')::jsonb
              else value::jsonb end as v
  from public.shared_kv
  where key like 'places:v34:%'
),
holes as (
  select substring(key from 'places:v34:(.*)') as tile,
         (select count(*) from jsonb_array_elements(v->'places') p where p->>'source' = 'osm') as osm_pins,
         to_timestamp((v->>'ts')::bigint / 1000) as built_at
  from rows
  where coalesce(v->>'osmEmpty', 'false') <> 'true'
    and not exists (select 1 from jsonb_array_elements(v->'places') p where p->>'source' = 'wiki')
),
placed as (
  select h.*,
         split_part(h.tile, '_', 1)::numeric * 0.05 as tlat,
         split_part(h.tile, '_', 2)::numeric * 0.05 as tlng
  from holes h
)
select p.tile,
       case when m.in_box then m.name else '(outside every box — near ' || m.name || ')' end as metro,
       round(m.km) as km_from_centre,
       p.osm_pins,
       p.built_at
from placed p
cross join lateral (
  select r.name,
         sqrt(power((p.tlat - r.lat) * 111.0, 2) + power((p.tlng - r.lng) * 111.0 * cos(radians(r.lat)), 2)) as km,
         abs(p.tlat - r.lat) <= 15 / 111.0 + 0.025
           and abs(p.tlng - r.lng) <= 15 / (111.0 * cos(radians(r.lat))) + 0.025 as in_box
  from roster r
  order by 2
  limit 1
) m
order by 2, p.osm_pins desc;

-- 2) SUMMARY (read-only). One line per metro with holes, plus the gate dry-run command that
--    metro needs AFTER the pre-warm (a deleted row loses its #300-family gate commit). Copy the
--    gate_dry_run cell into Terminal at the repo root; after the three drop reads, re-run the same
--    line with `--from-records --commit` appended, BEFORE the next metro's dry run.
with roster(name, lat, lng) as (values
  ('Chicago', 41.8781, -87.6298), ('New York', 40.7128, -74.0060), ('San Francisco', 37.7749, -122.4194),
  ('Seattle', 47.6062, -122.3321), ('Portland', 45.5152, -122.6784), ('Denver', 39.7392, -104.9903),
  ('Boston', 42.3601, -71.0589), ('Washington, D.C.', 38.9072, -77.0369), ('Philadelphia', 39.9526, -75.1652),
  ('Atlanta', 33.7490, -84.3880), ('Houston', 29.7604, -95.3698), ('Austin', 30.2672, -97.7431),
  ('Dallas', 32.7767, -96.7970), ('Fort Worth', 32.7555, -97.3308), ('Nashville', 36.1627, -86.7816),
  ('New Orleans', 29.9511, -90.0715), ('Miami', 25.7617, -80.1918), ('San Diego', 32.7157, -117.1611),
  ('Phoenix', 33.4484, -112.0740), ('Minneapolis', 44.9778, -93.2650), ('St. Paul', 44.9537, -93.0900),
  ('Los Angeles', 34.0522, -118.2437), ('Detroit', 42.3314, -83.0458), ('Baltimore', 39.2904, -76.6122),
  ('St. Louis', 38.6270, -90.1994)
),
rows as (
  select key,
         case when jsonb_typeof(value::jsonb) = 'string' then (value::jsonb #>> '{}')::jsonb
              else value::jsonb end as v
  from public.shared_kv
  where key like 'places:v34:%'
),
holes as (
  select substring(key from 'places:v34:(.*)') as tile
  from rows
  where coalesce(v->>'osmEmpty', 'false') <> 'true'
    and not exists (select 1 from jsonb_array_elements(v->'places') p where p->>'source' = 'wiki')
),
labelled as (
  select m.name, m.lat, m.lng, m.in_box
  from holes h
  cross join lateral (
    select r.name, r.lat, r.lng,
           abs(split_part(h.tile, '_', 1)::numeric * 0.05 - r.lat) <= 15 / 111.0 + 0.025
             and abs(split_part(h.tile, '_', 2)::numeric * 0.05 - r.lng) <= 15 / (111.0 * cos(radians(r.lat))) + 0.025 as in_box
    from roster r
    order by power((split_part(h.tile, '_', 1)::numeric * 0.05 - r.lat) * 111.0, 2)
           + power((split_part(h.tile, '_', 2)::numeric * 0.05 - r.lng) * 111.0 * cos(radians(r.lat)), 2)
    limit 1
  ) m
)
select case when in_box then name else '(outside every box)' end as metro,
       count(*) as holes,
       case when in_box then
         'SEED_CITY_NAME="' || name || '" SEED_CITY_LAT=' || lat || ' SEED_CITY_LNG=' || lng ||
         ' deno run -A gate-tiles.ts'
       else '(none — rebuilds on first visit)' end as gate_dry_run
from labelled
group by in_box, name, lat, lng
order by 2 desc, 1;

-- 3) DELETE — every row block 1 lists. Returns one line per deleted tile; expect the same count
--    as block 1. Deleted rows are rebuilt by the pre-warm (roster metros) or by the first visitor
--    (the two rural tiles), under the #486 guard either way. Until rebuilt, a visitor to one of
--    these tiles gets a cold build (~15 s) instead of the broken warm one.
with rows as (
  select key,
         case when jsonb_typeof(value::jsonb) = 'string' then (value::jsonb #>> '{}')::jsonb
              else value::jsonb end as v
  from public.shared_kv
  where key like 'places:v34:%'
)
delete from public.shared_kv s
using rows
where s.key = rows.key
  and coalesce(rows.v->>'osmEmpty', 'false') <> 'true'
  and not exists (select 1 from jsonb_array_elements(rows.v->'places') p where p->>'source' = 'wiki')
returning substring(s.key from 'places:v34:(.*)') as deleted_tile;

-- 4) CHECK — after the pre-warm and its --retry-failed runs are clean, re-run block 1.
--    Expect only genuine zeros: open water or open country (San Diego offshore 652_-2345 is the
--    likely one), and the two rural tiles only if someone visited them since. A city tile here
--    (NYC 817_-1484, Seattle 953_-2446) means the warm did not reach it — retry it, don't delete again.
