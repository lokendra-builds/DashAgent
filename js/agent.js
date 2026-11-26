// The DashAgent loop. Model-agnostic: every provider speaks the same tiny JSON protocol,
// because small in-browser models are unreliable at native tool calling.
//
// The model only ever sees: column names/types, <= 5 sample rows, and <= 20 result rows.

import { checkSQL } from './sqlguard.js';
import { resolveChart, fmtCompact } from './charts.js';

export const MAX_RETRIES = 3;
export const SAMPLE_ROWS = 5;
export const RESULT_ROWS = 20;
const CHART_TYPES = new Set(['kpi', 'bar', 'line', 'donut', 'table']);

export class AgentError extends Error {
  constructor(message, steps) {
    super(message);
    this.name = 'AgentError';
    this.steps = steps;
  }
}

function stopped() {
  return new DOMException('Stopped', 'AbortError');
}

/** Find the first parseable {...} object in a model reply (tolerates prose and ``` fences). */
/** Reasoning models write <think>…</think> before answering: keep only the answer (an unclosed block is all thinking). */
export function stripThinking(text) {
  return String(text ?? '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
}

export function extractJSON(text) {
  const s = String(text ?? '');
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const obj = JSON.parse(s.slice(start, i + 1));
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
        } catch { /* try the next '{' */ }
        break;
      }
    }
  }
  return null;
}

function compact(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

export function systemPrompt() {
  return [
    'You are DashAgent, a data analyst. You answer questions about ONE table named data, using DuckDB SQL.',
    'Reply with exactly ONE JSON object and nothing else. Two forms are allowed:',
    '{"action":"query","sql":"<one DuckDB SELECT>","chart":{"type":"bar|line|donut|kpi|table","x":"<column>","y":"<numeric column>"},"title":"<short chart title>"}',
    '{"action":"answer","text":"<reply>"}  (only when no query is needed, e.g. greetings or questions about the columns)',
    'Rules:',
    '- Query only the table data. Read-only: a single SELECT or WITH statement.',
    '- Always wrap column names in double quotes, exactly as listed, e.g. "Order Date".',
    '- Alias output columns: the category/time column AS label or period, the number AS value.',
    '- bar: compare categories (ORDER BY value DESC, LIMIT 15). line: trend over time (date_trunc, ORDER BY period). donut: share of a whole (<= 8 slices). kpi: one single number aliased value. table: anything else.',
    '- For "which X is highest/lowest" questions, return all groups ordered by value (never LIMIT 1) so the chart can compare them; the answer text names the top one.',
    '- Use ROUND(x, 2) for averages and ratios.',
    '- Every selected column must be in GROUP BY or inside SUM/AVG/COUNT/MIN/MAX.',
    '- To count how many people or items, use COUNT(DISTINCT "column"), not COUNT(*).',
    '- Filter dates with a range: "d" >= DATE \'2025-03-01\' AND "d" < DATE \'2025-04-01\'. Never use LIKE on dates.',
    '- If the question needs data that does not exist in the columns (e.g. profit when there is no cost column), do not guess: reply {"action":"answer","text":"..."} saying which data is missing and what you can answer instead.',
    'Examples (column names are made up; use the real ones):',
    'Example bar: {"action":"query","sql":"SELECT \\"region\\" AS label, SUM(\\"sales\\") AS value FROM data GROUP BY 1 ORDER BY value DESC LIMIT 15","chart":{"type":"bar","x":"label","y":"value"},"title":"Sales by region"}',
    'Example line: {"action":"query","sql":"SELECT date_trunc(\'month\', \\"day\\") AS period, SUM(\\"sales\\") AS value FROM data GROUP BY 1 ORDER BY 1","chart":{"type":"line","x":"period","y":"value"},"title":"Sales by month"}',
    'Example kpi: {"action":"query","sql":"SELECT COUNT(*) AS value FROM data","chart":{"type":"kpi","y":"value"},"title":"Number of rows"}',
  ].join('\n');
}

/** The column name as a SQL identifier, quotes doubled, so the model copies it exactly. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** The dataset part of the instructions. Constant per dataset, so CPU models reuse it from their prompt cache. */
function datasetPrompt(schema, sample) {
  const cols = schema.map((c) => `- ${quoteIdent(c.name)} ${c.type}${c.kind ? ` (${c.kind})` : ''}`).join('\n');
  return `\n\nColumns of table data:\n${cols}\n\nSample rows:\n${compact(sample.slice(0, SAMPLE_ROWS))}`;
}

/** The full system message for a dataset. The CPU engine pre-reads exactly this text (warm-up). */
export function instructions(schema, sample) {
  return systemPrompt() + datasetPrompt(schema, sample);
}

function questionPrompt(question, previous) {
  const before = previous?.question
    ? `\n\nPrevious question: ${previous.question}${previous.sql ? `\nIts SQL: ${previous.sql}` : ''}`
      + '\nIf the new question is a follow-up (e.g. "and for X?", "only for Y", "what about Z"), change that SQL to answer it.'
    : '';
  return `${before ? `${before.trim()}\n\n` : ''}Question: ${question}`;
}

/**
 * Fix mistakes small models make often, before running: LIKE on a date column ("date" LIKE '2025-03%')
 * is an error in DuckDB, so compare its text form instead.
 */
export function repairSQL(sql, schema) {
  let out = sql;
  for (const c of schema) {
    if (!/^(DATE|TIMESTAMP)/i.test(c.type)) continue;
    const name = String(c.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<!CAST\\()("${name}"|\\b${name}\\b)(\\s+)(NOT\\s+)?(I?LIKE)\\b`, 'gi');
    out = out.replace(re, (m, col, sp, not, op) => `CAST(${col} AS VARCHAR)${sp}${not || ''}${op}`);
  }
  return out;
}

/** Concrete advice for the errors small models make most, so a retry doesn't repeat the mistake. */
function fixHint(error) {
  const e = String(error);
  if (/GROUP BY|aggregate function/i.test(e)) return '\nHint: every selected column must be in GROUP BY or wrapped in SUM(), AVG(), COUNT(), MIN() or MAX(). For a share by category: SELECT "category" AS label, SUM("x") AS value FROM data GROUP BY 1.';
  if (/does not exist|not found|Referenced column/i.test(e)) return '\nHint: use only the column names listed above, in double quotes, exactly as written.';
  if (/Conversion Error|Could not convert|cast/i.test(e)) return '\nHint: a column has a different type than you assumed; use TRY_CAST or compare as text.';
  if (/~~|LIKE|(No function matches.*DATE)|(DATE.*No function matches)/i.test(e)) return '\nHint: filter dates with a range, e.g. "date" >= DATE \'2025-03-01\' AND "date" < DATE \'2025-04-01\'. Never use LIKE on dates.';
  if (/function .*does not exist|No function matches/i.test(e)) return '\nHint: that function is not available in DuckDB. For dates use date_trunc(\'month\', col) and current_date.';
  return '';
}

function insightPrompt(question, sql, result) {
  const rows = result.rows.slice(0, RESULT_ROWS);
  const more = result.rows.length > RESULT_ROWS ? `\n(${result.rows.length} rows in total, first ${RESULT_ROWS} shown)` : '';
  return `Question: ${question}\nSQL: ${sql}\nResult:\n${compact(rows)}${more}\n\n`
    + 'In 1-3 short sentences of plain English, answer the question using these numbers. '
    + 'Mention the most important figure. No JSON, no SQL, no markdown.';
}

/**
 * The answer sentence, written from the real result without a second model call.
 * Used for slow (CPU) models: instant, and the numbers are always right.
 */
export function quickInsight(card, result) {
  const rows = result.rows || [];
  if (!rows.length) return 'The query returned no rows.';
  const c = resolveChart(card.chart, result);
  const num = (v) => (typeof v === 'number' ? fmtCompact(v) : String(v ?? ''));
  // "2025-08-01T00:00:00Z" reads as "Aug 2025" (or "Aug 3, 2025" when it isn't the 1st).
  const label = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(String(v ?? ''));
    if (!m) return String(v ?? '');
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
    return m[3] === '01' ? `${mon} ${m[1]}` : `${mon} ${Number(m[3])}, ${m[1]}`;
  };
  if (c.type === 'kpi' || (rows.length === 1 && Object.values(rows[0]).some((x) => typeof x === 'number'))) {
    const vals = Object.values(rows[0]);
    const v = vals.find((x) => typeof x === 'number') ?? vals[0];
    const name = vals.find((x) => typeof x === 'string' && x.trim());
    return `${name ? label(name) : card.title}: ${num(v)}.`;
  }
  const numeric = rows.filter((r) => typeof r[c.y] === 'number');
  if (['bar', 'donut', 'line'].includes(c.type) && numeric.length) {
    const top = numeric.reduce((a, b) => (b[c.y] > a[c.y] ? b : a));
    const low = numeric.reduce((a, b) => (b[c.y] < a[c.y] ? b : a));
    if (numeric.length === 1) return `${label(top[c.x])}: ${num(top[c.y])}.`;
    if (c.type === 'line') {
      const first = numeric[0][c.y];
      const last = numeric[numeric.length - 1][c.y];
      const change = first ? Math.round(((last - first) / Math.abs(first)) * 100) : null;
      return `Highest in ${label(top[c.x])} at ${num(top[c.y])}, lowest in ${label(low[c.x])} at ${num(low[c.y])}`
        + `${change !== null ? `; ${change >= 0 ? 'up' : 'down'} ${Math.abs(change)}% from start to end` : ''}.`;
    }
    const total = numeric.reduce((t, r) => t + Math.max(0, r[c.y]), 0);
    const share = total > 0 && top[c.y] > 0 && !/avg|average|rate|ratio|%/i.test(`${card.title} ${card.sql}`)
      ? `, ${Math.round((top[c.y] / total) * 100)}% of the total` : '';
    return `${label(top[c.x])} is highest at ${num(top[c.y])}${share}; ${label(low[c.x])} is lowest at ${num(low[c.y])}.`;
  }
  return `${rows.length} ${rows.length === 1 ? 'row' : 'rows'} found; see the table.`;
}

function normalizeChart(chart) {
  const type = CHART_TYPES.has(chart?.type) ? chart.type : 'table';
  const out = { type };
  if (chart?.x) out.x = String(chart.x);
  if (chart?.y) out.y = String(chart.y);
  return out;
}

/**
 * Ask a question about table `data`.
 * llm(messages, {signal}) -> Promise<string>; query(sql) -> Promise<{columns, rows}> runs the
 * guarded SQL safely (db.safeQuery: one prepared statement, row cap, locked engine).
 * onStep({attempt, sql?, error?}) is called after every attempt.
 * Resolves { card, result, insight, steps }. card is null for plain answers.
 */
export async function runAgent({ question, schema, sample, llm, query, onStep = () => {}, signal, previous = null }) {
  const messages = [
    { role: 'system', content: instructions(schema, sample) },
    { role: 'user', content: questionPrompt(question, previous) },
  ];
  const steps = [];
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw stopped();
    let reply;
    try {
      reply = await llm(messages, { signal, json: true });
    } catch (e) {
      if (signal?.aborted) throw stopped();
      throw e;
    }
    reply = stripThinking(reply);
    messages.push({ role: 'assistant', content: reply });
    const step = { attempt };
    steps.push(step);
    const action = extractJSON(reply);
    // Small models sometimes put the SQL in an answer: run it as the query it is.
    if (action?.action === 'answer' && /^\s*(select|with)\s/i.test(String(action.text || ''))) {
      action.action = 'query';
      action.sql = String(action.text);
    }

    let error = null;
    let result = null;
    let sql = null;
    if (action?.action === 'answer' && action.text) {
      const text = String(action.text).trim();
      if (/\d/.test(text)) {
        // No query ran, so any number in this answer was made up.
        error = 'Numbers must come from the data. Reply with a query action instead of an answer.';
      } else if (!/[a-z]{2}/i.test(text) || /^<[^>]*>/.test(text)) {
        error = 'Your answer was empty or a placeholder. Reply with a query action.';
      } else {
        onStep(step);
        return { card: null, result: null, insight: text, steps };
      }
    } else if (!action || action.action !== 'query' || !action.sql) {
      error = 'Your reply was not a valid JSON object with "action":"query" and "sql".';
    } else {
      action.sql = repairSQL(String(action.sql), schema);
      const guard = checkSQL(action.sql);
      step.sql = action.sql;
      if (!guard.ok) error = guard.error;
      else {
        sql = guard.sql;
        try {
          const t0 = performance.now();
          result = await query(sql, { signal });
          step.ms = Math.round(performance.now() - t0);
          step.rows = result.rows.length;
        } catch (e) {
          error = String(e?.message || e).split('\n')[0];
        }
      }
    }
    if (error) {
      step.error = error;
      onStep(step);
      // The same error twice means the model is stuck; more tries only cost time.
      if (error === lastError) break;
      lastError = error;
      messages.push({ role: 'user', content: `That failed: ${error}${fixHint(error)}\nFix it and reply with one JSON object only.` });
      continue;
    }
    onStep(step);

    const card = {
      id: `ask-${Date.now().toString(36)}`,
      title: String(action.title || question).slice(0, 120),
      question,
      sql,
      chart: normalizeChart(action.chart),
    };
    let insight = '';
    if (llm.fast) return { card, result, insight: quickInsight(card, result), steps };
    try {
      insight = String(await llm([
        { role: 'system', content: 'You explain data analysis results briefly and accurately.' },
        { role: 'user', content: insightPrompt(question, sql, result) },
      ], { signal })).trim();
    } catch (e) {
      if (e?.name === 'AbortError' || signal?.aborted) throw stopped();
    }
    if (signal?.aborted) throw stopped();
    return { card, result, insight, steps };
  }
  const names = schema.map((c) => c.name).slice(0, 12).join(', ');
  throw new AgentError(`I couldn't answer that from this file. `
    + `The columns it has are: ${names}${schema.length > 12 ? ', …' : ''}. Try asking with those names.`, steps);
}

const CHAT_SYSTEM = [
  'You are DashAgent, a friendly data analyst assistant that runs entirely in the user\'s browser.',
  'No dataset is loaded yet. Answer helpfully and concisely in plain text (no JSON, no code unless asked).',
  'If the user wants to analyze their own data, tell them to drop a CSV file or click a sample dataset; then you can build charts and a dashboard from it.',
  'Their files never leave the browser: only column names, 5 sample rows and query results are ever sent to a model.',
].join('\n');

/**
 * General chat when no dataset is loaded. history = [{role:'user'|'assistant', content}].
 * Resolves the reply text.
 */
export async function chatOnly({ question, history = [], llm, signal }) {
  const messages = [{ role: 'system', content: CHAT_SYSTEM }, ...history.slice(-10), { role: 'user', content: question }];
  let reply;
  try {
    reply = await llm(messages, { signal });
  } catch (e) {
    if (signal?.aborted) throw stopped();
    throw e;
  }
  if (signal?.aborted) throw stopped();
  const answer = stripThinking(reply);
  const json = extractJSON(answer);
  if (json?.action === 'answer' && json.text) return String(json.text);
  return answer;
}
