# Prospecto

Repère sur une carte les commerces français **qui n'ont pas de site web**, pour la prospection. Les résultats s'exportent en CSV, et l'outil se pilote aussi depuis Claude grâce à un serveur MCP.

Aucune clé API ni aucun compte : toutes les sources sont ouvertes.

## Sources

- **[Overture Maps](https://overturemaps.org)** (lieux, téléphones, emails, réseaux sociaux), lu directement dans les fichiers publics via DuckDB.
- **[SIRENE](https://recherche-entreprises.api.gouv.fr)** (registre Insee) : artisans et commerces absents d'Overture, sans coordonnées.
- **[geo.api.gouv.fr](https://geo.api.gouv.fr)** : contours des communes.
- **OpenStreetMap (Overpass)** : sert à la double vérification.

## Installation

Il faut Node.js 22.9 ou plus récent.

```sh
npm install
npm start          # ou npm run dev (relance à chaque modification)
```

Ouvrir ensuite http://localhost:3000. Le premier scan télécharge les extensions DuckDB `httpfs` et `spatial`, il faut donc une connexion internet.

## Utilisation

1. **Scanner** une ville, une rue ou un cercle tracé sur la carte (de 50 m à 5 km). Les commerces sans site sont enregistrés dans `data/prospects.duckdb`.
2. **Filtrer** par type de commerce, ou par contact disponible (téléphone, email, réseau social).
3. **Vérifier** : une double vérification cherche un site via le domaine de l'email, des domaines devinés à partir du nom, puis OpenStreetMap. Un commerce dont on trouve le site sort des exports.
4. **Exporter** en CSV au format Excel FR (séparateur `;`), soit la vue courante, soit par région, département ou ville.

## Serveur MCP (Claude)

Le serveur MCP passe par l'API de l'appli : `npm start` doit donc tourner. Le fichier `.mcp.json` du projet le déclare déjà. Pour l'ajouter depuis un autre dossier :

```sh
claude mcp add prospecto -- node /chemin/vers/prospecto-patronum/mcp.js
```

| Outil | Rôle |
|---|---|
| `scan_city` | Scanne une commune, ou une rue de cette commune |
| `scan_radius` | Scanne un cercle autour d'un point |
| `stats` | Résume le contenu de la base par département, ville et famille |
| `export` | Exporte en CSV filtré (`save_to` pour écrire un fichier) |
| `list_places` | Liste les prospects d'une zone |
| `check_place` | Revérifie qu'un commerce n'a pas de site |

## Configuration (optionnelle)

Les variables suivantes se mettent dans un fichier `.env` (voir `.env.example`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port du serveur |
| `MIN_CONFIDENCE` | `0.5` | Score de fiabilité minimal des fiches Overture (0 à 1) |
| `DB_PATH` | `data/prospects.duckdb` | Emplacement de la base |
| `PROSPECTO_URL` | `http://127.0.0.1:3000` | Adresse de l'API utilisée par le MCP |

## Sécurité

Le serveur n'écoute que sur `127.0.0.1` et refuse les requêtes d'une autre origine. Il n'a **pas d'authentification** : il ne faut pas l'exposer sur internet tel quel.

## Tests

```sh
npm test
```
