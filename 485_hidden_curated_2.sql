-- 485_hidden_curated_2.sql — #485 Katy-Energy Corridor part 2: a curated row for one HIDDEN storyless OSM pin
-- (handoff §6 story-lines (y)). Tile 595_-1913 built in pre-warm round 5 (2026-10-28); its stored places:v34 row holds
-- osm_node12403652926, stored as "Gray Lodge No. 329, A. F. & A. M." (spaced — the row must match the STORED name, not HMdb's
-- "A.F.& A.M."), at 29.73786, -95.64827, desc "A local memorial (plaque)."; absent from the tile's served answer (17 pins, under
-- the ~20 cap), so hidden. Story worded from HMdb m=159203.
--
-- RUN: the SQL editor, this whole file in its own tab, AFTER 485_hidden_curated.sql. Re-runnable: skipped when a same-name curated
-- row sits within 50 m. Expect 1 row returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect "Gray Lodge No. 329, A. F. & A. M." among the rows, dist_m 0.
-- BACK-OUT: delete from public.curated_descriptions where note = '#485 hidden-pin row — Katy-Energy Corridor part 2 (2026-10-28)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Gray Lodge No. 329, A. F. & A. M.$t$, 29.73786::double precision, -95.64827::double precision, $t$Houston's second-oldest Masonic lodge, chartered in 1870, is named for William Fairfax Gray, who was at the 1836 convention that declared Texas independent; its members were among the first to help victims of the 1900 Galveston storm.$t$, $t$https://www.hmdb.org/m.asp?m=159203$t$, $t$#485 hidden-pin row — Katy-Energy Corridor part 2 (2026-10-28)$t$)
)
insert into public.curated_descriptions (name, lat, lng, description, source_url, note)
select v.name, v.lat, v.lng, v.description, v.source_url, v.note
from v
where not exists (
  select 1 from public.curated_descriptions d
  where d.name_clean = regexp_replace(lower(v.name), '[^a-z0-9]', '', 'g')
    and 6371000 * sqrt(
          power(radians(d.lat - v.lat), 2) +
          power(cos(radians((d.lat + v.lat) / 2)) * radians(d.lng - v.lng), 2)) <= 50
)
returning name, note;
