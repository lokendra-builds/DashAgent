// No-key demo for the two sample datasets. Each entry is a recorded agent run: the
// model's reply (title, SQL, chart) is fixed, but the SQL really runs in DuckDB and
// the insight sentence is computed from the real result, so every number is true.

import { fmtCompact } from './charts.js';

const pct = (a, total) => (total ? Math.round((a / total) * 100) : 0);
const sum = (rows) => rows.reduce((t, r) => t + (r.value || 0), 0);
const monthName = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)
  .toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });

function leaderInsight(noun) {
  return (rows) => {
    const top = rows[0];
    const last = rows[rows.length - 1];
    return `${top.label} has the highest ${noun} at ${fmtCompact(top.value)}, ${pct(top.value, sum(rows))}% of the total. `
      + `${last.label} is lowest at ${fmtCompact(last.value)}.`;
  };
}

function trendInsight(noun) {
  return (rows) => {
    const sorted = [...rows].sort((a, b) => b.value - a.value);
    const peak = sorted[0];
    const low = sorted[sorted.length - 1];
    const first = rows[0].value;
    const end = rows[rows.length - 1].value;
    const change = first ? Math.round(((end - first) / first) * 100) : 0;
    return `${noun} peaked in ${monthName(peak.period)} at ${fmtCompact(peak.value)} and was lowest in ${monthName(low.period)} `
      + `(${fmtCompact(low.value)}). From the first month to the last it ${change >= 0 ? 'rose' : 'fell'} ${Math.abs(change)}%.`;
  };
}

function growthInsight(noun) {
  return (rows) => {
    const top = rows[0];
    const last = rows[rows.length - 1];
    return `${top.label} grew fastest: ${noun} ${top.value >= 0 ? 'up' : 'down'} ${Math.abs(top.value)}% in the second half of the year `
      + `vs the first. ${last.label} changed least (${last.value >= 0 ? '+' : ''}${last.value}%).`;
  };
}

const growthSQL = (cat, measure, date) => `SELECT "${cat}" AS label, ROUND(100.0 * (SUM(CASE WHEN "${date}" >= DATE '2025-07-01' THEN "${measure}" END) `
  + `/ NULLIF(SUM(CASE WHEN "${date}" < DATE '2025-07-01' THEN "${measure}" END), 0) - 1), 1) AS value `
  + 'FROM data GROUP BY 1 ORDER BY 2 DESC';

const SCRIPTS = {
  sales: [
    {
      question: 'Which region has the highest revenue?',
      title: 'Revenue by region',
      sql: 'SELECT "region" AS label, ROUND(SUM("revenue"), 2) AS value FROM data GROUP BY 1 ORDER BY 2 DESC',
      chart: { type: 'bar', x: 'label', y: 'value' },
      insight: leaderInsight('revenue'),
    },
    {
      question: 'How did revenue change over time?',
      title: 'Monthly revenue',
      sql: 'SELECT date_trunc(\'month\', "order_date") AS period, ROUND(SUM("revenue"), 2) AS value FROM data GROUP BY 1 ORDER BY 1',
      chart: { type: 'line', x: 'period', y: 'value' },
      insight: trendInsight('Revenue'),
    },
    {
      question: 'Which region grew fastest?',
      title: 'Revenue growth by region, H2 vs H1 (%)',
      sql: growthSQL('region', 'revenue', 'order_date'),
      chart: { type: 'bar', x: 'label', y: 'value' },
      insight: growthInsight('revenue'),
    },
    {
      question: 'What stands out in this data?',
      title: 'Revenue share by category',
      sql: 'SELECT "category" AS label, ROUND(SUM("revenue"), 2) AS value FROM data GROUP BY 1 ORDER BY 2 DESC',
      chart: { type: 'donut', x: 'label', y: 'value' },
      insight: (rows) => `Revenue is concentrated: ${rows[0].label} alone brings ${pct(rows[0].value, sum(rows))}% `
        + `(${fmtCompact(rows[0].value)}), while ${rows[rows.length - 1].label} is only ${pct(rows[rows.length - 1].value, sum(rows))}%.`,
    },
    {
      question: 'Which products sell the most units?',
      title: 'Units sold by product',
      sql: 'SELECT "product" AS label, SUM("units") AS value FROM data GROUP BY 1 ORDER BY 2 DESC LIMIT 10',
      chart: { type: 'bar', x: 'label', y: 'value' },
      insight: leaderInsight('units sold'),
    },
  ],
  traffic: [
    {
      question: 'Which channel has the highest sessions?',
      title: 'Sessions by channel',
      sql: 'SELECT "channel" AS label, SUM("sessions") AS value FROM data GROUP BY 1 ORDER BY 2 DESC',
      chart: { type: 'bar', x: 'label', y: 'value' },
      insight: leaderInsight('sessions'),
    },
    {
      question: 'How did sessions change over time?',
      title: 'Monthly sessions',
      sql: 'SELECT date_trunc(\'month\', "date") AS period, SUM("sessions") AS value FROM data GROUP BY 1 ORDER BY 1',
      chart: { type: 'line', x: 'period', y: 'value' },
      insight: trendInsight('Sessions'),
    },
    {
      question: 'Which channel grew fastest?',
      title: 'Session growth by channel, H2 vs H1 (%)',
      sql: growthSQL('channel', 'sessions', 'date'),
      chart: { type: 'bar', x: 'label', y: 'value' },
      insight: growthInsight('sessions'),
    },
    {
      question: 'What stands out in this data?',
      title: 'Signup rate by channel (%)',
      sql: 'SELECT "channel" AS label, ROUND(100.0 * SUM("signups") / SUM("sessions"), 2) AS value FROM data GROUP BY 1 ORDER BY 2 DESC',
      chart: { type: 'bar', x: 'label', y: 'value' },
      insight: (rows) => `${rows[0].label} converts best: ${rows[0].value}% of its sessions sign up, `
        + `vs ${rows[rows.length - 1].value}% for ${rows[rows.length - 1].label}.`,
    },
  ],
};

export function demoScript(sample) {
  return SCRIPTS[sample] || [];
}

const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?.!]+$/, '');

export function findRecorded(sample, question) {
  return demoScript(sample).find((s) => norm(s.question) === norm(question)) || null;
}

/** Recorded questions the visitor has not asked yet (for next-step suggestions). */
export function remainingQuestions(sample, asked) {
  const done = new Set(asked.map(norm));
  return demoScript(sample).map((s) => s.question).filter((q) => !done.has(norm(q)));
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
});

/**
 * An llm(messages) that replays the recorded run for `sample`. It answers the agent's two
 * calls: the SQL step (returns the recorded JSON) and the insight step (computes the
 * sentence from the real result rows in the prompt).
 */
export function makeDemoLLM(sample) {
  return async (messages, { signal } = {}) => {
    await wait(window.__demoDelayMs ?? 650, signal);
    const last = messages[messages.length - 1].content;
    const q = /^Question: (.*)$/m.exec(last)?.[1] || '';
    const item = findRecorded(sample, q);
    if (!item) {
      const e = new Error('This demo has recorded answers for the suggested questions only. Download the in-browser model, or choose another model, to ask anything about your data.');
      e.code = 'DEMO_LIMIT';
      throw e;
    }
    if (!/^Result:$/m.test(last)) { // the SQL step (the insight step carries a Result: block)
      return JSON.stringify({ action: 'query', sql: item.sql, chart: item.chart, title: item.title });
    }
    const rows = last.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    return item.insight(rows);
  };
}
