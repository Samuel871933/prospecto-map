// 2e source au scan : SIRENE (registre Insee) via l'API publique recherche-entreprises, gratuite et sans clé.
// Elle connaît les artisans et commerces absents d'Overture, mais ni téléphone, ni email, ni site.
const API = 'https://recherche-entreprises.api.gouv.fr';
const PAGE_MAX = 40; // 25 entreprises par page : 1000 au plus par scan
const CHAIN_MIN = 10; // à partir de 10 établissements ouverts, on suppose une chaîne qui a déjà un site

// Codes NAF retenus → [famille de l'app, libellé]. Seulement des métiers qui reçoivent des clients.
const NAF = {
  '56.10A': ['food_and_drink', 'Restaurant'], '56.10B': ['food_and_drink', 'Cafétéria'], '56.10C': ['food_and_drink', 'Restauration rapide / snack'],
  '56.21Z': ['food_and_drink', 'Traiteur'], '56.30Z': ['food_and_drink', 'Bar'],
  '10.71C': ['food_and_drink', 'Boulangerie'], '10.71D': ['food_and_drink', 'Pâtisserie'], '47.24Z': ['food_and_drink', 'Boulangerie'],
  '10.13B': ['shopping', 'Charcuterie'], '47.22Z': ['shopping', 'Boucherie'], '47.23Z': ['shopping', 'Poissonnerie'], '47.21Z': ['shopping', 'Primeur'],
  '47.25Z': ['shopping', 'Cave / boissons'], '47.29Z': ['shopping', 'Alimentation spécialisée'], '47.11B': ['shopping', 'Épicerie'], '47.26Z': ['shopping', 'Tabac'],
  '47.51Z': ['shopping', 'Tissus & mercerie'], '47.52A': ['shopping', 'Quincaillerie'], '47.52B': ['shopping', 'Bricolage'],
  '47.59A': ['shopping', 'Meubles'], '47.59B': ['shopping', 'Équipement de la maison'], '47.61Z': ['shopping', 'Librairie'], '47.62Z': ['shopping', 'Presse'],
  '47.64Z': ['shopping', 'Articles de sport'], '47.65Z': ['shopping', 'Jouets'], '47.71Z': ['shopping', 'Mode & vêtements'], '47.72A': ['shopping', 'Chaussures'],
  '47.72B': ['shopping', 'Maroquinerie'], '47.75Z': ['shopping', 'Parfumerie & cosmétiques'], '47.76Z': ['shopping', 'Fleuriste / animalerie'],
  '47.77Z': ['shopping', 'Bijouterie'], '47.78A': ['shopping', 'Opticien'], '47.78C': ['shopping', 'Boutique spécialisée'], '47.79Z': ['shopping', 'Occasion / brocante'],
  '47.73Z': ['shopping', 'Pharmacie'],
  '96.02A': ['lifestyle_services', 'Coiffure'], '96.02B': ['lifestyle_services', 'Institut de beauté'], '96.04Z': ['lifestyle_services', 'Bien-être'],
  '96.09Z': ['lifestyle_services', 'Services à la personne'], '96.01B': ['lifestyle_services', 'Pressing'], '95.23Z': ['lifestyle_services', 'Cordonnerie'],
  '43.21A': ['services_and_business', 'Électricien'], '43.22A': ['services_and_business', 'Plombier'], '43.22B': ['services_and_business', 'Chauffagiste'],
  '43.29A': ['services_and_business', 'Isolation'], '43.31Z': ['services_and_business', 'Plâtrier'], '43.32A': ['services_and_business', 'Menuisier'],
  '43.32B': ['services_and_business', 'Serrurier / métallier'], '43.33Z': ['services_and_business', 'Carreleur / sols'], '43.34Z': ['services_and_business', 'Peintre'],
  '43.91B': ['services_and_business', 'Couvreur'], '43.99C': ['services_and_business', 'Maçon'], '81.30Z': ['services_and_business', 'Paysagiste'],
  '81.21Z': ['services_and_business', 'Nettoyage'], '74.20Z': ['services_and_business', 'Photographe'], '71.11Z': ['services_and_business', 'Architecte'],
  '68.31Z': ['services_and_business', 'Immobilier'], '69.20Z': ['services_and_business', 'Expert-comptable'], '95.11Z': ['services_and_business', 'Dépannage informatique'],
  '86.23Z': ['health_care', 'Dentiste'], '86.90E': ['health_care', 'Kiné & rééducation'], '86.90F': ['health_care', 'Médecine douce'], '75.00Z': ['health_care', 'Vétérinaire'],
  '55.10Z': ['lodging', 'Hôtel'], '55.20Z': ['lodging', 'Gîte / chambre d\'hôtes'], '55.30Z': ['lodging', 'Camping'],
  '45.20A': ['travel_and_transportation', 'Garage auto'], '45.20B': ['travel_and_transportation', 'Carrosserie / garage'], '45.11Z': ['travel_and_transportation', 'Concessionnaire'],
  '45.40Z': ['travel_and_transportation', 'Moto'], '49.32Z': ['travel_and_transportation', 'Taxi / VTC'], '79.11Z': ['travel_and_transportation', 'Agence de voyages'],
  '93.13Z': ['sports_and_recreation', 'Salle de sport'], '85.51Z': ['sports_and_recreation', 'Cours de sport'],
  '85.53Z': ['education', 'Auto-école'], '85.52Z': ['education', 'Cours artistiques'], '85.59B': ['education', 'Formation'],
};

const plain = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const compact = (s) => plain(s).replace(/&/g, 'et').replace(/[^a-z0-9]/g, '');
// Le registre écrit tout en capitales.
const title = (s) => s && s.toLowerCase().replace(/(^|[\s'’(-])(\p{L})/gu, (m, sep, c) => sep + c.toUpperCase());
const meters = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));

const codesFor = (families) => Object.keys(NAF).filter((c) => !families.length || families.includes(NAF[c][0]));

// Réponse de l'API → lignes de la table places. Garde les établissements actifs, du bon métier, dans la zone, hors chaînes,
// et jamais ceux qui ont refusé la prospection commerciale (obligation légale).
function toRows(results, scan) {
  const rows = [];
  for (const r of results) {
    if (r.opposition_diffusion_commerciale || r.statut_diffusion !== 'O' || r.nombre_etablissements_ouverts >= CHAIN_MIN) continue;
    for (const e of r.matching_etablissements ?? []) {
      const naf = NAF[e.activite_principale];
      const lat = Number(e.latitude), lon = Number(e.longitude);
      if (!naf || e.etat_administratif !== 'A' || e.statut_diffusion_etablissement !== 'O' || !e.latitude || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (scan.families?.length && !scan.families.includes(naf[0])) continue;
      if (scan.radius ? meters({ lat, lon }, scan) > scan.radius : e.commune !== scan.citycode) continue;
      if (scan.street && !compact(e.adresse).includes(compact(scan.street))) continue;
      const name = e.liste_enseignes?.[0] || (e.est_siege && e.nom_commercial) || r.nom_raison_sociale || r.nom_complet;
      rows.push({
        id: 'sirene:' + e.siret, name: title(name), category: naf[1], family: naf[0], confidence: null, phone: null, email: null, social: null,
        street: title(String(e.adresse ?? '').replace(` ${e.code_postal} ${e.libelle_commune}`, '')) || null,
        postcode: e.code_postal ?? null, city: title(e.libelle_commune) ?? null, lat, lon,
      });
    }
  }
  return rows;
}

// Mots d'au moins 4 lettres, pluriel retiré : « D.B. Automobiles » et « Bernardi Automobile » partagent « automobile ».
const words = (s) => plain(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4).map((w) => w.replace(/s$/, ''));

// Déjà connu d'Overture (avec ou sans site) : un nom contient l'autre, ou ils partagent un mot à moins de 50 m.
// La proximité seule ne suffit pas : le registre géocode à l'adresse, et une adresse abrite souvent plusieurs entreprises.
// shortcut: un sigle (« Sdl » pour « Service Dépannage Langonnais ») n'est pas reconnu, la fiche apparaît alors deux fois.
function isKnown(row, known) {
  const name = compact(row.name);
  const city = compact(row.city);
  const own = words(row.name).filter((w) => !words(row.city).includes(w));
  return known.some((k) => {
    const n = compact(k.name);
    if (n === city) return false; // lieu qui porte juste le nom de la commune
    return (name.length > 3 && n.length > 3 && (n.includes(name) || name.includes(n)))
      || (meters(row, k) < 50 && own.some((w) => words(k.name).includes(w)));
  });
}

async function getPage(params, page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}/${params.endpoint}?${params.query}&page=${page}`, { signal: AbortSignal.timeout(15000) });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); continue; } // limite : 7 requêtes par seconde
    if (!res.ok) throw new Error(`SIRENE ${res.status}`);
    return res.json();
  }
  throw new Error('SIRENE saturé');
}

// { rows, truncated }. Lève une erreur si l'API ne répond pas : le scan Overture reste valable.
async function sireneRows(scan) {
  const codes = codesFor(scan.families ?? []);
  if (!codes.length) return { rows: [], truncated: false };
  const common = `activite_principale=${codes.join(',')}&etat_administratif=A&per_page=25`;
  const params = scan.radius
    ? { endpoint: 'near_point', query: `lat=${scan.lat}&long=${scan.lon}&radius=${scan.radius / 1000}&${common}` }
    : { endpoint: 'search', query: `code_commune=${scan.citycode}&${common}` };
  // La 1re page donne le nombre de pages ; les suivantes partent par lots de 4 (l'API tolère 7 requêtes par seconde).
  const first = await getPage(params, 1);
  const results = [...first.results];
  const last = Math.min(first.total_pages, PAGE_MAX);
  for (let page = 2; page <= last; page += 4) {
    const batch = await Promise.all([0, 1, 2, 3].filter((i) => page + i <= last).map((i) => getPage(params, page + i)));
    for (const data of batch) results.push(...data.results);
  }
  return { rows: toRows(results, scan), truncated: first.total_pages > PAGE_MAX };
}

export { sireneRows, toRows, isKnown, codesFor, plain };
