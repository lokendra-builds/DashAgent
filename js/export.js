// Export the dashboard as ONE self-contained HTML file: inline CSS + SVG, no scripts,
// no external URLs. Open it anywhere, email it, or drop it on any static host.

import { chartHTML, resolveChart, esc } from './charts.js';

const EXPORT_CSS = `
*{box-sizing:border-box}body{margin:0;padding:28px;color:#fff;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
background-color:#0a0614;background-image:radial-gradient(900px 700px at 8% 0%,rgba(124,58,237,.7),transparent 60%),radial-gradient(800px 600px at 75% 0%,rgba(37,99,235,.55),transparent 60%),
radial-gradient(900px 700px at 100% 100%,rgba(236,72,153,.45),transparent 60%),radial-gradient(700px 600px at 30% 100%,rgba(249,115,22,.35),transparent 60%)}
header{display:flex;align-items:baseline;gap:12px;margin-bottom:18px}h1{margin:0;font-size:24px;letter-spacing:-.02em}header span{color:rgba(255,255,255,.65)}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;grid-auto-flow:row dense}
.card{grid-column:span 2;padding:18px 20px;border-radius:22px;min-width:0;background:linear-gradient(135deg,rgba(255,255,255,.15),rgba(255,255,255,.05));
border:1px solid rgba(255,255,255,.2);box-shadow:inset 0 1px 0 rgba(255,255,255,.4)}
.card.kind-kpi{grid-column:span 1}.card.kind-table,.card.kind-line,.card.wide{grid-column:1/-1}
.card h4{margin:0 0 10px;font-size:13px;font-weight:600}.kpi-value{font-size:32px;font-weight:700;font-variant-numeric:tabular-nums}
.kpi-row{display:flex;align-items:flex-end;justify-content:space-between;gap:8px}.spark{width:88px;height:28px;color:rgba(255,255,255,.85)}
.delta{display:inline-block;margin-top:4px;font-size:12px;font-weight:600;padding:1px 7px;border-radius:7px}
.delta.up{color:#bbf7d0;background:rgba(34,197,94,.24)}.delta.down{color:#fecaca;background:rgba(239,68,68,.26)}
.k-compare{color:rgba(255,255,255,.6);font-size:12px;margin-top:6px}.insight{margin:10px 0 0}
svg{width:100%;height:auto;display:block}svg.spark{width:88px;height:28px}svg text{fill:rgba(255,255,255,.72);font:11px ui-sans-serif,system-ui,sans-serif}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:rgba(255,255,255,.75)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px}.empty{color:rgba(255,255,255,.6);text-align:center;padding:24px 0}
.table-wrap{overflow:auto;max-height:420px}table{width:100%;border-collapse:collapse;font-size:12px}
th,td{padding:6px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,.08);white-space:nowrap}th{color:rgba(255,255,255,.7)}td.num{text-align:right}
.hint{color:rgba(255,255,255,.6);font-size:12px}footer{margin-top:22px;color:rgba(255,255,255,.7);font-size:12px}footer b{color:#fff}
@media (max-width:700px){.grid{grid-template-columns:1fr}.card,.card.kind-kpi{grid-column:1/-1}}
@media print{@page{size:A4 landscape;margin:0}html{background:#0b0716}body{padding:10mm;min-height:100vh;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.card{break-inside:avoid}.table-wrap{max-height:none;overflow:visible}}
`;

/**
 * cards: card[]; results: Map or object of card.id -> {columns, rows}; title: dataset name.
 * withTables: false leaves out raw-row tables (used for the shareable image).
 */
export function exportHTML(cards, results, title, { withTables = true } = {}) {
  const get = (id) => (results instanceof Map ? results.get(id) : results?.[id]);
  const items = cards.map((card) => {
    const result = get(card.id);
    if (!result) return null;
    const kind = result.rows.length ? resolveChart(card.chart, result).type : 'empty';
    if (!withTables && kind === 'table') return null;
    return { card, result, kind };
  }).filter(Boolean);
  // A lone half-width card takes the whole row, like on the live dashboard.
  const halves = items.filter((i) => !['kpi', 'line', 'table'].includes(i.kind));
  const lone = halves.length % 2 === 1 ? halves[halves.length - 1] : null;
  const body = items.map((i) => {
    const insight = i.card.insight ? `<p class="insight">${esc(i.card.insight)}</p>` : '';
    return `<section class="card kind-${i.kind}${i === lone ? ' wide' : ''}"><h4>${esc(i.card.title)}</h4>${chartHTML(i.card, i.result)}${insight}</section>`;
  }).join('\n');
  const date = new Date().toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · DashAgent</title><style>${EXPORT_CSS}</style></head>
<body><header><h1>${esc(title)}</h1><span>${date}</span></header>
<main class="grid">
${body}
</main>
<footer>Made with DashAgent · analysed in the browser with DuckDB</footer>
</body></html>`;
}

/**
 * Render the dashboard to a PNG Blob (2x for crisp text), entirely in the browser:
 * the self-contained export page is laid out in a hidden iframe, wrapped in an SVG
 * <foreignObject>, and drawn onto a canvas. Raw-row tables are left out of shared images.
 * Rejects if the browser refuses to draw it.
 */
export async function exportPNG(cards, results, title, { width = 1400, scale = 2 } = {}) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:10px;border:0;visibility:hidden`;
  document.body.appendChild(frame);
  try {
    await new Promise((resolve) => {
      frame.onload = resolve;
      frame.srcdoc = exportHTML(cards, results, title, { withTables: false });
    });
    const doc = frame.contentDocument;
    const height = Math.ceil(doc.documentElement.scrollHeight);
    const markup = new XMLSerializer().serializeToString(doc.documentElement);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
      + `<foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject></svg>`;
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('This browser could not render the image.'));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    return await new Promise((resolve, reject) => canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('This browser could not create the image.'))), 'image/png',
    ));
  } finally {
    frame.remove();
  }
}
