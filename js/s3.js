// s3.js — fetch NEXRAD Level II volumes from a public AWS S3 bucket.
//
// We use Unidata's realtime full-volume feed `unidata-nexrad-level2`, mirrored
// openly on AWS as part of the NOAA Open Data Dissemination program. Objects are
// keyed as  YYYY/MM/DD/SITE/SITEYYYYMMDD_HHMMSS_V06 . The bucket returns
// `Access-Control-Allow-Origin: *` for both listing and GET, so the browser can
// discover and download volumes directly — no backend, no proxy required.
//
// (NOAA's deep archive bucket `noaa-nexrad-level2` holds data back to 1991 but
// disables anonymous bucket listing, so it can't be browsed from the client.
// The Unidata feed carries a rolling window of the most recent scans, which is
// exactly what a live viewer needs.)

const BUCKET = 'https://unidata-nexrad-level2.s3.amazonaws.com';

// Optional CORS proxy. Left empty: we talk to S3 directly. If a user's network
// blocks it, they can set a proxy prefix here.
let proxy = '';
export function setProxy(p) {
  proxy = p || '';
}
function url(path) {
  return proxy ? proxy + encodeURIComponent(BUCKET + path) : BUCKET + path;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// List the volume scan keys for a given site and UTC day, newest last.
export async function listVolumes(site, date) {
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const prefix = `${y}/${m}/${d}/${site.toUpperCase()}/`;
  const listUrl = url(`/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`);

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

function labelForKey(key) {
  const name = key.split('/').pop();
  const t = timeForKey(key);
  if (!t) return name;
  return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}Z`;
}

function timeForKey(key) {
  // KTLX20240619_120300_V06
  const name = key.split('/').pop();
  const m = name.match(/(\d{8})_(\d{6})/);
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

// Download one volume scan as raw bytes, reporting progress 0..1.
export async function fetchVolume(key, onProgress) {
  const res = await fetch(url('/' + key));
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
