// Logique commune à la page (GitHub Pages) et au serveur MCP (Node) : scan Overture + SIRENE, dédoublonnage, filtres, CSV.
// Rien n'est enregistré : les résultats vivent en mémoire (l'onglet ou le processus MCP), dans un store créé par newStore().
// Le moteur SQL est fourni par l'appelant : query(sql) → lignes, DuckDB-Wasm dans le navigateur, @duckdb/node-api dans Node.
import CATEGORIES from './categories.js';
import { sireneRows, isKnown, plain } from './sirene.js';

export const LIMIT = 1000;
const MIN_CONFIDENCE = 0.5;
// Familles Overture (1er niveau de taxonomy.hierarchy). Sert aussi de liste blanche pour le filtre SQL.
export const FAMILIES = {
  food_and_drink: 'Restauration',
  shopping: 'Boutiques',
  lifestyle_services: 'Beauté & bien-être',
  services_and_business: 'Services & artisans',
  health_care: 'Santé',
  lodging: 'Hébergement',
  travel_and_transportation: 'Auto & transport',
  sports_and_recreation: 'Sport & loisirs',
  arts_and_entertainment: 'Culture & sorties',
  education: 'Formation',
  community_and_government: 'Associations & public',
  cultural_and_historic: 'Patrimoine & cultes',
  geographic_entities: 'Lieux & nature',
};

const expected = (message) => Object.assign(new Error(message), { expected: true });

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} : ${res.status}`);
  return res.json();
}

export function latestRelease(catalog) {
  const releases = catalog.links.map((l) => l.href.match(/\/(\d{4}-\d\d-\d\d\.\d+)\//)?.[1]).filter(Boolean).sort();
  if (!releases.length) throw expected('Aucune version Overture trouvée');
  return releases.pop();
}

// Overture publie une version par mois et retire les anciennes : un processus resté ouvert relit le catalogue chaque jour.
let releaseCache = { name: null, at: 0 };
async function currentRelease() {
  if (Date.now() - releaseCache.at < 24 * 3600e3) return releaseCache.name;
  try {
    releaseCache = { name: latestRelease(await getJson('https://stac.overturemaps.org/catalog.json')), at: Date.now() };
  } catch (e) {
    if (!releaseCache.name) throw e; // catalogue en panne : la version d'hier reste bonne
  }
  return releaseCache.name;
}

// Les lieux Overture sont répartis en ~16 fichiers de 700 Mo, chacun sur une bande du globe (emprise donnée par le catalogue STAC).
// On ne lit que ceux qui touchent la zone : ouvrir les 16 coûte 3 fois plus de temps au 1er scan.
// Les URL finissent dans le SQL : seulement des fichiers du bucket public Overture.
const PARQUET = /^https:\/\/overturemaps-us-west-2\.s3\.us-west-2\.amazonaws\.com\/release\/[\w.=/-]+\.parquet$/;
export function pickFiles(items, [w, s, e, n]) {
  return items.filter(({ bbox: b }) => b[0] <= e && b[2] >= w && b[1] <= n && b[3] >= s).map((it) => {
    const url = it.assets?.aws?.href;
    if (!PARQUET.test(url ?? '')) throw new Error('Catalogue Overture inattendu : ' + url);
    return url;
  });
}

const itemsCache = new Map();
async function overtureFiles(release, box) {
  if (!itemsCache.has(release)) {
    const collection = `https://stac.overturemaps.org/${release}/places/place/collection.json`;
    const links = (await getJson(collection)).links.filter((l) => l.rel === 'item');
    itemsCache.set(release, await Promise.all(links.map((l) => getJson(new URL(l.href, collection).href))));
  }
  const files = pickFiles(itemsCache.get(release), box);
  if (!files.length) throw expected('Aucune donnée Overture sur cette zone');
  return files;
}

export function parseScan(body) {
  const families = body?.families ?? [];
  if (!Array.isArray(families) || !families.every((f) => Object.hasOwn(FAMILIES, f))) throw new Error('Type de commerce inconnu');
  // Zone « ville » ou « rue » : la commune vient de son code INSEE, la rue de son nom.
  if (body.zone === 'city' || body.zone === 'street') {
    const { zone, citycode } = body;
    if (!/^\d[\dAB]\d{3}$/.test(citycode)) throw new Error('Commune inconnue');
    if (zone === 'city') return { zone, citycode, families };
    // Le nom de rue finit dans le SQL : jeu de caractères restreint, apostrophes doublées par placesQuery.
    if (typeof body.street !== 'string' || !/^[\p{L}\p{N} '’.-]{2,100}$/u.test(body.street)) throw new Error('Rue inconnue');
    return { zone, citycode, street: body.street, families };
  }
  const lat = Number(body?.lat);
  const lon = Number(body?.lon);
  const radius = Math.round(Number(body?.radius));
  if (!(lat >= 41 && lat <= 51.5 && lon >= -5.5 && lon <= 10)) throw new Error('Point hors de France métropolitaine');
  if (!(radius >= 50 && radius <= 5000)) throw new Error('Rayon entre 50 et 5000 m');
  return { lat, lon, radius, families };
}

// Contour officiel de la commune (ou de l'arrondissement à Paris, Lyon, Marseille).
async function communeGeometry(citycode) {
  const res = await fetch(`https://geo.api.gouv.fr/communes/${citycode}?fields=nom,contour&format=geojson&geometry=contour`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw expected(`Contour de commune indisponible (${res.status})`);
  const { type, coordinates } = (await res.json()).geometry ?? {};
  // La géométrie sert aux bornes du SQL : on n'en garde que le type attendu et des nombres.
  if (!['Polygon', 'MultiPolygon'].includes(type) || !coordinates.flat(Infinity).every(Number.isFinite)) throw expected('Contour de commune illisible');
  return { type, coordinates };
}

// Rectangle « ouest, sud, est, nord » qui contient la zone.
function areaBox({ lat, lon, radius, geometry }) {
  if (!geometry) {
    const dLat = radius / 111320;
    const dLon = dLat / Math.cos((lat * Math.PI) / 180);
    return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
  }
  const flat = geometry.coordinates.flat(Infinity);
  const xs = flat.filter((_, i) => i % 2 === 0);
  const ys = flat.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Point dans le contour (règle pair-impair : un trou du polygone est dehors). Fait en JS : l'extension spatial n'existe pas partout.
export function inArea({ type, coordinates }, lon, lat) {
  const crosses = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return (type === 'Polygon' ? [coordinates] : coordinates).some((rings) => rings.reduce((inside, ring) => inside !== crosses(ring), false));
}

function areaFilter(scan) {
  const [w, s, e, n] = areaBox(scan);
  const box = `bbox.xmin BETWEEN ${w} AND ${e}\n  AND bbox.ymin BETWEEN ${s} AND ${n}`;
  if (!scan.geometry) {
    const { lat, lon, radius } = scan;
    return `${box}\n  AND pow((bbox.ymin - ${lat}) * 111320, 2) + pow((bbox.xmin - ${lon}) * 111320 * cos(radians(${lat})), 2) <= ${radius * radius}`;
  }
  // Le contour exact est vérifié ensuite par inArea.
  return `${box}
  -- Certaines fiches sont posées au centre d'une commune homonyme ou au hasard (ex. une adresse à Juzes 31 placée à Génissac 33) : l'adresse doit être du même département.
  -- shortcut: faux pour de rares communes rattachées au bureau de poste du département voisin.
  AND (addresses[1].postcode IS NULL OR left(addresses[1].postcode, 2) = '${scan.citycode.slice(0, 2).replace(/2[AB]/, '20')}')${
    scan.street ? `\n  AND addresses[1].freeform ILIKE '%${scan.street.replaceAll("'", "''")}%'` : ''}`;
}

// Tout ce qui est interpolé est validé par parseScan, communeGeometry ou pickFiles.
// Tous les lieux nommés de la zone, avec ou sans site : prospect dit lesquels garder, les autres servent à dédoublonner SIRENE.
export function placesQuery(files, scan) {
  const { families = [] } = scan;
  return `
SELECT id, names.primary AS name, basic_category AS category, taxonomy.hierarchy[1] AS family, round(confidence, 2) AS confidence,
  phones[1] AS phone, emails[1] AS email, socials[1] AS social,
  addresses[1].freeform AS street, addresses[1].postcode AS postcode, addresses[1].locality AS city,
  bbox.ymin AS lat, bbox.xmin AS lon,
  websites IS NULL
  -- Les enseignes de chaîne ont un site même s'il n'est pas renseigné. On teste le nom : les fiches venues de Facebook ont une marque vide mais pas NULL.
  AND brand.names.primary IS NULL
  AND operating_status IS DISTINCT FROM 'permanently_closed'
  AND confidence >= ${MIN_CONFIDENCE} AS prospect
FROM read_parquet([${files.map((f) => `'${f}'`).join(', ')}])
WHERE ${areaFilter(scan)}
  AND names.primary IS NOT NULL
  ${families.length ? `AND taxonomy.hierarchy[1] IN (${families.map((f) => `'${f}'`).join(', ')})` : ''}`;
}

// places : fiches par id ; checks : résultat de la double vérification par id (un rescan remplace la fiche, pas sa vérification).
export const newStore = () => ({ places: new Map(), checks: new Map() });

// Fusion d'un scan Overture : retire les fiches que ce scan contredit (elles ont gagné un site ou ne sont plus fiables,
// ou, sur une commune entière, ont disparu d'Overture ou n'y sont plus localisées), puis ajoute ou met à jour les prospects.
// Les fiches SIRENE ne sont pas touchées : leur source est interrogée à part. Renvoie le nombre de prospects trouvés.
export function mergeOverture({ places }, rows, scan, now = new Date().toISOString()) {
  const seen = new Set(rows.map((r) => r.id));
  for (const r of rows) if (!r.prospect) places.delete(r.id);
  if (scan.zone === 'city') {
    for (const [id, p] of places) {
      if (!seen.has(id) && !id.startsWith('sirene:') && inArea(scan.geometry, p.lon, p.lat)
        && (!scan.families?.length || scan.families.includes(p.family))) places.delete(id);
    }
  }
  const keep = rows.filter((r) => r.prospect).sort((a, b) => b.confidence - a.confidence);
  for (const { prospect, ...r } of keep.slice(0, LIMIT)) places.set(r.id, { ...r, scanned_at: now });
  return keep.length;
}

// Scan complet d'une zone (body : { zone, citycode, street } ou { lat, lon, radius }, plus families).
export async function runScan(store, body, query) {
  const scan = parseScan(body);
  // SIRENE ne dépend pas d'Overture : on l'interroge pendant la lecture des fichiers Overture.
  const sireneP = sireneRows(scan).catch((e) => ({ error: e }));
  let release, rows;
  try {
    release = await currentRelease();
    if (scan.zone) scan.geometry = await communeGeometry(scan.citycode);
    rows = await query(placesQuery(await overtureFiles(release, areaBox(scan)), scan));
  } catch (e) {
    // Nos propres contrôles (contour, version) disent ce qui ne va pas ; le reste est une panne de source.
    if (e.expected) throw e;
    console.error(e);
    throw new Error('La source de données ne répond pas, réessaie dans une minute.');
  }
  if (scan.geometry) rows = rows.filter((r) => inArea(scan.geometry, r.lon, r.lat));
  const now = new Date().toISOString();
  const count = mergeOverture(store, rows, scan, now);
  // SIRENE en complément : une panne n'annule pas le scan Overture, elle est signalée.
  let sirene = { count: 0, truncated: false, error: null };
  try {
    const { rows: found, truncated, error } = await sireneP;
    if (error) throw error;
    const fresh = found.filter((r) => !isKnown(r, rows));
    for (const r of fresh) store.places.set(r.id, { ...r, scanned_at: now });
    sirene = { count: fresh.length, truncated, error: null };
  } catch (e) {
    console.error('SIRENE :', e.message);
    sirene.error = 'Registre SIRENE indisponible, seules les données Overture ont été ajoutées.';
  }
  return { release, area: scan.geometry, truncated: count > LIMIT, count: Math.min(count, LIMIT), sirene };
}

export function saveCheck(store, id, result) {
  store.checks.set(id, { ...result, checked_at: new Date().toISOString() });
}

export function toPlace(r, check) {
  return {
    id: r.id,
    name: r.name,
    category: r.category ? CATEGORIES[r.category] ?? FAMILIES[r.category] ?? r.category.replaceAll('_', ' ') : null,
    family: r.family ?? null,
    confidence: r.confidence,
    address: [r.street, r.postcode, r.city].filter(Boolean).join(' '),
    phone: r.phone,
    email: r.email,
    social: r.social,
    lat: r.lat,
    lon: r.lon,
    checked: check ? check.checked_at.slice(0, 10) : null,
    partial: check?.partial ?? null,
    possible: check?.possible ?? null, // domaine qui existe, à vérifier à la main (vérification du navigateur)
  };
}

// Commerces sans site, moins ceux où la double vérification en a trouvé un.
const visibleRows = (store) => [...store.places.values()].filter((p) => !store.checks.get(p.id)?.url);

// Zone de la carte : « ouest,sud,est,nord ». Absente = tout.
export function bboxFilter(q) {
  if (q == null) return () => true;
  const b = String(q).split(',').map(Number);
  if (b.length !== 4 || !b.every(Number.isFinite)) throw new Error('Zone invalide');
  return (r) => r.lon >= b[0] && r.lon <= b[2] && r.lat >= b[1] && r.lat <= b[3];
}

// Lieux de la zone visible, les plus fiables d'abord (SIRENE, sans score, en dernier), limités pour l'affichage.
export function listPlaces(store, bbox) {
  const rows = visibleRows(store).filter(bboxFilter(bbox)).sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
  return { truncated: rows.length > LIMIT, places: rows.slice(0, LIMIT).map((r) => toPlace(r, store.checks.get(r.id))) };
}

// « other » regroupe les familles inconnues ou absentes.
const familyOf = (f) => (Object.hasOwn(FAMILIES, f ?? '') ? f : 'other');
// shortcut: département déduit du code postal (faux pour de rares communes rattachées au bureau de poste du département voisin).
export function deptOf(postcode) {
  if (!postcode) return null;
  if (/^9[78]/.test(postcode)) return postcode.slice(0, 3);
  if (postcode.startsWith('20')) return postcode < '20200' ? '2A' : '2B';
  return postcode.slice(0, 2);
}
// Overture écrit une même ville de plusieurs façons (« Brive la Gaillarde », « Brive-la-Gaillarde ») : on compare sans tirets, accents ni casse.
const cityKey = (s) => plain(String(s).replaceAll('-', ' '));
const CONTACTS = ['phone', 'email', 'social'];
const filled = (v) => (v ?? '') !== '';

// Ce que contient la mémoire, par département, ville, famille et infos de contact présentes : la fenêtre d'export ne propose que ça.
// Les variantes d'écriture d'une ville sont regroupées sous la plus fréquente.
export function exportGroups(store) {
  const rows = visibleRows(store);
  const spellings = new Map();
  for (const r of rows.filter((x) => x.city != null)) {
    const m = spellings.get(cityKey(r.city)) ?? spellings.set(cityKey(r.city), new Map()).get(cityKey(r.city));
    m.set(r.city, (m.get(r.city) ?? 0) + 1);
  }
  const usual = (c) => (c == null ? null : [...spellings.get(cityKey(c))].sort((a, b) => b[1] - a[1])[0][0]);
  const groups = new Map();
  for (const r of rows) {
    const g = { dept: deptOf(r.postcode), city: usual(r.city), family: familyOf(r.family), ...Object.fromEntries(CONTACTS.map((f) => [f, filled(r[f])])) };
    const k = JSON.stringify(g);
    (groups.get(k) ?? groups.set(k, { ...g, n: 0 }).get(k)).n++;
  }
  return [...groups.values()];
}

// Lignes à exporter, sans limite de nombre : zone, familles masquées, départements (une région = ses départements),
// ville, familles gardées et infos de contact exigées. Triées par code postal, ville, nom.
export function exportRows(store, { bbox, hide = [], depts = [], city, families = [], has = [] } = {}) {
  if (!has.every((f) => CONTACTS.includes(f))) throw new Error('Info de contact inconnue');
  const inBox = bboxFilter(bbox);
  const key = city ? cityKey(city) : null;
  const cmp = (a, b) => (a == null) - (b == null) || (a < b ? -1 : a > b ? 1 : 0);
  return visibleRows(store).filter((r) => inBox(r) && !hide.includes(familyOf(r.family))
    && (!depts.length || depts.includes(deptOf(r.postcode))) && (!families.length || families.includes(familyOf(r.family)))
    && (!key || (r.city != null && cityKey(r.city) === key)) && has.every((f) => filled(r[f])))
    .sort((a, b) => cmp(a.postcode, b.postcode) || cmp(a.city, b.city) || cmp(a.name, b.name));
}

export function toCsv(rows) {
  // Les données sont externes : une cellule qui commence par = + - @ tab ou CR serait exécutée comme formule par Excel.
  // Un téléphone (+33 5…) n'est fait que de chiffres et de séparateurs : on le laisse lisible.
  const cell = (v) => {
    const s = String(v ?? '');
    const risky = /^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+\d\s().-]+$/.test(s));
    return '"' + (risky ? "'" : '') + s.replace(/"/g, '""') + '"';
  };
  const lines = [['Nom', 'Catégorie', 'Famille', 'Adresse', 'Code postal', 'Ville', 'Téléphone', 'Email', 'Réseau social', 'Latitude', 'Longitude', 'Scanné le'],
    ...rows.map((r) => [r.name, toPlace(r).category, FAMILIES[r.family] ?? 'Autre', r.street, r.postcode, r.city, r.phone, r.email, r.social, r.lat, r.lon, String(r.scanned_at ?? '').slice(0, 10)])];
  // BOM + point-virgule : ouverture directe dans Excel en français.
  return '﻿' + lines.map((l) => l.map(cell).join(';')).join('\r\n');
}
