#!/usr/bin/env bash
# =============================================================================
# 497_gate_rerun.sh — #497: re-run the #300-family gate for the 17 metros whose
# tiles #487 deleted and rebuilt (a rebuilt row carries no gate commit, so pins
# a metro's gate run had dropped can be back on the map).
#
# One background command does all 17, one metro at a time, unattended:
#   for each metro: dry run (with --resume, retried after a cool-down while
#   Wikipedia throttles) → save that metro's records → --from-records --commit
#   → record the drop counts → short gap → next metro.
#
# RUN (from the repo root, ~/roaminator; caffeinate keeps the Mac awake):
#   nohup caffeinate -i bash 497_gate_rerun.sh > ~/roaminator-497.log 2>&1 &
# WATCH:   tail -f ~/roaminator-497.log
# RESULTS: ~/roaminator-497/summary.tsv  (one line per metro — paste it back)
#
# RE-RUN SAFE: a metro that finished cleanly gets a .done marker and is skipped;
# just run the same command again. A metro still throttled after every try is
# committed for its clean tiles and marked .partial — a re-run redoes it whole.
#
# Review happens AFTER commit (the trade-off chosen 2026-10-02): every metro's
# dropped lists are kept in ~/roaminator-497/<metro>.records.json. A wrong drop
# backs out by deleting that tile's places:<VER>:<tile> row — the function
# rebuilds it un-gated on the next hit (the gate-tiles.ts BACK-OUT note).
#
# CONFIG OUTSIDE THE FILE: the same shell env gate-tiles.ts needs —
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEARBY_PLACES_KEY. Nothing else.
# Optional knobs: GATE497_ONLY="Atlanta" (run just one metro),
# GATE497_RETRY_WAIT_MIN (default 20), GATE497_MAX_TRIES (default 8),
# GATE497_METRO_GAP_MIN (default 5), GATE497_OUT (default ~/roaminator-497).
# Not a deploy target: repo commit only. Changes no index.html / function.
# =============================================================================
BUILD="497_gate_rerun 2026.10.02a"
set -u

cd "$(dirname "$0")" || exit 1

OUT="${GATE497_OUT:-$HOME/roaminator-497}"
RETRY_WAIT_MIN="${GATE497_RETRY_WAIT_MIN:-20}"
MAX_TRIES="${GATE497_MAX_TRIES:-8}"
METRO_GAP_MIN="${GATE497_METRO_GAP_MIN:-5}"
ONLY="${GATE497_ONLY:-}"
SUMMARY="$OUT/summary.tsv"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# The 17 metros (#497), coordinates copied from the gate-tiles.ts roster.
METROS=(
  "Atlanta|33.7490|-84.3880"
  "Baltimore|39.2904|-76.6122"
  "Boston|42.3601|-71.0589"
  "Denver|39.7392|-104.9903"
  "Detroit|42.3314|-83.0458"
  "Houston|29.7604|-95.3698"
  "Los Angeles|34.0522|-118.2437"
  "Nashville|36.1627|-86.7816"
  "New Orleans|29.9511|-90.0715"
  "New York|40.7128|-74.0060"
  "Philadelphia|39.9526|-75.1652"
  "Phoenix|33.4484|-112.0740"
  "Portland|45.5152|-122.6784"
  "San Diego|32.7157|-117.1611"
  "Seattle|47.6062|-122.3321"
  "St. Paul|44.9537|-93.0900"
  "Washington, D.C.|38.9072|-77.0369"
)

# ---- preflight: fail before touching anything ----
log "$BUILD — starting in $(pwd)"
for v in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY NEARBY_PLACES_KEY; do
  if [ -z "${!v:-}" ]; then log "FATAL: $v is not set in this shell — nothing was run."; exit 1; fi
done
command -v deno >/dev/null 2>&1 || { log "FATAL: deno not found on PATH — nothing was run."; exit 1; }
[ -f gate-tiles.ts ] || { log "FATAL: gate-tiles.ts not here — run from the repo root (~/roaminator)."; exit 1; }
mkdir -p "$OUT"
[ -f "$SUMMARY" ] || printf "metro\tstatus\ttiles\tdropped\tresolved\tgrave_resolved\tthrottled_left\tno_row\tcommitted\teligible\tfinished\n" > "$SUMMARY"

# Summarise gate_tiles_records.json (+ report's `bailed`) as space-separated numbers:
#   tiles dropped resolved grave throttled noRow committed eligible bailed
# Totals come from the RECORDS, not the report: under --resume the report only
# counts tiles processed in that run, while the records hold every tile.
stats() {
  deno eval '
    const rd = (f) => { try { return JSON.parse(Deno.readTextFileSync(f)); } catch { return null; } };
    const recs = rd("gate_tiles_records.json") || [];
    const rep = rd("gate_tiles_report.json") || {};
    let dropped = 0, resolved = 0, grave = 0, thr = 0, noRow = 0, committed = 0, eligible = 0;
    for (const r of recs) {
      dropped += r.droppedCount || 0; resolved += r.resolved || 0; grave += r.graveResolved || 0;
      if (r.throttled) thr++;
      if (r.skipped === "no-row") noRow++;
      if (r.committed) committed++;
      if (!r.throttled && !r.skipped && typeof r.outCount === "number") eligible++;
    }
    console.log([recs.length, dropped, resolved, grave, thr, noRow, committed, eligible, rep.bailed ? 1 : 0].join(" "));
  ' 2>/dev/null || echo "0 0 0 0 0 0 0 0 1"
}

done_count=0; partial_count=0; skipped_count=0
for entry in "${METROS[@]}"; do
  IFS='|' read -r name lat lng <<< "$entry"
  if [ -n "$ONLY" ] && [ "$ONLY" != "$name" ]; then continue; fi
  slug="$(echo "$name" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n' '-' | tr -s '-' | sed 's/-$//')"

  if [ -f "$OUT/$slug.done" ]; then
    log "$name — already done (remove $OUT/$slug.done to redo), skipping"
    skipped_count=$((skipped_count + 1)); continue
  fi
  rm -f "$OUT/$slug.partial"

  # Fresh slate: a leftover checkpoint or records file from another metro must
  # never be resumed from or committed.
  rm -f gate_tiles_progress.json gate_tiles_records.json gate_tiles_report.json gate_tiles_held.json

  # ---- dry run, retried with --resume while Wikipedia throttles ----
  try=1; clean=0
  while :; do
    log "$name — dry run, try $try/$MAX_TRIES"
    SEED_CITY_NAME="$name" SEED_CITY_LAT="$lat" SEED_CITY_LNG="$lng" \
      deno run -A gate-tiles.ts --resume >> "$OUT/$slug.dry.log" 2>&1
    rc=$?
    read -r tiles dropped resolved grave thr noRow committed eligible bailed <<< "$(stats)"
    log "$name — try $try: exit $rc, tiles=$tiles dropped=$dropped resolved=$resolved throttled=$thr bailed=$bailed"
    if [ "$rc" -eq 0 ] && [ "$bailed" -eq 0 ] && [ "$thr" -eq 0 ] && [ "$tiles" -gt 0 ]; then clean=1; break; fi
    if [ "$try" -ge "$MAX_TRIES" ]; then break; fi
    log "$name — waiting ${RETRY_WAIT_MIN} min for Wikipedia to cool, then resuming"
    sleep $((RETRY_WAIT_MIN * 60))
    try=$((try + 1))
  done

  if [ "$tiles" -eq 0 ]; then
    log "$name — NO RECORDS after $try tries (see $OUT/$slug.dry.log). Not committed; a re-run will redo it."
    printf "%s\tFAILED\t0\t0\t0\t0\t0\t0\t0\t0\t%s\n" "$name" "$(date '+%Y-%m-%d %H:%M')" >> "$SUMMARY"
    touch "$OUT/$slug.partial"; partial_count=$((partial_count + 1))
    continue
  fi

  cp gate_tiles_records.json "$OUT/$slug.records.json"
  cp gate_tiles_report.json "$OUT/$slug.dry-report.json" 2>/dev/null

  # ---- commit exactly what the dry run recorded (no re-crawl; throttled tiles are skipped) ----
  log "$name — committing $eligible tile(s) from the dry run's records"
  deno run -A gate-tiles.ts --from-records --commit >> "$OUT/$slug.commit.log" 2>&1
  crc=$?
  read -r tiles dropped resolved grave thr noRow committed eligible bailed <<< "$(stats)"
  cp gate_tiles_records.json "$OUT/$slug.committed-records.json"

  if [ "$clean" -eq 1 ] && [ "$crc" -eq 0 ] && [ "$committed" -eq "$eligible" ]; then
    status="DONE"; touch "$OUT/$slug.done"; done_count=$((done_count + 1))
  else
    status="PARTIAL"; touch "$OUT/$slug.partial"; partial_count=$((partial_count + 1))
  fi
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
    "$name" "$status" "$tiles" "$dropped" "$resolved" "$grave" "$thr" "$noRow" "$committed" "$eligible" "$(date '+%Y-%m-%d %H:%M')" >> "$SUMMARY"
  log "$name — $status: tiles=$tiles dropped=$dropped resolved=$resolved grave=$grave throttled_left=$thr committed=$committed/$eligible (commit exit $crc)"

  log "pausing ${METRO_GAP_MIN} min before the next metro"
  sleep $((METRO_GAP_MIN * 60))
done

log "FINISHED — done=$done_count partial/failed=$partial_count already-done=$skipped_count"
log "Summary: $SUMMARY"
column -t -s $'\t' "$SUMMARY" 2>/dev/null || cat "$SUMMARY"
[ "$partial_count" -gt 0 ] && log "Re-run the same command later to redo the PARTIAL/FAILED metros; DONE ones are skipped."
exit 0
