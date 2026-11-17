import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promises as dns } from 'node:dns';
import { parseScan, placesQuery, toPlace, latestRelease, bboxFilter, toCsv, newStore, mergeOverture, exportRows, exportGroups, inArea, pickFiles } from './docs/lib/prospecto.js';
import { ownDomain, guessDomains, pageMatches, isPrivate, checkPlace } from './check.js';
import { toRows, isKnown, codesFor } from './docs/lib/sirene.js';
import { safeCsvPath } from './mcp.js';

const FILE = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-10-21.0/theme=places/type=place/part-0.parquet';

test('parseScan valide et borne', () => {
  assert.deepStrictEqual(parseScan({ lat: '48.85', lon: 2.35, radius: 500.4 }), { lat: 48.85, lon: 2.35, radius: 500, families: [] });
  assert.deepStrictEqual(parseScan({ lat: 48.85, lon: 2.35, radius: 500, families: ['shopping'] }).families, ['shopping']);
  assert.throws(() => parseScan({ lat: 48.85, lon: 2.35, radius: 500, families: ["x') OR 1=1 --"] }));
  assert.throws(() => parseScan({ lat: 48.85, lon: 2.35, radius: 500, families: 'shopping' }));
  assert.throws(() => parseScan({ lat: 48.85, lon: 2.35, radius: 500, families: ['toString'] }));
  assert.throws(() => parseScan({ lat: 48.85, lon: 2.35, radius: 50000 }));
  assert.throws(() => parseScan({ lat: 0, lon: 0, radius: 500 }));
  assert.throws(() => parseScan({ lat: '48;drop', lon: 2.35, radius: 500 }));
  assert.throws(() => parseScan(undefined));
  assert.deepStrictEqual(parseScan({ zone: 'city', citycode: '33238' }), { zone: 'city', citycode: '33238', families: [] });
  assert.strictEqual(parseScan({ zone: 'street', citycode: '2A004', street: "Rue de l'Église" }).street, "Rue de l'Église");
  assert.throws(() => parseScan({ zone: 'city', citycode: "33238' OR 1=1" }));
  assert.throws(() => parseScan({ zone: 'street', citycode: '33238', street: "x%'); DROP" }));
  assert.throws(() => parseScan({ zone: 'street', citycode: '33238' }));
});

test('placesQuery cible les fichiers, le cercle et les sans-site', () => {
  const q = placesQuery([FILE], { lat: 48.85, lon: 2.35, radius: 500 });
  assert.ok(q.includes(`read_parquet(['${FILE}'])`));
  assert.match(q, /websites IS NULL/);
  assert.match(q, /brand\.names\.primary IS NULL/);
  assert.doesNotMatch(q, /brand IS NULL/);
  assert.match(q, /<= 250000/);
  assert.doesNotMatch(q, /hierarchy\[1\] IN/);
  assert.match(placesQuery([FILE], { lat: 48.85, lon: 2.35, radius: 500, families: ['shopping', 'lodging'] }), /hierarchy\[1\] IN \('shopping', 'lodging'\)/);
  const geometry = { type: 'Polygon', coordinates: [[[2, 48], [3, 48], [3, 49], [2, 48]]] };
  const area = placesQuery([FILE], { geometry, citycode: '33185', street: "Rue de l'Église" });
  assert.match(area, /left\(addresses\[1\]\.postcode, 2\) = '33'/);
  assert.match(placesQuery([FILE], { geometry, citycode: '2A004' }), /postcode, 2\) = '20'/);
  assert.match(area, /bbox\.xmin BETWEEN 2 AND 3\n\s+AND bbox\.ymin BETWEEN 48 AND 49/);
  assert.doesNotMatch(area, /ST_Contains/);
  assert.match(area, /ILIKE '%Rue de l''Église%'/);
  assert.doesNotMatch(placesQuery([FILE], { geometry, citycode: '33185' }), /ILIKE/);
});

test('latestRelease prend la plus récente', () => {
  const links = ['2026-09-23.1', '2026-10-21.0', '2026-09-23.0'].map((r) => ({ rel: 'child', href: `https://x/${r}/catalog.json` }));
  assert.strictEqual(latestRelease({ links: [{ rel: 'self', href: 'https://x/catalog.json' }, ...links] }), '2026-10-21.0');
  assert.throws(() => latestRelease({ links: [] }));
});

test('toPlace assemble adresse et catégorie', () => {
  const p = toPlace({ id: 'a', name: 'A', category: 'coffee_shop', family: 'food_and_drink', confidence: 0.9, street: '1 rue X', postcode: null, city: 'Y', phone: null, email: null, social: null, lat: 1, lon: 2 });
  assert.strictEqual(p.address, '1 rue X Y');
  assert.strictEqual(p.category, 'Café');
  assert.strictEqual(p.family, 'food_and_drink');
  assert.strictEqual(toPlace({ category: 'shopping' }).category, 'Boutiques');
  assert.strictEqual(toPlace({ category: 'new_thing' }).category, 'new thing');
});

test('bboxFilter valide son entrée et filtre par zone', () => {
  const inBox = bboxFilter('-1,44,0,45');
  assert.ok(inBox({ lon: -0.5, lat: 44.5 }));
  assert.ok(!inBox({ lon: 0.5, lat: 44.5 }) && !inBox({ lon: -0.5, lat: 45.5 }));
  assert.ok(bboxFilter(undefined)({ lon: 99, lat: 99 }));
  assert.throws(() => bboxFilter('1,2,3'));
  assert.throws(() => bboxFilter('1,2,3,4 OR 1=1'));
});

test('toCsv traduit, échappe et neutralise les formules', () => {
  const csv = toCsv([{ name: '=HYPERLINK("x")', category: 'coffee_shop', family: 'food_and_drink', street: '1 rue X', postcode: '33850', city: 'Y', scanned_at: '2026-11-16 17:00:00' }]);
  assert.match(csv, /"'=HYPERLINK\(""x""\)";"Café";"Restauration";"1 rue X";"33850";"Y"/);
  assert.match(csv, /"2026-11-16"$/);
  const cells = toCsv([{ name: "-2+3+cmd|' /C calc'!A0", street: '+cmd', phone: '+33 5 55 12 34 56' }]);
  assert.match(cells, /"'-2\+3\+cmd/);
  assert.match(cells, /"'\+cmd"/);
  assert.match(cells, /"\+33 5 55 12 34 56"/);
});

const place = (id, o) => ({ id, name: id, family: 'shopping', confidence: 0.9, lat: 48.5, lon: 2.5, ...o });
const storeOf = (...ps) => ({ ...newStore(), places: new Map(ps.map((p) => [p.id, p])) });

test('exportGroups et exportRows : département, ville, contacts, vérifié', () => {
  const store = storeOf(
    place('a', { postcode: '20100', city: 'Brive-la-Gaillarde', phone: '0555' }),
    place('b', { postcode: '97400', city: 'Brive-la-Gaillarde' }),
    place('c', { postcode: '19100', city: 'Brive la Gaillarde', email: 'x@y.fr' }),
    place('d', { postcode: '20200', city: 'Ajaccio' }),
    place('e', { postcode: '33000', city: 'Bordeaux' }));
  store.checks.set('e', { url: 'https://e.fr', checked_at: '2026-11-16T10:00:00Z' });
  const ids = (o) => exportRows(store, o).map((r) => r.id);
  assert.deepStrictEqual(ids({ depts: ['2A'] }), ['a']);
  assert.deepStrictEqual(ids({ depts: ['2B'] }), ['d']);
  assert.deepStrictEqual(ids({ depts: ['974'] }), ['b']);
  // « Brive-la-Gaillarde » (2 fiches) l'emporte sur « Brive la Gaillarde » (1) ; le filtre ville ignore tirets et casse.
  assert.deepStrictEqual(exportGroups(store).map((g) => g.city).filter((c) => c?.startsWith('Brive')), ['Brive-la-Gaillarde', 'Brive-la-Gaillarde', 'Brive-la-Gaillarde']);
  assert.deepStrictEqual(ids({ city: 'brive la gaillarde' }), ['c', 'a', 'b']);
  assert.deepStrictEqual(ids({ has: ['phone'] }), ['a']);
  assert.deepStrictEqual(ids({ has: ['phone', 'email'] }), []);
  assert.ok(!ids({}).includes('e'));
  assert.strictEqual(ids({}).length, 4);
  assert.throws(() => exportRows(store, { has: ['toString'] }));
});

test('inArea : dedans, dehors, trou, MultiPolygon', () => {
  const sq = (a, b) => [[a, a], [b, a], [b, b], [a, b], [a, a]];
  const holed = { type: 'Polygon', coordinates: [sq(0, 10), sq(4, 6)] };
  assert.ok(inArea(holed, 2, 2));
  assert.ok(!inArea(holed, 5, 5));
  assert.ok(!inArea(holed, 20, 2));
  const multi = { type: 'MultiPolygon', coordinates: [[sq(0, 1)], [sq(10, 11)]] };
  assert.ok(inArea(multi, 10.5, 10.5) && inArea(multi, 0.5, 0.5));
  assert.ok(!inArea(multi, 5, 5));
});

test('pickFiles garde les fichiers qui touchent la zone et refuse une URL inattendue', () => {
  const item = (bbox, href = FILE) => ({ bbox, assets: { aws: { href } } });
  const items = [item([0, 40, 5, 50]), item([10, 40, 15, 50], FILE.replace('part-0', 'part-1'))];
  assert.deepStrictEqual(pickFiles(items, [1, 45, 2, 46]), [FILE]);
  assert.deepStrictEqual(pickFiles(items, [20, 45, 21, 46]), []);
  assert.throws(() => pickFiles([item([0, 40, 5, 50], 'https://evil.test/x.parquet')], [1, 45, 2, 46]), /inattendu/);
});

test('double vérification : domaines et contenu de page', () => {
  assert.strictEqual(ownDomain('contact@Boulangerie-Dupont.fr'), 'boulangerie-dupont.fr');
  assert.strictEqual(ownDomain('terredeslilas@gmail.com'), null);
  assert.strictEqual(ownDomain('x@localhost'), null);
  assert.deepStrictEqual(guessDomains('Le Coin Pizza'), ['lecoinpizza.fr', 'lecoinpizza.com', 'le-coin-pizza.fr', 'le-coin-pizza.com', 'coinpizza.fr', 'coinpizza.com']);
  assert.deepStrictEqual(guessDomains("Fromagerie From' Ange").slice(0, 2), ['fromageriefromange.fr', 'fromageriefromange.com']);
  const lilas = { name: 'Terre des Lilas', phone: '+33 6 12 34 56 78' };
  assert.ok(pageMatches('<h1>Terre des Lilas</h1>', 'terredeslilas.fr', lilas));
  assert.ok(pageMatches('<p>Appelez le 06 12 34 56 78</p>', 'x.fr', lilas));
  assert.ok(!pageMatches('<title>terredeslilas.fr</title>', 'terredeslilas.fr', lilas));
  assert.ok(!pageMatches('<h1>Terre des Lilas</h1> This domain is for sale', 'x.fr', lilas));
  assert.ok(isPrivate('127.0.0.1') && isPrivate('192.168.1.2') && isPrivate('::1') && !isPrivate('23.236.62.147'));
  assert.ok(isPrivate('::ffff:172.17.0.1') && isPrivate('100.64.0.1') && !isPrivate('::ffff:23.236.62.147') && !isPrivate('100.128.0.1'));
});

test('SIRENE : filtre légal, chaînes, zone et nom affiché', () => {
  const etab = (o) => ({ activite_principale: '10.71C', etat_administratif: 'A', statut_diffusion_etablissement: 'O', latitude: '44.6805', longitude: '-0.5299',
    commune: '33213', siret: '1', adresse: '10 AVENUE DU CHATEAU 33650 LA BREDE', code_postal: '33650', libelle_commune: 'LA BREDE', liste_enseignes: ['BOULANGERIE DU CHATEAU'], ...o });
  const ent = (o, e = [etab()]) => ({ nom_complet: 'CROUSTI', nom_raison_sociale: "CROUSTI'BREDOISE", statut_diffusion: 'O', nombre_etablissements_ouverts: 1, matching_etablissements: e, ...o });
  const city = { citycode: '33213', families: [] };
  const [row] = toRows([ent()], city);
  assert.deepStrictEqual([row.id, row.name, row.street, row.city, row.category, row.family], ['sirene:1', 'Boulangerie Du Chateau', '10 Avenue Du Chateau', 'La Brede', 'Boulangerie', 'food_and_drink']);
  assert.strictEqual(toRows([ent({}, [etab({ liste_enseignes: null })])], city)[0].name, "Crousti'Bredoise");
  assert.strictEqual(toRows([ent({ opposition_diffusion_commerciale: true })], city).length, 0);
  assert.strictEqual(toRows([ent({ nombre_etablissements_ouverts: 22 })], city).length, 0);
  assert.strictEqual(toRows([ent({ statut_diffusion: 'P' })], city).length, 0);
  assert.strictEqual(toRows([ent({}, [etab({ etat_administratif: 'F' })])], city).length, 0);
  assert.strictEqual(toRows([ent({}, [etab({ activite_principale: '70.10Z' })])], city).length, 0);
  assert.strictEqual(toRows([ent({}, [etab({ commune: '33238' })])], city).length, 0);
  assert.strictEqual(toRows([ent()], { ...city, families: ['shopping'] }).length, 0);
  assert.strictEqual(toRows([ent()], { lat: 44.6805, lon: -0.5299, radius: 100 }).length, 1);
  assert.strictEqual(toRows([ent()], { lat: 44.70, lon: -0.5299, radius: 100 }).length, 0);
  assert.strictEqual(toRows([ent()], { ...city, street: 'Avenue du Château' }).length, 1);
  assert.strictEqual(toRows([ent()], { ...city, street: 'Rue Montesquieu' }).length, 0);
  assert.ok(codesFor(['lodging']).every((c) => c.startsWith('55.')));
});

test('SIRENE : dédoublonnage par nom, ou mot commun tout près', () => {
  const row = { name: 'Farine & Chocolat', city: 'La Brede', lat: 44.68, lon: -0.528 };
  assert.ok(isKnown(row, [{ name: 'Farine et Chocolat Boulangerie', lat: 0, lon: 0 }]));
  assert.ok(isKnown(row, [{ name: 'FARINE & CHOCOLAT', lat: 0, lon: 0 }]));
  // Même adresse, autre commerce : cas réel (la boulangerie fusionnait avec l'agence Allianz voisine).
  assert.ok(!isKnown({ name: 'Boulangerie Du Chateau', city: 'La Brede', lat: 44.68052, lon: -0.52991 }, [{ name: 'Allianz', lat: 44.68051, lon: -0.53002 }]));
  const vet = { name: 'Docteur C.salaun Chirurgien Dentist', city: 'La Brede', lat: 44.68, lon: -0.528 };
  assert.ok(isKnown(vet, [{ name: 'Dentistes - Drs Cécile Salaun & Diem Ha Nguyen', lat: 44.68015, lon: -0.528 }]));
  assert.ok(!isKnown(vet, [{ name: 'Dentistes - Drs Cécile Salaun & Diem Ha Nguyen', lat: 44.69, lon: -0.528 }]));
  assert.ok(isKnown({ name: 'Bernardi Automobile', city: 'La Brede', lat: 44.68, lon: -0.528 }, [{ name: 'D.B. AUTOMOBILES', lat: 44.6801, lon: -0.528 }]));
  // Le lieu « La Brède » n'avale pas les entreprises qui ont la commune dans leur nom.
  assert.ok(!isKnown({ name: 'La Bri Bricojem Labrede', city: 'La Brede', lat: 44.68, lon: -0.528 }, [{ name: 'La Brède', lat: 44.68, lon: -0.528 }]));
});

test('MCP : un export ne peut écrire qu\'un nouveau .csv', () => {
  assert.throws(() => safeCsvPath('/tmp/x/.bashrc'), /\.csv/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospecto-'));
  const file = path.join(dir, 'prospects.csv');
  assert.equal(safeCsvPath(file), file);
  fs.writeFileSync(file, '');
  assert.throws(() => safeCsvPath(file), /existe déjà/);
});

test('double vérification : une redirection vers le réseau local est refusée', async () => {
  const { lookup } = dns;
  const realFetch = global.fetch;
  const seen = [];
  dns.lookup = async (host) => [{ address: host === 'interne.test' ? '192.168.1.1' : '93.184.216.34' }];
  // Faux fetch qui, comme le vrai, suit seul les redirections sauf en mode manual.
  global.fetch = async function fake(url, init = {}) {
    seen.push(url);
    const to = url.includes('commerce.fr') ? 'http://interne.test/admin' : url.includes('autre.fr') ? 'http://127.0.0.1/' : null;
    if (!to) return new Response('ok', { status: 200 });
    return init.redirect === 'manual' ? new Response(null, { status: 302, headers: { location: to } }) : fake(to, init);
  };
  try {
    // L'email mène à commerce.fr puis autre.fr (via le http:// de repli) : aucune page interne n'est jamais demandée.
    await checkPlace({ name: 'Xy', email: 'a@commerce.fr', lat: 0, lon: 0 });
    await checkPlace({ name: 'Xy', email: 'a@autre.fr', lat: 0, lon: 0 });
    assert.ok(seen.some((u) => u.includes('commerce.fr')));
    assert.ok(!seen.some((u) => /interne\.test|127\.0\.0\.1/.test(u)), seen.join(' '));
  } finally {
    dns.lookup = lookup;
    global.fetch = realFetch;
  }
});

test('un rescan retire les fiches qui ont un site ou ont quitté la commune', () => {
  const store = storeOf(...[['a', 'shopping', 48.5], ['gagne_un_site', 'shopping', 48.5], ['disparu', 'shopping', 48.5], ['autre_famille', 'lodging', 48.5],
    ['ailleurs', 'shopping', 40], ['sirene:1', 'shopping', 48.5]].map(([id, family, lat]) => place(id, { family, lat, lon: lat === 40 ? 0 : 2.5 })));
  const geometry = { type: 'Polygon', coordinates: [[[2, 48], [3, 48], [3, 49], [2, 49], [2, 48]]] };
  const row = (id, prospect) => place(id, { prospect });
  mergeOverture(store, [row('a', true), row('gagne_un_site', false)], { lat: 48.5, lon: 2.5, radius: 500, families: [] });
  assert.deepStrictEqual([...store.places.keys()].sort(), ['a', 'ailleurs', 'autre_famille', 'disparu', 'sirene:1']);
  mergeOverture(store, [row('a', true)], { zone: 'city', citycode: '75056', geometry, families: ['shopping'] });
  assert.deepStrictEqual([...store.places.keys()].sort(), ['a', 'ailleurs', 'autre_famille', 'sirene:1']);
});
