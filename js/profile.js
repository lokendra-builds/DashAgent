// Column profiling and the deterministic auto-dashboard (works with no model at all).
// A card is { id, title, sql, chart: { type: 'kpi'|'bar'|'line'|'donut'|'table', x?, y? } }.

import { quoteIdent as q } from './db.js';

const NUMBER_RE = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i;
const DATE_RE = /^(DATE|TIMESTAMP)/i;
const AVG_NAME_RE = /rate|ratio|percent|pct|share|avg|average|score|price|age|temp/i;
const ID_NAME_RE = /(^id$|_id$|^id_)/i;
const CATEGORY_MAX = 50;
const MONEY_NAME_RE = /revenue|sales|amount|total|profit|income|spend|cost|gmv|value/i;

export function humanize(name) {
  const s = String(name).replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Profile table `data`. `query(sql)` is db.query.
 * Returns [{ name, type, kind: 'number'|'date'|'category'|'text', distinct, spanDays? }].
 */
export async function profileTable(query, table = 'data') {
  const cols = (await query(`DESCRIBE ${table}`)).rows.map((r) => ({ name: r.column_name, type: r.column_type }));
  if (!cols.length) return [];
  const parts = cols.map((c, i) => `COUNT(DISTINCT ${q(c.name)}) AS d${i}`);
  cols.forEach((c, i) => {
    if (DATE_RE.test(c.type)) parts.push(`date_diff('day', MIN(${q(c.name)}), MAX(${q(c.name)})) AS s${i}`);
  });
  const stats = (await query(`SELECT ${parts.join(', ')} FROM ${table}`)).rows[0];
  return cols.map((c, i) => {
    const distinct = Number(stats[`d${i}`]);
    let kind = 'text';
    if (NUMBER_RE.test(c.type)) kind = 'number';
    else if (DATE_RE.test(c.type)) kind = 'date';
    else if (distinct <= CATEGORY_MAX) kind = 'category';
    const out = { name: c.name, type: c.type, kind, distinct };
    if (kind === 'date') out.spanDays = Number(stats[`s${i}`] ?? 0);
    return out;
  });
}

function measureOf(col) {
  const avg = AVG_NAME_RE.test(col.name);
  return {
    expr: `${avg ? 'AVG' : 'SUM'}(${q(col.name)})`,
    label: `${avg ? 'Average' : 'Total'} ${humanize(col.name).toLowerCase()}`,
    name: humanize(col.name),
  };
}

function grainFor(spanDays) {
  if (spanDays > 120) return 'month';
  if (spanDays > 21) return 'week';
  return 'day';
}

function mainMeasure(measures) {
  const sums = measures.filter((m) => m.expr.startsWith('SUM'));
  return sums.find((m) => MONEY_NAME_RE.test(m.name)) || sums[0] || measures[0];
}

/** Build the starter dashboard from a profile. Every card's SQL runs against `data`. */
export function autoCards(profiled) {
  const cards = [];
  const add = (card) => cards.push({ id: `auto-${cards.length}`, ...card });
  const numbers = profiled.filter((c) => c.kind === 'number' && !ID_NAME_RE.test(c.name));
  const dates = profiled.filter((c) => c.kind === 'date');
  const cats = profiled.filter((c) => c.kind === 'category' && c.distinct > 1);
  const measures = numbers.map(measureOf);
  const main = mainMeasure(measures);
  const value = main ? main.expr : 'COUNT(*)';
  const valueName = main ? main.name : 'Rows';

  // KPIs: rows, the headline measure, its average per row, and one more measure.
  // With a date column each KPI also gets a trend series (sparkline + 2nd-half vs 1st-half change).
  const d0 = dates[0];
  const trendGrain = d0 ? grainFor(d0.spanDays ?? 0) : null;
  const trend = (expr, agg) => (d0 ? {
    sql: `SELECT date_trunc('${trendGrain}', ${q(d0.name)}) AS period, ${expr} AS value FROM data `
      + `WHERE ${q(d0.name)} IS NOT NULL GROUP BY 1 ORDER BY 1`,
    agg,
  } : undefined);
  const kpi = (title, expr, agg) => add({
    title, sql: `SELECT ${expr} AS value FROM data`, chart: { type: 'kpi', y: 'value' }, trend: trend(expr, agg),
  });
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  kpi('Rows', 'COUNT(*)', 'sum');
  if (main) {
    kpi(cap(main.label), main.expr, main.expr.startsWith('SUM') ? 'sum' : 'avg');
    if (main.expr.startsWith('SUM')) kpi(`Average ${main.name.toLowerCase()}`, main.expr.replace(/^SUM/, 'AVG'), 'avg');
    const second = measures.find((m) => m !== main);
    if (second) kpi(cap(second.label), second.expr, second.expr.startsWith('SUM') ? 'sum' : 'avg');
  }

  if (dates.length) {
    const d = dates[0];
    const grain = grainFor(d.spanDays ?? 0);
    add({
      title: `${valueName} by ${grain}`,
      sql: `SELECT date_trunc('${grain}', ${q(d.name)}) AS period, ${value} AS value FROM data `
        + `WHERE ${q(d.name)} IS NOT NULL GROUP BY 1 ORDER BY 1`,
      chart: { type: 'line', x: 'period', y: 'value' },
    });
  }

  cats.slice(0, 2).forEach((c, i) => {
    const donut = i === 1 && c.distinct <= 8;
    add({
      title: `${valueName} by ${humanize(c.name).toLowerCase()}`,
      sql: `SELECT ${q(c.name)} AS label, ${value} AS value FROM data GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      chart: { type: donut ? 'donut' : 'bar', x: 'label', y: 'value' },
    });
  });

  add({ title: 'Data preview', sql: 'SELECT * FROM data LIMIT 50', chart: { type: 'table' } });
  return cards;
}

/** Starter questions shown under the ask bar. */
export function suggestQuestions(profiled) {
  const num = mainMeasure(profiled.filter((c) => c.kind === 'number' && !ID_NAME_RE.test(c.name)).map(measureOf));
  const cat = profiled.find((c) => c.kind === 'category');
  const date = profiled.find((c) => c.kind === 'date');
  const n = num ? num.name.toLowerCase() : 'rows';
  const out = [];
  if (cat) out.push(`Which ${humanize(cat.name).toLowerCase()} has the highest ${n}?`);
  if (date && num) out.push(`How did ${n} change over time?`);
  if (cat && date) out.push(`Which ${humanize(cat.name).toLowerCase()} grew fastest?`);
  out.push('What stands out in this data?');
  return out.slice(0, 4);
}
