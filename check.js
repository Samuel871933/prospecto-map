// Double vérification « sans site » avec des sources gratuites, sans clé :
// 1. domaine de l'email s'il n'est pas un webmail, 2. domaine deviné depuis le nom, 3. OpenStreetMap (Overpass).
const dns = require('dns').promises;
const net = require('net');

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const UA = 'prospecto-patronum/1.0 (verification de site)';
const WEBMAILS = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.fr', 'outlook.com', 'outlook.fr', 'live.com', 'live.fr', 'msn.com',
  'yahoo.com', 'yahoo.fr', 'icloud.com', 'me.com', 'aol.com', 'aol.fr', 'gmx.fr', 'gmx.com', 'protonmail.com', 'proton.me', 'orange.fr', 'wanadoo.fr',
  'free.fr', 'sfr.fr', 'neuf.fr', 'laposte.net', 'bbox.fr', 'numericable.fr', 'club-internet.fr', 'cegetel.net', 'aliceadsl.fr', 'nordnet.fr']);
const ARTICLES = new Set(['le', 'la', 'les', 'l', 'au', 'aux', 'chez']);
// Page de domaine parqué ou à vendre : elle répète souvent le nom du domaine, donc le nom du commerce.
const PARKED = /domain (is )?for sale|buy this domain|domaine (est )?(à|a) vendre|ce domaine|parked|sedoparking|domain parking|nom de domaine.*(disponible|réservé)/i;

const { plain } = require('./sirene');
const compact = (s) => plain(s).replace(/[^a-z0-9]/g, '');

function ownDomain(email) {
  const d = plain(email).split('@')[1]?.trim();
  return d && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && !WEBMAILS.has(d) ? d : null;
}

// « Le Coin Pizza » → lecoinpizza, le-coin-pizza, coinpizza ; en .fr et .com.
function guessDomains(name) {
  const words = plain(name).replace(/&/g, ' et ').split(/[^a-z0-9]+/).filter(Boolean);
  const bare = words[0] && ARTICLES.has(words[0]) ? words.slice(1) : words;
  const slugs = new Set([words.join(''), words.join('-'), bare.join('')].filter((s) => s.length >= 4 && s.length <= 63));
  return [...slugs].flatMap((s) => [s + '.fr', s + '.com']);
}

// La page parle bien de ce commerce : son nom (assez long pour ne pas matcher par hasard) ou son téléphone, hors mention du domaine lui-même.
function pageMatches(html, host, place) {
  if (PARKED.test(html)) return false;
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const body = compact(text).replaceAll(compact(host), '');
  const name = compact(place.name);
  const phone = String(place.phone ?? '').replace(/\D/g, '').slice(-9);
  return (name.length >= 5 && body.includes(name)) || (phone.length === 9 && text.replace(/\D/g, '').includes(phone));
}

function isPrivate(ip) {
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1]; // IPv4 écrite en IPv6
  if (v4) return isPrivate(v4);
  if (net.isIPv6(ip)) return /^(::1?$|f[cd]|fe80|::ffff:(10|127|192\.168|169\.254)\.)/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// Le domaine vient de données externes : on refuse ce qui pointe vers le réseau local, y compris après une redirection.
// shortcut: l'IP est résolue ici puis à nouveau par fetch (un DNS piégé peut changer entre les deux), acceptable tant que le serveur n'écoute qu'en local.
async function publicHost(host) {
  let ips;
  try { ips = await dns.lookup(host, { all: true }); } catch { return false; } // domaine inexistant : réponse normale
  return ips.length > 0 && !ips.some((i) => isPrivate(i.address));
}

async function fetchPage(host) {
  if (!(await publicHost(host))) return null;
  for (let url of [`https://${host}/`, `http://${host}/`]) {
    try {
      // Redirections suivies à la main (5 au plus) pour contrôler chaque hôte.
      for (let hop = 0; hop <= 5; hop++) {
        const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(6000) });
        const next = res.status >= 300 && res.status < 400 && res.headers.get('location');
        if (!next) {
          if (res.ok) return { url, html: (await res.text()).slice(0, 500000) };
          break;
        }
        url = new URL(next, url).href;
        const { protocol, hostname } = new URL(url);
        if (!/^https?:$/.test(protocol) || !(net.isIP(hostname) ? !isPrivate(hostname) : await publicHost(hostname))) break;
      }
    } catch { /* essai suivant */ }
  }
  return null;
}

async function viaEmail(place) {
  const host = ownDomain(place.email);
  // Un domaine d'email à soi qui répond = un site, même sans le nom dessus (franchise, page d'accueil minimaliste).
  const page = host && await fetchPage(host);
  return page && !PARKED.test(page.html) ? page.url : null;
}

async function viaGuess(place) {
  const pages = await Promise.all(guessDomains(place.name).map(async (host) => {
    const page = await fetchPage(host);
    return page && pageMatches(page.html, host, place) ? page.url : null;
  }));
  return pages.find(Boolean) ?? null;
}

// Overpass en panne : on ne le réinterroge pas pendant 5 min, sinon chaque vérification attendrait ses délais.
let osmDownUntil = 0;
// Objet OSM du même nom à moins de 80 m, avec un site renseigné. Lève une erreur si Overpass ne répond pas : ce n'est pas un « non ».
async function viaOsm(place) {
  const q = `[out:json][timeout:15];nwr(around:80,${+place.lat},${+place.lon})[name]["website"];out tags;nwr(around:80,${+place.lat},${+place.lon})[name]["contact:website"];out tags;`;
  if (Date.now() < osmDownUntil) throw new Error('OpenStreetMap indisponible');
  let data;
  // Serveurs publics gratuits, souvent saturés : la file d'attente d'overpass-api.de dépasse souvent 30 s, d'où le long délai.
  for (const host of OVERPASS) {
    try {
      const res = await fetch(host, {
        method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
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

// { url, source } si un site est trouvé, sinon { url: null, partial } : partial = une source n'a pas répondu, à revérifier plus tard.
async function checkPlace(place) {
  let partial = false;
  for (const [source, fn] of [['email', viaEmail], ['domaine', viaGuess], ['osm', viaOsm]]) {
    try {
      const url = await fn(place);
      if (url) return { url, source, partial: false };
    } catch { partial = true; }
  }
  return { url: null, source: null, partial };
}

module.exports = { checkPlace, ownDomain, guessDomains, pageMatches, isPrivate };
