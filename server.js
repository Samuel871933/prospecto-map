const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { DuckDBInstance } = require('@duckdb/node-api');

const CATEGORIES = require('./categories');
const { checkPlace } = require('./check');
const { sireneRows, isKnown } = require('./sirene');

const LIMIT = 1000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'prospects.duckdb');
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0.5);
// Familles Overture (1er niveau de taxonomy.hierarchy). Sert aussi de liste blanche pour le filtre SQL.
const FAMILIES = {
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

// Source : Overture Maps (données ouvertes Meta/Microsoft/Foursquare…), lues directement
// dans leurs fichiers publics. Aucune clé, aucun compte.
// Base locale : chaque scan y est enregistré, la carte et les exports ne lisent que là.
// Connexion de lecture à part : un scan en cours ne bloque pas l'affichage.
let store;
function getStore() {
  return (store ??= (async () => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const instance = await DuckDBInstance.create(DB_PATH);
    const read = await instance.connect();
    await read.run(`CREATE TABLE IF NOT EXISTS places (id VARCHAR PRIMARY KEY, name VARCHAR, category VARCHAR, family VARCHAR,
      confidence DOUBLE, phone VARCHAR, email VARCHAR, social VARCHAR, street VARCHAR, postcode VARCHAR, city VARCHAR,
      lat DOUBLE, lon DOUBLE, scanned_at TIMESTAMP)`);
    // Table à part : un nouveau scan remplace la ligne du commerce (INSERT OR REPLACE) sans effacer sa vérification.
    await read.run('CREATE TABLE IF NOT EXISTS site_checks (id VARCHAR PRIMARY KEY, url VARCHAR, source VARCHAR, partial BOOLEAN, checked_at TIMESTAMP)');
    return { instance, read };
  })().catch((e) => {
    store = null;
    throw e;
  }));
}

let ready;
function getDb() {
  return (ready ??= (async () => {
    const { instance } = await getStore();
    const db = await instance.connect();
    await db.run("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';");
    return db;
  })().catch((e) => {
    ready = null; // on retentera au prochain scan
    throw e;
  }));
}

// Overture publie une version par mois et retire les anciennes : un serveur resté allumé relit le catalogue chaque jour.
let releaseCache = { name: null, at: 0 };
async function currentRelease() {
  if (Date.now() - releaseCache.at < 24 * 3600e3) return releaseCache.name;
  try {
    const res = await fetch('https://stac.overturemaps.org/catalog.json', { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Catalogue Overture indisponible (${res.status})`);
    releaseCache = { name: latestRelease(await res.json()), at: Date.now() };
  } catch (e) {
    if (!releaseCache.name) throw e; // catalogue en panne : la version d'hier reste bonne
  }
  return releaseCache.name;
}

// Un scan à la fois : ils partagent la connexion d'écriture (donc sa transaction) et la bande passante vers Overture.
let scanQueue = Promise.resolve();
function oneAtATime(fn) {
  const run = scanQueue.then(fn);
  scanQueue = run.catch(() => {});
  return run;
}

function latestRelease(catalog) {
  const releases = catalog.links.map((l) => l.href.match(/\/(\d{4}-\d\d-\d\d\.\d+)\//)?.[1]).filter(Boolean).sort();
  if (!releases.length) throw Object.assign(new Error('Aucune version Overture trouvée'), { expected: true });
  return releases.pop();
}

function parseScan(body) {
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
  if (!res.ok) throw Object.assign(new Error(`Contour de commune indisponible (${res.status})`), { expected: true });
  const { type, coordinates } = (await res.json()).geometry ?? {};
  // La géométrie finit dans le SQL : on n'en garde que le type attendu et des nombres.
  if (!['Polygon', 'MultiPolygon'].includes(type) || !coordinates.flat(Infinity).every(Number.isFinite)) throw Object.assign(new Error('Contour de commune illisible'), { expected: true });
  return { type, coordinates };
}

function areaFilter({ lat, lon, radius, geometry, street, citycode }) {
  if (!geometry) {
    const dLat = radius / 111320;
    const dLon = dLat / Math.cos((lat * Math.PI) / 180);
    return `bbox.xmin BETWEEN ${lon - dLon} AND ${lon + dLon}
  AND bbox.ymin BETWEEN ${lat - dLat} AND ${lat + dLat}
  AND pow((bbox.ymin - ${lat}) * 111320, 2) + pow((bbox.xmin - ${lon}) * 111320 * cos(radians(${lat})), 2) <= ${radius * radius}`;
  }
  const flat = geometry.coordinates.flat(Infinity);
  const xs = flat.filter((_, i) => i % 2 === 0);
  const ys = flat.filter((_, i) => i % 2 === 1);
  return `bbox.xmin BETWEEN ${Math.min(...xs)} AND ${Math.max(...xs)}
  AND bbox.ymin BETWEEN ${Math.min(...ys)} AND ${Math.max(...ys)}
  AND ST_Contains(ST_GeomFromGeoJSON('${JSON.stringify(geometry)}'), ST_Point(bbox.xmin, bbox.ymin))
  -- Certaines fiches sont posées au centre d'une commune homonyme ou au hasard (ex. une adresse à Juzes 31 placée à Génissac 33) : l'adresse doit être du même département.
  -- shortcut: faux pour de rares communes rattachées au bureau de poste du département voisin.
  AND (addresses[1].postcode IS NULL OR left(addresses[1].postcode, 2) = '${citycode.slice(0, 2).replace(/2[AB]/, '20')}')${
    street ? `\n  AND addresses[1].freeform ILIKE '%${street.replaceAll("'", "''")}%'` : ''}`;
}

// Tout ce qui est interpolé est validé par parseScan ou communeGeometry.
// Tous les lieux nommés de la zone, avec ou sans site : prospect dit lesquels garder, les autres servent à dédoublonner SIRENE.
function placesQuery(release, scan) {
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
FROM read_parquet('s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*')
WHERE ${areaFilter(scan)}
  AND names.primary IS NOT NULL
  ${families.length ? `AND taxonomy.hierarchy[1] IN (${families.map((f) => `'${f}'`).join(', ')})` : ''}`;
}

// Fiches Overture déjà en base que ce scan contredit : elles ont gagné un site (ou ne sont plus fiables),
// ou, sur une commune entière, elles ont disparu d'Overture ou n'y sont plus localisées.
// Les fiches SIRENE ne sont pas touchées : leur source est interrogée à part.
function pruneSql(tmp, scan) {
  const gone = scan.zone === 'city'
    ? ` OR (id NOT IN (SELECT id FROM ${tmp}) AND id NOT LIKE 'sirene:%'
    AND ST_Contains(ST_GeomFromGeoJSON('${JSON.stringify(scan.geometry)}'), ST_Point(lon, lat))${
      scan.families?.length ? ` AND family IN (${sqlList(scan.families)})` : ''})`
    : '';
  return `DELETE FROM places WHERE id IN (SELECT id FROM ${tmp} WHERE NOT prospect)${gone}`;
}

// Zone visible de la carte : « ouest,sud,est,nord ». Absente = toute la base.
function bboxFilter(q) {
  if (q == null) return 'TRUE';
  const b = String(q).split(',').map(Number);
  if (b.length !== 4 || !b.every(Number.isFinite)) throw new Error('Zone invalide');
  return `lon BETWEEN ${b[0]} AND ${b[2]} AND lat BETWEEN ${b[1]} AND ${b[3]}`;
}

const sqlList = (a) => a.map((f) => `'${f}'`).join(', ');
// « other » regroupe les familles inconnues ou absentes.
const FAMILY_SQL = `CASE WHEN family IN (${sqlList(Object.getOwnPropertyNames(FAMILIES))}) THEN family ELSE 'other' END`;
// shortcut: département déduit du code postal (faux pour de rares communes rattachées au bureau de poste du département voisin). Enregistrer le code INSEE au scan si ça gêne.
const DEPT_SQL = `CASE WHEN postcode LIKE '97%' OR postcode LIKE '98%' THEN left(postcode, 3)
  WHEN postcode LIKE '20%' THEN CASE WHEN postcode < '20200' THEN '2A' ELSE '2B' END ELSE left(postcode, 2) END`;

function familyList(q) {
  const list = q ? String(q).split(',') : [];
  if (!list.every((f) => f === 'other' || Object.hasOwn(FAMILIES, f))) throw new Error('Type de commerce inconnu');
  return list;
}

// Familles masquées par les pastilles.
function hideFilter(q) {
  const hide = familyList(q);
  return hide.length ? `AND ${FAMILY_SQL} NOT IN (${sqlList(hide)})` : '';
}

// Overture écrit une même ville de plusieurs façons (« Brive la Gaillarde », « Brive-la-Gaillarde ») : on compare sans tirets, accents ni casse.
const cityKey = (x) => `lower(strip_accents(replace(${x}, '-', ' ')))`;

// Infos de contact exigées (« avec téléphone »…) : liste fermée, jamais de texte libre dans le SQL.
const CONTACTS = ['phone', 'email', 'social'];
const HAS_SQL = (f) => `coalesce(${f}, '') <> ''`;

// Filtres de la fenêtre d'export : départements (une région = la liste de ses départements), ville, familles gardées.
// La ville est un texte libre : elle passe en paramètre, jamais dans le SQL.
function exportFilter(q) {
  const depts = q.depts ? String(q.depts).split(',') : [];
  if (!depts.every((d) => /^(\d{2,3}|2[AB])$/.test(d))) throw new Error('Département inconnu');
  const families = familyList(q.families);
  const has = q.has ? String(q.has).split(',') : [];
  if (!has.every((f) => CONTACTS.includes(f))) throw new Error('Info de contact inconnue');
  const values = q.city ? [String(q.city)] : [];
  const where = (depts.length ? ` AND ${DEPT_SQL} IN (${sqlList(depts)})` : '')
    + (families.length ? ` AND ${FAMILY_SQL} IN (${sqlList(families)})` : '')
    + (values.length ? ` AND ${cityKey('city')} = ${cityKey('$1')}` : '')
    + has.map((f) => ` AND ${HAS_SQL(f)}`).join('');
  return { where, values };
}

function toCsv(rows) {
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
  return '\ufeff' + lines.map((l) => l.map(cell).join(';')).join('\r\n');
}

function toPlace(r) {
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
    checked: r.checked ? String(r.checked).slice(0, 10) : null,
    partial: r.partial ?? null,
  };
}

// Commerces sans site, moins ceux où la double vérification en a trouvé un. checked = date de vérification si elle a eu lieu.
const PLACES = `(SELECT p.*, c.checked_at AS checked, c.partial FROM places p LEFT JOIN site_checks c USING (id) WHERE c.url IS NULL)`;

const app = express();
// Sans login : on refuse les requêtes dont l'hôte n'est pas local (une page web qui ferait pointer son domaine vers 127.0.0.1),
// et celles envoyées par une autre page web ouverte dans le navigateur (formulaire caché vers localhost).
const LOCAL = ['localhost', '127.0.0.1'];
const localOrigin = (o) => { try { return LOCAL.includes(new URL(o).hostname); } catch { return false; } };
app.use((req, res, next) => (LOCAL.includes(req.hostname) && (!req.get('origin') || localOrigin(req.get('origin'))) ? next() : res.status(403).end()));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/families', (req, res) => res.json(FAMILIES));

app.post('/api/scan', async (req, res) => {
  let scan;
  try {
    scan = parseScan(req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  // SIRENE ne dépend pas d'Overture : on l'interroge pendant la lecture des fichiers Overture.
  const sireneP = sireneRows(scan).catch((e) => ({ error: e }));
  try {
    res.json(await oneAtATime(() => runScan(scan, sireneP)));
  } catch (e) {
    console.error(e);
    // Nos propres contrôles (contour, version) disent ce qui ne va pas ; le reste est une panne de source.
    res.status(502).json({ error: e.expected ? e.message : 'La source de données ne répond pas, réessaie dans une minute.' });
  }
});

async function runScan(scan, sireneP) {
  const [db, release] = await Promise.all([getDb(), currentRelease()]);
  if (scan.zone) scan.geometry = await communeGeometry(scan.citycode);
  // Table temporaire propre au scan : les fichiers Overture ne sont lus qu'une fois pour l'insertion et le dédoublonnage.
  const tmp = 'scan_' + crypto.randomUUID().replaceAll('-', '');
  await db.run(`CREATE TEMP TABLE ${tmp} AS ${placesQuery(release, scan)}`);
  let count, known;
  try {
    await db.run(pruneSql(tmp, scan));
    // Un commerce déjà en base est mis à jour, pas dupliqué.
    count = Number((await db.runAndReadAll(`SELECT count(*) FROM ${tmp} WHERE prospect`)).getRowsJson()[0][0]);
    await db.run(`INSERT OR REPLACE INTO places SELECT * EXCLUDE (prospect), now()::TIMESTAMP FROM ${tmp} WHERE prospect ORDER BY confidence DESC LIMIT ${LIMIT}`);
    known = (await db.runAndReadAll(`SELECT name, lat, lon FROM ${tmp}`)).getRowObjectsJson();
  } finally {
    await db.run(`DROP TABLE IF EXISTS ${tmp}`);
  }
  // SIRENE en complément : une panne n'annule pas le scan Overture, elle est signalée.
  let sirene = { count: 0, truncated: false, error: null };
  try {
    const { rows, truncated, error } = await sireneP;
    if (error) throw error;
    const fresh = rows.filter((r) => !isKnown(r, known));
    // Une seule transaction : un commit par ligne coûte une écriture disque chacun.
    await db.run('BEGIN');
    try {
      for (const r of fresh) {
        await db.run('INSERT OR REPLACE INTO places VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL, $5, $6, $7, $8, $9, now()::TIMESTAMP)',
          [r.id, r.name, r.category, r.family, r.street, r.postcode, r.city, r.lat, r.lon]);
      }
      await db.run('COMMIT');
    } catch (e) {
      await db.run('ROLLBACK');
      throw e;
    }
    sirene = { count: fresh.length, truncated, error: null };
  } catch (e) {
    console.error('SIRENE :', e.message);
    sirene.error = 'Registre SIRENE indisponible, seules les données Overture ont été ajoutées.';
  }
  return { release, area: scan.geometry, truncated: count > LIMIT, count: Math.min(count, LIMIT), sirene };
}

// Lecture de la base, limitée à la zone visible pour ne jamais tout charger d'un coup.
app.get('/api/places', async (req, res) => {
  let where;
  try {
    where = bboxFilter(req.query.bbox);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const { read } = await getStore();
  const rows = (await read.runAndReadAll(`SELECT * FROM ${PLACES} WHERE ${where} ORDER BY confidence DESC LIMIT ${LIMIT + 1}`)).getRowObjectsJson();
  res.json({ truncated: rows.length > LIMIT, places: rows.slice(0, LIMIT).map(toPlace) });
});

// Double vérification d'un commerce (sources gratuites, voir check.js). Un site trouvé le retire de la carte et des exports.
app.post('/api/check/:id', async (req, res) => {
  const { read } = await getStore();
  const [row] = (await read.runAndReadAll('SELECT * FROM places WHERE id = $1', [String(req.params.id)])).getRowObjectsJson();
  if (!row) return res.status(404).json({ error: 'Commerce introuvable' });
  const result = await checkPlace(row);
  await read.run('INSERT OR REPLACE INTO site_checks VALUES ($1, $2, $3, $4, now()::TIMESTAMP)', [row.id, result.url, result.source, result.partial]);
  res.json(result);
});

// Ce que contient la base, par département, ville, famille et infos de contact présentes : la fenêtre d'export ne propose que ça.
// Les variantes d'écriture d'une ville sont regroupées sous la plus fréquente.
app.get('/api/export/groups', async (req, res) => {
  const { read } = await getStore();
  res.json((await read.runAndReadAll(`SELECT dept, city, family, ${CONTACTS.join(', ')}, count(*)::INTEGER AS n FROM (
    SELECT ${DEPT_SQL} AS dept, mode(city) OVER (PARTITION BY ${cityKey('city')}) AS city, ${FAMILY_SQL} AS family,
      ${CONTACTS.map((f) => `${HAS_SQL(f)} AS ${f}`).join(', ')} FROM ${PLACES}) GROUP BY ALL`)).getRowObjectsJson());
});

// Export sans limite de nombre : toute la base, ou la zone, les départements, la ville et les familles demandés.
app.get('/api/export.csv', async (req, res) => {
  let where, values;
  try {
    const filter = exportFilter(req.query);
    where = `${bboxFilter(req.query.bbox)} ${hideFilter(req.query.hide)}${filter.where}`;
    values = filter.values;
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const { read } = await getStore();
  const rows = (await read.runAndReadAll(`SELECT * FROM ${PLACES} WHERE ${where} ORDER BY postcode, city, name`, values)).getRowObjectsJson();
  res.attachment('prospects.csv').type('text/csv').send(toCsv(rows));
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  // shortcut: pas d'authentification, donc écoute en local seulement. Ajouter un login avant d'exposer sur le réseau.
  app.listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}`));
  Promise.all([getDb(), currentRelease()]).catch((e) => console.error('Préchargement Overture raté :', e.message));
}

module.exports = { FAMILIES, parseScan, placesQuery, pruneSql, toPlace, latestRelease, bboxFilter, hideFilter, exportFilter, toCsv };
