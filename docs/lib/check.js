// Double vérification « sans site », partie commune au navigateur et à Node : domaines candidats et OpenStreetMap (Overpass).
// Node (check.js à la racine) lit en plus les pages ; le navigateur ne peut pas (CORS), il demande seulement au DNS public si le domaine existe.
import { plain } from './sirene.js';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const WEBMAILS = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.fr', 'outlook.com', 'outlook.fr', 'live.com', 'live.fr', 'msn.com',
  'yahoo.com', 'yahoo.fr', 'icloud.com', 'me.com', 'aol.com', 'aol.fr', 'gmx.fr', 'gmx.com', 'protonmail.com', 'proton.me', 'orange.fr', 'wanadoo.fr',
  'free.fr', 'sfr.fr', 'neuf.fr', 'laposte.net', 'bbox.fr', 'numericable.fr', 'club-internet.fr', 'cegetel.net', 'aliceadsl.fr', 'nordnet.fr']);
const ARTICLES = new Set(['le', 'la', 'les', 'l', 'au', 'aux', 'chez']);

export const compact = (s) => plain(s).replace(/[^a-z0-9]/g, '');

export function ownDomain(email) {
  const d = plain(email).split('@')[1]?.trim();
  return d && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && !WEBMAILS.has(d) ? d : null;
}

// « Le Coin Pizza » → lecoinpizza, le-coin-pizza, coinpizza ; en .fr et .com.
export function guessDomains(name) {
  const words = plain(name).replace(/&/g, ' et ').split(/[^a-z0-9]+/).filter(Boolean);
  const bare = words[0] && ARTICLES.has(words[0]) ? words.slice(1) : words;
  const slugs = new Set([words.join(''), words.join('-'), bare.join('')].filter((s) => s.length >= 4 && s.length <= 63));
  return [...slugs].flatMap((s) => [s + '.fr', s + '.com']);
}

// Overpass en panne : on ne le réinterroge pas pendant 5 min, sinon chaque vérification attendrait ses délais.
let osmDownUntil = 0;
// Objet OSM du même nom à moins de 80 m, avec un site renseigné. Lève une erreur si Overpass ne répond pas : ce n'est pas un « non ».
// headers : Node s'identifie (User-Agent) ; le navigateur ne peut pas changer ce champ.
export async function viaOsm(place, headers = {}) {
  const q = `[out:json][timeout:15];nwr(around:80,${+place.lat},${+place.lon})[name]["website"];out tags;nwr(around:80,${+place.lat},${+place.lon})[name]["contact:website"];out tags;`;
  if (Date.now() < osmDownUntil) throw new Error('OpenStreetMap indisponible');
  let data;
  // Serveurs publics gratuits, souvent saturés : la file d'attente d'overpass-api.de dépasse souvent 30 s, d'où le long délai.
  for (const host of OVERPASS) {
    try {
      const res = await fetch(host, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(40000),
      });
      if (res.ok) { data = await res.json(); break; }
    } catch { /* serveur suivant */ }
  }
  if (!data) { osmDownUntil = Date.now() + 5 * 60000; throw new Error('OpenStreetMap indisponible'); }
  const name = compact(place.name);
  const hit = data.elements.find((e) => { const n = compact(e.tags.name); return n && (n.includes(name) || name.includes(n)); });
  const url = hit && (hit.tags.website || hit.tags['contact:website']);
  return /^https?:\/\//.test(url ?? '') ? url : null;
}

// Le domaine existe-t-il ? DNS public en HTTPS (CORS ouvert). Une erreur compte comme « non » : ce n'est qu'un indice.
async function dnsExists(host) {
  try {
    const res = await fetch(`https://dns.google/resolve?type=A&name=${encodeURIComponent(host)}`, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    return data.Status === 0 && (data.Answer ?? []).length > 0;
  } catch {
    return false;
  }
}

// Vérification faite par le navigateur. Seul un site renseigné dans OSM est sûr (url, la fiche sort de la liste) ;
// un domaine d'email ou deviné qui existe est seulement « possible » : le navigateur ne peut pas lire la page pour s'en assurer.
// partial = OpenStreetMap n'a pas répondu, à revérifier plus tard.
export async function checkInBrowser(place) {
  let partial = false;
  try {
    const url = await viaOsm(place);
    if (url) return { url, source: 'osm', partial: false, possible: null };
  } catch { partial = true; }
  const hosts = [ownDomain(place.email), ...guessDomains(place.name)].filter(Boolean);
  const exists = await Promise.all(hosts.map(dnsExists));
  return { url: null, source: null, partial, possible: hosts.find((_, i) => exists[i]) ?? null };
}
