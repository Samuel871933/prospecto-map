// DuckDB compilé en WebAssembly, pour le navigateur seulement : chargé depuis jsDelivr au premier scan (version figée).
const CDN = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm';

let conn;
function connect() {
  return (conn ??= (async () => {
    const duckdb = await import(CDN);
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    // Un Worker doit venir de la même origine que la page : on charge celui du CDN via un petit script local (blob).
    const url = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(url));
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(url);
    const c = await db.connect();
    // Sans httpfs, DuckDB-Wasm télécharge chaque fichier Overture en entier (700 Mo) au lieu d'en lire des morceaux.
    await c.query('LOAD httpfs');
    return c;
  })().catch((e) => {
    conn = null; // on retentera au prochain scan
    throw e;
  }));
}

// query(sql) → lignes en objets simples, comme getRowObjectsJson côté Node.
export async function query(sql) {
  return (await (await connect()).query(sql)).toArray().map((r) => r.toJSON());
}
