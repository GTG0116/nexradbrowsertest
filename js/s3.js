// s3.js — discover and download NEXRAD Level II volumes for the live viewer.
//
// Two public sources are used, in priority order:
//
//   1. PRIMARY — the Iowa Environmental Mesonet (IEM) raw Level II feed at
//      mesonet-nexrad.agron.iastate.edu/level2/raw/<SITE>/ . IEM relays the NWS
//      realtime feed and exposes each volume as it is ingested, so it carries
//      newer scans (and a denser recent loop) than the AWS mirror — exactly what
//      a live viewer wants. Each site directory holds a `dir.list` index
//      (`<bytes> <filename>` per line) plus the volumes, named
//      <SITE>_YYYYMMDD_HHMMSS.bz2 . Despite the extension these are ordinary
//      AR2V "Archive II" files (internally bzip2-compressed LDM records), so the
//      decoder reads them unchanged.
//
//   2. FALLBACK — Unidata's realtime full-volume feed `unidata-nexrad-level2`,
//      mirrored openly on AWS as part of the NOAA Open Data Dissemination
//      program. Objects are keyed  YYYY/MM/DD/SITE/SITEYYYYMMDD_HHMMSS_V06  and
//      the bucket returns `Access-Control-Allow-Origin: *` for listing and GET.
//
// IEM is tried first. We fall back to the AWS bucket whenever IEM is unreachable
// (it does not advertise CORS, so a cross-origin browser fetch can be blocked —
// set a proxy below if so), errors out, or simply has no data for the requested
// UTC day. That last case covers history browsing: IEM keeps only a rolling
// window, while AWS retains the full recent archive.
//
// (NOAA's deep archive bucket `noaa-nexrad-level2` holds data back to 1991 but
// disables anonymous bucket listing, so it can't be browsed from the client.)

const IEM_BASE = 'https://mesonet-nexrad.agron.iastate.edu/level2/raw';
const BUCKET = 'https://unidata-nexrad-level2.s3.amazonaws.com';

// Keys for IEM volumes carry this prefix so fetchVolume can route them back to
// the right source; AWS keys are bare S3 object keys.
const IEM_PREFIX = 'iem:';

// Optional CORS proxy. Left empty: we talk to each source directly. If a user's
// network blocks a source, they can set a proxy prefix here.
let proxy = '';
export function setProxy(p) {
  proxy = p || '';
}
function viaProxy(fullUrl) {
  return proxy ? proxy + encodeURIComponent(fullUrl) : fullUrl;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// List the volume scan keys for a given site and UTC day, newest last. Prefers
// the IEM feed and falls back to the AWS bucket when IEM has nothing usable.
export async function listVolumes(site, date) {
  try {
    const vols = await listVolumesIem(site, date);
    if (vols.length) return vols;
  } catch (e) {
    console.warn('IEM list failed, falling back to AWS:', e.message);
  }
  return listVolumesAws(site, date);
}

// --- IEM (primary) -------------------------------------------------------

async function listVolumesIem(site, date) {
  const SITE = site.toUpperCase();
  const res = await fetch(viaProxy(`${IEM_BASE}/${SITE}/dir.list`));
  if (!res.ok) throw new Error(`IEM list failed: ${res.status}`);
  const text = await res.text();

  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const day = `${y}${m}${d}`;

  const vols = [];
  for (const line of text.split('\n')) {
    // dir.list rows are "<bytes> <filename>"; take the trailing filename.
    const name = line.trim().split(/\s+/).pop();
    if (!name) continue;
    const t = timeForName(name);
    if (!t) continue;
    // Keep only scans from the requested UTC day, matching the date picker.
    if (name.indexOf(`_${day}_`) === -1) continue;
    vols.push({
      key: `${IEM_PREFIX}${SITE}/${name}`,
      label: labelForTime(t),
      time: t,
    });
  }
  vols.sort((a, b) => a.time - b.time);
  return vols;
}

// --- AWS S3 (fallback) ---------------------------------------------------

async function listVolumesAws(site, date) {
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const prefix = `${y}/${m}/${d}/${site.toUpperCase()}/`;
  const listUrl = viaProxy(
    `${BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`
  );

  const res = await fetch(listUrl);
  if (!res.ok) throw new Error(`S3 list failed: ${res.status}`);
  const xml = await res.text();

  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const key = match[1];
    // Ignore MDM (metadata) sidecars and partial chunk objects (".001" etc.).
    if (key.endsWith('_MDM')) continue;
    if (/\.\d+$/.test(key)) continue;
    keys.push(key);
  }
  keys.sort();
  return keys.map((key) => ({
    key,
    label: labelForKey(key),
    time: timeForKey(key),
  }));
}

// --- shared helpers ------------------------------------------------------

function labelForTime(t) {
  return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}Z`;
}

function labelForKey(key) {
  const t = timeForKey(key);
  if (!t) return key.split('/').pop();
  return labelForTime(t);
}

function timeForKey(key) {
  return timeForName(key.split('/').pop());
}

// Parse the UTC scan time from a volume filename. Handles both the AWS form
// (KTLX20240619_120300_V06) and the IEM form (KTLX_20240619_120300.bz2).
function timeForName(name) {
  const m = name && name.match(/(\d{8})_(\d{6})/);
  if (!m) return null;
  const d = m[1];
  const t = m[2];
  return new Date(
    Date.UTC(
      +d.slice(0, 4),
      +d.slice(4, 6) - 1,
      +d.slice(6, 8),
      +t.slice(0, 2),
      +t.slice(2, 4),
      +t.slice(4, 6)
    )
  );
}

// Abort a single download attempt if no bytes arrive for this long (ms) — a
// genuine stall — so a hung connection surfaces an error instead of spinning the
// progress bar forever. It is reset on every chunk, so a merely slow (but
// progressing) download is never cut off.
const STALL_TIMEOUT_MS = 20000;

// Derive the equivalent AWS S3 object key for an IEM volume filename, so a
// transient IEM outage on a single scan can fall back to the mirror. IEM names
// are <SITE>_YYYYMMDD_HHMMSS.bz2; AWS keys are YYYY/MM/DD/SITE/SITEYYYYMMDD_HHMMSS_V06
// (TDWR terminal radars — the T### sites — end _V08 instead).
function awsKeyForIemName(name) {
  const m = name && name.match(/^([A-Z0-9]+)_(\d{4})(\d{2})(\d{2})_(\d{6})/i);
  if (!m) return null;
  const [, site, y, mo, d, hms] = m;
  const SITE = site.toUpperCase();
  const ver = SITE[0] === 'T' ? '_V08' : '_V06';
  return `${y}/${mo}/${d}/${SITE}/${SITE}${y}${mo}${d}_${hms}${ver}`;
}

// Download bytes from one URL with progress + a stall timeout. Throws on a
// non-ok response, abort/timeout, or network error.
async function downloadBytes(fullUrl, onProgress) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), STALL_TIMEOUT_MS);
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), STALL_TIMEOUT_MS);
  };
  try {
    const res = await fetch(viaProxy(fullUrl), { signal: ctrl.signal });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);

    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !total) {
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bump(); // progress made — reset the stall timer
      chunks.push(value);
      received += value.length;
      if (onProgress) onProgress(received / total);
    }
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// Download one volume scan as raw bytes, reporting progress 0..1. The key picks
// the source: IEM keys are prefixed (see IEM_PREFIX), AWS keys are bare. If an
// IEM scan fails (outage/timeout) we retry the equivalent AWS mirror object
// once before giving up.
export async function fetchVolume(key, onProgress) {
  if (key.startsWith(IEM_PREFIX)) {
    const path = key.slice(IEM_PREFIX.length); // e.g. "KTLX/KTLX_20240619_120300.bz2"
    try {
      return await downloadBytes(`${IEM_BASE}/${path}`, onProgress);
    } catch (e) {
      const awsKey = awsKeyForIemName(path.split('/').pop());
      if (!awsKey) throw e;
      console.warn('IEM volume fetch failed, trying AWS mirror:', e.message);
      return downloadBytes(`${BUCKET}/${awsKey}`, onProgress);
    }
  }
  return downloadBytes(`${BUCKET}/${key}`, onProgress);
}

// A curated list of common WSR-88D sites for the picker.
export const SITES = [
  ['KTLX', 'Oklahoma City, OK'],
  ['KFWS', 'Dallas/Fort Worth, TX'],
  ['KHGX', 'Houston, TX'],
  ['KICT', 'Wichita, KS'],
  ['KLOT', 'Chicago, IL'],
  ['KOKX', 'New York City, NY'],
  ['KDIX', 'Philadelphia, PA'],
  ['KLWX', 'Washington, DC'],
  ['KATX', 'Seattle, WA'],
  ['KMUX', 'San Francisco, CA'],
  ['KVTX', 'Los Angeles, CA'],
  ['KMLB', 'Melbourne, FL'],
  ['KTBW', 'Tampa Bay, FL'],
  ['KAMX', 'Miami, FL'],
  ['KEWX', 'Austin/San Antonio, TX'],
  ['KBMX', 'Birmingham, AL'],
  ['KFFC', 'Atlanta, GA'],
  ['KDTX', 'Detroit, MI'],
  ['KIND', 'Indianapolis, IN'],
  ['KDMX', 'Des Moines, IA'],
  ['KUEX', 'Hastings, NE'],
  ['KDDC', 'Dodge City, KS'],
  ['KPUX', 'Pueblo, CO'],
  ['KFTG', 'Denver, CO'],
  ['KMPX', 'Minneapolis, MN'],
];

// Full WSR-88D site geometry [ICAO, name, lat, lon] — used to pick the radar
// nearest to a clicked point on the map. Coordinates are the published tower
// locations (good to a small fraction of a degree, ample for nearest-site).
export const RADARS = [
  ['KABR', 'Aberdeen, SD', 45.456, -98.413],
  ['KABX', 'Albuquerque, NM', 35.15, -106.824],
  ['KAKQ', 'Wakefield, VA', 36.984, -77.007],
  ['KAMA', 'Amarillo, TX', 35.233, -101.709],
  ['KAMX', 'Miami, FL', 25.611, -80.413],
  ['KAPX', 'Gaylord, MI', 44.907, -84.72],
  ['KARX', 'La Crosse, WI', 43.823, -91.191],
  ['KATX', 'Seattle, WA', 48.195, -122.496],
  ['KBBX', 'Beale AFB, CA', 39.496, -121.632],
  ['KBGM', 'Binghamton, NY', 42.2, -75.985],
  ['KBHX', 'Eureka, CA', 40.499, -124.292],
  ['KBIS', 'Bismarck, ND', 46.771, -100.76],
  ['KBLX', 'Billings, MT', 45.854, -108.607],
  ['KBMX', 'Birmingham, AL', 33.172, -86.77],
  ['KBOX', 'Boston, MA', 41.956, -71.137],
  ['KBRO', 'Brownsville, TX', 25.916, -97.419],
  ['KBUF', 'Buffalo, NY', 42.949, -78.737],
  ['KBYX', 'Key West, FL', 24.598, -81.703],
  ['KCAE', 'Columbia, SC', 33.949, -81.118],
  ['KCBW', 'Caribou, ME', 46.039, -67.807],
  ['KCBX', 'Boise, ID', 43.49, -116.236],
  ['KCCX', 'State College, PA', 40.923, -78.004],
  ['KCLE', 'Cleveland, OH', 41.413, -81.86],
  ['KCLX', 'Charleston, SC', 32.656, -81.042],
  ['KCRP', 'Corpus Christi, TX', 27.784, -97.511],
  ['KCXX', 'Burlington, VT', 44.511, -73.167],
  ['KCYS', 'Cheyenne, WY', 41.152, -104.806],
  ['KDAX', 'Sacramento, CA', 38.501, -121.678],
  ['KDDC', 'Dodge City, KS', 37.761, -99.969],
  ['KDFX', 'Laughlin, TX', 29.273, -100.281],
  ['KDGX', 'Jackson, MS', 32.28, -89.984],
  ['KDIX', 'Philadelphia, PA', 39.947, -74.411],
  ['KDLH', 'Duluth, MN', 46.837, -92.21],
  ['KDMX', 'Des Moines, IA', 41.731, -93.723],
  ['KDOX', 'Dover, DE', 38.826, -75.44],
  ['KDTX', 'Detroit, MI', 42.7, -83.472],
  ['KDVN', 'Davenport, IA', 41.612, -90.581],
  ['KDYX', 'Dyess AFB, TX', 32.538, -99.254],
  ['KEAX', 'Kansas City, MO', 38.81, -94.264],
  ['KEMX', 'Tucson, AZ', 31.894, -110.63],
  ['KENX', 'Albany, NY', 42.586, -74.064],
  ['KEOX', 'Fort Rucker, AL', 31.461, -85.459],
  ['KEPZ', 'El Paso, TX', 31.873, -106.698],
  ['KESX', 'Las Vegas, NV', 35.701, -114.891],
  ['KEVX', 'Eglin AFB, FL', 30.565, -85.922],
  ['KEWX', 'Austin/San Antonio, TX', 29.704, -98.028],
  ['KEYX', 'Edwards AFB, CA', 35.098, -117.561],
  ['KFCX', 'Roanoke, VA', 37.024, -80.274],
  ['KFDR', 'Frederick, OK', 34.362, -98.976],
  ['KFDX', 'Cannon AFB, NM', 34.635, -103.63],
  ['KFFC', 'Atlanta, GA', 33.364, -84.566],
  ['KFSD', 'Sioux Falls, SD', 43.588, -96.729],
  ['KFSX', 'Flagstaff, AZ', 34.574, -111.198],
  ['KFTG', 'Denver, CO', 39.787, -104.546],
  ['KFWS', 'Dallas/Fort Worth, TX', 32.573, -97.303],
  ['KGGW', 'Glasgow, MT', 48.206, -106.625],
  ['KGJX', 'Grand Junction, CO', 39.062, -108.214],
  ['KGLD', 'Goodland, KS', 39.367, -101.7],
  ['KGRB', 'Green Bay, WI', 44.498, -88.111],
  ['KGRK', 'Fort Hood, TX', 30.722, -97.383],
  ['KGRR', 'Grand Rapids, MI', 42.894, -85.545],
  ['KGSP', 'Greer, SC', 34.883, -82.22],
  ['KGWX', 'Columbus AFB, MS', 33.897, -88.329],
  ['KGYX', 'Portland, ME', 43.891, -70.257],
  ['KHDX', 'Holloman AFB, NM', 33.077, -106.123],
  ['KHGX', 'Houston, TX', 29.472, -95.079],
  ['KHNX', 'San Joaquin Valley, CA', 36.314, -119.632],
  ['KHPX', 'Fort Campbell, KY', 36.737, -87.285],
  ['KHTX', 'Huntsville, AL', 34.931, -86.084],
  ['KICT', 'Wichita, KS', 37.655, -97.443],
  ['KICX', 'Cedar City, UT', 37.591, -112.862],
  ['KILN', 'Cincinnati, OH', 39.42, -83.822],
  ['KILX', 'Lincoln, IL', 40.151, -89.337],
  ['KIND', 'Indianapolis, IN', 39.708, -86.28],
  ['KINX', 'Tulsa, OK', 36.175, -95.564],
  ['KIWA', 'Phoenix, AZ', 33.289, -111.67],
  ['KIWX', 'Fort Wayne, IN', 41.359, -85.7],
  ['KJAX', 'Jacksonville, FL', 30.485, -81.702],
  ['KJGX', 'Robins AFB, GA', 32.675, -83.351],
  ['KJKL', 'Jackson, KY', 37.591, -83.313],
  ['KLBB', 'Lubbock, TX', 33.654, -101.814],
  ['KLCH', 'Lake Charles, LA', 30.125, -93.216],
  ['KLGX', 'Langley Hill, WA', 47.117, -124.107],
  ['KLIX', 'New Orleans, LA', 30.337, -89.825],
  ['KLNX', 'North Platte, NE', 41.958, -100.576],
  ['KLOT', 'Chicago, IL', 41.604, -88.085],
  ['KLRX', 'Elko, NV', 40.74, -116.803],
  ['KLSX', 'St. Louis, MO', 38.699, -90.683],
  ['KLTX', 'Wilmington, NC', 33.989, -78.429],
  ['KLVX', 'Louisville, KY', 37.975, -85.944],
  ['KLWX', 'Washington, DC', 38.975, -77.478],
  ['KLZK', 'Little Rock, AR', 34.836, -92.262],
  ['KMAF', 'Midland, TX', 31.943, -102.189],
  ['KMAX', 'Medford, OR', 42.081, -122.717],
  ['KMBX', 'Minot, ND', 48.393, -100.865],
  ['KMHX', 'Morehead City, NC', 34.776, -76.876],
  ['KMKX', 'Milwaukee, WI', 42.968, -88.551],
  ['KMLB', 'Melbourne, FL', 28.113, -80.654],
  ['KMOB', 'Mobile, AL', 30.679, -88.24],
  ['KMPX', 'Minneapolis, MN', 44.849, -93.566],
  ['KMQT', 'Marquette, MI', 46.531, -87.548],
  ['KMRX', 'Knoxville, TN', 36.168, -83.402],
  ['KMSX', 'Missoula, MT', 47.041, -113.986],
  ['KMTX', 'Salt Lake City, UT', 41.263, -112.448],
  ['KMUX', 'San Francisco, CA', 37.155, -121.898],
  ['KMVX', 'Grand Forks, ND', 47.528, -97.326],
  ['KMXX', 'Maxwell AFB, AL', 32.537, -85.79],
  ['KNKX', 'San Diego, CA', 32.919, -117.042],
  ['KNQA', 'Memphis, TN', 35.345, -89.873],
  ['KOAX', 'Omaha, NE', 41.32, -96.367],
  ['KOHX', 'Nashville, TN', 36.247, -86.563],
  ['KOKX', 'New York City, NY', 40.866, -72.864],
  ['KOTX', 'Spokane, WA', 47.681, -117.627],
  ['KPAH', 'Paducah, KY', 37.068, -88.772],
  ['KPBZ', 'Pittsburgh, PA', 40.532, -80.218],
  ['KPDT', 'Pendleton, OR', 45.691, -118.853],
  ['KPOE', 'Fort Polk, LA', 31.156, -92.976],
  ['KPUX', 'Pueblo, CO', 38.46, -104.181],
  ['KRAX', 'Raleigh/Durham, NC', 35.666, -78.49],
  ['KRGX', 'Reno, NV', 39.754, -119.462],
  ['KRIW', 'Riverton, WY', 43.066, -108.477],
  ['KRLX', 'Charleston, WV', 38.311, -81.723],
  ['KRTX', 'Portland, OR', 45.715, -122.965],
  ['KSFX', 'Pocatello, ID', 43.106, -112.686],
  ['KSGF', 'Springfield, MO', 37.235, -93.4],
  ['KSHV', 'Shreveport, LA', 32.451, -93.841],
  ['KSJT', 'San Angelo, TX', 31.371, -100.492],
  ['KSOX', 'Santa Ana Mtns, CA', 33.818, -117.636],
  ['KSRX', 'Fort Smith, AR', 35.29, -94.362],
  ['KTBW', 'Tampa Bay, FL', 27.706, -82.402],
  ['KTFX', 'Great Falls, MT', 47.46, -111.385],
  ['KTLH', 'Tallahassee, FL', 30.398, -84.329],
  ['KTLX', 'Oklahoma City, OK', 35.333, -97.278],
  ['KTWX', 'Topeka, KS', 38.997, -96.232],
  ['KTYX', 'Montague, NY', 43.756, -75.68],
  ['KUDX', 'Rapid City, SD', 44.125, -102.83],
  ['KUEX', 'Hastings, NE', 40.321, -98.442],
  ['KVAX', 'Moody AFB, GA', 30.89, -83.002],
  ['KVBX', 'Vandenberg AFB, CA', 34.838, -120.398],
  ['KVNX', 'Vance AFB, OK', 36.741, -98.128],
  ['KVTX', 'Los Angeles, CA', 34.412, -119.179],
  ['KVWX', 'Evansville, IN', 38.26, -87.724],
  ['KYUX', 'Yuma, AZ', 32.495, -114.656],
  ['PACG', 'Sitka, AK', 56.853, -135.529],
  ['PAEC', 'Nome, AK', 64.511, -165.295],
  ['PAHG', 'Anchorage, AK', 60.726, -151.351],
  ['PAIH', 'Middleton Island, AK', 59.461, -146.303],
  ['PAKC', 'Bethel, AK', 60.792, -161.842],
  ['PAPD', 'Fairbanks, AK', 65.035, -147.501],
  ['PHKI', 'South Kauai, HI', 21.894, -159.552],
  ['PHKM', 'Kohala, HI', 20.125, -155.778],
  ['PHMO', 'Molokai, HI', 21.133, -157.18],
  ['PHWA', 'South Shore, HI', 19.095, -155.569],
  ['TJUA', 'San Juan, PR', 18.116, -66.078],
  ['PGUA', 'Andersen AFB, Guam', 13.456, 144.811],

  // --- TDWR (Terminal Doppler Weather Radar) -----------------------------
  // The FAA's terminal radars guarding major airports. They share the same
  // realtime feed and Archive-II message format as the WSR-88D network (AWS
  // keys end _V08 rather than _V06; listVolumes/fetchVolume handle both), so
  // they load through the exact same path. TDWR is C-band with a tighter
  // ~90 nmi range and finer beam, giving a much sharper near-airport view than
  // the parent WSR-88D. Names carry a "(TDWR)" tag so they're easy to spot in
  // the picker, which sits next to the WSR-88D site of the same city.
  ['TADW', 'Washington/Andrews, MD (TDWR)', 38.695, -76.845],
  ['TATL', 'Atlanta, GA (TDWR)', 33.646, -84.262],
  ['TBNA', 'Nashville, TN (TDWR)', 35.98, -86.662],
  ['TBOS', 'Boston, MA (TDWR)', 42.159, -70.934],
  ['TBWI', 'Baltimore, MD (TDWR)', 39.09, -76.63],
  ['TCLT', 'Charlotte, NC (TDWR)', 35.337, -80.885],
  ['TCMH', 'Columbus, OH (TDWR)', 40.006, -82.715],
  ['TCVG', 'Cincinnati, OH (TDWR)', 38.898, -84.58],
  ['TDAL', 'Dallas Love, TX (TDWR)', 32.926, -96.968],
  ['TDAY', 'Dayton, OH (TDWR)', 40.022, -84.123],
  ['TDCA', 'Washington/National, DC (TDWR)', 38.759, -76.962],
  ['TDEN', 'Denver, CO (TDWR)', 39.728, -104.526],
  ['TDFW', 'Dallas/Fort Worth, TX (TDWR)', 33.065, -96.918],
  ['TDTW', 'Detroit, MI (TDWR)', 42.111, -83.515],
  ['TEWR', 'Newark, NJ (TDWR)', 40.593, -74.27],
  ['TFLL', 'Fort Lauderdale, FL (TDWR)', 26.143, -80.344],
  ['THOU', 'Houston/Hobby, TX (TDWR)', 29.516, -95.242],
  ['TIAD', 'Washington/Dulles, VA (TDWR)', 39.084, -77.529],
  ['TIAH', 'Houston/Intercontinental, TX (TDWR)', 30.065, -95.567],
  ['TICH', 'Wichita, KS (TDWR)', 37.507, -97.437],
  ['TIDS', 'Indianapolis, IN (TDWR)', 39.637, -86.435],
  ['TJFK', 'New York/JFK, NY (TDWR)', 40.589, -73.881],
  ['TLAS', 'Las Vegas, NV (TDWR)', 36.144, -115.007],
  ['TLVE', 'Cleveland, OH (TDWR)', 41.29, -81.972],
  ['TMCI', 'Kansas City, MO (TDWR)', 39.498, -94.742],
  ['TMCO', 'Orlando, FL (TDWR)', 28.343, -81.326],
  ['TMDW', 'Chicago/Midway, IL (TDWR)', 41.651, -87.73],
  ['TMEM', 'Memphis, TN (TDWR)', 34.896, -89.993],
  ['TMIA', 'Miami, FL (TDWR)', 25.758, -80.491],
  ['TMKE', 'Milwaukee, WI (TDWR)', 42.819, -88.046],
  ['TMSP', 'Minneapolis, MN (TDWR)', 44.871, -93.341],
  ['TMSY', 'New Orleans, LA (TDWR)', 30.022, -90.403],
  ['TOKC', 'Oklahoma City, OK (TDWR)', 35.276, -97.51],
  ['TORD', 'Chicago/O’Hare, IL (TDWR)', 41.797, -87.858],
  ['TPBI', 'West Palm Beach, FL (TDWR)', 26.688, -80.273],
  ['TPHL', 'Philadelphia, PA (TDWR)', 39.95, -75.069],
  ['TPHX', 'Phoenix, AZ (TDWR)', 33.421, -112.163],
  ['TPIT', 'Pittsburgh, PA (TDWR)', 40.501, -80.486],
  ['TRDU', 'Raleigh/Durham, NC (TDWR)', 36.002, -78.697],
  ['TSDF', 'Louisville, KY (TDWR)', 38.046, -85.611],
  ['TSJU', 'San Juan, PR (TDWR)', 18.474, -66.179],
  ['TSLC', 'Salt Lake City, UT (TDWR)', 40.967, -111.93],
  ['TSTL', 'St. Louis, MO (TDWR)', 38.804, -90.489],
  ['TTPA', 'Tampa, FL (TDWR)', 27.86, -82.518],
  ['TTUL', 'Tulsa, OK (TDWR)', 36.071, -95.827],
];

// The TDWR terminal radars, derived from the "(TDWR)" tag in their names so the
// list above stays the single source of truth. Used to color their map dots and
// to drop dual-pol products (they scan to Doppler only), and to keep them out of
// nearest-site selection (right-click / long-press snaps to NEXRAD only).
export const TDWR_CODES = new Set(
  RADARS.filter((r) => /\(TDWR\)/.test(r[1])).map((r) => r[0])
);
export function isTDWR(icao) {
  return TDWR_CODES.has((icao || '').toUpperCase());
}

// Find the WSR-88D site nearest to a geographic point. Returns [ICAO, name, lat,
// lon] of the closest tower by great-circle distance. TDWR towers are skipped so
// a click/long-press always lands on the parent NEXRAD, not the terminal radar.
export function nearestSite(lat, lon) {
  const toRad = (d) => (d * Math.PI) / 180;
  let best = null;
  let bestD = Infinity;
  for (const r of RADARS) {
    if (TDWR_CODES.has(r[0])) continue;
    const dLat = toRad(r[2] - lat);
    const dLon = toRad(r[3] - lon);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat)) * Math.cos(toRad(r[2])) * Math.sin(dLon / 2) ** 2;
    const d = 2 * Math.asin(Math.min(1, Math.sqrt(a)));
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}
