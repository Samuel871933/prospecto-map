const test = require('node:test');
const assert = require('node:assert');
const { DuckDBInstance } = require('@duckdb/node-api');
const { parseScan, placesQuery, pruneSql, toPlace, latestRelease, bboxFilter, hideFilter, exportFilter, toCsv } = require('./server');

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

test('placesQuery cible la version, le cercle et les sans-site', () => {
  const q = placesQuery('2026-10-21.0', { lat: 48.85, lon: 2.35, radius: 500 });
  assert.match(q, /release\/2026-10-21\.0\/theme=places/);
  assert.match(q, /websites IS NULL/);
  assert.match(q, /brand\.names\.primary IS NULL/);
  assert.doesNotMatch(q, /brand IS NULL/);
  assert.match(q, /<= 250000/);
  assert.doesNotMatch(q, /hierarchy\[1\] IN/);
  assert.match(placesQuery('r', { lat: 48.85, lon: 2.35, radius: 500, families: ['shopping', 'lodging'] }), /hierarchy\[1\] IN \('shopping', 'lodging'\)/);
  const geometry = { type: 'Polygon', coordinates: [[[2, 48], [3, 48], [3, 49], [2, 48]]] };
  const area = placesQuery('r', { geometry, citycode: '33185', street: "Rue de l'Église" });
  assert.match(area, /left\(addresses\[1\]\.postcode, 2\) = '33'/);
  assert.match(placesQuery('r', { geometry, citycode: '2A004' }), /postcode, 2\) = '20'/);
  assert.match(area, /bbox\.xmin BETWEEN 2 AND 3\n\s+AND bbox\.ymin BETWEEN 48 AND 49/);
  assert.match(area, /ST_Contains\(ST_GeomFromGeoJSON\('\{"type":"Polygon"/);
  assert.match(area, /ILIKE '%Rue de l''Église%'/);
  assert.doesNotMatch(placesQuery('r', { geometry, citycode: '33185' }), /ILIKE/);
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

test('bboxFilter et hideFilter valident leurs entrées', () => {
  assert.strictEqual(bboxFilter('-1,44,0,45'), 'lon BETWEEN -1 AND 0 AND lat BETWEEN 44 AND 45');
  assert.strictEqual(bboxFilter(undefined), 'TRUE');
  assert.throws(() => bboxFilter('1,2,3'));
  assert.throws(() => bboxFilter('1,2,3,4 OR 1=1'));
  assert.strictEqual(hideFilter(undefined), '');
  assert.match(hideFilter('shopping,other'), /NOT IN \('shopping', 'other'\)/);
  assert.throws(() => hideFilter("x') OR 1=1 --"));
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

test('exportFilter valide départements et familles, la ville passe en paramètre', () => {
  assert.deepStrictEqual(exportFilter({}), { where: '', values: [] });
  const f = exportFilter({ depts: '33,2A,974', families: 'shopping,other', city: "L'Île' OR 1=1" });
  assert.match(f.where, /IN \('33', '2A', '974'\)/);
  assert.match(f.where, /IN \('shopping', 'other'\)/);
  assert.match(f.where, /= lower\(strip_accents\(replace\(\$1, '-', ' '\)\)\)$/);
  assert.deepStrictEqual(f.values, ["L'Île' OR 1=1"]);
  assert.throws(() => exportFilter({ depts: "33') OR 1=1 --" }));
  assert.throws(() => exportFilter({ families: 'toString' }));
  assert.match(exportFilter({ has: 'phone,email' }).where, /coalesce\(phone, ''\) <> '' AND coalesce\(email, ''\) <> ''/);
  assert.throws(() => exportFilter({ has: "phone') OR 1=1 --" }));
});

const { ownDomain, guessDomains, pageMatches, isPrivate } = require('./check');
test('double vérification : domaines et contenu de page', () => {
  assert.strictEqual(ownDomain('contact@Boulangerie-Dupont.fr'), 'boulangerie-dupont.fr');
  assert.strictEqual(ownDomain('terredeslilas@gmail.com'), null);
  assert.strictEqual(ownDomain('x@localhost'), null);
  assert.deepStrictEqual(guessDomains('Le Coin Pizza'), ['lecoinpizza.fr', 'lecoinpizza.com', 'le-coin-pizza.fr', 'le-coin-pizza.com', 'coinpizza.fr', 'coinpizza.com']);
  assert.deepStrictEqual(guessDomains("Fromagerie From' Ange").slice(0, 2), ['fromageriefromange.fr', 'fromageriefromange.com']);
  const place = { name: 'Terre des Lilas', phone: '+33 6 12 34 56 78' };
  assert.ok(pageMatches('<h1>Terre des Lilas</h1>', 'terredeslilas.fr', place));
  assert.ok(pageMatches('<p>Appelez le 06 12 34 56 78</p>', 'x.fr', place));
  assert.ok(!pageMatches('<title>terredeslilas.fr</title>', 'terredeslilas.fr', place));
  assert.ok(!pageMatches('<h1>Terre des Lilas</h1> This domain is for sale', 'x.fr', place));
  assert.ok(isPrivate('127.0.0.1') && isPrivate('192.168.1.2') && isPrivate('::1') && !isPrivate('23.236.62.147'));
  assert.ok(isPrivate('::ffff:172.17.0.1') && isPrivate('100.64.0.1') && !isPrivate('::ffff:23.236.62.147') && !isPrivate('100.128.0.1'));
});

const { toRows, isKnown, codesFor } = require('./sirene');

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
  const { safeCsvPath } = require('./mcp');
  assert.throws(() => safeCsvPath('/tmp/x/.bashrc'), /\.csv/);
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'prospecto-'));
  const file = require('path').join(dir, 'prospects.csv');
  assert.equal(safeCsvPath(file), file);
  require('fs').writeFileSync(file, '');
  assert.throws(() => safeCsvPath(file), /existe déjà/);
});

test('double vérification : une redirection vers le réseau local est refusée', async () => {
  const dns = require('dns').promises;
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
    const { checkPlace } = require('./check');
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

test('un rescan retire les fiches qui ont un site ou ont quitté la commune', async () => {
  const db = await (await DuckDBInstance.create(':memory:')).connect();
  await db.run('LOAD spatial');
  await db.run('CREATE TABLE places (id VARCHAR, family VARCHAR, lat DOUBLE, lon DOUBLE)');
  await db.run(`INSERT INTO places VALUES ('a', 'shopping', 48.5, 2.5), ('gagne_un_site', 'shopping', 48.5, 2.5), ('disparu', 'shopping', 48.5, 2.5),
    ('autre_famille', 'lodging', 48.5, 2.5), ('ailleurs', 'shopping', 40, 0), ('sirene:1', 'shopping', 48.5, 2.5)`);
  await db.run(`CREATE TABLE t AS SELECT * FROM (VALUES ('a', true), ('gagne_un_site', false)) v(id, prospect)`);
  const geometry = { type: 'Polygon', coordinates: [[[2, 48], [3, 48], [3, 49], [2, 49], [2, 48]]] };
  const ids = async () => (await db.runAndReadAll('SELECT id FROM places ORDER BY id')).getRowsJson().flat();
  await db.run(pruneSql('t', { lat: 48.5, lon: 2.5, radius: 500, families: [] }));
  assert.deepStrictEqual(await ids(), ['a', 'ailleurs', 'autre_famille', 'disparu', 'sirene:1']);
  await db.run(pruneSql('t', { zone: 'city', citycode: '75056', geometry, families: ['shopping'] }));
  assert.deepStrictEqual(await ids(), ['a', 'ailleurs', 'autre_famille', 'sirene:1']);
});
