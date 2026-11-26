// DuckDB-WASM wrapper. Loaded on first use from this site's vendor/ folder (no CDN), runs in its own worker.
// The loaded file always becomes the table `data`.

import { checkSQL } from './sqlguard.js';

const DUCKDB_VERSION = '1.33.1-dev57.0';
const FILE = 'upload.csv';
export const ROW_CAP = 5000;

// Locked in the engine, so no SQL can undo it: no network or file access except the
// one uploaded file, no extension loading. This is the real guard; sqlguard.js is a
// first filter that gives the model friendlier error messages.
const LOCKDOWN = [
  `SET allowed_paths = ['${FILE}']`,
  'SET enable_external_access = false',
  'SET autoinstall_known_extensions = false',
  'SET autoload_known_extensions = false',
  'SET lock_configuration = true',
];
// Bundled build (see scripts/vendor_duckdb.sh). "apache-arrow" resolves via the import map in index.html.
const VENDOR = new URL('../vendor/duckdb/', import.meta.url).href;
const CDN = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/dist/`;
const BUNDLES = {
  // Every current browser supports WASM exceptions, so the "eh" build ships with the app.
  eh: { mainModule: `${VENDOR}duckdb-eh.wasm`, mainWorker: `${VENDOR}duckdb-browser-eh.worker.js` },
  // Very old browsers only (e.g. Safari < 15.2): fetched from the CDN rather than adding 41 MB to the repo.
  mvp: { mainModule: `${CDN}duckdb-mvp.wasm`, mainWorker: `${CDN}duckdb-browser-mvp.worker.js` },
};

let connPromise = null;

async function connect() {
  const duckdb = await import('../vendor/duckdb/duckdb-browser.mjs');
  const bundle = await duckdb.selectBundle(BUNDLES);
  // A blob bootstrap works for both the same-origin build and the cross-origin fallback.
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
  );
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  const conn = await db.connect();
  for (const sql of LOCKDOWN) await conn.query(sql);
  return { db, conn };
}

function getConn() {
  if (!connPromise) {
    connPromise = connect().catch((e) => { connPromise = null; throw e; });
  }
  return connPromise;
}

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function decimalToNumber(words, scale) {
  // Arrow decimals arrive as little-endian 32-bit words of a signed 128-bit integer.
  let big = 0n;
  for (let i = words.length - 1; i >= 0; i--) big = (big << 32n) | BigInt(words[i] >>> 0);
  const bits = BigInt(words.length * 32);
  if (big >= 1n << (bits - 1n)) big -= 1n << bits;
  return Number(big) / 10 ** scale;
}

function converter(field) {
  const t = String(field.type);
  if (t.startsWith('Date')) return (v) => new Date(v).toISOString().slice(0, 10);
  if (t.startsWith('Timestamp')) return (v) => new Date(v).toISOString().replace('.000Z', 'Z');
  if (t.startsWith('Decimal')) {
    return (v) => (v && typeof v === 'object' && 'length' in v ? decimalToNumber(v, field.type.scale) : Number(v));
  }
  return (v) => {
    if (typeof v === 'bigint') return Number(v);
    if (v && typeof v === 'object') return String(v);
    return v;
  };
}

function toPlain(table) {
  const fields = table.schema.fields;
  const columns = fields.map((f) => f.name);
  const convs = fields.map(converter);
  const vectors = fields.map((_, i) => table.getChildAt(i));
  const rows = [];
  for (let r = 0; r < table.numRows; r++) {
    const row = {};
    for (let c = 0; c < columns.length; c++) {
      const v = vectors[c].get(r);
      row[columns[c]] = v === null || v === undefined ? null : convs[c](v);
    }
    rows.push(row);
  }
  return { columns, rows };
}

// One connection runs one query at a time. Streamed (cancellable) queries would otherwise be
// broken by a second query starting on the same connection, so every query waits its turn.
let lock = Promise.resolve();
function exclusive(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

/** Run SQL and return { columns: string[], rows: object[] } with JSON-friendly values. */
export function query(sql) {
  return exclusive(async () => {
    const { conn } = await getConn();
    return toPlain(await conn.query(sql));
  });
}

/**
 * Run model-written or saved SQL safely: guard check, then ONE prepared statement
 * (DuckDB refuses to prepare several), wrapped to cap the rows returned.
 */
let queryTimeoutMs = 30000;

/** How long one model-written or saved query may run before it is cancelled. */
export function setQueryTimeout(ms) {
  queryTimeoutMs = ms;
}

/**
 * Run model-written or saved SQL safely: guard check, then ONE statement (DuckDB refuses to
 * prepare several), wrapped to cap the rows returned. It runs as a cancellable pending query:
 * Stop (signal) or the timeout cancels it inside DuckDB, so a runaway query can't freeze the app.
 */
export async function safeQuery(sql, { signal } = {}) {
  const guard = checkSQL(sql);
  if (!guard.ok) throw new Error(guard.error);
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  return exclusive(() => runGuarded(guard.sql, signal));
}

async function runGuarded(guardedSql, signal) {
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  const { conn } = await getConn();
  const guard = { sql: guardedSql };
  // Newlines keep a trailing "-- comment" from swallowing the wrapper.
  const wrapped = `SELECT * FROM (\n${guard.sql}\n) AS answer LIMIT ${ROW_CAP}`;
  const stmt = await conn.prepare(wrapped); // throws on more than one statement
  await stmt.close();
  let cancelled = null;
  const cancel = (why) => {
    if (cancelled) return;
    cancelled = why;
    conn.cancelSent().catch(() => {});
  };
  const onAbort = () => cancel('stopped');
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => cancel('timeout'), queryTimeoutMs);
  try {
    const reader = await conn.send(wrapped, true);
    const batches = [];
    for await (const batch of reader) batches.push(batch);
    if (cancelled) throw new Error('cancelled');
    if (!batches.length) return { columns: (reader.schema?.fields || []).map((f) => f.name), rows: [] };
    const { Table } = await import('apache-arrow');
    return toPlain(new Table(batches));
  } catch (e) {
    if (cancelled === 'stopped') throw new DOMException('Stopped', 'AbortError');
    if (cancelled === 'timeout') {
      throw new Error(`The query took longer than ${Math.round(queryTimeoutMs / 1000)} s and was cancelled. Try a simpler question.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Parse CSV text into the staging table `data_next`. The current `data` is untouched. */
/** A plain identifier for a column name: "Total Amount ($)" -> total_amount. */
export function simpleName(name, i) {
  let n = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!n) n = `column_${i + 1}`;
  if (/^\d/.test(n)) n = `c_${n}`;
  return n;
}

// Text that is really a number: "1,234.50", "$2,000", "12%", "₹ 950".
const NUMERIC_TEXT = '^[-+]?[$€£₹]?\\s*[0-9][0-9,]*(\\.[0-9]+)?\\s*%?$';

/**
 * Make a freshly read CSV easy to query, for people and for small models:
 * simple column names (no spaces or symbols to quote) and numbers stored as text turned into numbers.
 */
async function tidyStaged() {
  const cols = (await query('DESCRIBE data_next')).rows;
  const used = new Set();
  const exprs = [];
  let changed = false;
  for (const [i, c] of cols.entries()) {
    let name = simpleName(c.column_name, i);
    for (let k = 2; used.has(name); k++) name = `${simpleName(c.column_name, i)}_${k}`;
    used.add(name);
    const src = quoteIdent(c.column_name);
    let expr = src;
    if (/^VARCHAR/i.test(c.column_type)) {
      const r = (await query(`SELECT COUNT(*) FILTER (WHERE trim(${src}) <> '') AS n,
        COUNT(*) FILTER (WHERE trim(${src}) <> '' AND NOT regexp_full_match(trim(${src}), '${NUMERIC_TEXT}')) AS bad
        FROM data_next`)).rows[0];
      if (Number(r.n) > 0 && Number(r.bad) === 0) {
        expr = `TRY_CAST(regexp_replace(trim(${src}), '[$€£₹,%\\s]', '', 'g') AS DOUBLE)`;
      }
    }
    if (expr !== src || name !== c.column_name) changed = true;
    exprs.push(`${expr} AS ${quoteIdent(name)}`);
  }
  if (!changed) return;
  await query(`CREATE OR REPLACE TABLE data_tidy AS SELECT ${exprs.join(', ')} FROM data_next`);
  await query('DROP TABLE data_next');
  await query('ALTER TABLE data_tidy RENAME TO data_next');
}

export async function stageCSV(text) {
  if (!String(text ?? '').trim()) throw new Error('The file is empty.');
  const { db } = await getConn();
  await db.dropFile(FILE).catch(() => {});
  await db.registerFileText(FILE, text);
  try {
    await query(`CREATE OR REPLACE TABLE data_next AS SELECT * FROM read_csv_auto('${FILE}', sample_size=-1)`);
  } catch {
    throw new Error("This file couldn't be read as a CSV.");
  }
  let info = await describe('data_next');
  const junk = info.columns.some((c) => /[\x00-\x08\x0e-\x1f]/.test(c.name))
    || (info.rows === 0 && info.columns.every((c) => /^column\d+$/.test(c.name)));
  if (junk) {
    await query('DROP TABLE IF EXISTS data_next');
    throw new Error(info.rows === 0 ? 'The file is empty.' : "This file doesn't look like a CSV.");
  }
  await tidyStaged(); // only for files that passed the junk check
  info = await describe('data_next');
  if (info.rows === 0) info.warning = 'The file has column names but no rows.';
  return info;
}

/** Swap the staged table in as `data`. */
// The file lives in `data_all`; `data` is a view on it, optionally limited to a recent
// date range, so every query (auto-dashboard, agent, demo) respects the chosen range.
let range = null; // { column, days } or null for all rows

async function applyView() {
  const where = range
    ? ` WHERE ${quoteIdent(range.column)} >= (SELECT MAX(${quoteIdent(range.column)}) FROM data_all) - INTERVAL ${Math.floor(range.days)} DAY`
    : '';
  await query(`CREATE OR REPLACE VIEW data AS SELECT * FROM data_all${where}`);
}

/** Limit `data` to the last `days` days of `column` (relative to its latest date); null for all rows. */
export async function setDateRange(column, days) {
  range = column && days > 0 ? { column, days } : null;
  await applyView();
}

/** Swap the staged table in as the dataset. A new file always starts with all rows. */
export async function commitStaged() {
  await query('DROP VIEW IF EXISTS data');
  await query('DROP TABLE IF EXISTS data');
  await query('DROP TABLE IF EXISTS data_all');
  await query('ALTER TABLE data_next RENAME TO data_all');
  range = null;
  await applyView();
}

/** Remove the loaded dataset from the in-browser database entirely. */
export async function dropData() {
  await query('DROP VIEW IF EXISTS data');
  for (const t of ['data', 'data_all', 'data_next', 'data_tidy']) await query(`DROP TABLE IF EXISTS ${t}`);
  range = null;
}

/** Load CSV text into table `data`. Returns { rows, columns: [{name, type}] }. */
export async function loadCSV(name, text) {
  await stageCSV(text);
  await commitStaged();
  return describe();
}

export async function describe(table = 'data') {
  const cols = await query(`DESCRIBE ${table}`);
  const count = await query(`SELECT COUNT(*) AS n FROM ${table}`);
  return {
    rows: count.rows[0].n,
    columns: cols.rows.map((r) => ({ name: r.column_name, type: r.column_type })),
  };
}

export async function sample(n = 5) {
  return (await query(`SELECT * FROM data LIMIT ${Math.max(0, Math.floor(n))}`)).rows;
}
