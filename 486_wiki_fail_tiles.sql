-- 486_wiki_fail_tiles.sql — #486 (2026-09-30). Run in the Supabase SQL editor AFTER the
-- nearby-places deploy that carries WIKI_FAIL_VERSION "486-wiki-fail-nocache-v1".
-- Run order matters: deleting before the deploy lets the old function re-cache the same
-- OSM-only tile if Wikipedia throttles the rebuild again.
--
-- What it is: before #486 a tile whose Wikipedia geosearch failed was cached as if the
-- geosearch had found nothing — an OSM-only tile served for 21 days. St. Louis tile
-- 772_-1805 (Tower Grove Park, the Botanical Garden, South Grand) was cached with 0
-- Wikipedia pins during the 2026-09-30 pre-warm. Tile rows live in public.shared_kv under
-- key 'places:<CACHE_VERSION>:<tile>'; the function writes value = JSON.stringify({ts, places}).
-- The parse below reads that value whether the column stores it as text, as a jsonb
-- object, or as a jsonb string.
--
-- Three blocks. Run them one at a time and read each result before the next.

-- 1) AUDIT (read-only) — every v34 tile row that has OSM pins but ZERO Wikipedia pins,
--    across all metros. A zero is real in open country; in a city it is the #486 hole.
--    Expect the St. Louis tiles from block 2 in this list; the rest scopes the follow-up.
with rows as (
  select key,
         case when jsonb_typeof(value::jsonb) = 'string' then (value::jsonb #>> '{}')::jsonb
              else value::jsonb end as v
  from public.shared_kv
  where key like 'places:v34:%'
)
select substring(key from 'places:v34:(.*)') as tile,
       (select count(*) from jsonb_array_elements(v->'places') p where p->>'source' = 'osm')  as osm_pins,
       to_timestamp((v->>'ts')::bigint / 1000) as built_at
from rows
where coalesce(v->>'osmEmpty', 'false') <> 'true'
  and not exists (select 1 from jsonb_array_elements(v->'places') p where p->>'source' = 'wiki')
order by built_at desc;

-- 2) DELETE — the St. Louis rows (the 42 #445 tiles) that hold zero Wikipedia pins.
--    Expect roughly 10–14 rows (the five dense tiles named in #486 plus the thin and
--    Illinois-side ones). A deleted row is rebuilt by the next pre-warm, under the guard.
with stl as (
  select key,
         case when jsonb_typeof(value::jsonb) = 'string' then (value::jsonb #>> '{}')::jsonb
              else value::jsonb end as v
  from public.shared_kv
  where key in (
    'places:v34:770_-1807', 'places:v34:770_-1806', 'places:v34:770_-1805', 'places:v34:770_-1804', 'places:v34:770_-1803', 'places:v34:770_-1802', 'places:v34:770_-1801',
    'places:v34:771_-1807', 'places:v34:771_-1806', 'places:v34:771_-1805', 'places:v34:771_-1804', 'places:v34:771_-1803', 'places:v34:771_-1802', 'places:v34:771_-1801',
    'places:v34:772_-1807', 'places:v34:772_-1806', 'places:v34:772_-1805', 'places:v34:772_-1804', 'places:v34:772_-1803', 'places:v34:772_-1802', 'places:v34:772_-1801',
    'places:v34:773_-1807', 'places:v34:773_-1806', 'places:v34:773_-1805', 'places:v34:773_-1804', 'places:v34:773_-1803', 'places:v34:773_-1802', 'places:v34:773_-1801',
    'places:v34:774_-1807', 'places:v34:774_-1806', 'places:v34:774_-1805', 'places:v34:774_-1804', 'places:v34:774_-1803', 'places:v34:774_-1802', 'places:v34:774_-1801',
    'places:v34:775_-1807', 'places:v34:775_-1806', 'places:v34:775_-1805', 'places:v34:775_-1804', 'places:v34:775_-1803', 'places:v34:775_-1802', 'places:v34:775_-1801'
  )
)
delete from public.shared_kv s
using stl
where s.key = stl.key
  and not exists (select 1 from jsonb_array_elements(stl.v->'places') p where p->>'source' = 'wiki')
returning substring(s.key from 'places:v34:(.*)') as deleted_tile;

-- 3) CHECK — the St. Louis tile rows left. Expect 42 minus block 2's count, every one
--    with wiki_pins above 0.
with stl as (
  select key,
         case when jsonb_typeof(value::jsonb) = 'string' then (value::jsonb #>> '{}')::jsonb
              else value::jsonb end as v
  from public.shared_kv
  where key in (
    'places:v34:770_-1807', 'places:v34:770_-1806', 'places:v34:770_-1805', 'places:v34:770_-1804', 'places:v34:770_-1803', 'places:v34:770_-1802', 'places:v34:770_-1801',
    'places:v34:771_-1807', 'places:v34:771_-1806', 'places:v34:771_-1805', 'places:v34:771_-1804', 'places:v34:771_-1803', 'places:v34:771_-1802', 'places:v34:771_-1801',
    'places:v34:772_-1807', 'places:v34:772_-1806', 'places:v34:772_-1805', 'places:v34:772_-1804', 'places:v34:772_-1803', 'places:v34:772_-1802', 'places:v34:772_-1801',
    'places:v34:773_-1807', 'places:v34:773_-1806', 'places:v34:773_-1805', 'places:v34:773_-1804', 'places:v34:773_-1803', 'places:v34:773_-1802', 'places:v34:773_-1801',
    'places:v34:774_-1807', 'places:v34:774_-1806', 'places:v34:774_-1805', 'places:v34:774_-1804', 'places:v34:774_-1803', 'places:v34:774_-1802', 'places:v34:774_-1801',
    'places:v34:775_-1807', 'places:v34:775_-1806', 'places:v34:775_-1805', 'places:v34:775_-1804', 'places:v34:775_-1803', 'places:v34:775_-1802', 'places:v34:775_-1801'
  )
)
select substring(key from 'places:v34:(.*)') as tile,
       (select count(*) from jsonb_array_elements(v->'places') p where p->>'source' = 'wiki') as wiki_pins
from stl
order by 1;
