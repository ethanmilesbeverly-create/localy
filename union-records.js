// union-records.js — merge N gate-tiles dry-run record files into ONE conservative union
// that `gate-tiles.ts --from-records --commit` can consume.
//
// WHY: the recall path (Wikipedia search ranking) is nondeterministic — the same art pin
// resolves on one sweep and misses on the next (the logged --gen 236↔221 variance). A
// single run therefore drops some works that DO have an article, at random. This tool
// takes several dry runs and, per tile, keeps a pin if it resolved in ANY run — i.e. the
// committed `dropped` list is the INTERSECTION of the runs' drops, and `resolvedDetail`
// is the UNION of their hits. Union only ADDS resolutions; it never drops a pin that any
// run resolved, and never invents a description that wasn't produced by some run.
//
// USAGE:
//   deno run --allow-read --allow-write union-records.js run1.json run2.json [run3.json ...]
//   -> writes gate_tiles_records.union.json  (then cp it over gate_tiles_records.json to commit)

const files = Deno.args.filter((a) => !a.startsWith("--"));
if (files.length < 2) {
  console.error("Need at least 2 record files. Usage: union-records.js run1.json run2.json [run3.json ...]");
  Deno.exit(1);
}

const runs = [];
for (const f of files) {
  try { runs.push({ f, recs: JSON.parse(Deno.readTextFile ? await Deno.readTextFile(f) : "") }); }
  catch (e) { console.error(`FATAL: cannot read/parse ${f}: ${e}`); Deno.exit(1); }
}
console.log(`Merging ${runs.length} runs: ${files.join(", ")}`);

// index every run's records by tile
const tilesSeen = new Map(); // tile -> { lat,lng,metro, inCount }
const perTile = new Map();   // tile -> { resolved: Map(name->desc), droppedAny: Map(name->{category,desc}), noRowInEvery: bool }

for (const { recs } of runs) {
  const tilesInThisRun = new Set();
  for (const r of recs) {
    if (!r || !r.tile) continue;
    tilesInThisRun.add(r.tile);
    if (!tilesSeen.has(r.tile)) tilesSeen.set(r.tile, { lat: r.lat, lng: r.lng, metro: r.metro, inCount: r.inCount || 0 });
    else { const t = tilesSeen.get(r.tile); if ((r.inCount || 0) > t.inCount) t.inCount = r.inCount; } // max inCount
    if (!perTile.has(r.tile)) perTile.set(r.tile, { resolved: new Map(), droppedAny: new Map(), noRowRuns: 0, dataRuns: 0 });
    const agg = perTile.get(r.tile);

    const isNoRow = r.skipped === "no-row";
    if (isNoRow) { agg.noRowRuns++; continue; }
    agg.dataRuns++;

    for (const d of (r.resolvedDetail || [])) {
      if (!d || !d.name) continue;
      const prev = agg.resolved.get(d.name);
      const desc = String(d.desc || "");
      // prefer the longest description across runs (richer article intro), ties -> keep first
      if (prev === undefined || desc.length > prev.length) agg.resolved.set(d.name, desc);
    }
    for (const d of (r.dropped || [])) {
      if (!d || !d.name) continue;
      if (!agg.droppedAny.has(d.name)) agg.droppedAny.set(d.name, { category: String(d.category || ""), desc: String(d.desc || "") });
    }
  }
  // tiles absent from this run entirely don't count as no-row; only explicit no-row records do
}

// build merged records
const merged = [];
let totalResolved = 0, totalDropped = 0;
const rescued = []; // resolved in the union but dropped in at least one run

for (const [tile, meta] of tilesSeen) {
  const agg = perTile.get(tile);
  // tile that was no-row in every run and never had data -> keep as a no-row skip (commit ignores it)
  if (agg.dataRuns === 0) {
    merged.push({ tile, metro: meta.metro, lat: meta.lat, lng: meta.lng, inCount: 0, outCount: 0, resolved: 0, droppedCount: 0, dropped: [], resolvedDetail: [], throttled: false, skipped: "no-row" });
    continue;
  }

  const resolvedNames = new Set(agg.resolved.keys());
  // union rule: a pin is dropped in the union ONLY if no run resolved it
  const dropped = [];
  for (const [name, meta2] of agg.droppedAny) {
    if (resolvedNames.has(name)) { rescued.push({ tile, name }); continue; } // resolved in some run -> keep
    dropped.push({ name, category: meta2.category, desc: meta2.desc });
  }
  const resolvedDetail = [...agg.resolved].map(([name, desc]) => ({ name, desc }));

  totalResolved += resolvedDetail.length;
  totalDropped += dropped.length;

  merged.push({
    tile, metro: meta.metro, lat: meta.lat, lng: meta.lng,
    inCount: meta.inCount,
    outCount: Math.max(0, meta.inCount - dropped.length), // number -> satisfies the commit guard
    resolved: resolvedDetail.length,
    droppedCount: dropped.length,
    dropped,
    resolvedDetail,
    throttled: false,   // union is always a clean, committable record
    // skipped intentionally omitted for tiles with data, so --from-records will commit them
  });
}

await Deno.writeTextFile("gate_tiles_records.union.json", JSON.stringify(merged, null, 2));

console.log(`\nUNION written -> gate_tiles_records.union.json`);
console.log(`  tiles: ${merged.length}`);
console.log(`  total resolved (union): ${totalResolved}`);
console.log(`  total dropped  (union): ${totalDropped}`);
console.log(`  rescued by union (resolved in some run, dropped in another): ${rescued.length}`);
if (rescued.length) {
  const names = [...new Set(rescued.map((r) => r.name))].sort();
  console.log(`\n  -- names the union saved from a false drop --`);
  for (const n of names) console.log(`     + ${n}`);
}
console.log(`\nTo commit this union:`);
console.log(`  cp gate_tiles_records.json gate_tiles_records.prev.json   # backup the last single run`);
console.log(`  cp gate_tiles_records.union.json gate_tiles_records.json  # put the union where --from-records reads`);
console.log(`  deno run --allow-net --allow-env --allow-read --allow-write gate-tiles.ts --from-records --commit`);
