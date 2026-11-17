#!/usr/bin/env node
// Serveur MCP (stdio) : pilote prospecto depuis Claude, sans serveur web ni base de fichier.
// Les scans vivent dans la mémoire de ce processus (rien n'est enregistré) : ils disparaissent quand Claude le ferme.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DuckDBInstance } from '@duckdb/node-api';
import { FAMILIES, newStore, runScan, exportGroups, exportRows, toCsv, listPlaces, saveCheck } from './docs/lib/prospecto.js';
import { plain } from './docs/lib/sirene.js';
import { checkPlace } from './check.js';

const Family = z.enum(Object.keys(FAMILIES));
// Noms de ville comparés sans accents, casse, tirets ni apostrophes.
const key = (s) => plain(s).replace(/[-’']/g, ' ').trim();

const store = newStore();
// Base en mémoire ouverte au premier scan ; en cas d'échec on repart de zéro au suivant.
let db;
const query = async (sql) => {
  db ??= (async () => {
    const conn = await (await DuckDBInstance.create(':memory:')).connect();
    await conn.run('INSTALL httpfs; LOAD httpfs;');
    return conn;
  })();
  try {
    return (await (await db).runAndReadAll(sql)).getRowObjectsJson();
  } catch (e) {
    db = undefined;
    throw e;
  }
};

// Nom de ville → code INSEE. Plusieurs communes du même nom : on renvoie la liste pour que Claude choisisse.
async function resolveCity({ city, postcode }) {
  const q = new URLSearchParams({ nom: city, fields: 'nom,code,codesPostaux,departement', limit: '20', boost: 'population' });
  if (postcode) q.set('codePostal', postcode);
  const res = await fetch('https://geo.api.gouv.fr/communes?' + q, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`geo.api.gouv.fr indisponible (${res.status})`);
  const all = await res.json();
  const exact = all.filter((c) => key(c.nom) === key(city));
  const found = exact.length ? exact : all;
  if (found.length === 1) return found[0];
  if (!found.length) throw new Error(`Commune « ${city} » introuvable`);
  throw new Error('Plusieurs communes possibles, rappelle avec citycode : '
    + found.slice(0, 10).map((c) => `${c.nom} (${c.departement?.nom ?? '?'}, CP ${c.codesPostaux[0] ?? '?'}) → ${c.code}`).join(' ; '));
}

// Les noms de commerces viennent d'Internet et passent sous les yeux de Claude : on borne ce qu'un export peut écrire.
function safeCsvPath(p) {
  const file = path.resolve(p);
  if (!/\.csv$/i.test(file)) throw new Error('save_to doit finir par .csv');
  if (fs.existsSync(file)) throw new Error(`${file} existe déjà, choisis un autre nom`);
  return file;
}

const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
// Les erreurs remontent à Claude en clair au lieu de casser l'appel.
const tool = (fn) => async (args) => {
  try {
    return text(await fn(args));
  } catch (e) {
    return { ...text(e.message), isError: true };
  }
};

const server = new McpServer({ name: 'prospecto', version: '1.0.0' });

server.registerTool('scan_city', {
  description: 'Scanne une commune française (ou une rue de cette commune) : ajoute en mémoire ses commerces sans site web (Overture + SIRENE). Peut prendre une à plusieurs minutes.',
  inputSchema: {
    city: z.string().optional().describe('Nom de la commune, ex. "Brive-la-Gaillarde"'),
    citycode: z.string().optional().describe('Code INSEE, prioritaire sur city (à utiliser si le nom est ambigu)'),
    postcode: z.string().optional().describe('Code postal pour lever une ambiguïté sur le nom'),
    street: z.string().optional().describe('Limiter le scan à cette rue'),
    families: z.array(Family).optional().describe('Familles de commerces à garder (toutes si absent)'),
  },
}, tool(async ({ city, citycode, postcode, street, families = [] }) => {
  if (!citycode && !city) throw new Error('Donne city ou citycode');
  const commune = citycode ? { code: citycode } : await resolveCity({ city, postcode });
  const body = street ? { zone: 'street', citycode: commune.code, street, families } : { zone: 'city', citycode: commune.code, families };
  const { area, ...result } = await runScan(store, body, query);
  return { commune: commune.nom ?? commune.code, citycode: commune.code, ...result };
}));

server.registerTool('scan_radius', {
  description: 'Scanne un cercle autour d\'un point (France métropolitaine, rayon 50 à 5000 m).',
  inputSchema: {
    lat: z.number(), lon: z.number(),
    radius: z.number().min(50).max(5000).describe('Rayon en mètres'),
    families: z.array(Family).optional(),
  },
}, tool(async (args) => {
  const { area, ...result } = await runScan(store, { families: [], ...args }, query);
  return result;
}));

server.registerTool('stats', {
  description: 'Contenu de la mémoire (lieux scannés pendant cette session) : nombre de prospects par département, ville et famille, avec ou sans téléphone/email/réseau social. À consulter avant un export.',
  inputSchema: {
    dept: z.string().optional().describe('Ne garder que ce département, ex. "19"'),
    city: z.string().optional().describe('Ne garder que cette ville'),
  },
}, tool(async ({ dept, city }) => {
  const rows = exportGroups(store).filter((r) => (!dept || r.dept === dept) && (!city || key(r.city) === key(city)));
  // Regroupement par ville et famille : les lignes brutes (une par combinaison de contacts) seraient trop longues.
  const out = {};
  for (const r of rows) {
    const g = (out[`${r.dept} | ${r.city ?? '?'} | ${r.family}`] ??= { total: 0, phone: 0, email: 0, social: 0 });
    g.total += r.n;
    for (const f of ['phone', 'email', 'social']) if (r[f]) g[f] += r.n;
  }
  return { total: rows.reduce((s, r) => s + r.n, 0), 'dept | ville | famille': out };
}));

server.registerTool('export', {
  description: 'Exporte les prospects scannés pendant cette session, filtrés en CSV (format Excel FR, séparateur ;). Avec save_to, écrit le fichier et ne renvoie qu\'un aperçu.',
  inputSchema: {
    depts: z.array(z.string()).optional().describe('Départements, ex. ["19","24"]'),
    city: z.string().optional(),
    families: z.array(z.union([Family, z.literal('other')])).optional(),
    has: z.array(z.enum(['phone', 'email', 'social'])).optional().describe('Infos de contact exigées'),
    bbox: z.string().optional().describe('"ouest,sud,est,nord"'),
    save_to: z.string().optional().describe('Chemin du fichier CSV à écrire'),
  },
}, tool(async ({ depts, city, families, has, bbox, save_to }) => {
  const csv = toCsv(exportRows(store, { depts, city, families, has, bbox }));
  const lines = csv.split('\r\n');
  if (!save_to) return csv;
  const file = safeCsvPath(save_to);
  fs.writeFileSync(file, csv, { flag: 'wx' }); // wx : n'écrase jamais un fichier existant
  return `${lines.length - 1} prospects écrits dans ${file}\n\n${lines.slice(0, 6).join('\n')}`;
}));

server.registerTool('check_place', {
  description: 'Double vérification qu\'un commerce n\'a vraiment pas de site (email, domaines devinés, OSM). Un site trouvé le retire des exports. L\'id vient de list_places.',
  inputSchema: { id: z.string() },
}, tool(async ({ id }) => {
  const row = store.places.get(id);
  if (!row) throw new Error('Commerce introuvable : lance d\'abord un scan');
  const result = await checkPlace(row);
  saveCheck(store, id, result);
  return result;
}));

server.registerTool('list_places', {
  description: 'Liste les prospects scannés pendant cette session dans une zone (max 1000), avec leur id, contacts et date de vérification.',
  inputSchema: { bbox: z.string().describe('"ouest,sud,est,nord", ex. "1.50,45.14,1.56,45.18"') },
}, tool(({ bbox }) => listPlaces(store, bbox)));

// Lancé directement (aussi via le lien symbolique de npx/bin), pas quand test.js l'importe.
if (fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) server.connect(new StdioServerTransport());

export { resolveCity, safeCsvPath };
