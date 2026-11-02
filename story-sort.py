#!/usr/bin/env python3
# story-sort.py — #543: the story pass's mechanical sort, as a tool (handoff §6 THE FAST RUNBOOK (f)).
#
# It reads what a roster box already has (stored `places:v34` rows for the box and one tile around it, the live
# serve of those stored tiles, approved gems), takes the box's candidate list (built here from Wikipedia list
# pages, or hand-made in the same TSV shape), geosearches Wikipedia around every candidate, and writes ONE sorted
# draft: each candidate's action, the line's name and coordinate, the matched pin or article with its distance,
# a `new` flag where the same-place judge could flip, and an empty status column for the chat to fill.
#
# It writes NO story text and replaces NONE of the checks after it — stories are still read and written in chat
# from their sources; the dry run, the bio read, the outside verify and phone QA all stay (THE FAST RUNBOOK (a)).
# Every match it reports is a PROPOSAL: a row marked CHECK SUBJECT must be read by eye (FROM SAN ANTONIO (8)).
#
# Runs in the sandbox (Python 3, standard library only). Reads with the PUBLISHABLE key only — no service key,
# no writes anywhere. Fetches are cached in --cache DIR, so a run that is cut off resumes where it stopped
# (FROM SAN ANTONIO (10)); delete the cache dir to re-read live state.
#
# USAGE (from the repo root, so the roster is read from prewarm-tiles.ts — one fact, not a fourth copy):
#   python3 story-sort.py candidates --box Tampa --prefix TP \
#       --list "National Register of Historic Places listings in Hillsborough County, Florida" \
#       --out 448_candidates_tampa.tsv
#   python3 story-sort.py sort  --box Tampa --candidates 448_candidates_tampa.tsv --out 448_sort_tampa.tsv
#   python3 story-sort.py leads --box Tampa --out 448_leads_tampa.tsv
#
#   candidates  every row of each --list page that carries a coordinate ({{NRHP row}} lat/lon, or a row's
#               {{coord}}) and falls inside the box's tiles, with its linked article as the story article.
#               District listings are kind=district. Rows with no coordinate are listed with kind
#               "no coordinate" so the chat can place or drop them by hand.
#   sort        the sort itself (verdicts below). Re-run it after editing the candidates file — the cache
#               makes a re-run cost only the new candidates' geosearches.
#   leads       every HIDDEN stored pin of a landmark class in the box (history, art, memorial, museum — the
#               gate dry run's drop list, read against the live serve already, FROM PITTSBURGH (7)), each with
#               #542's containing-tile route and an empty verdict column for the chat.
#
# SORT VERDICTS (column `action`):
#   CUT — served                     a served pin of the same subject within MATCH_M (150 m). No line.
#   CUT — gem                        an approved gem of the same subject within MATCH_M. No line.
#   CURATED ROW — hidden pin         a hidden (storyless) stored pin of the same subject, and the tile CONTAINING
#                                    it (Math.round) stores it (#542, checked by pin ID across every stored row):
#                                    a curated row under the pin's EXACT stored name at its stored coordinate.
#   SEED under a different name      a hidden stored pin of the same subject whose containing tile does not store
#     (#542)                         it: a curated row cannot un-hide it, so a seed at the pin's coordinate under
#                                    a different name, flagged `new`.
#   SEED — article in no tile (#539) the candidate's own article (or a same-subject article) has a coordinate
#                                    within MATCH_M and is in no stored row: a line named EXACTLY as the article,
#                                    at the article's coordinate, NOT flagged `new` (FROM PITTSBURGH (4)).
#   SEED — unmapped                  nothing matched: a seed line at the list point. Flagged `new` when any stored
#                                    pin, gem or other candidate sits within NEW_M (100 m), or a near-named article
#                                    within MATCH_M (DuPage (1), Bergen (2)).
#   NO LINE — district centroid      a district with no matching pin: a centroid pin would be arbitrary.
#   NO LINE — no coordinate          kept so nothing silently drops; place it by hand or cut it.
# Flags in `why`: CHECK SUBJECT (a partial-name or container-type match — read it), LIST POINT FAR (the list
# point is > FAR_M (300 m) from its article's point: a wrong article or a large site, FROM SAN ANTONIO (8)),
# TWIN CANDIDATE (two candidates within TWIN_M (30 m) — two plaques on one lot, or one building listed twice),
# CHECK: same-named pin (a pin of the same name 100–300 m from the list point — the place mapped elsewhere?).
#
# Name matching is deliberately conservative: a match needs a shared DISTINCTIVE token (not a generic type word)
# and most of the shorter name's tokens. A miss falls through to SEED — unmapped with a `new` flag, which is the
# safe direction: the dry run's same-place judge never sees a `new` line, and a wrong cut loses a story silently.

import argparse, json, math, os, re, sys, time, unicodedata, urllib.parse, urllib.request

BUILD = "story-sort 2026.11.01b"  # 01b: a Wikipedia 429 waits (Retry-After, then 15 s → 4 min backoff) and, if it persists, exits cleanly with a re-run hint — the cache resumes. 01a: #543 first build: candidates / sort / leads; validated against #447's hand sort.

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://siacjgpqzaylsfefihyr.supabase.co")
# Public by design: the same `sb_publishable_…` key index.html ships. Read-only use here.
PUBLISHABLE_KEY = os.environ.get("NEARBY_PLACES_KEY", "sb_publishable_sJkeQ89O2geQLB5z6d__Zw_9G6nxLt_")
WIKI_API = "https://en.wikipedia.org/w/api.php"
UA = "roaminator-story-sort/2026.11 (operator tool; github.com/ethanmilesbeverly-create/localy)"

TILE_DEG = 0.05            # the tools' tile size
METRO_KM = 15              # the tools' box half-size (prewarm-tiles.ts METRO_KM)
KM_PER_DEG_LAT = 111.0     # the tools' constant — 111.32 shifts a row (Queens-Nassau (a))
MATCH_M = 150              # pin / article match radius (FROM PITTSBURGH (4))
NEW_M = 100                # anything this close makes a seed line `new`
TWIN_M = 30                # two lines this close need a reason (FROM SAN ANTONIO (12))
FAR_M = 300                # list point vs article point (FROM SAN ANTONIO (8))
SERVE_GAP_S = 2.0          # single-file serve reads (Middlesex-Union (2))
WIKI_GAP_S = 1.0           # Wikipedia API spacing (FROM PITTSBURGH (3))
LANDMARK_CATS = {"history", "art", "memorial", "museum", "monument", "graves"}

# ---------------------------------------------------------------- tile math (identical to prewarm-tiles.ts)

def js_round(x):
    # JavaScript Math.round: half rounds toward +infinity (Python's round() is banker's — Queens-Nassau (a)).
    return math.floor(x + 0.5)

def tile_key(lat, lng):
    return f"{js_round(lat / TILE_DEG)}_{js_round(lng / TILE_DEG)}"

def box_tiles(lat0, lng0):
    seen, out = set(), []
    d_lat = METRO_KM / KM_PER_DEG_LAT
    d_lng = METRO_KM / (KM_PER_DEG_LAT * max(0.1, math.cos(math.radians(lat0))))
    lat = lat0 - d_lat
    while lat <= lat0 + d_lat + 1e-9:
        lng = lng0 - d_lng
        while lng <= lng0 + d_lng + 1e-9:
            k = tile_key(lat, lng)
            if k not in seen:
                seen.add(k); out.append(k)
            lng += TILE_DEG
        lat += TILE_DEG
    return out

def ring_of(tiles):
    s = set(tiles)
    for t in tiles:
        a, b = map(int, t.split("_"))
        for da in (-1, 0, 1):
            for db in (-1, 0, 1):
                s.add(f"{a + da}_{b + db}")
    return sorted(s)

def metres(a_lat, a_lng, b_lat, b_lng):
    x = math.radians(b_lng - a_lng) * math.cos(math.radians((a_lat + b_lat) / 2))
    y = math.radians(b_lat - a_lat)
    return 6371000 * math.hypot(x, y)

def read_roster(repo_dir):
    path = os.path.join(repo_dir, "prewarm-tiles.ts")
    src = open(path, encoding="utf-8").read()
    rows = re.findall(r'\{\s*name:\s*"([^"]+)",\s*lat:\s*(-?[\d.]+),\s*lng:\s*(-?[\d.]+)\s*\}', src)
    return {n: (float(a), float(b)) for n, a, b in rows}

# ---------------------------------------------------------------- HTTP with a file cache

class Cache:
    def __init__(self, d):
        self.d = d; os.makedirs(d, exist_ok=True)
    def path(self, name):
        return os.path.join(self.d, re.sub(r"[^A-Za-z0-9_.-]", "_", name)[:180] + ".json")
    def get(self, name):
        p = self.path(name)
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f: return json.load(f)
        return None
    def put(self, name, v):
        p = self.path(name); tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f: json.dump(v, f)
        os.replace(tmp, p)
        return v

class RateLimited(Exception):
    pass

BACKOFF_S = [15, 30, 60, 120, 240]   # a throttled host gets ~8 minutes in all before the run stops

def http_json(url, data=None, headers=None):
    h = {"User-Agent": UA}; h.update(headers or {})
    body = json.dumps(data).encode() if data is not None else None
    if body is not None: h["Content-Type"] = "application/json"
    host = urllib.parse.urlsplit(url).netloc
    for i in range(len(BACKOFF_S) + 1):
        try:
            req = urllib.request.Request(url, data=body, headers=h, method="POST" if body is not None else "GET")
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                if i == len(BACKOFF_S):
                    if e.code == 429: raise RateLimited(host)
                    raise
                wait = BACKOFF_S[i]
                ra = e.headers.get("Retry-After") if e.headers else None
                if ra and ra.strip().isdigit(): wait = max(wait, min(int(ra), 600))
                print(f"  … {host} answered HTTP {e.code}; waiting {wait} s (try {i + 2} of {len(BACKOFF_S) + 1})", file=sys.stderr)
                time.sleep(wait); continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if i < len(BACKOFF_S): time.sleep(BACKOFF_S[i]); continue
            raise

def sb_headers():
    return {"apikey": PUBLISHABLE_KEY, "Authorization": "Bearer " + PUBLISHABLE_KEY}

_last_wiki = [0.0]
def wiki(params):
    wait = WIKI_GAP_S - (time.time() - _last_wiki[0])
    if wait > 0: time.sleep(wait)
    _last_wiki[0] = time.time()
    q = dict(params); q.update({"format": "json", "formatversion": "2"})
    return http_json(WIKI_API + "?" + urllib.parse.urlencode(q))

# ---------------------------------------------------------------- reads

def read_stored(cache, tiles):
    got = cache.get("stored") or {}
    todo = [t for t in tiles if t not in got]
    for i in range(0, len(todo), 20):
        chunk = todo[i:i + 20]
        keys = ",".join("places:v34:" + t for t in chunk)
        rows = http_json(f"{SUPABASE_URL}/rest/v1/shared_kv?select=key,value&key=in.({keys})", headers=sb_headers())
        for t in chunk: got[t] = None                       # not stored (cold, or outside anything warmed)
        for r in rows:
            v = r["value"]; v = json.loads(v) if isinstance(v, str) else v
            got[r["key"].split(":")[-1]] = v.get("places") or []
        cache.put("stored", got)
    return got

def read_served(cache, stored_tiles):
    # POST only tiles already stored — a cold tile's POST starts a build that competes with a drip (FROM SAN ANTONIO (9)).
    got = cache.get("served") or {}
    todo = [t for t in stored_tiles if t not in got]
    for n, t in enumerate(todo):
        a, b = map(int, t.split("_"))
        j = http_json(f"{SUPABASE_URL}/functions/v1/nearby-places", data={"lat": a * TILE_DEG, "lng": b * TILE_DEG}, headers=sb_headers())
        if j.get("cached") is not True:
            print(f"  ! served read of {t} was not a cache hit (cached={j.get('cached')}) — recorded anyway", file=sys.stderr)
        got[t] = {"ids": [p.get("id") for p in (j.get("places") or [])], "storyHidden": j.get("storyHidden"),
                  "curatedIndexRows": j.get("curatedIndexRows"), "cached": j.get("cached")}
        cache.put("served", got)
        print(f"  served {n + 1}/{len(todo)} {t}: {len(got[t]['ids'])} pins", file=sys.stderr)
        time.sleep(SERVE_GAP_S)
    return got

GEM_SELECT = "id,name,description,category,lat,lng,name_clean,resolved_description,resolved_source"  # index.html's GEM_SELECT, minus submitted_by

def read_gems(cache, tiles):
    got = cache.get("gems")
    if got is not None: return got
    lats = [int(t.split("_")[0]) * TILE_DEG for t in tiles]; lngs = [int(t.split("_")[1]) * TILE_DEG for t in tiles]
    lo_lat, hi_lat = min(lats) - TILE_DEG, max(lats) + TILE_DEG
    lo_lng, hi_lng = min(lngs) - TILE_DEG, max(lngs) + TILE_DEG
    out, off = [], 0
    while True:
        # The app's own anon gem query; an anon filter on city or source returns 401 (DuPage (2)), so none is used.
        url = (f"{SUPABASE_URL}/rest/v1/submissions?select={GEM_SELECT}&status=eq.approved&merged_into=is.null"
               f"&lat=gte.{lo_lat}&lat=lte.{hi_lat}&lng=gte.{lo_lng}&lng=lte.{hi_lng}&order=id&limit=1000&offset={off}")
        rows = http_json(url, headers=sb_headers())
        out += rows
        if len(rows) < 1000: break
        off += 1000
    return cache.put("gems", out)

def geosearch(cache, cid, lat, lng):
    name = f"geo_{cid}_{lat:.6f}_{lng:.6f}"
    v = cache.get(name)
    if v is not None: return v
    j = wiki({"action": "query", "list": "geosearch", "gscoord": f"{lat}|{lng}", "gsradius": MATCH_M, "gslimit": 30})
    return cache.put(name, j.get("query", {}).get("geosearch", []))

def article_info(cache, titles):
    known = cache.get("articles") or {}
    todo = [t for t in dict.fromkeys(titles) if t and t not in known]
    for i in range(0, len(todo), 40):
        chunk = todo[i:i + 40]
        j = wiki({"action": "query", "prop": "coordinates|info", "titles": "|".join(chunk), "redirects": 1, "coprimary": "primary"})
        q = j.get("query", {})
        redir = {r["from"]: r["to"] for r in q.get("redirects", [])}
        norm = {r["from"]: r["to"] for r in q.get("normalized", [])}
        pages = {p.get("title"): p for p in q.get("pages", [])}
        for t in chunk:
            tt = norm.get(t, t); final = redir.get(tt, tt); p = pages.get(final) or {}
            c = (p.get("coordinates") or [None])[0]
            known[t] = {"title": final if not p.get("missing") else None, "pageid": p.get("pageid"),
                        "redirect": final != tt, "lat": c and c.get("lat"), "lng": c and c.get("lon")}
        cache.put("articles", known)
    return known

# ---------------------------------------------------------------- names

NUMWORDS = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8",
            "nine": "9", "ten": "10", "first": "1st", "second": "2nd", "third": "3rd"}
STOP = {"the", "of", "a", "an", "and", "at", "in", "on", "for", "to", "site", "old", "former", "historic", "historical",
        "marker", "texas", "florida", "us", "u", "s", "no", "st", "saint", "san", "sta", "de", "la", "el", "del", "los", "las"}
GENERIC = {"house", "home", "building", "church", "school", "hotel", "bank", "company", "co", "store", "park", "hall",
           "theatre", "theater", "museum", "bridge", "street", "avenue", "ave", "road", "rd", "boulevard", "blvd", "station",
           "depot", "office", "post", "library", "center", "centre", "club", "lodge", "temple", "chapel", "cathedral",
           "mission", "cemetery", "plaza", "square", "tower", "court", "courthouse", "hospital", "college", "university",
           "high", "elementary", "district", "complex", "estate", "mansion", "residence", "cottage", "barn", "mill",
           "works", "plant", "factory", "warehouse", "garage", "motor", "national", "first", "1st", "united", "methodist",
           "baptist", "catholic", "presbyterian", "episcopal", "lutheran", "congregation", "memorial", "monument", "fort",
           "county", "city", "state", "federal", "american", "public", "community", "apartments", "inn", "market", "arsenal",
           "fire", "headquarters", "commercial", "block", "row", "garden", "gardens", "campus", "field", "airport", "zoo",
           "brewery", "company's", "inc", "corporation", "association", "society", "historic", "trail", "creek", "river",
           "bay", "island", "lake", "point", "place", "union", "new", "south", "north", "east", "west", "central", "grand"}
CONTAINER = {"district", "campus", "park", "zoo", "university", "college", "complex", "plaza", "square", "cemetery",
             "base", "field", "airport", "fort", "estate", "village", "neighborhood", "neighbourhood", "garden", "gardens"}

def fold(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\([^)]*\)", " ", s)                 # disambiguators: "(San Antonio, Texas)"
    s = s.replace("&", " and ")
    s = re.sub(r"[’'`]s\b", "", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()

def tokens(s):
    out = []
    for w in fold(s).split():
        w = NUMWORDS.get(w, w)
        if w not in STOP: out.append(w)
    return out

def name_match(a, b):
    """→ (matched, check_subject). Conservative: a shared DISTINCTIVE token and most of the shorter name."""
    ta, tb = set(tokens(a)), set(tokens(b))
    if not ta or not tb: return False, False
    if fold(a) == fold(b): return True, False
    shared = ta & tb
    if not (shared - GENERIC): return False, False
    small = min(len(ta), len(tb))
    if len(shared) / small < 0.75: return False, False
    extra = (ta ^ tb)
    check = bool(extra & CONTAINER) or len(shared) / max(len(ta), len(tb)) < 0.6
    return True, check

def near_named(a, b):
    return bool((set(tokens(a)) & set(tokens(b))) - GENERIC)

# ---------------------------------------------------------------- candidates from Wikipedia lists

def parse_template_params(body):
    # split a template body on top-level pipes
    parts, depth, cur, i = [], 0, "", 0
    while i < len(body):
        two = body[i:i + 2]
        if two in ("{{", "[["): depth += 1; cur += two; i += 2; continue
        if two in ("}}", "]]"): depth -= 1; cur += two; i += 2; continue
        if body[i] == "|" and depth == 0: parts.append(cur); cur = ""; i += 1; continue
        cur += body[i]; i += 1
    parts.append(cur)
    named = {}
    pos = []
    for p in parts[1:]:
        if "=" in p and re.match(r"^\s*[\w ]+\s*=", p):
            k, v = p.split("=", 1); named[k.strip()] = v.strip()
        else:
            pos.append(p.strip())
    return named, pos

def find_templates(text, name):
    out, i = [], 0
    pat = re.compile(r"\{\{\s*" + name + r"\s*\|", re.I)
    while True:
        m = pat.search(text, i)
        if not m: break
        depth, j = 0, m.start()
        while j < len(text):
            if text.startswith("{{", j): depth += 1; j += 2; continue
            if text.startswith("}}", j):
                depth -= 1; j += 2
                if depth == 0: break
                continue
            j += 1
        out.append(text[m.start() + 2:j - 2]); i = j
    return out

def coord_to_deg(pos):
    # {{coord|27|56|51|N|82|27|24|W}} or {{coord|27.9|-82.4}}
    vals = [p for p in pos if p and "=" not in p]
    nums, hem = [], []
    for v in vals:
        if v.upper() in ("N", "S", "E", "W"): hem.append(v.upper()); nums.append(None)
        else:
            try: nums.append(float(v))
            except ValueError: break
    if not hem:
        n = [x for x in nums if x is not None]
        return (n[0], n[1]) if len(n) >= 2 else None
    try:
        i = nums.index(None); lat_parts = [x for x in nums[:i]]; rest = nums[i + 1:]
        j = rest.index(None); lng_parts = rest[:j]
    except ValueError:
        return None
    def dms(p): return sum(v / (60 ** k) for k, v in enumerate(p))
    lat = dms(lat_parts) * (-1 if hem[0] == "S" else 1)
    lng = dms(lng_parts) * (-1 if len(hem) > 1 and hem[1] == "W" else 1)
    return lat, lng

def strip_wiki(s):
    s = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", s or "", flags=re.S)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"'{2,}", "", s)
    return re.sub(r"\s+", " ", s).strip()

def first_link(s):
    m = re.search(r"\[\[([^|\]#]+)", s or "")
    return m.group(1).strip() if m else ""

def cmd_candidates(a):
    roster = read_roster(a.repo)
    if a.box not in roster: sys.exit(f"box {a.box!r} is not in prewarm-tiles.ts's roster: {sorted(roster)}")
    tiles = set(box_tiles(*roster[a.box]))
    rows, n = [], 0
    for title in a.list:
        j = wiki({"action": "parse", "page": title, "prop": "wikitext", "redirects": 1})
        if "error" in j: sys.exit(f"list {title!r}: {j['error'].get('info')}")
        text = j["parse"]["wikitext"]
        nrhp = find_templates(text, "NRHP row")
        src = "NRHP" if nrhp else "list"
        if nrhp:
            for body in nrhp:
                p, _ = parse_template_params("x|" + body.split("|", 1)[1] if "|" in body else body)
                article = (p.get("article") or "").strip()
                name = strip_wiki(p.get("name") or article) or article
                lat = p.get("lat"); lng = p.get("lon") or p.get("long")
                try: lat, lng = float(lat), float(lng)
                except (TypeError, ValueError): lat = lng = None
                rows.append({"name": name, "article": article, "lat": lat, "lng": lng,
                             "address": strip_wiki(p.get("address") or p.get("location") or ""), "src": f"{(p.get('type') or 'NRHP').strip()} {p.get('refnum', '').strip()}".strip(),
                             "list": title})
        else:
            # generic table rows: the row's first wikilink is its subject; its {{coord}} if it has one, else the
            # article's own coordinate (filled below). Only text inside wikitables counts (not an infobox).
            tables = re.findall(r"\{\|.*?\n\|\}", text, flags=re.S)
            for row in [r for tb in tables for r in re.split(r"\n\|-", tb)[1:]]:
                cs = find_templates(row, "coord")
                ll = None
                if cs:
                    _, pos = parse_template_params("x|" + cs[0].split("|", 1)[1])
                    ll = coord_to_deg(pos)
                elif not first_link(row):
                    continue
                cells = [c for c in re.split(r"\n\||\|\|", row) if c.strip()]
                link = first_link(row)
                name = strip_wiki(cells[0]) if cells else link
                if len(name) > 120 or not name: name = link
                rows.append({"name": name or link, "article": link, "lat": ll[0] if ll else None, "lng": ll[1] if ll else None,
                             "address": "", "src": src, "list": title})
    # rows with no coordinate of their own take their article's (noted on the row)
    need = [r["article"] for r in rows if r["lat"] is None and r["article"]]
    if need:
        info = article_info(Cache(a.cache or ".story-sort-cache-candidates"), need)
        for r in rows:
            i = info.get(r["article"]) if r["lat"] is None and r["article"] else None
            if i and i.get("lat") is not None:
                r["lat"], r["lng"] = i["lat"], i["lng"]; r["list"] += "; coordinate from the article"
    # one row per subject: a listing repeated across lists (an MPS list and the city list) merges into the first
    merged, by_key = [], {}
    for r in rows:
        k = (r["article"] or "").strip().lower() or fold(r["name"])
        if k in by_key:
            f = by_key[k]
            if r["src"] not in f["src"]: f["src"] += "; " + r["src"]
            if r["list"].split(";")[0] not in f["list"]: f["list"] += " + " + r["list"].split(";")[0]
            if f["lat"] is None and r["lat"] is not None: f["lat"], f["lng"] = r["lat"], r["lng"]
            continue
        by_key[k] = r; merged.append(r)
    rows = merged
    out = []
    for r in rows:
        inside = r["lat"] is not None and tile_key(r["lat"], r["lng"]) in tiles
        if r["lat"] is not None and not inside: continue
        n += 1
        kind = "no coordinate" if r["lat"] is None else ("district" if (re.search(r"historic district|\bdistrict\b", r["name"], re.I) or r["src"].split(" ")[0] in ("HD", "NHLD")) else "site")
        out.append([f"{a.prefix}{n:03d}", kind, r["name"], "", tile_key(r["lat"], r["lng"]) if r["lat"] is not None else "",
                    f"{r['lat']:.6f}" if r["lat"] is not None else "", f"{r['lng']:.6f}" if r["lng"] is not None else "",
                    r["address"], r["src"], r["article"], "", f"from: {r['list']}"])
    hdr = ["id", "kind", "name (as listed)", "also listed as", "tile", "lat", "lng", "address", "sources", "story article", "story owed to", "notes"]
    write_tsv(a.out, hdr, out)
    print(f"[{BUILD}] {a.box}: {len(out)} candidates in the box ({sum(1 for r in out if r[1]=='district')} districts, "
          f"{sum(1 for r in out if r[1]=='no coordinate')} with no coordinate) → {a.out}")

# ---------------------------------------------------------------- sort

def write_tsv(path, hdr, rows):
    with open(path, "w", encoding="utf-8") as f:
        f.write("\t".join(hdr) + "\n")
        for r in rows: f.write("\t".join(str(x if x is not None else "").replace("\t", " ").replace("\n", " ") for x in r) + "\n")

def read_tsv(path):
    lines = open(path, encoding="utf-8").read().splitlines()
    hdr = lines[0].split("\t")
    return [dict(zip(hdr, (l.split("\t") + [""] * len(hdr))[:len(hdr)])) for l in lines[1:] if l.strip()]

def load_box(a, cache):
    roster = read_roster(a.repo)
    if a.box not in roster: sys.exit(f"box {a.box!r} is not in prewarm-tiles.ts's roster: {sorted(roster)}")
    tiles = box_tiles(*roster[a.box]); ring = ring_of(tiles)
    print(f"[{BUILD}] {a.box} @ {roster[a.box]} → {len(tiles)} tiles, {len(ring)} with the ring", file=sys.stderr)
    stored = read_stored(cache, ring)
    cold_box = [t for t in tiles if stored.get(t) is None]
    if cold_box: print(f"  ! {len(cold_box)} box tile(s) not stored (cold): {' '.join(cold_box)} — split their lines (Orange County (g))", file=sys.stderr)
    stored_tiles = [t for t in ring if stored.get(t) is not None]
    served = read_served(cache, stored_tiles)
    served_ids = {i for t in stored_tiles for i in (served.get(t) or {}).get("ids", [])}
    pins, where = {}, {}
    for t in stored_tiles:
        for p in stored[t]:
            pid = p.get("id")
            if pid not in pins: pins[pid] = p
            where.setdefault(pid, []).append(t)
    gems = read_gems(cache, ring)
    idx = curated_rows_seen(served)
    return dict(tiles=tiles, ring=ring, stored=stored, served=served, served_ids=served_ids, pins=pins, where=where,
                gems=gems, cold_box=cold_box, curated_index=idx)

def curated_rows_seen(served):
    vals = {v.get("curatedIndexRows") for v in served.values() if v}
    return sorted(x for x in vals if x is not None)

def containing_ok(pid, p, where):
    ct = tile_key(p["lat"], p["lng"])
    return ct, ct in where.get(pid, [])

def box_generic(box):
    GENERIC.update(tokens(box))

def cmd_sort(a):
    box_generic(a.box)
    cache = Cache(a.cache or f".story-sort-cache-{re.sub(r'[^a-z0-9]+', '-', a.box.lower())}")
    B = load_box(a, cache)
    cands = read_tsv(a.candidates)
    tiles = set(B["tiles"])
    # article info for every story article, in batches
    arts = article_info(cache, [c.get("story article", "").strip() for c in cands])
    stored_wiki_ids = {pid for pid in B["pins"] if str(pid).startswith("wiki_")}
    out = []
    placed = []  # (id, lat, lng) of every candidate that becomes a line, for the TWIN / other-line checks
    for n, c in enumerate(cands):
        cid, kind, name = c["id"], c.get("kind", "site"), c.get("name (as listed)", "")
        also = [x.strip() for x in (c.get("also listed as") or "").split("/") if x.strip()]
        names = [name] + also
        art_t = (c.get("story article") or "").strip()
        art = arts.get(art_t) if art_t else None
        if art and art.get("title"): names.append(art["title"])
        try: lat, lng = float(c["lat"]), float(c["lng"])
        except (KeyError, ValueError):
            out.append([cid, "NO LINE — no coordinate", "", name, "", "", "", art_t, c.get("story owed to", ""), "place by hand or cut", name, ""]); continue
        why = []
        if tile_key(lat, lng) not in tiles: why.append(f"OUTSIDE THE BOX (tile {tile_key(lat, lng)})")
        if art and art.get("lat") is not None:
            d = metres(lat, lng, art["lat"], art["lng"])
            if d > FAR_M: why.append(f"LIST POINT FAR: {d:.0f} m from its article's point ({art['title']}) — wrong article or a large site?")
        # 1. pins (served or hidden) within MATCH_M, same subject
        best = None
        for pid, p in B["pins"].items():
            d = metres(lat, lng, p["lat"], p["lng"])
            if d > MATCH_M: continue
            res = [name_match(nm, p.get("name", "")) for nm in names]
            if any(ok for ok, _ in res):
                chk = not any(ok and not c for ok, c in res)
                if best is None or d < best[0]: best = (d, pid, p, chk)
        gem = None
        for g in B["gems"]:
            if g.get("lat") is None: continue
            d = metres(lat, lng, g["lat"], g["lng"])
            if d > MATCH_M: continue
            res = [name_match(nm, g.get("name", "")) for nm in names]
            if any(ok for ok, _ in res):
                chk = not any(ok and not c for ok, c in res)
                if gem is None or d < gem[0]: gem = (d, g, chk)
        geo = geosearch(cache, cid, lat, lng)
        if best:
            d, pid, p, chk = best
            pin_s = f"{p.get('name')} · {pid} · {d:.0f} m"
            if chk: why.append("CHECK SUBJECT (partial or container match)")
            if pid in B["served_ids"]:
                out.append([cid, "CUT — served", "", "", "", "", pin_s, art_t, "", "; ".join(why), name, ""])
                continue
            ct, ok = containing_ok(pid, p, B["where"])
            stores = ", ".join(B["where"][pid])
            if ok:
                why.append(f"hidden pin stored in {stores}; containing tile {ct} stores it (#542)")
                out.append([cid, "CURATED ROW — hidden pin", "", p.get("name"), p["lat"], p["lng"], pin_s, art_t, c.get("story owed to", ""), "; ".join(why), name, ""])
            else:
                why.append(f"hidden pin stored in {stores}; containing tile {ct} does NOT store it (#542) — a curated row cannot un-hide it")
                out.append([cid, f"SEED under a different name — containing tile {ct} does not store the pin (#542)", "",
                            name if fold(name) != fold(p.get("name", "")) else f"{name} (rename)", p["lat"], p["lng"], pin_s, art_t,
                            c.get("story owed to", ""), "; ".join(why), name, "new"])
            placed.append((cid, p["lat"], p["lng"]))
            continue
        if gem:
            d, g, chk = gem
            if chk: why.append("CHECK SUBJECT (partial or container match)")
            out.append([cid, "CUT — gem", "", "", "", "", f"{g.get('name')} · gem {g.get('id')} · {d:.0f} m", art_t, "", "; ".join(why), name, ""])
            continue
        # 2. #539 — an article of the same subject with a coordinate, in no stored row
        hit = None
        for gs in geo:
            if f"wiki_{gs.get('pageid')}" in stored_wiki_ids: continue
            same = (art and art.get("title") and gs.get("title") == art["title"])
            if not same:
                for nm in names:
                    ok, chk = name_match(nm, gs.get("title", ""))
                    if ok: same = True; break
            if same and (hit is None or gs["dist"] < hit["dist"]): hit = gs
        if hit and kind != "district":
            for pid, p in B["pins"].items():
                d = metres(hit["lat"], hit["lon"], p["lat"], p["lng"])
                if d <= MATCH_M and near_named(hit["title"], p.get("name", "")):
                    why.append(f"CHECK SUBJECT: {'served' if pid in B['served_ids'] else 'hidden'} pin {p.get('name')} ({pid}) {d:.0f} m from the article may already be this place")
                    break
            out.append([cid, "SEED — article in no tile (#539)", "", hit["title"], hit["lat"], hit["lon"], f"article {hit['title']} · {hit['dist']:.0f} m",
                        hit["title"], c.get("story owed to", ""), "; ".join(why), name, ""])
            placed.append((cid, hit["lat"], hit["lon"]))
            continue
        if kind == "district":
            out.append([cid, "NO LINE — district centroid", "", "", "", "", "", art_t, "", "; ".join(why + ["no stored pin for the district; a centroid pin would be arbitrary"]), name, ""])
            continue
        # 3. unmapped seed — and why it is `new`
        reasons = []
        for pid, p in B["pins"].items():
            d = metres(lat, lng, p["lat"], p["lng"])
            if d <= NEW_M: reasons.append(f"{'served' if pid in B['served_ids'] else 'hidden'} pin {p.get('name')} {d:.0f} m")
        for g in B["gems"]:
            if g.get("lat") is not None:
                d = metres(lat, lng, g["lat"], g["lng"])
                if d <= NEW_M: reasons.append(f"gem {g.get('name')} {d:.0f} m")
        for gs in geo:
            if any(near_named(nm, gs.get("title", "")) for nm in names):
                reasons.append(f"near-named article {gs['title']} {gs['dist']:.0f} m")
        for pid, p in B["pins"].items():
            d = metres(lat, lng, p["lat"], p["lng"])
            if NEW_M < d <= FAR_M and any(name_match(nm, p.get("name", ""))[0] for nm in names):
                why.append(f"CHECK: same-named {'served' if pid in B['served_ids'] else 'hidden'} pin {p.get('name')} ({pid}) {d:.0f} m away — the same place, mapped off the list point?")
                reasons.append(f"same-named pin {d:.0f} m")
        if reasons: why.append("new: " + "; ".join(reasons[:4]) + (f" (+{len(reasons) - 4})" if len(reasons) > 4 else ""))
        out.append([cid, "SEED — unmapped", "", name, f"{lat}", f"{lng}", "", art_t, c.get("story owed to", ""), "; ".join(why), name, "new" if reasons else ""])
        placed.append((cid, lat, lng))
        if (n + 1) % 25 == 0: print(f"  sorted {n + 1}/{len(cands)}", file=sys.stderr)
    # other-line and twin checks over every line placed
    pos = {p[0]: p for p in placed}
    for r in out:
        if r[0] not in pos or not r[1].startswith(("SEED", "CURATED")): continue
        _, la, ln = pos[r[0]]
        for oid, ola, oln in placed:
            if oid == r[0]: continue
            d = metres(float(la), float(ln), float(ola), float(oln))
            if d <= TWIN_M:
                r[9] = (r[9] + "; " if r[9] else "") + f"TWIN CANDIDATE {oid} {d:.0f} m — one building listed twice, or two plaques on one lot?"
            elif d <= NEW_M and r[1] == "SEED — unmapped":
                r[9] = (r[9] + "; " if r[9] else "") + f"new: line {oid} {d:.0f} m"; r[11] = "new"
    order = {"CURATED": 0, "SEED": 1, "CUT": 2, "NO LINE": 3}
    out.sort(key=lambda r: (min(v for k, v in order.items() if r[1].startswith(k)), r[0]))
    hdr = ["id", "action", "status", "line name", "line lat", "line lng", "stored pin (name · id · m)", "story source",
           "story owed to", "why", "candidate name", "new"]
    write_tsv(a.out, hdr, out)
    from collections import Counter
    tally = Counter(r[1].split(" — containing")[0] for r in out)
    print(f"[{BUILD}] {a.box}: {len(out)} candidates → {a.out}")
    for k, v in tally.most_common(): print(f"  {v:4d}  {k}")
    print(f"  `new` flagged: {sum(1 for r in out if r[11] == 'new')} · CHECK SUBJECT: {sum(1 for r in out if 'CHECK SUBJECT' in r[9])}"
          f" · served tiles read: {len(B['served'])} · curatedIndexRows seen: {B['curated_index']}")
    if B["cold_box"]: print(f"  ! {len(B['cold_box'])} cold box tile(s) — lines in them are unchecked against OSM; split them out")

# ---------------------------------------------------------------- leads (hidden landmark-class pins)

def cmd_leads(a):
    box_generic(a.box)
    cache = Cache(a.cache or f".story-sort-cache-{re.sub(r'[^a-z0-9]+', '-', a.box.lower())}")
    B = load_box(a, cache)
    tiles = set(B["tiles"])
    rows = []
    for pid, p in B["pins"].items():
        if pid in B["served_ids"]: continue
        if tile_key(p["lat"], p["lng"]) not in tiles: continue
        cat = (p.get("category") or "").lower()
        if cat not in LANDMARK_CATS: continue
        ct, ok = containing_ok(pid, p, B["where"])
        gem_near = [g for g in B["gems"] if g.get("lat") is not None and metres(p["lat"], p["lng"], g["lat"], g["lng"]) <= MATCH_M
                    and name_match(p.get("name", ""), g.get("name", ""))[0]]
        note = f"gem {gem_near[0].get('name')} near — likely already told" if gem_near else ""
        rows.append([pid, p.get("name"), cat, (p.get("desc") or "")[:120], p["lat"], p["lng"], ct, "yes" if ok else "no",
                     "curated row (exact stored name)" if ok else "seed under a different name, `new` (#542)", note, ""])
    rows.sort(key=lambda r: (r[2], r[1] or ""))
    hdr = ["pin id", "stored name", "category", "stored desc", "lat", "lng", "containing tile", "containing tile stores it (#542)",
           "route if it gets a story", "note", "verdict"]
    write_tsv(a.out, hdr, rows)
    print(f"[{BUILD}] {a.box}: {len(rows)} hidden landmark-class pins → {a.out} (verdict column empty, for the chat)")

# ----------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=f"{BUILD} — #543 story-pass sort (read-only)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for nm in ("candidates", "sort", "leads"):
        s = sub.add_parser(nm)
        s.add_argument("--box", required=True, help="roster row name, exactly as in prewarm-tiles.ts")
        s.add_argument("--out", required=True)
        s.add_argument("--repo", default=".", help="repo root (prewarm-tiles.ts is read for the roster)")
        s.add_argument("--cache", help="cache dir (default .story-sort-cache-<box>)")
        if nm == "candidates":
            s.add_argument("--list", action="append", required=True, help="Wikipedia list page title (repeatable)")
            s.add_argument("--prefix", required=True, help="candidate id prefix, e.g. TP")
        if nm == "sort":
            s.add_argument("--candidates", required=True)
    a = ap.parse_args()
    try:
        {"candidates": cmd_candidates, "sort": cmd_sort, "leads": cmd_leads}[a.cmd](a)
    except RateLimited as e:
        sys.exit(f"\n[{BUILD}] STOPPED: {e} is still rate-limiting after ~8 minutes of waiting. Nothing is lost — every read so far "
                 f"is in the cache folder. Wait 15–30 minutes (and let any other tool that calls Wikipedia — seed-resolve, "
                 f"graves-resolve, gate-tiles — finish first), then run the same command again; it resumes where it stopped.")

if __name__ == "__main__":
    main()
