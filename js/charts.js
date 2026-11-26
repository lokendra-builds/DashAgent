// Hand-written SVG charts in the glass style. No chart library, no dependencies.
// renderCard(card, result) -> HTMLElement. result = { columns: string[], rows: object[] }.
// Data points carry data-tip="label: value" for the page's hover tooltip.

import { icon, CHART_ICON } from './icons.js';

// Light, equal-weight tints that read as glass on the vivid background (max 6 + grey for the rest).
export const PALETTE = ['#ffffff', '#7dd3fc', '#f0abfc', '#fcd34d', '#86efac', '#c4b5fd', 'rgba(255,255,255,.35)'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtNumber(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v ?? '');
  const a = Math.abs(v);
  const short = (n, s) => `${parseFloat(n.toFixed(2))}${s}`;
  if (a >= 1e9) return short(v / 1e9, 'B');
  if (a >= 1e6) return short(v / 1e6, 'M');
  return v.toLocaleString('en-US', { maximumFractionDigits: a < 1 ? 3 : 2 });
}

/** Short form for tight spaces: 707133 -> 707.13K. */
export function fmtCompact(v) {
  if (typeof v === 'number' && Math.abs(v) >= 1e4 && Math.abs(v) < 1e6) return `${parseFloat((v / 1e3).toFixed(2))}K`;
  return fmtNumber(v);
}

function fmtValue(v) {
  return typeof v === 'number' ? fmtNumber(v) : String(v ?? '—');
}

/** Round axis ticks to 1/2/2.5/5 x 10^n steps. */
export function niceTicks(min, max, count = 4) {
  // A constant series (e.g. all zeros) would collapse to one tick; open up a range around it.
  if (!(max > min)) {
    if (min === 0) max = 1;
    else if (min > 0) min = 0;
    else max = 0;
  }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(parseFloat(v.toPrecision(12)));
  return ticks;
}

function shortLabel(v, max = 14) {
  let s = String(v ?? '—');
  if (/^\d{4}-\d{2}-\d{2}T00:00:00/.test(s)) s = s.slice(0, 10);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Month starts read as "Jan 2025"; other ISO dates drop the time part. */
function axisLabel(v, monthly) {
  const s = String(v ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m && monthly) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  if (m) return s.slice(0, 10);
  return shortLabel(s, 10);
}

function tip(label, value) {
  return `data-tip="${esc(`${label}: ${fmtValue(value)}`)}"`;
}

function isNumeric(rows, col) {
  return rows.length > 0 && rows.every((r) => r[col] === null || typeof r[col] === 'number');
}

/** Pick the chart that can actually be drawn from this result; fall back to a table. */
export function resolveChart(chart, result) {
  const type = chart?.type || 'table';
  const cols = result.columns;
  if (type === 'table') return { type };
  if (type === 'kpi') {
    const y = cols.includes(chart.y) ? chart.y : cols[0];
    return result.rows.length === 1 && isNumeric(result.rows, y) ? { type, y } : { type: 'table' };
  }
  const { x, y } = chart;
  if (!cols.includes(x) || !cols.includes(y) || !isNumeric(result.rows, y)) return { type: 'table' };
  return { type, x, y };
}

function barSVG(rows, x, y, width) {
  const data = rows.slice(0, 20);
  const vals = data.map((r) => r[y] ?? 0);
  const posMax = Math.max(0, ...vals);
  const negMax = Math.max(0, ...vals.map((v) => -v));
  const hasNeg = negMax > 0;
  const rowH = 30;
  // Drawn at the card's real pixel width when known, so text stays the same size on any screen.
  const w = Math.max(280, Math.round(width || 440));
  const labelW = 120;
  const valueW = 64;
  // Negative values get their own label gutter left of the plot; bars grow from a zero baseline.
  const left = labelW + (hasNeg ? valueW : 0);
  const plotW = w - left - (posMax > 0 || !hasNeg ? valueW : 0);
  const span = posMax + negMax || 1;
  const zeroX = left + (negMax / span) * plotW;
  const h = data.length * rowH + 4;
  const bars = data.map((r, i) => {
    const v = vals[i];
    const neg = v < 0;
    const len = Math.max(2, (Math.abs(v) / span) * plotW);
    const bx = neg ? zeroX - len : zeroX;
    const top = i * rowH + 4;
    const valueX = neg ? bx - 6 : bx + len + 6;
    const cls = `bar${i === 0 ? ' top' : ''}${neg ? ' neg' : ''}`;
    // Negative bars animate out of the baseline too (the stylesheet grows bars from their left edge).
    const style = `--i:${i}${neg ? ';transform-origin:right center' : ''}`;
    return `<text x="${labelW - 8}" y="${top + 15}" text-anchor="end">${esc(shortLabel(r[x], 18))}</text>`
      + `<rect class="${cls}" style="${style}" x="${bx.toFixed(1)}" y="${top}" width="${len.toFixed(1)}" height="${rowH - 10}" rx="6" fill="${i === 0 ? '#ffffff' : 'rgba(255,255,255,.28)'}" ${tip(r[x], v)}></rect>`
      + `<text x="${valueX.toFixed(1)}" y="${top + 15}"${neg ? ' text-anchor="end"' : ''}>${esc(fmtCompact(v))}</text>`;
  }).join('');
  const baseline = hasNeg
    ? `<line class="zero" x1="${zeroX.toFixed(1)}" x2="${zeroX.toFixed(1)}" y1="0" y2="${h}" stroke="rgba(255,255,255,.45)" stroke-width="1"/>`
    : '';
  return `<svg viewBox="0 0 ${w} ${h}">${bars}${baseline}</svg>`;
}

function lineSVG(rows, x, y, width) {
  // A trend reads left to right in time, whatever order the query returned.
  const sortable = rows.every((r) => !Number.isNaN(Date.parse(String(r[x] ?? ''))) && /\d{4}/.test(String(r[x] ?? '')));
  const data = (sortable ? [...rows].sort((a, b) => Date.parse(a[x]) - Date.parse(b[x])) : rows).slice(0, 1000);
  const w = Math.max(320, Math.round(width || 1000));
  const h = 280;
  const pad = { l: 60, r: 16, t: 14, b: 30 };
  const vals = data.map((r) => r[y] ?? 0);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(...vals));
  const min = ticks[0];
  const max = ticks[ticks.length - 1] === min ? min + 1 : ticks[ticks.length - 1];
  const monthly = data.every((r) => /^\d{4}-\d{2}-01/.test(String(r[x] ?? '')));
  const px = (i) => pad.l + (data.length === 1 ? (w - pad.l - pad.r) / 2 : (i / (data.length - 1)) * (w - pad.l - pad.r));
  const py = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);
  const pts = vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`);
  const grid = ticks.map((v) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${py(v)}" y2="${py(v)}" stroke="rgba(255,255,255,.07)"/>`
    + `<text x="${pad.l - 8}" y="${py(v) + 4}" text-anchor="end">${esc(fmtNumber(v))}</text>`).join('');
  const every = Math.max(1, Math.ceil(data.length / 8));
  const xLabels = data.map((r, i) => (i % every === 0
    ? `<text x="${px(i)}" y="${h - 8}" text-anchor="middle">${esc(axisLabel(r[x], monthly))}</text>` : '')).join('');
  const showDots = data.length <= 60;
  const dots = showDots ? data.map((r, i) => `<circle class="dot" cx="${px(i)}" cy="${py(vals[i])}" r="3.5" fill="#ffffff"/>`).join('') : '';
  // Invisible, larger hit areas so points are easy to hover and tap.
  const hits = showDots ? data.map((r, i) => `<circle class="hit" cx="${px(i)}" cy="${py(vals[i])}" r="14" fill="transparent" ${tip(axisLabel(r[x], monthly), vals[i])}/>`).join('') : '';
  const area = `M${px(0)},${py(min)} L${pts.join(' L')} L${px(data.length - 1)},${py(min)} Z`;
  return `<svg viewBox="0 0 ${w} ${h}"><defs><linearGradient id="area-grad" x1="0" x2="0" y1="0" y2="1">`
    + `<stop offset="0" stop-color="#ffffff" stop-opacity=".22"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs>`
    + `${grid}<path class="area" d="${area}" fill="url(#area-grad)"/>`
    + `<polyline class="line-path" pathLength="1" points="${pts.join(' ')}" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>`
    + `${dots}${xLabels}${hits}</svg>`;
}

function donutSVG(rows, x, y) {
  let data = rows.filter((r) => (r[y] ?? 0) > 0);
  if (data.length > 8) {
    const rest = data.slice(7).reduce((s, r) => s + r[y], 0);
    data = [...data.slice(0, 7), { [x]: 'Other', [y]: rest }];
  }
  const total = data.reduce((s, r) => s + r[y], 0) || 1;
  const cx = 110;
  const cy = 110;
  const R = 95;
  const r0 = 58;
  let a = -Math.PI / 2;
  const arcs = data.map((r, i) => {
    const frac = r[y] / total;
    const a2 = a + frac * Math.PI * 2 - (data.length > 1 ? 0.012 : 0);
    const large = a2 - a > Math.PI ? 1 : 0;
    const p = (ang, rad) => `${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`;
    const d = frac >= 0.9999
      ? `M${cx - R},${cy} a${R},${R} 0 1,0 ${2 * R},0 a${R},${R} 0 1,0 ${-2 * R},0 M${cx - r0},${cy} a${r0},${r0} 0 1,1 ${2 * r0},0 a${r0},${r0} 0 1,1 ${-2 * r0},0`
      : `M${p(a, R)} A${R},${R} 0 ${large} 1 ${p(a2, R)} L${p(a2, r0)} A${r0},${r0} 0 ${large} 0 ${p(a, r0)} Z`;
    a += frac * Math.PI * 2;
    return `<path class="slice" style="--i:${i}" d="${d}" fill="${PALETTE[i % PALETTE.length]}" fill-rule="evenodd" ${tip(r[x], r[y])}/>`;
  }).join('');
  const legend = data.map((r, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(shortLabel(r[x], 20))} · ${Math.round((r[y] / total) * 100)}%</span>`).join('');
  return `<svg viewBox="0 0 220 220" style="max-width:240px;margin:auto">${arcs}`
    + `<text x="${cx}" y="${cy + 5}" text-anchor="middle" style="font-size:16px;fill:#eceaf6">${esc(fmtNumber(total))}</text></svg>`
    + `<div class="legend">${legend}</div>`;
}

function tableHTML(result, limit = 100) {
  const cols = result.columns;
  const rows = result.rows.slice(0, limit);
  const head = cols.map((c) => `<th scope="col">${esc(c)}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map((c) => {
    const v = r[c];
    return typeof v === 'number' ? `<td class="num">${esc(fmtNumber(v))}</td>` : `<td>${esc(v ?? '')}</td>`;
  }).join('')}</tr>`).join('');
  const more = result.rows.length > limit ? `<p class="hint">Showing ${limit} of ${result.rows.length} rows.</p>` : '';
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
}

/** Inner HTML for a chart, also used by the HTML export. */
export function chartHTML(card, result, { width } = {}) {
  if (!result.rows.length) return '<div class="empty">No results</div>';
  const c = resolveChart(card.chart, result);
  switch (c.type) {
    case 'kpi': return kpiHTML(result.rows[0][c.y], result.trend);
    case 'bar': return barSVG(result.rows, c.x, c.y, width);
    case 'line': return lineSVG(result.rows, c.x, c.y, width);
    case 'donut': return donutSVG(result.rows, c.x, c.y);
    default: return tableHTML(result);
  }
}

/** Change between the 1st and 2nd half of a trend series: sums for totals, means for averages. */
export function trendDelta(rows, agg = 'sum') {
  const vals = (rows || []).map((r) => r.value).filter((v) => typeof v === 'number');
  if (vals.length < 4) return null;
  const mid = Math.floor(vals.length / 2);
  const reduce = (a) => (agg === 'avg' ? a.reduce((s, v) => s + v, 0) / a.length : a.reduce((s, v) => s + v, 0));
  const first = reduce(vals.slice(0, mid));
  const second = reduce(vals.slice(vals.length - mid));
  if (!first) return null;
  return { pct: ((second - first) / Math.abs(first)) * 100, first, second };
}

function sparkSVG(vals) {
  const w = 88;
  const h = 28;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / (max - min || 1)) * (h - 6)).toFixed(1)}`);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

function kpiHTML(value, trend) {
  const delta = trend ? trendDelta(trend.rows, trend.agg) : null;
  if (!delta) return `<div class="kpi-value">${esc(fmtValue(value))}</div>`;
  const up = delta.pct >= 0;
  const badge = `<span class="delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(delta.pct).toFixed(1)}%</span>`;
  return `<div class="kpi-row"><div><div class="kpi-value">${esc(fmtValue(value))}</div>${badge}</div>${sparkSVG(trend.rows.map((r) => r.value ?? 0))}</div>`
    + `<div class="k-compare">2nd half vs 1st half of the period</div>`;
}

/** Short insight shown next to a chart title, e.g. "Peak in Aug 2025 at 301.28K". */
export function chartInsight(card, result) {
  if (!result.rows.length) return '';
  const c = resolveChart(card.chart, result);
  if (!['bar', 'line', 'donut'].includes(c.type)) return '';
  const rows = result.rows.filter((r) => typeof r[c.y] === 'number');
  if (rows.length < 2) return '';
  const sorted = [...rows].sort((a, b) => b[c.y] - a[c.y]);
  const top = sorted[0];
  if (c.type === 'line') {
    const monthly = rows.every((r) => /^\d{4}-\d{2}-01/.test(String(r[c.x] ?? '')));
    return `Peak in ${axisLabel(top[c.x], monthly)} at ${fmtCompact(top[c.y])}`;
  }
  if (c.type === 'donut') {
    const total = rows.reduce((t, r) => t + Math.max(0, r[c.y]), 0) || 1;
    return `${shortLabel(top[c.x], 24)} is ${Math.round((top[c.y] / total) * 100)}% of the total`;
  }
  // Shares only make sense for additive, non-negative values (not rates or % changes).
  if (rows.some((r) => r[c.y] < 0) || /%|rate|ratio|growth|average|avg/i.test(card.title || '')) {
    return `${shortLabel(top[c.x], 24)} is highest at ${fmtCompact(top[c.y])}`;
  }
  const total = rows.reduce((t, r) => t + Math.max(0, r[c.y]), 0);
  const share = total > 0 && top[c.y] > 0 ? Math.round((top[c.y] / total) * 100) : null;
  return `${shortLabel(top[c.x], 24)} leads${share !== null ? ` with ${share}% of the total` : ''}`;
}

/** One-line description of a chart for screen readers. */
function chartSummary(card, result, type) {
  const { x, y } = resolveChart(card.chart, result);
  const top = [...result.rows].sort((a, b) => (b[y] ?? 0) - (a[y] ?? 0))[0];
  const kind = { bar: 'Bar chart', line: 'Line chart', donut: 'Donut chart' }[type];
  return `${kind}: ${card.title}. ${result.rows.length} points; highest ${shortLabel(top?.[x], 30)} at ${fmtValue(top?.[y])}.`;
}

export function renderCard(card, result) {
  const el = document.createElement('article');
  const kind = result.rows.length ? resolveChart(card.chart, result).type : 'empty';
  el.className = `card glass kind-${kind}`;
  el.dataset.id = card.id;
  const graphic = ['bar', 'line', 'donut'].includes(kind);
  const a11y = graphic ? ` role="img" aria-label="${esc(chartSummary(card, result, kind))}"` : '';
  const sub = chartInsight(card, result);
  el.innerHTML = `<div class="card-head"><span class="card-icon">${icon(CHART_ICON[kind] || 'table', 14)}</span>`
    + `<h4>${esc(card.title)}</h4>${sub ? `<span class="card-sub">${esc(sub)}</span>` : ''}<div class="card-actions"></div></div>`
    + `<div class="chart"${a11y}>${chartHTML(card, result)}</div>`;
  return el;
}
