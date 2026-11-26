// Read-only guard for model-written SQL. Only one statement, only reads,
// and no reading of remote URLs or other files (blocks data exfiltration via
// prompt injection hidden in the dataset).

const ALLOWED_START = new Set(['SELECT', 'WITH', 'FROM', 'DESCRIBE', 'SUMMARIZE', 'VALUES', 'SHOW']);
const FORBIDDEN = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'ATTACH', 'DETACH', 'COPY', 'EXPORT',
  'IMPORT', 'INSTALL', 'LOAD', 'PRAGMA', 'SET', 'RESET', 'CALL', 'TRUNCATE', 'VACUUM', 'CHECKPOINT',
  'MERGE', 'GRANT', 'USE', 'BEGIN', 'COMMIT', 'ROLLBACK',
]);
const FORBIDDEN_FUNCS = /^(read_\w+|glob|sniff_csv|parquet_\w+|iceberg_\w+|\w+_scan|query_table|query|getvariable|sqlite_\w+|postgres_\w+|mysql_\w+)$/i;
const FILE_LIKE = /:\/\/|\.(csv|tsv|parquet|json|ndjson|jsonl|db|sqlite|duckdb|txt|xlsx?)$/i;

// A command keyword is only accepted as a bare column name or alias inside a SELECT, where it
// cannot run anything: right after SELECT / DISTINCT / a comma / AS / a table qualifier "t." /
// ORDER|GROUP BY, and right before a comma, FROM, AS, ")" or the end of the query.
// Anything else (statement start, after a CTE, "SET x = ...") is still rejected.
const IDENT_BEFORE = /^(SELECT|DISTINCT|AS|BY|,|\.)$/i;
const IDENT_AFTER = /^(FROM|AS|,|\))$/i;

function isColumnName(tokens, k) {
  const prev = tokens[k - 1];
  const next = tokens[k + 1];
  if (!prev || !IDENT_BEFORE.test(prev.text) || prev.kind === 'string' || prev.kind === 'ident') return false;
  return !next || (next.kind !== 'string' && next.kind !== 'ident' && IDENT_AFTER.test(next.text));
}

/** Split SQL into tokens, skipping comments. Strings and quoted identifiers stay whole. */
function tokenize(sql) {
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    // DuckDB ends a -- comment at either \n or \r, so the guard must too.
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) { j += 2; continue; }
        if (sql[j] === c) break;
        j++;
      }
      tokens.push({ kind: c === "'" ? 'string' : 'ident', text: sql.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      tokens.push({ kind: 'word', text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '$') { tokens.push({ kind: 'dollar', text: c }); i++; continue; }
    if (!/\s/.test(c)) tokens.push({ kind: 'sym', text: c });
    i++;
  }
  return tokens;
}

/** Returns { ok: true, sql } with trailing semicolons removed, or { ok: false, error }. */
export function checkSQL(sql) {
  const fail = (why) => ({ ok: false, error: `Only read-only SQL is allowed: ${why}` });
  const tokens = tokenize(String(sql ?? ''));
  while (tokens.length && tokens[tokens.length - 1].text === ';' && tokens[tokens.length - 1].kind === 'sym') tokens.pop();
  if (!tokens.length) return fail('the query is empty.');
  if (tokens.some((t) => t.kind === 'sym' && t.text === ';')) return fail('send exactly one statement.');
  let depth = 0;
  for (const t of tokens) {
    if (t.kind !== 'sym') continue;
    if (t.text === '(') depth++;
    else if (t.text === ')' && --depth < 0) break;
  }
  if (depth !== 0) return fail('parentheses are unbalanced.');
  const first = tokens[0];
  if (first.kind !== 'word' && !(first.kind === 'sym' && first.text === '(')) return fail('start with SELECT or WITH.');
  if (first.kind === 'word' && !ALLOWED_START.has(first.text.toUpperCase())) return fail(`${first.text.toUpperCase()} is not allowed.`);
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind === 'dollar') return fail('dollar-quoted strings and parameters are not allowed.');
    if (t.kind === 'word' && /^e$/i.test(t.text) && tokens[k + 1]?.kind === 'string') return fail("escape strings (E'...') are not allowed.");
    if (t.kind === 'ident' && FILE_LIKE.test(t.text)) return fail('only the table "data" can be queried.');
    if (t.kind === 'ident' && FORBIDDEN_FUNCS.test(t.text) && tokens[k + 1]?.text === '(') return fail(`${t.text}() cannot read other files.`);
    if (t.kind === 'word' && FORBIDDEN.has(t.text.toUpperCase()) && (k === 0 || !isColumnName(tokens, k))) return fail(`${t.text.toUpperCase()} is not allowed.`);
    if (t.kind === 'word' && FORBIDDEN_FUNCS.test(t.text) && tokens[k + 1]?.text === '(') return fail(`${t.text}() cannot read other files.`);
    if (t.kind === 'string' && /:\/\//.test(t.text)) return fail('URLs cannot be read.');
    if (t.kind === 'string' && tokens[k - 1]?.kind === 'word' && /^(FROM|JOIN)$/i.test(tokens[k - 1].text)) {
      return fail('only the table "data" can be queried.');
    }
  }
  return { ok: true, sql: String(sql).trim().replace(/;\s*$/, '').trim() };
}
