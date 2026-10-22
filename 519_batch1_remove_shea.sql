-- 519_batch1_remove_shea.sql — #519 batch 1: remove the five Shea Stadium base-marker curated rows (operator choice,
-- 2026-10-22). With the rows gone, the five OSM marker pins are storyless again and the serve-time hide (#367) takes
-- them off the map within the 5-minute curated cache. Nothing else in batch 1 is touched.
-- RUN: the SQL editor, this whole file in its own tab. Expect 5 rows returned on the first run, 0 on a re-run.

delete from public.curated_descriptions
where note = '#519 rescue line — New York (2026-10-22)'
  and name in (
    'Site of Shea Stadium First Base 1964-2008',
    'Site of Shea Stadium Second Base 1964-2008',
    'Site of Shea Stadium Third Base 1964-2008',
    'Site of Shea Stadium Home Plate 1964-2008',
    'Site of Shea Stadium Pitcher''s Plate 1964-2008'
  )
returning name;
