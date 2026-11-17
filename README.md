# Prospecto

Repère sur une carte les commerces français **qui n'ont pas de site web**, pour la prospection. Les résultats s'exportent en CSV, et l'outil se pilote aussi depuis Claude grâce à un serveur MCP.

Aucune clé API ni aucun compte : toutes les sources sont ouvertes.

## Sources

- **[Overture Maps](https://overturemaps.org)** (lieux, téléphones, emails, réseaux sociaux), lu directement dans les fichiers publics : le catalogue STAC donne les fichiers qui touchent la zone, DuckDB n'en lit que les morceaux utiles (requêtes HTTP par plages d'octets).
- **[SIRENE](https://recherche-entreprises.api.gouv.fr)** (registre Insee) : artisans et commerces absents d'Overture, sans coordonnées.
- **[geo.api.gouv.fr](https://geo.api.gouv.fr)** : contours des communes.
- **OpenStreetMap (Overpass)** : sert à la double vérification.

## Page web (GitHub Pages)

La page est statique (dossier `docs/`), sans serveur. Pour la publier : *Settings → Pages → Deploy from branch → `main` / `/docs`*. Elle est ensuite disponible sur `https://<compte>.github.io/<dépôt>/` (ici `https://samuel871933.github.io/prospecto-map/`).

Tout se passe dans le navigateur :

- **DuckDB-Wasm**, chargé depuis jsDelivr au premier scan, lit Overture via le catalogue STAC et des lectures HTTP par plages.
- SIRENE et geo.api.gouv.fr sont appelés directement.
- Les résultats ne vivent que dans la mémoire de l'onglet : ils sont perdus au rechargement. Seules les préférences d'affichage sont gardées dans le `localStorage`.

Limites de la vérification dans le navigateur : seul un site renseigné dans OpenStreetMap est confirmé (le commerce sort alors de la liste). Les domaines de l'email ou devinés à partir du nom sont testés par DNS-over-HTTPS : s'ils existent, la fiche est marquée « site possible », à vérifier à la main, car le navigateur ne peut pas lire la page d'un autre site.

## Utilisation

1. **Scanner** une ville, une rue ou un cercle tracé sur la carte (de 50 m à 5 km).
2. **Filtrer** par type de commerce, ou par contact disponible (téléphone, email, réseau social).
3. **Vérifier** : une double vérification cherche un site (voir la limite ci-dessus pour la page web ; le MCP lit en plus les pages des domaines trouvés). Un commerce dont on trouve le site sort des exports.
4. **Exporter** en CSV au format Excel FR (séparateur `;`), soit la vue courante, soit par région, département ou ville.

## Serveur MCP (Claude)

Node.js 22 ou plus récent. Aucune base ni serveur à lancer : les scans vivent dans la mémoire du processus MCP et disparaissent quand Claude le ferme. Le premier scan télécharge l'extension DuckDB `httpfs`, il faut donc une connexion internet.

```sh
claude mcp add prospecto -- npx -y github:Samuel871933/prospecto-map
```

Depuis un clone (`npm install`), le fichier `.mcp.json` du projet le déclare déjà (`node mcp.js`), ou :

```sh
claude mcp add prospecto -- node /chemin/vers/prospecto-patronum/mcp.js
```

| Outil | Rôle |
|---|---|
| `scan_city` | Scanne une commune, ou une rue de cette commune |
| `scan_radius` | Scanne un cercle autour d'un point |
| `stats` | Résume les lieux scannés pendant la session par département, ville et famille |
| `export` | Exporte en CSV filtré (`save_to` pour écrire un fichier) |
| `list_places` | Liste les prospects d'une zone |
| `check_place` | Revérifie qu'un commerce n'a pas de site |

## Sécurité

L'export MCP n'écrit qu'un nouveau fichier `.csv` (jamais d'écrasement), et la double vérification de Node refuse les domaines qui pointent vers le réseau local, y compris après une redirection.

La version complète précédente (serveur Express, base DuckDB sur disque) se trouve sur la branche `full_project`.

## Tests

```sh
npm test
```
