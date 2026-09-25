// places-coverage.ts — READ-ONLY diagnostic. Measures how many of the 89 story-gate-hidden
// seed pins (resolved_source='none') Google Places (New) can describe, to scope the #318
// external-source rung before any code ships. Writes NOTHING — no Supabase, no --commit.
//
// RUN (Codespace or Mac, deno installed):
//   export GOOGLE_PLACES_KEY='<your key>'          # the key you just made; NOT hard-coded here
//   deno run --allow-net --allow-env places-coverage.ts
//
// It calls Places Text Search (New) once per pin, biased to the pin's coordinate, asking for
// the editorialSummary field, and buckets each pin. Paste the SUMMARY block back — that's all
// I need to size the build. (Full per-pin lines print too, for eyeballing namesakes.)
//
// Cost: 89 Text Search calls, once. Enterprise-tier SKU (editorialSummary bumps it there):
// 1,000 free/month, so this run is $0 and nowhere near your 200/day cap.

const KEY = Deno.env.get("GOOGLE_PLACES_KEY") ?? "";
if (!KEY) { console.error("FATAL: export GOOGLE_PLACES_KEY=... first."); Deno.exit(1); }

const ON_PIN_M = 500;   // within this of the pin = "on the pin" (the #316 gate is looser for big
                        // features, but 500 m is a fair first cut; distances print so we can retune)
const BIAS_M   = 3000;  // locationBias search radius around the pin
const PACE_MS  = 150;

type Pin = { name: string; lat: number; lng: number; cat: string };
const PINS: Pin[] = [
  { name: "Camp Long", lat: 47.5579668, lng: -122.373605, cat: "park" },
  { name: "The Lawn on D", lat: 42.3485027, lng: -71.0359348, cat: "park" },
  { name: "Burnham Wildlife Corridor", lat: 41.8462821, lng: -87.6097033, cat: "park" },
  { name: "Quest Eternal", lat: 42.3633748, lng: -71.1311738, cat: "history" },
  { name: "Spectra Art Space", lat: 39.6783839, lng: -104.986759, cat: "art" },
  { name: "Rue de la Course", lat: 29.9473785, lng: -90.1299666, cat: "history" },
  { name: "Hollywood Beach Broadwalk", lat: 26.0069244, lng: -80.1160068, cat: "park" },
  { name: "The Clay Studio", lat: 39.9790053, lng: -75.1387045, cat: "art" },
  { name: "Kelly Drive Loop", lat: 39.9662792, lng: -75.1798209, cat: "park" },
  { name: "Smither Park", lat: 29.7290978, lng: -95.3357653, cat: "park" },
  { name: "Sloan's Lake Park", lat: 39.7911272, lng: -105.054739, cat: "park" },
  { name: "Montlake Spite House", lat: 47.6385384, lng: -122.3014874, cat: "history" },
  { name: "Jessica Hollis Park", lat: 30.3866229, lng: -97.9096357, cat: "park" },
  { name: "Austin Nature & Science Center", lat: 30.2718148, lng: -97.7746229, cat: "park" },
  { name: "Museum of Human Achievement", lat: 30.2614666, lng: -97.6994336, cat: "history" },
  { name: "Kettle Art Gallery", lat: 32.7835224, lng: -96.784344, cat: "art" },
  { name: "Mt. Falcon Park", lat: 39.6438871, lng: -105.2022596, cat: "park" },
  { name: "Cattle Track Arts Compound", lat: 33.528899, lng: -111.9173531, cat: "art" },
  { name: "Rail Park", lat: 39.9590969, lng: -75.1385726, cat: "park" },
  { name: "Zymoglyphic Museum", lat: 45.5178451, lng: -122.5997267, cat: "history" },
  { name: "Ghost Ranch", lat: 33.3356501, lng: -111.9276001, cat: "history" },
  { name: "ColdTowne Theater", lat: 30.258914, lng: -97.72578, cat: "art" },
  { name: "Old Town Scottsdale", lat: 33.4931429, lng: -111.9207726, cat: "history" },
  { name: "Pacific Bonsai Museum", lat: 47.3007469, lng: -122.314133, cat: "history" },
  { name: "Museum of Illusions Denver", lat: 39.75363, lng: -105.0007481, cat: "history" },
  { name: "Castle Island", lat: 42.3378061, lng: -71.0565542, cat: "park" },
  { name: "Trinity Park", lat: 32.749468, lng: -97.3693756, cat: "park" },
  { name: "Big Stacy Pool", lat: 30.2400679, lng: -97.7470328, cat: "park" },
  { name: "Bill Jarvis Migratory Bird Sanctuary", lat: 41.9488661, lng: -87.6406791, cat: "park" },
  { name: "Everett House Community Healing Center", lat: 45.5252176, lng: -122.6352914, cat: "history" },
  { name: "Steelworkers Park", lat: 41.7369393, lng: -87.5300781, cat: "park" },
  { name: "Pace Bend Park", lat: 30.4550939, lng: -98.0220502, cat: "park" },
  { name: "Shelby Bottoms Greenway", lat: 36.1657875, lng: -86.7253217, cat: "park" },
  { name: "Paco Sánchez Park", lat: 39.7363859, lng: -105.0285299, cat: "park" },
  { name: "Willie Dixon's Blues Heaven Foundation", lat: 41.8536162, lng: -87.6240618, cat: "history" },
  { name: "Littleton Museum", lat: 39.6065737, lng: -105.0014641, cat: "history" },
  { name: "Roosevelt Row Arts District", lat: 33.458447, lng: -112.0696393, cat: "art" },
  { name: "Windsor", lat: 33.5135662, lng: -112.0734029, cat: "history" },
  { name: "The Box SF", lat: 37.7820689, lng: -122.4048016, cat: "history" },
  { name: "Race Street Pier", lat: 39.953636, lng: -75.1395008, cat: "park" },
  { name: "Patch of Heaven Sanctuary", lat: 25.5628059, lng: -80.4478279, cat: "park" },
  { name: "Historic Fourth Ward Skatepark", lat: 33.7639494, lng: -84.364252, cat: "park" },
  { name: "Curious Comedy Theater", lat: 45.5609791, lng: -122.6618212, cat: "art" },
  { name: "Japan Information & Culture Center", lat: 38.9088537, lng: -77.0416119, cat: "history" },
  { name: "Presidio Officers' Club", lat: 37.797459, lng: -122.4590735, cat: "history" },
  { name: "Houston Center for Photography", lat: 29.7383783, lng: -95.3972603, cat: "art" },
  { name: "Matthew Turner Tall Ship", lat: 37.8640076, lng: -122.4964808, cat: "history" },
  { name: "The Colonnade", lat: 33.8116132, lng: -84.3574624, cat: "history" },
  { name: "Insect Asylum", lat: 41.9334505, lng: -87.7148384, cat: "art" },
  { name: "North Park Village Nature Center", lat: 41.9880391, lng: -87.7203973, cat: "park" },
  { name: "Moonwalk Riverfront", lat: 29.9613787, lng: -90.0577963, cat: "park" },
  { name: "View Boston", lat: 42.36027778, lng: -71.05777778, cat: "history" },
  { name: "Texas Toy Museum", lat: 30.2692722, lng: -97.7428236, cat: "history" },
  { name: "Johnny Roberts Disc Golf Course", lat: 39.8021203, lng: -105.103122, cat: "park" },
  { name: "Big Marsh Park", lat: 41.689683, lng: -87.5704346, cat: "park" },
  { name: "Valley of the Gnomes", lat: 47.6154234, lng: -122.2828452, cat: "park" },
  { name: "The Hammocks Community Park", lat: 25.6742059, lng: -80.4393822, cat: "park" },
  { name: "Camelback Mountain (Echo Canyon Trail)", lat: 33.5232698, lng: -111.9745943, cat: "park" },
  { name: "ReCreative Denver", lat: 39.728487, lng: -104.9987708, cat: "art" },
  { name: "Sicardi Ayers Bacino", lat: 29.7383783, lng: -95.3972603, cat: "art" },
  { name: "Sculpture Falls", lat: 30.2563856, lng: -97.8225558, cat: "park" },
  { name: "Upstairs Circus", lat: 39.7507813, lng: -105.001632, cat: "art" },
  { name: "Singing Oak", lat: 30.0194997, lng: -90.1184485, cat: "park" },
  { name: "UW Life Sciences Greenhouse", lat: 47.6554303, lng: -122.3001692, cat: "park" },
  { name: "North Beach Oceanside Park", lat: 25.8686343, lng: -80.1216048, cat: "park" },
  { name: "Seattle Pinball Museum", lat: 47.5980084, lng: -122.3248559, cat: "history" },
  { name: "Westside Park", lat: 33.8126837, lng: -84.4288419, cat: "park" },
  { name: "West Chelsea Contemporary", lat: 30.271618, lng: -97.755147, cat: "art" },
  { name: "Acorn Street", lat: 42.3576199, lng: -71.0688367, cat: "history" },
  { name: "Dutch Alley Artist's Co-op", lat: 29.9583217, lng: -90.0609154, cat: "art" },
  { name: "Couturie Forest", lat: 30.0038576, lng: -90.0969693, cat: "park" },
  { name: "Shit Fountain", lat: 41.9104584, lng: -87.6751455, cat: "art" },
  { name: "Architectural Heritage Center", lat: 45.5177909, lng: -122.6610662, cat: "history" },
  { name: "Laser Dome", lat: 47.5350094, lng: -122.3763599, cat: "history" },
  { name: "Sunset Cliffs Trail", lat: 32.72972778, lng: -117.25255833, cat: "park" },
  { name: "Sanders Theatre", lat: 42.3707762, lng: -71.1168698, cat: "history" },
  { name: "Cochran Shoals Trail", lat: 33.9006974, lng: -84.4669354, cat: "park" },
  { name: "Nelson's Green Brier Distillery", lat: 36.1635935, lng: -86.7985097, cat: "history" },
  { name: "Cherry Street Pier", lat: 39.9525055, lng: -75.1390561, cat: "art" },
  { name: "Topaz Farm", lat: 45.6478211, lng: -122.8236435, cat: "park" },
  { name: "Ocean Beach Pier", lat: 32.7400082199622, lng: -117.244473997181, cat: "history" },
  { name: "Waterton Canyon", lat: 39.5565348, lng: -105.1646145, cat: "park" },
  { name: "Hobie Beach", lat: 25.6968351, lng: -80.1635261, cat: "park" },
  { name: "Katy Trail", lat: 32.7984202, lng: -96.8078755, cat: "park" },
  { name: "Museum of the Weird", lat: 30.267141, lng: -97.7387026, cat: "history" },
  { name: "Cheasty Greenspace", lat: 47.5605963, lng: -122.2979313, cat: "park" },
  { name: "Grand Avenue Arts District", lat: 33.4624896, lng: -112.0963773, cat: "art" },
  { name: "Boston Harbor Islands", lat: 42.3020436, lng: -70.9078243, cat: "park" },
  { name: "ICA Watershed", lat: 42.3639428, lng: -71.0342966, cat: "art" },
];

function haversine(aLat:number,aLng:number,bLat:number,bLng:number){
  const R=6371000, r=Math.PI/180;
  const dLat=(bLat-aLat)*r, dLng=(bLng-aLng)*r;
  const s=Math.sin(dLat/2)**2 + Math.cos(aLat*r)*Math.cos(bLat*r)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}

async function probe(p:Pin){
  const body = {
    textQuery: p.name,
    locationBias: { circle: { center: { latitude: p.lat, longitude: p.lng }, radius: BIAS_M } },
    maxResultCount: 3,
  };
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.editorialSummary,places.primaryType",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    return { err: `HTTP ${res.status} ${t.slice(0,120)}` };
  }
  const j = await res.json();
  const top = (j.places && j.places[0]) || null;
  if (!top) return { found:false as const };
  const dist = top.location ? Math.round(haversine(p.lat,p.lng,top.location.latitude,top.location.longitude)) : -1;
  const summary = top.editorialSummary?.text || "";
  return {
    found: true as const,
    title: top.displayName?.text || "(no name)",
    dist,
    onPin: dist>=0 && dist<=ON_PIN_M,
    hasSummary: !!summary,
    summary: summary.slice(0,90),
  };
}

let found=0, onPin=0, withSummary=0, onPinNoSummary=0, offPin=0, notFound=0, errs=0;
const catAgg: Record<string,{sum:number,tot:number}> = { park:{sum:0,tot:0}, history:{sum:0,tot:0}, art:{sum:0,tot:0} };

console.log(`Probing ${PINS.length} pins through Places Text Search (New)...\n`);
for (const p of PINS) {
  catAgg[p.cat] && (catAgg[p.cat].tot++);
  let r:any;
  try { r = await probe(p); } catch(e){ r = { err: String(e).slice(0,120) }; }
  if (r.err){ errs++; console.log(`ERR   ${p.name} :: ${r.err}`); }
  else if (!r.found){ notFound++; console.log(`MISS  ${p.name}  (no Places result)`); }
  else {
    found++;
    const tag = r.onPin ? (r.hasSummary ? "SUMMARY " : "NO-SUMM ") : "OFF-PIN ";
    if (r.onPin){ onPin++; if(r.hasSummary){ withSummary++; catAgg[p.cat] && catAgg[p.cat].sum++; } else onPinNoSummary++; }
    else offPin++;
    console.log(`${tag} ${p.name} -> "${r.title}" ${r.dist}m${r.hasSummary?` | ${r.summary}`:""}`);
  }
  await new Promise(r=>setTimeout(r,PACE_MS));
}

console.log("\n================ SUMMARY (paste this back) ================");
console.log(`total pins:            ${PINS.length}`);
console.log(`found in Places:       ${found}`);
console.log(`  on-pin (<=${ON_PIN_M}m):    ${onPin}`);
console.log(`    WITH summary:      ${withSummary}   <-- rung serves these directly`);
console.log(`    no summary:        ${onPinNoSummary}   <-- need thin-line/curated fallback`);
console.log(`  off-pin (>${ON_PIN_M}m):     ${offPin}   <-- would be gate-rejected (curated territory)`);
console.log(`not found:             ${notFound}`);
console.log(`errors:                ${errs}`);
console.log("by category (with-summary / total):");
for (const c of Object.keys(catAgg)) console.log(`  ${c}: ${catAgg[c].sum}/${catAgg[c].tot}`);
console.log("===========================================================");
