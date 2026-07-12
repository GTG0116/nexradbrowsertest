// mesoanalysis.js -- SPC Mesoscale Analysis products.
//
// Unlike every other source in this app, the SPC mesoanalysis is not a decoded
// data grid we can drape over the interactive map: SPC only publishes finished
// raster plots. So this module is just a catalog of the products, sectors and
// the URL scheme used to fetch each static GIF. The app swaps the live map for
// the plain image whenever a mesoanalysis product is selected (see app.js).
//
// Image URL scheme (mirrors viewsector.php's showimage()):
//   https://www.spc.noaa.gov/exper/mesoanalysis/s<sector>/<code>/<code>.gif
// e.g. https://www.spc.noaa.gov/exper/mesoanalysis/s16/sbcp/sbcp.gif

const BASE = 'https://www.spc.noaa.gov/exper/mesoanalysis';

// Regional sectors, numbered as SPC numbers them (19 == full CONUS). Order here
// is the display order in the picker: CONUS first, then west-to-east regionals.
export const MESO_SECTORS = [
  { id: '19', name: 'CONUS (National)' },
  { id: '11', name: 'Pacific Northwest' },
  { id: '12', name: 'Southwest' },
  { id: '22', name: 'Great Basin' },
  { id: '13', name: 'Northern Plains' },
  { id: '14', name: 'Central Plains' },
  { id: '15', name: 'Southern Plains' },
  { id: '20', name: 'Midwest' },
  { id: '21', name: 'Great Lakes' },
  { id: '16', name: 'Northeast' },
  { id: '17', name: 'Mid-Atlantic' },
  { id: '18', name: 'Southeast' },
];

export const MESO_DEFAULT_SECTOR = '19';
export const MESO_DEFAULT_CODE = 'sbcp';

// Products grouped exactly as they appear in the SPC mesoanalysis menus. Each
// entry is [code, name]; the code is both the directory and file stem of the
// GIF. Sections preserve SPC's own ordering and headings.
export const MESO_CATEGORIES = [
  {
    name: 'Observations',
    products: [
      ['bigsfc', 'Surface Observations'],
      ['1kmv', 'Visible Satellite'],
      ['rgnlrad', 'Radar Base Reflectivity'],
    ],
  },
  {
    name: 'Surface',
    products: [
      ['pmsl', 'MSL Pressure / Wind'],
      ['ttd', 'Temp / Wind / Dewpoint'],
      ['thet', 'MSL Pressure / Theta-E / Wind'],
      ['mcon', 'Moisture Convergence'],
      ['thea', 'Theta-E Advection'],
      ['mxth', 'Mixing Ratio / Theta'],
      ['icon', 'Instantaneous Contraction Rate (sfc)'],
      ['trap', 'Fluid Trapping (sfc)'],
      ['vtm', 'Velocity Tensor Magnitude (sfc)'],
      ['dvvr', 'Divergence and Vorticity (sfc)'],
      ['def', 'Deformation & Axes of Dilatation (sfc)'],
      ['pchg', '2-hour Pressure Change'],
      ['temp_chg', '3-hour Temp Change'],
      ['dwpt_chg', '3-hour Dewpoint Change'],
      ['mixr_chg', '3-hour 100mb Mixing Ratio Change'],
      ['thte_chg', '3-hour Theta-E Change'],
    ],
  },
  {
    name: 'Upper Air',
    products: [
      ['925mb', '925mb Analysis'],
      ['850mb', '850mb Analysis'],
      ['850mb2', '850mb Analysis (version 2)'],
      ['700mb', '700mb Analysis'],
      ['500mb', '500mb Analysis'],
      ['300mb', '300mb Analysis'],
      ['dlcp', 'Deep Moist Convergence'],
      ['tadv_925', '925mb Temp Advection'],
      ['tadv', '850mb Temp Advection'],
      ['7tad', '700mb Temp Advection'],
      ['sfnt', 'Sfc Frontogenesis'],
      ['9fnt', '925mb Frontogenesis'],
      ['8fnt', '850mb Frontogenesis'],
      ['7fnt', '700mb Frontogenesis'],
      ['925f', '1000-925mb Frontogenesis'],
      ['98ft', '925-850mb Frontogenesis'],
      ['857f', '850-700mb Frontogenesis'],
      ['75ft', '700-500mb Frontogenesis'],
      ['vadv', '700-400mb Diff. Vorticity Advection'],
      ['padv', '400-250mb Pot. Vorticity Advection'],
      ['ddiv', '850-250mb Diff. Divergence'],
      ['ageo', '300mb Jet Circulation'],
      ['500mb_chg', '12-hour 500mb Height Change'],
      ['trap_500', 'Fluid Trapping (500mb)'],
      ['trap_250', 'Fluid Trapping (250mb)'],
    ],
  },
  {
    name: 'Thermodynamics',
    products: [
      ['sbcp', 'CAPE - Surface-Based'],
      ['mlcp', 'CAPE - 100mb Mixed-Layer'],
      ['mucp', 'CAPE - Most-Unstable / LPL Height'],
      ['eltm', 'EL Temp / MUCAPE / MUCIN'],
      ['ncap', 'CAPE - Normalized'],
      ['dcape', 'CAPE - Downdraft'],
      ['muli', 'Surface-based Lifted Index'],
      ['laps', 'Mid-Level Lapse Rates'],
      ['lllr', 'Low-Level Lapse Rates'],
      ['maxlr', 'Max 2-6 km AGL Lapse Rate'],
      ['lclh', 'LCL Height'],
      ['lfch', 'LFC Height'],
      ['lfrh', 'LCL-LFC Mean RH'],
      ['sbcp_chg', '3-hour Surface-Based CAPE Change'],
      ['sbcn_chg', '3-hour Surface-Based CIN Change'],
      ['mlcp_chg', '3-hour 100mb Mixed-Layer CAPE Change'],
      ['mucp_chg', '3-hour Most-Unstable CAPE Change'],
      ['lllr_chg', '3-hour Low-Level LR Change'],
      ['laps_chg', '6-hour Mid-Level LR Change'],
    ],
  },
  {
    name: 'Wind Shear',
    products: [
      ['eshr', 'Bulk Shear - Effective'],
      ['shr1', 'Bulk Shear - Sfc-1km'],
      ['shr3', 'Bulk Shear - Sfc-3km'],
      ['shr6', 'Bulk Shear - Sfc-6km'],
      ['shr8', 'Bulk Shear - Sfc-8km'],
      ['brns', 'BRN Shear'],
      ['effh', 'SR Helicity - Effective'],
      ['srh5', 'SR Helicity - Sfc-500m'],
      ['srh1', 'SR Helicity - Sfc-1km'],
      ['srh3', 'SR Helicity - Sfc-3km'],
      ['llsr', 'SR Wind - Sfc-2km'],
      ['mlsr', 'SR Wind - 4-6km'],
      ['ulsr', 'SR Wind - 9-11km'],
      ['alsr', 'SR Wind - Anvil Level'],
      ['mnwd', '850-300mb Mean Wind'],
      ['xover', '850 and 500mb Winds'],
      ['shr1_chg', '3hr Sfc-1km Bulk Shear Change'],
      ['srh3_chg', '3hr Sfc-3km SR Helicity Change'],
      ['shr6_chg', '3hr Sfc-6km Bulk Shear Change'],
    ],
  },
  {
    name: 'Composite Indices',
    products: [
      ['scp', 'Supercell Composite'],
      ['lscp', 'Supercell Composite (left-moving)'],
      ['stor', 'Sgfnt Tornado (fixed layer)'],
      ['stpc', 'Sgfnt Tornado (effective layer)'],
      ['stpc5', 'Sgfnt Tornado (0-500m SRH)'],
      ['sigt1', 'Cond. Prob. Sigtor (Eqn 1)'],
      ['sigt2', 'Cond. Prob. Sigtor (Eqn 2)'],
      ['nstp', 'Non-Supercell Tornado'],
      ['vtp3', 'Violent Tornado Parameter (VTP)'],
      ['sigh', 'Sgfnt Hail'],
      ['sars1', 'SARS Hail Size'],
      ['sars2', 'SARS Sig. Hail Percentage'],
      ['lghl', 'Large Hail Parameter'],
      ['dcp', 'Derecho Composite'],
      ['cbsig', 'Craven/Brooks Sgfnt Severe'],
      ['brn', 'Bulk Richardson Number'],
      ['mcsm', 'MCS Maintenance'],
      ['mbcp', 'Microburst Composite'],
      ['desp', 'Enhanced Stretching Potential'],
      ['ehi1', 'EHI - Sfc-1km'],
      ['ehi3', 'EHI - Sfc-3km'],
      ['vgp3', 'VGP - Sfc-3km'],
      ['crit', 'Critical Angle'],
    ],
  },
  {
    name: 'Multi-Parameter Fields',
    products: [
      ['mlcp_eshr', '100mb ML CAPE / Effective Bulk Shear'],
      ['cpsh', 'Most-Unstable CAPE / Effective Bulk Shear'],
      ['comp', 'Most-Unstable LI / 850 & 500mb Winds'],
      ['lcls', 'LCL Height / Sfc-1km SR Helicity'],
      ['lr3c', 'Sfc-3km Lapse Rate / Sfc-3km MLCAPE'],
      ['3cape_shr3', 'Sfc-3km Bulk Shear / Sfc-3km MLCAPE'],
      ['3cvr', 'Sfc Vorticity / Sfc-3km MLCAPE'],
      ['tdlr', 'Sfc Dewpoint / 700-500mb Lapse Rates'],
      ['hail', 'Hail Parameters'],
      ['qlcs1', 'Theta-E diff. / MUCAPE / 0-3km Shear'],
      ['qlcs2', 'Theta-E diff. / MLCAPE / 0-3km Shear'],
    ],
  },
  {
    name: 'Heavy Rain',
    products: [
      ['pwtr', 'Precipitable Water'],
      ['pwtr2', 'Precipitable Water (w/ 850mb Transport)'],
      ['tran', '850mb Moisture Transport'],
      ['tran_925', '925mb Moisture Transport'],
      ['tran_925-850', '925-850mb Moisture Transport'],
      ['prop', 'Upwind Propagation Vector'],
      ['peff', 'Precipitation Potential Placement'],
      ['mixr', '100mb Mean Mixing Ratio'],
    ],
  },
  {
    name: 'Winter Weather',
    products: [
      ['ptyp', 'Precipitation Type'],
      ['fztp', 'Near-Freezing Surface Temp'],
      ['swbt', 'Surface Wet-Bulb Temp'],
      ['fzlv', 'Freezing Level'],
      ['thck', 'Critical Thicknesses'],
      ['epvl', '800-750mb EPVg'],
      ['epvm', '650-500mb EPVg'],
      ['les1', 'Lake Effect Snow 1'],
      ['les2', 'Lake Effect Snow 2'],
      ['snsq', 'Snow Squall Parameter'],
      ['dend', 'Dendritic Growth Layer Depth'],
      ['dendrh', 'Dendritic Growth Layer RH'],
      ['ddrh', 'Dendritic Growth Layer Depth & RH'],
      ['mxwb', 'Max Wet Bulb Temperature'],
    ],
  },
  {
    name: 'Fire Weather',
    products: [
      ['sfir', 'Sfc RH / Temp / Wind'],
      ['fosb', 'Fosberg Index'],
      ['lfrh2', 'LCL-LFC Mean RH (fire wx)'],
    ],
  },
  {
    name: 'Classic',
    products: [
      ['ttot', 'Total Totals'],
      ['kidx', 'K-Index'],
      ['show', 'Showalter Index'],
    ],
  },
  {
    name: 'Beta',
    products: [
      ['sherbe', 'SHERBE'],
      ['moshe', 'Modified SHERBE'],
      ['cwasp', 'CWASP'],
      ['tehi', 'Tornadic 0-1km EHI'],
      ['tts', 'Tornadic Tilting & Stretching'],
      ['oprh', 'OPRH'],
      ['ptstpe', 'Prob EF0+ (cond. on RM supercell)'],
      ['pstpe', 'Prob EF2+ (cond. on RM supercell)'],
      ['pvstpe', 'Prob EF4+ (cond. on RM supercell)'],
      ['pw3k', 'PW * 3kmRH'],
    ],
  },
];

// Flat code -> name lookup across every category.
export const MESO_PRODUCTS = (() => {
  const out = {};
  for (const cat of MESO_CATEGORIES) {
    for (const [code, name] of cat.products) out[code] = { code, name, category: cat.name };
  }
  return out;
})();

export function mesoProductName(code) {
  return MESO_PRODUCTS[code] ? MESO_PRODUCTS[code].name : code;
}

export function mesoSectorName(id) {
  const s = MESO_SECTORS.find((x) => x.id === String(id));
  return s ? s.name : `Sector ${id}`;
}

// Full image URL for a product/sector. `bust`, when set, appends a cache-buster
// so a manual refresh or live tick pulls the freshest analysis rather than the
// browser-cached copy.
export function mesoImageUrl(sector, code, bust) {
  const url = `${BASE}/s${sector}/${code}/${code}.gif`;
  return bust ? `${url}?${typeof bust === 'number' ? bust : Date.now()}` : url;
}

// ---------------------------------------------------------------------------
// Playback / archive frames
//
// SPC keeps an hourly archive of every product: the current hour is the plain
// {code}.gif, and each earlier top-of-hour is {code}_{YYMMDDHH}.gif (UTC). We
// synthesize the recent frame list client-side from the wall clock rather than
// scraping the archive page — the stamps are just consecutive UTC hours.
// ---------------------------------------------------------------------------
const p2 = (n) => String(n).padStart(2, '0');

// SPC archive stamp (YYMMDDHH, UTC) for a Date.
function mesoStamp(d) {
  return `${p2(d.getUTCFullYear() % 100)}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}`;
}

export const MESO_FRAME_COUNTS = [6, 12, 18, 24];
export const MESO_DEFAULT_FRAMES = 12;

// The last `count` hourly frames, oldest first, ending at the most recent
// top-of-hour. The newest frame is flagged `latest` (served as the realtime
// {code}.gif); older frames carry their archive stamp and a UTC hour label.
export function mesoFrames(count = MESO_DEFAULT_FRAMES, now = new Date()) {
  const anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(anchor - i * 3600000);
    out.push({
      dt: mesoStamp(d),
      time: d,
      label: i === 0 ? 'Latest' : `${p2(d.getUTCHours())}Z`,
      latest: i === 0,
    });
  }
  return out;
}

// Archive image URL for one frame. The newest hour uses the plain realtime GIF
// (always the freshest posted image); earlier hours use the timestamped file.
export function mesoFrameUrl(sector, code, frame, bust) {
  const path = frame.latest
    ? `${BASE}/s${sector}/${code}/${code}.gif`
    : `${BASE}/s${sector}/${code}/${code}_${frame.dt}.gif`;
  return bust ? `${path}?${typeof bust === 'number' ? bust : Date.now()}` : path;
}
