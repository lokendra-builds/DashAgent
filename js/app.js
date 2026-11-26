// DashAgent UI wiring: dashboard on the left, chat on the right.
// Every chart the agent makes lands on the dashboard automatically.
// Heavy libraries (DuckDB, WebLLM) load lazily on first use.

import * as db from './db.js';
import { profileTable, autoCards, suggestQuestions, humanize } from './profile.js';
import { renderCard, chartHTML, esc } from './charts.js';
import { putItem, getItem, deleteItem, listItems, getSettings, saveSettings, clearAll, hasSavedSettings } from './storage.js';
import { listWebLLMModels, defaultWebLLMModel, loadWebLLM, hasWebGPU, webllmReady, makeLLM, isWebLLMCachedFast,
  DEFAULT_WEBLLM_MODEL, KNOWN_MODEL_GB, friendlyModelName, compatibleModelId,
  CPU_MODELS, cpuModelFor, wllamaReady, isWllamaCached, loadWllama } from './llm.js';
import { runAgent, chatOnly, instructions } from './agent.js';
import { exportHTML, exportPNG } from './export.js';
import { makeDemoLLM, remainingQuestions } from './demo.js';
import { icon, hydrateIcons } from './icons.js';

const MOCK = new URLSearchParams(location.search).has('mock');

const $ = (sel) => document.querySelector(sel);

export const state = {
  rangeDays: 0, // active date range (0 = all data)
  datasetName: '',
  sample: null, // 'sales' | 'traffic' when a bundled sample is loaded (enables the no-key demo)
  datasetKey: '',
  profiled: [],
  cards: [],
  results: new Map(),
  chat: [],
  // The open conversation (see saveDashboard for the stored shape).
  convId: '',
  convCreated: 0,
  convTitle: '',
  convRenamed: false,
};

function setStatus(text, isError = false) {
  const el = $('#status');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', isError);
}

function button(label, onClick, cls = 'btn small ghost') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// ---- Dashboard ----

async function runCard(card) {
  try {
    const result = await db.safeQuery(card.sql);
    if (card.trend?.sql) {
      // The sparkline is a bonus: a failed trend query never breaks the KPI.
      result.trend = await db.safeQuery(card.trend.sql).then((r) => ({ rows: r.rows, agg: card.trend.agg })).catch(() => null);
    }
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function errorCard(card, message) {
  const el = document.createElement('article');
  el.className = 'card glass error';
  el.dataset.id = card.id;
  el.innerHTML = `<div class="card-head"><h4>${esc(card.title)}</h4><div class="card-actions"></div></div><p class="insight">${esc(message)}</p>`;
  return el;
}

function addInsight(el, text) {
  if (!text) return;
  const p = document.createElement('p');
  p.className = 'insight';
  p.textContent = text;
  el.appendChild(p);
}

function addRemove(el, card) {
  const b = button('', async () => {
    state.cards = state.cards.filter((c) => c.id !== card.id);
    await saveDashboard();
    el.remove();
    layoutKPIs();
  }, 'icon-btn card-remove');
  b.innerHTML = icon('x', 16);
  b.setAttribute('aria-label', 'Remove');
  b.title = 'Remove from dashboard';
  el.querySelector('.card-actions').appendChild(b);
}

/** KPIs share the first row evenly; a lone half-width card takes the full row. */
function layoutKPIs() {
  const n = state.cards.filter((c) => c.chart?.type === 'kpi').length || 1;
  $('#dashboard').style.setProperty('--kpis', String(Math.min(n, 4)));
  const halves = [...document.querySelectorAll('#dashboard .card')]
    .filter((el) => !/kind-(kpi|line|table)/.test(el.className));
  halves.forEach((el) => el.classList.remove('wide'));
  if (halves.length % 2 === 1) halves[halves.length - 1].classList.add('wide');
}

function showSkeleton() {
  $('#dashboard').replaceChildren(...[0, 1, 2, 3, 4, 5].map((i) => {
    const el = document.createElement('div');
    el.className = `glass skeleton ${i < 3 ? 'sk-kpi' : i === 3 ? 'sk-line' : 'sk-chart'}`;
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="sk sk-title"></div><div class="sk sk-body"></div>';
    return el;
  }));
  $('#dashboard').style.setProperty('--kpis', '3');
}

function cardEl(card, run) {
  const el = run.ok ? renderCard(card, run.result) : errorCard(card, run.error);
  // An answer's sentence is frozen when asked; say so if the range has changed since.
  const asked = card.rangeDays || 0;
  const now = state.rangeDays || 0;
  addInsight(el, card.insight && asked !== now ? `Written for ${RANGE_LABEL[asked] || 'another range'}: ${card.insight}` : card.insight);
  if (card.insight && asked !== now) el.querySelector('.insight:last-of-type')?.classList.add('stale');
  if (card.pinned) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'New · from chat';
    el.querySelector('.card-head h4')?.after(tag);
    addRemove(el, card);
  }
  return el;
}

/**
 * Redraw bar and line charts at each card's real pixel width, so axis text and bars keep the
 * same size from a laptop to a 4K screen (an SVG viewBox would otherwise scale its text).
 */
function fitCharts() {
  document.querySelectorAll('#dashboard .card.kind-bar, #dashboard .card.kind-line').forEach((el) => {
    const chart = el.querySelector('.chart');
    const card = state.cards.find((c) => c.id === el.dataset.id);
    const result = state.results.get(el.dataset.id);
    if (!chart || !card || !result) return;
    const width = Math.round(chart.clientWidth);
    if (!width || Math.abs(width - Number(chart.dataset.w || 0)) < 8) return;
    chart.dataset.w = String(width);
    chart.innerHTML = chartHTML(card, result, { width });
  });
}

let fitTimer = null;
const chartResizer = typeof ResizeObserver === 'function'
  ? new ResizeObserver(() => { clearTimeout(fitTimer); fitTimer = setTimeout(fitCharts, 120); })
  : null;

export async function renderDashboard() {
  const els = [];
  for (const card of state.cards) {
    const run = await runCard(card);
    if (run.ok) state.results.set(card.id, run.result);
    const el = cardEl(card, run);
    el.style.setProperty('--i', String(els.length));
    els.push(el);
  }
  $('#dashboard').replaceChildren(...els);
  layoutKPIs();
  fitCharts();
}

/** Put an agent-made chart right after the KPI row. Saved before it is shown. */
async function addToDashboard(card, result) {
  let at = 0;
  while (at < state.cards.length && state.cards[at].chart?.type === 'kpi') at++;
  state.cards.splice(at, 0, card);
  state.results.set(card.id, result);
  await saveDashboard();
  const el = cardEl(card, { ok: true, result });
  el.classList.add('flash');
  const grid = $('#dashboard');
  grid.insertBefore(el, grid.children[at] || null);
  layoutKPIs();
  fitCharts();
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Save the open conversation as its own record:
 * {id, title, renamed, createdAt, updatedAt, dataset: {name, sample, size} | null, cards, chat}.
 * The CSV text is stored once per conversation in 'datasets' (key = conversation id), not on
 * every save, so asking a question never rewrites a large file.
 */
/** Ids of deleted conversations: a late reply or save must never bring one back. */
const deletedConvs = new Set();

export async function saveDashboard() {
  if (!state.datasetName && !state.chat.length) return; // an untouched new chat is not worth listing
  if (deletedConvs.has(state.convId)) return;
  if (!state.convId) freshConversation();
  const now = Date.now();
  const rec = {
    id: state.convId,
    title: state.convRenamed ? state.convTitle : titleFrom(state.chat, state.datasetName),
    renamed: state.convRenamed,
    createdAt: state.convCreated || now,
    updatedAt: now,
    dataset: state.datasetName ? { name: state.datasetName, sample: state.sample, size: state.datasetSize || 0 } : null,
    cards: state.datasetName ? state.cards.map(({ id, title, sql, chart, insight, pinned, trend, rangeDays }) => ({ id, title, sql, chart, insight, pinned, trend, rangeDays })) : [],
    chat: state.chat.slice(-100),
  };
  await putItem('conversations', rec.id, rec);
  rememberActive(rec.id);
  state.convTitle = rec.title;
  upsertSummary(rec);
}

// ---- Chat ----

const STARTERS = ['What can you do?', 'What kind of CSV works best?', 'Is my data private?'];

/** The chat always works; with a dataset loaded it analyzes the data. */
/** Let the model pre-read this dataset's instructions in the background (CPU engine: big first-question speed-up). */
let lastWarmKey = null;
async function warmModel() {
  const s = getSettings();
  if (!state.profiled || running) return;
  if (s.provider === 'wllama' && !wllamaReady(s.cpuModel)) return;
  const llm = makeLLM(s);
  if (!llm?.warm) return;
  try {
    const schema = state.profiled.map(({ name, type, kind }) => ({ name, type, kind }));
    const text = instructions(schema, await db.sample(5));
    const key = `${s.provider}\n${s.cpuModel}\n${text}`;
    if (key === lastWarmKey) return; // already read
    lastWarmKey = key;
    await llm.warm(text);
  } catch { /* only an optimisation */ }
}

function enableChat(hasData) {
  $('#ask-input').disabled = false;
  updateSendButton();
  $('#ask-input').placeholder = hasData ? 'Ask your data… e.g. Which region grew fastest?' : 'Ask anything, or load a CSV to analyze it';
}

function scrollChat() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

const STEP_ICON = { done: '✓', failed: '!', running: '' };

function stepsEl(steps) {
  const box = document.createElement('div');
  box.className = 'steps';
  steps.forEach((st) => {
    const row = document.createElement('div');
    row.className = `step ${st.state}`;
    row.innerHTML = st.state === 'running' ? '<span class="spin" aria-hidden="true"></span>' : `<span class="ok" aria-hidden="true">${STEP_ICON[st.state]}</span>`;
    const label = document.createElement('span');
    label.textContent = st.label;
    row.appendChild(label);
    if (st.detail) {
      const d = document.createElement('span');
      d.className = 't';
      d.textContent = st.detail;
      row.appendChild(d);
    }
    box.appendChild(row);
  });
  return box;
}

/** Columns of the dataset that the SQL actually references, in order of appearance. */
function columnsUsed(sql) {
  const found = [];
  for (const c of state.profiled) {
    const quoted = sql.indexOf(`"${c.name.replace(/"/g, '""')}"`);
    const bare = /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) ? sql.search(new RegExp(`\\b${c.name}\\b`, 'i')) : -1;
    const at = [quoted, bare].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    if (at !== undefined) found.push([at, c.name]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, n]) => n);
}

/** Three follow-up questions built from the answer's own columns and top result. */
function nextQuestions(cols, result, card) {
  const lower = (s) => humanize(s).toLowerCase();
  const measure = state.profiled.find((c) => cols.includes(c.name) && c.kind === 'number');
  const usedCat = state.profiled.find((c) => cols.includes(c.name) && c.kind === 'category');
  const otherCats = state.profiled.filter((c) => c.kind === 'category' && c.name !== usedCat?.name);
  const date = state.profiled.find((c) => c.kind === 'date');
  const x = card?.chart?.x;
  const first = x ? result?.rows?.[0]?.[x] : null;
  // A trend's first x is a date ("2025-01-01T00:00:00Z"), not a category worth a follow-up.
  const isDate = first instanceof Date || /^\d{4}-\d{2}-\d{2}/.test(String(first ?? ''));
  const top = first != null && !isDate ? String(first) : null;
  const m = measure ? lower(measure.name) : 'rows';
  const out = [];
  if (top && date && usedCat) out.push(`How has ${m} for ${top} changed over time?`);
  if (top && otherCats[0]) out.push(`How is ${top} split by ${lower(otherCats[0].name)}?`);
  if (usedCat && otherCats[1]) out.push(`Compare ${lower(usedCat.name)} by ${lower(otherCats[1].name)}`);
  if (usedCat && measure) out.push(`What is the average ${m} per ${lower(usedCat.name)}?`);
  if (date && !usedCat) out.push(`How did ${m} change over time?`);
  out.push('What stands out in this data?');
  return [...new Set(out)].slice(0, 3);
}

function previewEl(m) {
  const el = document.createElement('div');
  el.className = 'preview';
  el.innerHTML = '<div class="ph"><b></b><span></span></div><div class="types"></div>';
  el.querySelector('b').textContent = m.name;
  el.querySelector('.ph span').textContent = `${m.rows.toLocaleString('en-US')} rows · ${m.cols.length} columns`;
  el.querySelector('.types').append(...m.cols.map((c) => {
    const chip = document.createElement('span');
    chip.className = 'col-chip';
    chip.textContent = `${c.name} · ${c.kind}`;
    return chip;
  }));
  return el;
}

/** m = { role, text, error?, kind?, steps?, cardId?, cardTitle?, sql?, cols?, next?, question? } */
function messageEl(m) {
  if (m.kind === 'preview') return previewEl(m);
  const el = document.createElement('div');
  el.className = `msg ${m.role}${m.error ? ' error' : ''}`;
  if (m.role === 'user') {
    const text = document.createElement('span');
    text.textContent = m.text;
    const resend = button('', () => askQuestion(m.text), 'icon-btn msg-resend');
    resend.innerHTML = icon('refresh', 14);
    resend.setAttribute('aria-label', 'Resend');
    resend.title = 'Ask this again';
    el.append(text, resend);
    return el;
  }
  if (m.steps?.length) el.appendChild(stepsEl(m.steps));
  addInsight(el, m.text);
  if (m.fixes && !m.steps?.length) {
    const s = document.createElement('div');
    s.className = 'steps legacy';
    s.textContent = `Fixed its SQL after ${m.fixes} error${m.fixes > 1 ? 's' : ''}.`;
    el.appendChild(s);
  }
  // Only a successful answer "fixed" its SQL; a failed one already says it couldn't answer.
  if (!m.error && m.steps?.some((st) => st.state === 'failed')) {
    const n = m.steps.filter((st) => st.state === 'failed').length;
    const s = document.createElement('div');
    s.className = 'steps-note';
    s.textContent = `Fixed its SQL after ${n} error${n > 1 ? 's' : ''}.`;
    el.appendChild(s);
  }
  if (m.cardTitle) {
    const live = document.querySelector(`#dashboard .card[data-id="${CSS.escape(m.cardId || '')}"] .chart svg`);
    const mini = document.createElement('div');
    mini.className = 'mini';
    if (live) mini.appendChild(live.cloneNode(true));
    const ft = document.createElement('div');
    ft.className = 'ft';
    ft.innerHTML = '<a href="#" class="added"></a>';
    const added = ft.querySelector('a');
    added.textContent = `Added “${m.cardTitle}” to the dashboard ↗`;
    added.addEventListener('click', (e) => {
      e.preventDefault();
      const card = document.querySelector(`#dashboard .card[data-id="${CSS.escape(m.cardId || '')}"]`);
      if (card) {
        document.body.classList.remove('chat-open');
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('flash');
        void card.offsetWidth;
        card.classList.add('flash');
      }
    });
    mini.appendChild(ft);
    el.appendChild(mini);
  }
  if (m.demo) {
    const note = document.createElement('div');
    note.className = 'demo-note';
    note.append('Recorded demo answer on the sample data. ');
    note.appendChild(button('Choose a model', () => openModelSettings(null, '#provider'), 'link-btn'));
    note.append(' to ask your own questions.');
    el.appendChild(note);
  }
  if (m.fix && FIXES[m.fix]) {
    const f = FIXES[m.fix];
    const row = document.createElement('div');
    row.className = 'msg-actions';
    row.appendChild(button(f.label, () => (f.run ? f.run() : openModelSettings(f.provider, f.focus)), 'btn small primary'));
    el.appendChild(row);
  }
  if (m.cols?.length) {
    const c = document.createElement('div');
    c.className = 'cols';
    c.append('Columns used: ', ...m.cols.map((n) => {
      const code = document.createElement('code');
      code.textContent = n;
      return code;
    }));
    el.appendChild(c);
  }
  if (m.sql) {
    const pre = document.createElement('pre');
    pre.className = 'sql';
    pre.hidden = true;
    pre.textContent = m.sql;
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.append(
      button('Show SQL', (e) => {
        pre.hidden = !pre.hidden;
        e.target.textContent = pre.hidden ? 'Show SQL' : 'Hide SQL';
      }),
      button('Edit', () => { $('#ask-input').value = m.question || ''; $('#ask-input').focus(); }),
      button('Rerun', () => { if (m.question) askQuestion(m.question); }),
      button('Copy', async (e) => {
        await navigator.clipboard?.writeText(`${m.text}\n\n${m.sql}`).catch(() => {});
        e.target.textContent = 'Copied';
        setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
      }),
    );
    el.append(actions, pre);
  }
  if (m.next?.length) {
    const n = document.createElement('div');
    n.className = 'next';
    n.append(...m.next.map((q) => button(q, () => askQuestion(q), 'next-q')));
    el.appendChild(n);
  }
  return el;
}

function postMessage(m) {
  state.chat.push(m);
  const el = messageEl(m);
  $('#messages').appendChild(el);
  scrollChat();
  return el;
}

/** Save the reply before showing it, so a quick reload never loses it.
 * If the user switched conversations meanwhile, the reply goes to the one it belongs to. */
async function postReply(m, conv = state.convId) {
  if (deletedConvs.has(conv)) return;
  if (conv !== state.convId) {
    const rec = await getItem('conversations', conv);
    if (rec) {
      rec.chat = [...(rec.chat || []), m].slice(-100);
      rec.updatedAt = Date.now();
      await putItem('conversations', conv, rec);
      upsertSummary(rec);
    }
    return;
  }
  state.chat.push(m);
  await saveDashboard();
  $('#messages').appendChild(messageEl(m));
  scrollChat();
}

function renderChat() {
  const intro = document.querySelector('#messages .intro');
  $('#messages').replaceChildren(...[intro].filter(Boolean), ...state.chat.map(messageEl));
  scrollChat();
}

function showSuggestions(questions) {
  $('#suggestions').replaceChildren(...questions.map((q) => button(q, () => askQuestion(q), 'chip')));
}

let running = null;

function updateSendButton() {
  $('#ask-btn').disabled = !!running || !$('#ask-input').value.trim();
}

function setRunning(controller) {
  running = controller;
  $('#stop-btn').hidden = !controller;
  $('#ask-btn').hidden = !!controller;
  updateSendButton();
  document.querySelectorAll('.msg-resend').forEach((b) => { b.disabled = !!controller; });
  updateModelStatus();
}

async function onAsk(e) {
  e.preventDefault();
  const question = $('#ask-input').value.trim();
  if (!question || running) return;
  $('#ask-input').value = '';
  updateSendButton();
  await askQuestion(question);
}

/** While the in-browser model is selected, "choose a model" really means "download it". */
function fixFor(code) {
  return code === 'DEMO_LIMIT' && ['webllm', 'wllama'].includes(getSettings().provider) ? 'MODEL_NOT_DOWNLOADED' : code;
}

const FIXES = {
  DEMO_LIMIT: { label: 'Choose a model', provider: null, focus: '#provider' },
  MODEL_NOT_DOWNLOADED: { label: 'Download model', provider: 'webllm', focus: '#webllm-load' },
  MISSING_KEY: { label: 'Add API key', provider: 'claude', focus: '#claude-key' },
  OLLAMA_UNREACHABLE: { label: 'Open Ollama settings', provider: 'ollama', focus: '#ollama-url' },
  GPU_STALLED: { label: 'Switch to CPU', run: () => document.querySelector('#engine-switch [data-engine="wllama"]')?.click() },
};

/** Open Model settings on the panel that fixes an error, and point at the control to use. */
function openModelSettings(provider, focusSel) {
  // The in-browser fix button means whichever in-browser engine is selected.
  if (provider === 'webllm' && getSettings().provider === 'wllama') provider = 'wllama';
  document.body.classList.add('chat-open');
  const details = $('#model-settings');
  details.open = true;
  const panel = provider && document.querySelector(`.provider-panel[data-provider="${provider}"]`);
  if (panel) {
    showProviderPanel(provider);
    panel.classList.remove('attention');
    void panel.offsetWidth;
    panel.classList.add('attention');
    panel.scrollIntoView({ block: 'nearest' });
  }
  const target = $(focusSel);
  if (target && !target.disabled) target.focus();
  if (provider === 'webllm' || provider === 'wllama') {
    // Asking for the fix reopens the GPU notice, expanded, even if it was dismissed.
    try { localStorage.removeItem(GPU_NOTICE_KEY); } catch { /* ignore */ }
    gpuNoticeOpen = true;
    updateModelCard();
    if (!$('#mc-download').hidden) $('#mc-download').focus();
  }
}

/** Earlier turns as plain chat history (no previews, errors or data steps). */
function chatHistory() {
  return state.chat
    .filter((m) => !m.kind && !m.error && m.text && m.text !== 'Stopped.')
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
    .slice(0, -1); // the newest entry is the question being asked now
}

/** No dataset yet: a normal assistant with conversation memory. */
async function generalChat(question, llm, conv) {
  const pending = document.createElement('div');
  pending.className = 'msg agent pending';
  pending.innerHTML = '<div class="typing" aria-hidden="true"><span></span><span></span><span></span></div>';
  $('#messages').appendChild(pending);
  scrollChat();
  const controller = new AbortController();
  setRunning(controller);
  let reply;
  try {
    const text = await chatOnly({ question, history: chatHistory(), llm, signal: controller.signal });
    reply = { role: 'agent', text: text || '…', question };
  } catch (err) {
    const stopped = err?.name === 'AbortError' || controller.signal.aborted;
    reply = { role: 'agent', text: stopped ? 'Stopped.' : (err?.message || String(err)), error: !stopped, question, fix: stopped ? undefined : fixFor(err?.code) };
  } finally {
    setRunning(null);
  }
  pending.remove();
  await postReply(reply, conv);
}

/** Ask the agent, showing each step live (Julius-style), then post the answer. */
async function askQuestion(question) {
  if (running || !question) return;
  postMessage({ role: 'user', text: question });
  // Listed in history at once, titled by this question. Not awaited, so the working indicator
  // shows immediately; IndexedDB commits transactions in order, so the reply's save lands after.
  saveDashboard().catch(() => {});
  const conv = state.convId;

  const settings = getSettings();
  let llm = makeLLM(settings);
  // Until the in-browser model is downloaded, the samples still answer with recorded runs.
  const webllmPending = (settings.provider === 'webllm' && !webllmReady(currentWebLLMId()))
    || (settings.provider === 'wllama' && !wllamaReady(settings.cpuModel));
  const demo = (!llm || webllmPending) && !!state.sample && !!state.datasetName;
  if (demo) llm = makeDemoLLM(state.sample);
  if (!llm) {
    postMessage({ role: 'agent', text: 'Pick a model above (in-browser, Ollama, or your Claude key) to ask questions. Dashboards work without one.' });
    $('#model-settings').open = true;
    await saveDashboard();
    return;
  }

  if (!state.datasetName) {
    await generalChat(question, llm, conv);
    return;
  }
  if (demo && state.rangeDays) {
    // Recorded answers were written for the whole sample; they would be wrong for a slice of it.
    await postReply({ role: 'agent', text: 'Recorded demo answers cover all data. Switch Showing to All, or choose a model to ask about this date range.', fix: 'DEMO_LIMIT', question }, conv);
    return;
  }

  const steps = [
    { label: 'Looked up schema', detail: `${state.profiled.length} columns`, state: 'done' },
    { label: 'Generating SQL…', state: 'running' },
  ];
  const pending = document.createElement('div');
  pending.className = 'msg agent pending';
  const paint = () => pending.replaceChildren(stepsEl(steps));
  paint();
  $('#messages').appendChild(pending);
  scrollChat();
  const setLast = (st) => { steps[steps.length - 1] = st; };
  const controller = new AbortController();
  setRunning(controller);
  let reply;
  try {
    // The last answered question and its SQL, so follow-ups like "and for East?" make sense.
    const prevAnswer = [...state.chat].reverse().find((x) => x.role === 'agent' && x.question && x.sql);
    const out = await runAgent({
      question,
      previous: prevAnswer ? { question: prevAnswer.question, sql: prevAnswer.sql } : null,
      schema: state.profiled.map(({ name, type, kind }) => ({ name, type, kind })),
      sample: await db.sample(5),
      llm,
      query: db.safeQuery,
      signal: controller.signal,
      onStep: (step) => {
        if (step.error) {
          setLast({ label: 'Query failed, retrying', detail: step.error.slice(0, 60), state: 'failed' });
          steps.push({ label: 'Generating SQL…', state: 'running' });
        } else if (step.sql) {
          setLast({ label: 'Generated SQL', state: 'done' });
          steps.push({ label: 'Ran query in your browser', detail: `${step.rows} row${step.rows === 1 ? '' : 's'} · ${step.ms} ms`, state: 'done' });
          steps.push({ label: 'Writing the answer…', state: 'running' });
        } else {
          setLast({ label: 'Wrote the answer', state: 'done' });
        }
        paint();
        scrollChat();
      },
    });
    if (out.card && state.convId === conv) {
      setLast({ label: 'Generated visualization', state: 'done' });
      const card = { ...out.card, insight: out.insight, pinned: true, rangeDays: state.rangeDays || 0 };
      await addToDashboard(card, out.result);
      const cols = columnsUsed(card.sql);
      const asked = state.chat.filter((x) => x.role === 'user').map((x) => x.text);
      reply = {
        role: 'agent', text: out.insight || 'Here is the chart.', steps, question, demo: demo || undefined,
        cardId: card.id, cardTitle: card.title, sql: card.sql, cols,
        next: demo ? remainingQuestions(state.sample, asked).slice(0, 3) : nextQuestions(cols, out.result, card),
      };
    } else {
      reply = { role: 'agent', text: out.insight, question };
    }
  } catch (err) {
    const stopped = err?.name === 'AbortError' || controller.signal.aborted;
    if (steps[steps.length - 1].state === 'running') steps.pop();
    reply = { role: 'agent', text: stopped ? 'Stopped.' : (err?.message || String(err)), error: !stopped, steps, question, fix: stopped ? undefined : fixFor(err?.code) };
  } finally {
    setRunning(null);
  }
  pending.remove();
  await postReply(reply, conv);
}

// ---- Loading data ----

function datasetKey(name, text) {
  return `${name}:${text.length}`;
}

let loadChain = Promise.resolve();

/**
 * Load CSV text, profile it and build the auto-dashboard. `saved` restores a previous dashboard + chat.
 * Loads run one at a time, so quick clicks can never interleave two files.
 */
export function loadDataset(...args) {
  return enqueueLoad(() => loadDatasetNow(...args));
}

/** Run a whole load (download/read + parse) after the previous one, in click order. */
function enqueueLoad(fn) {
  const run = loadChain.then(fn);
  loadChain = run.catch(() => {});
  return run;
}

async function loadDatasetNow(name, text, saved = null, sample = null, conv = null) {
  const fresh = !state.datasetName;
  if (fresh) {
    $('#drop-zone').hidden = true;
    showSkeleton();
  }
  setStatus(fresh ? '' : `Loading ${name}…`);
  try {
    // Parse and profile into a staging table first, so a bad file leaves the current dataset intact.
    const info = await db.stageCSV(text);
    const profiled = await profileTable(db.query, 'data_next');
    running?.abort();
    await db.commitStaged();
    // Reopening a saved chat adopts it; a new file while one is open starts a new chat
    // (the old one stays in the history); a first file joins the current chat.
    if (conv) adoptConversation(conv);
    else if (!fresh) freshConversation();
    state.datasetName = name;
    state.datasetSize = text.length;
    state.sample = sample;
    state.datasetKey = datasetKey(name, text);
    state.profiled = profiled;
    state.cards = saved?.cards?.length ? saved.cards : autoCards(state.profiled);
    const earlier = fresh ? state.chat : [];
    state.chat = saved?.chat || [...earlier, {
      role: 'agent', kind: 'preview', name, rows: info.rows,
      cols: profiled.map((c) => ({ name: c.name, kind: c.kind === 'number' ? 'number' : c.kind })),
    }];
    state.results.clear();
    $('#drop-zone').hidden = true;
    $('#export-wrap').hidden = false;
    $('#dataset-name').textContent = name;
    $('#dataset-meta').textContent = `${info.rows.toLocaleString('en-US')} rows · ${info.columns.length} columns`;
    setStatus(info.warning || '');
    resetRangeBar();
    await renderDashboard();
    renderChat();
    enableChat(true);
    warmModel();
    showSuggestions(suggestQuestions(state.profiled));
    updateModelStatus();
    if (!saved) {
      try {
        await putItem('datasets', state.convId, { name, text, sample });
        await saveDashboard();
      } catch (err) {
        setStatus(`Loaded, but this browser could not save it (${err?.name === 'QuotaExceededError' ? 'storage is full' : err?.message || err}). It will be gone after a reload.`);
      }
    }
    renderHistory();
    refreshStorage();
  } catch (e) {
    if (fresh) {
      $('#dashboard').replaceChildren();
      $('#drop-zone').hidden = false;
    }
    setStatus(`Could not load ${name}: ${e.message || e}`, true);
  }
}

function loadSample(key) {
  // Same queue as opening chats: a file always lands in the chat it was started from.
  return queued(() => enqueueLoad(async () => {
    let text;
    try {
      const res = await fetch(`samples/${key}.csv`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (e) {
      setStatus(`Could not load the ${key} sample (${e.message || e}). Check your connection and try again.`, true);
      return;
    }
    await loadDatasetNow(`${key}.csv`, text, null, key);
  }));
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > 500 * 1024 * 1024) {
    setStatus('That file is over 500 MB, which is more than a browser tab can handle comfortably.', true);
    return;
  }
  const text = await file.text();
  await queued(() => enqueueLoad(() => loadDatasetNow(file.name, text)));
}

function wireDataInputs() {
  document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', () => loadSample(b.dataset.sample)));
  $('#file-input').addEventListener('change', (e) => {
    loadFile(e.target.files[0]);
    e.target.value = '';
  });
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    loadFile(e.dataTransfer.files[0]);
  });
}

// ---- Conversations (history sidebar) ----

/** Summaries of saved conversations, newest first: {id, title, createdAt, updatedAt, size}. */
let convs = [];

function newId() {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Start a new, still-unsaved conversation (it is saved on the first message or file). */
const ACTIVE_KEY = 'dashagent.activeConv';

function rememberActive(id) {
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* memory only */ }
}

function freshConversation() {
  // Not remembered yet: an empty new chat isn't saved, so reload should go back to the last real one.
  Object.assign(state, { convId: newId(), convCreated: Date.now(), convTitle: '', convRenamed: false });
}

function adoptConversation(rec) {
  Object.assign(state, { convId: rec.id, convCreated: rec.createdAt || Date.now(), convTitle: rec.title || '', convRenamed: !!rec.renamed });
  rememberActive(rec.id);
}

/** First question (trimmed to ~40 characters), else the file name, else "New chat". */
function titleFrom(chat, datasetName) {
  const q = (chat || []).find((m) => m.role === 'user' && m.text)?.text.trim().replace(/\s+/g, ' ');
  if (q) return q.length > 40 ? `${q.slice(0, 40).trimEnd()}…` : q;
  return datasetName || 'New chat';
}

/** Approximate bytes a conversation keeps: its JSON plus its CSV text. */
function summary(rec) {
  return {
    id: rec.id, title: rec.title || 'New chat', createdAt: rec.createdAt || 0, updatedAt: rec.updatedAt || 0,
    size: JSON.stringify(rec).length + (rec.dataset?.size || 0),
  };
}

function upsertSummary(rec) {
  convs = [summary(rec), ...convs.filter((c) => c.id !== rec.id)].sort((a, b) => b.updatedAt - a.updatedAt);
  renderHistory();
  refreshStorage();
}

async function loadHistory() {
  convs = (await listItems('conversations')).filter((r) => r?.id).map(summary).sort((a, b) => b.updatedAt - a.updatedAt);
  renderHistory();
}

const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Just now", "5 min ago", "Today 4:12 PM", "Yesterday", "Mon 24 Nov" (plus the year if not this year). */
export function relativeTime(ts, now = Date.now()) {
  const diff = now - ts;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const d = new Date(ts);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) {
    return `Today ${d.getHours() % 12 || 12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  }
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  const year = d.getFullYear() === n.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

let editingId = null;

function iconButton(name, label, onClick, cls = 'icon-btn conv-btn') {
  const b = button('', onClick, cls);
  b.innerHTML = icon(name, 15);
  b.setAttribute('aria-label', label);
  b.title = label;
  return b;
}

function convActions(li, c) {
  const box = document.createElement('div');
  box.className = 'conv-actions';
  const rename = button('✎', () => startRename(li, c), 'icon-btn conv-btn');
  rename.setAttribute('aria-label', 'Rename');
  rename.title = 'Rename';
  const del = iconButton('trash', 'Delete', () => {
    // Confirm step: the row asks before anything is removed.
    li.classList.add('confirming');
    const ask = document.createElement('span');
    ask.className = 'conv-ask';
    ask.textContent = 'Delete?';
    box.replaceChildren(
      ask,
      iconButton('check', 'Confirm delete', () => deleteConversation(c.id), 'icon-btn conv-btn danger'),
      iconButton('x', 'Cancel', () => { li.classList.remove('confirming'); box.replaceWith(convActions(li, c)); }),
    );
  });
  box.append(rename, del);
  return box;
}

function convEl(c, now) {
  const li = document.createElement('li');
  li.className = `conv${c.id === state.convId ? ' active' : ''}`;
  li.dataset.id = c.id;
  const open = button('', () => openConversation(c.id), 'conv-open');
  open.innerHTML = '<span class="conv-title"></span><span class="conv-time"></span>';
  open.querySelector('.conv-title').textContent = c.title;
  open.querySelector('.conv-time').textContent = relativeTime(c.updatedAt, now);
  if (c.id === state.convId) open.setAttribute('aria-current', 'true');
  li.append(open, convActions(li, c));
  return li;
}

function renderHistory() {
  if (editingId) return; // never yank the rename field away mid-typing
  const list = $('#history-list');
  const now = Date.now();
  if (!convs.length) {
    const empty = document.createElement('li');
    empty.className = 'conv-empty';
    empty.textContent = 'No saved chats yet';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...convs.map((c) => convEl(c, now)));
}

function startRename(li, c) {
  editingId = c.id;
  const field = document.createElement('input');
  field.className = 'conv-edit';
  field.value = c.title;
  field.setAttribute('aria-label', 'Chat title');
  field.maxLength = 120;
  li.querySelector('.conv-open').replaceWith(field);
  li.querySelector('.conv-actions').hidden = true;
  let done = false;
  const finish = async (keep) => {
    if (done) return;
    done = true;
    editingId = null;
    const next = field.value.trim().replace(/\s+/g, ' ');
    if (keep && next && next !== c.title) await renameConversation(c.id, next);
    renderHistory();
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  field.addEventListener('blur', () => finish(true));
  field.focus();
  field.select();
}

/** A manual title sticks: later questions never overwrite it. Renaming does not reorder the list. */
async function renameConversation(id, title) {
  const rec = await getItem('conversations', id);
  if (!rec) return;
  rec.title = title;
  rec.renamed = true;
  await putItem('conversations', id, rec);
  if (id === state.convId) Object.assign(state, { convTitle: title, convRenamed: true });
  convs = convs.map((c) => (c.id === id ? summary(rec) : c));
}

async function deleteConversation(id) {
  deletedConvs.add(id);
  const rec = await getItem('conversations', id);
  // A chat migrated from the old single-dashboard storage also owns those legacy copies.
  if (rec?.legacy === 'dataset') await Promise.all([deleteItem('datasets', 'last'), deleteItem('dashboards', 'last')]);
  if (rec?.legacy === 'general') await deleteItem('dashboards', 'general');
  await deleteItem('conversations', id);
  await deleteItem('datasets', id);
  convs = convs.filter((c) => c.id !== id);
  if (id === state.convId) {
    running?.abort();
    state.convId = '';
    if (convs[0]) await openConversation(convs[0].id, { keepOverlay: true });
    else await newChat({ keepOverlay: true });
  }
  renderHistory();
  refreshStorage();
}

/** Back to the empty state: no dataset, drop zone visible, chat usable for general questions.
 * Resolves once the old data is gone from DuckDB too. */
function clearDatasetView() {
  Object.assign(state, { datasetName: '', datasetSize: 0, sample: null, datasetKey: '', profiled: [], cards: [] });
  state.results.clear();
  $('#dashboard').replaceChildren();
  $('#drop-zone').hidden = false;
  $('#export-wrap').hidden = true;
  closeExportMenu();
  resetRangeBar(true);
  const dropped = db.dropData().catch(() => {});
  $('#dataset-name').textContent = '';
  $('#dataset-meta').textContent = '';
  setStatus('');
  showSuggestions(STARTERS);
  enableChat(false);
  updateModelStatus();
  return dropped;
}

let openQueue = Promise.resolve();

/** Opens run one at a time, so quick clicks never interleave two dataset loads. */
function queued(fn) {
  openQueue = openQueue.then(fn).catch((e) => setStatus(String(e?.message || e), true));
  return openQueue;
}

function openConversation(id, { keepOverlay = false } = {}) {
  if (!keepOverlay) closeHistory();
  return queued(async () => {
    if (id === state.convId) return;
    const rec = await getItem('conversations', id);
    if (!rec) return;
    running?.abort();
    if (rec.dataset) {
      const ds = await getItem('datasets', id);
      if (ds?.text) {
        await loadDataset(rec.dataset.name, ds.text, { cards: rec.cards, chat: rec.chat || [] }, rec.dataset.sample || null, rec);
        renderHistory();
        return;
      }
    }
    adoptConversation(rec);
    state.chat = rec.chat || []; // switch the chat first, so nothing typed meanwhile lands in the old one
    const dropped = clearDatasetView();
    renderChat();
    renderHistory();
    await dropped;
  });
}

function newChat({ keepOverlay = false } = {}) {
  if (!keepOverlay) closeHistory();
  return queued(async () => {
    running?.abort();
    freshConversation();
    state.chat = [];
    const dropped = clearDatasetView();
    renderChat();
    renderHistory();
    $('#ask-input').focus();
    await dropped;
  });
}

/**
 * One-time move of the single pre-history dashboard ('datasets'/'last', 'dashboards'/'last'
 * and 'dashboards'/'general') into conversations. The old records are left in place; a small
 * signature in 'meta' remembers what was already moved, so nothing is duplicated or lost.
 */
async function migrateLegacy() {
  const [ds, last, general] = await Promise.all([
    getItem('datasets', 'last'), getItem('dashboards', 'last'), getItem('dashboards', 'general'),
  ]);
  const now = Date.now();
  const write = async (rec, text) => {
    const id = newId();
    if (text != null) await putItem('datasets', id, { name: rec.dataset.name, text, sample: rec.dataset.sample });
    await putItem('conversations', id, { id, renamed: false, createdAt: rec.updatedAt, ...rec });
  };
  if (Array.isArray(general?.chat) && general.chat.length) {
    const sig = `general:${general.chat.length}:${JSON.stringify(general.chat).length}`;
    if (await getItem('meta', 'legacy-general') !== sig) {
      await write({ title: titleFrom(general.chat, ''), updatedAt: now - 1, dataset: null, cards: [], chat: general.chat.slice(-100), legacy: 'general' });
      await putItem('meta', 'legacy-general', sig);
    }
  }
  if (ds?.text && ds.name) {
    const key = datasetKey(ds.name, ds.text);
    const matches = last?.dataset === key;
    const chat = matches && Array.isArray(last.chat) ? last.chat.slice(-100) : [];
    const sig = `dataset:${key}:${chat.length}`;
    if (await getItem('meta', 'legacy-dataset') !== sig) {
      await write({
        title: titleFrom(chat, ds.name), updatedAt: now,
        dataset: { name: ds.name, sample: ds.sample || null, size: ds.text.length },
        cards: matches && Array.isArray(last.cards) ? last.cards : [], chat, legacy: 'dataset',
      }, ds.text);
      await putItem('meta', 'legacy-dataset', sig);
    }
  }
}

/** On boot: move old data over, list conversations, reopen the most recently updated one. */
async function restoreLast() {
  await migrateLegacy().catch(() => {});
  await loadHistory();
  let active = null;
  try { active = localStorage.getItem(ACTIVE_KEY); } catch { /* ignore */ }
  const pick = convs.find((c) => c.id === active) || convs[0];
  if (pick) await openConversation(pick.id, { keepOverlay: true });
}

const COLLAPSE_KEY = 'dashagent.historyCollapsed';

function setCollapsed(collapsed) {
  document.body.classList.toggle('history-collapsed', collapsed);
  const t = $('#history-toggle');
  t.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  t.title = collapsed ? 'Show chats' : 'Hide chats';
  t.setAttribute('aria-expanded', String(!collapsed));
}

function closeHistory() {
  document.body.classList.remove('history-open');
  $('#history-backdrop').hidden = true;
}

function wireHistory() {
  let collapsed = false;
  let saved = null;
  try { saved = localStorage.getItem(COLLAPSE_KEY); } catch { /* storage blocked */ }
  // No choice yet: on laptop-size screens start with the slim rail so the dashboard gets room.
  collapsed = saved === null ? window.innerWidth < 1400 : saved === '1';
  setCollapsed(collapsed);
  $('#history-toggle').addEventListener('click', () => {
    const next = !document.body.classList.contains('history-collapsed');
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* memory only */ }
  });
  $('#new-chat').addEventListener('click', () => newChat());
  $('#history-btn').addEventListener('click', () => {
    document.body.classList.add('history-open');
    $('#history-backdrop').hidden = false;
  });
  $('#history-close').addEventListener('click', closeHistory);
  $('#history-backdrop').addEventListener('click', closeHistory);
  setInterval(renderHistory, 60_000); // keep "5 min ago" honest
  renderHistory();
}

// ---- Storage used (header pill) ----

/** 1536 -> "1.5 KB" (binary units, one decimal). */
export function formatBytes(n) {
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  if (v < 1024) return `${Math.round(v)} B`;
  let i = -1;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

let storageInfo = null;
let storageTimer = null;

function refreshStorage() {
  clearTimeout(storageTimer);
  storageTimer = setTimeout(updateStorage, 150);
}

async function updateStorage() {
  const pill = $('#storage-pill');
  if (typeof navigator.storage?.estimate !== 'function') { pill.hidden = true; return; }
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    storageInfo = { usage, quota };
    pill.textContent = `Storage ${formatBytes(usage)}`;
    pill.hidden = false;
    if (!$('#storage-pop').hidden) renderStoragePop();
  } catch {
    pill.hidden = true;
  }
}

function storageRow(label, bytes) {
  const row = document.createElement('div');
  row.className = 'storage-row';
  const name = document.createElement('span');
  name.textContent = label;
  const size = document.createElement('b');
  size.textContent = formatBytes(bytes);
  row.append(name, size);
  return row;
}

function renderStoragePop() {
  if (!storageInfo) return;
  const { usage, quota } = storageInfo;
  $('#storage-total').textContent = quota ? `${formatBytes(usage)} used of ${formatBytes(quota)}` : `${formatBytes(usage)} used`;
  $('#storage-meter i').style.width = `${quota ? Math.min(100, Math.max(1, (usage / quota) * 100)) : 0}%`;
  const chats = convs.reduce((sum, c) => sum + c.size, 0);
  $('#storage-rows').replaceChildren(
    storageRow(`Saved chats (approx.) · ${convs.length}`, chats),
    storageRow('Other (in-browser model cache etc.)', Math.max(0, usage - chats)),
  );
}

function placeStoragePop() {
  const r = $('#storage-pill').getBoundingClientRect();
  const pop = $('#storage-pop');
  pop.style.top = `${Math.round(r.bottom + 8)}px`;
  const left = Math.min(window.innerWidth - pop.offsetWidth - 12, Math.max(12, r.right - pop.offsetWidth));
  pop.style.left = `${Math.round(left)}px`;
}

function toggleStoragePop(show) {
  const pop = $('#storage-pop');
  pop.hidden = !show;
  $('#storage-pill').setAttribute('aria-expanded', String(show));
  if (show) {
    renderStoragePop();
    placeStoragePop();
    updateStorage();
  }
}

function wireStorage() {
  $('#storage-pill').addEventListener('click', () => toggleStoragePop($('#storage-pop').hidden));
  $('#storage-close').addEventListener('click', () => toggleStoragePop(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#storage-pop').hidden) toggleStoragePop(false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('#storage-pop').hidden && !e.target.closest?.('#storage-pop, #storage-pill')) toggleStoragePop(false);
  });
  window.addEventListener('resize', () => { if (!$('#storage-pop').hidden) placeStoragePop(); });
}

// ---- Export and privacy ----

function onExport() {
  const html = exportHTML(state.cards, state.results, state.datasetName);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.datasetName.replace(/\.[^.]+$/, '') || 'dashboard'}-dashboard.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function onShare() {
  const btn = $('#export-btn');
  btn.disabled = true;
  try {
    const blob = await exportPNG(state.cards, state.results, state.datasetName);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.datasetName.replace(/\.[^.]+$/, '') || 'dashboard'}-dashboard.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    setStatus(`Could not create the image: ${err.message || err}`, true);
  } finally {
    btn.disabled = false;
  }
}

/** PDF without a library: print the self-contained export page; the browser offers "Save as PDF". */
function onPrintPDF() {
  document.querySelector('#print-frame')?.remove();
  const frame = document.createElement('iframe');
  frame.id = 'print-frame';
  frame.setAttribute('aria-hidden', 'true');
  // A real page size, just off screen: a 0x0 or hidden frame prints a blank page.
  frame.style.cssText = 'position:fixed;left:-12000px;top:0;width:1240px;height:1754px;border:0;pointer-events:none';
  frame.srcdoc = exportHTML(state.cards, state.results, state.datasetName, { withTables: true, forPrint: true });
  frame.onload = () => {
    try {
      frame.contentDocument.title = `${state.datasetName.replace(/\.[^.]+$/, '') || 'dashboard'}-dashboard`;
      frame.contentWindow.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 500));
      // Let fonts and layout settle so the PDF is not blank.
      setTimeout(() => { frame.contentWindow.focus(); frame.contentWindow.print(); }, 250);
    } catch (err) {
      setStatus(`Could not open the print dialog: ${err.message || err}`, true);
    }
  };
  document.body.appendChild(frame);
}

function closeExportMenu() {
  const menu = $('#export-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $('#export-btn').setAttribute('aria-expanded', 'false');
}

/** One Export button; its menu offers PNG image, HTML file and PDF. Keyboard: arrows, Escape. */
function wireExportMenu() {
  const btn = $('#export-btn');
  const menu = $('#export-menu');
  const items = () => [...menu.querySelectorAll('[role=menuitem]')];
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) items()[0].focus();
  });
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-export]');
    if (!item) return;
    closeExportMenu();
    ({ png: onShare, html: onExport, pdf: onPrintPDF })[item.dataset.export]();
  });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { closeExportMenu(); btn.focus(); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('#export-wrap')) closeExportMenu(); });
}

// ---- Date range ----

/** Show the range bar only when the data has a date column; a new file starts at "All". */
const RANGE_LABEL = { 0: 'all data', 365: 'the last 12 months', 90: 'the last 90 days', 30: 'the last 30 days' };

function resetRangeBar(hide = false) {
  state.rangeDays = 0;
  const bar = $('#range-bar');
  const date = state.profiled.find((c) => c.kind === 'date');
  bar.hidden = hide || !date;
  bar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.days === '0')));
}

async function onRange(e) {
  const btn = e.target.closest('button[data-days]');
  const date = state.profiled.find((c) => c.kind === 'date');
  if (!btn || !date) return;
  const days = Number(btn.dataset.days);
  state.rangeDays = days;
  $('#range-bar').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  await db.setDateRange(days ? date.name : null, days);
  state.results.clear();
  await renderDashboard();
}

const deleteArmed = new Map();

/** Two clicks wipe everything this site stored. Shared by "Delete all data" and "Delete all chats". */
async function onDeleteAll(e) {
  const btn = e.currentTarget;
  const label = btn.querySelector('span');
  const idle = btn.dataset.label || 'Delete all data';
  if (!deleteArmed.has(btn)) {
    label.textContent = 'Click again to delete everything';
    deleteArmed.set(btn, setTimeout(() => { deleteArmed.delete(btn); label.textContent = idle; }, 5000));
    return;
  }
  clearTimeout(deleteArmed.get(btn));
  deleteArmed.delete(btn);
  label.textContent = idle;
  deletedConvs.add(state.convId);
  convs.forEach((c) => deletedConvs.add(c.id));
  running?.abort();
  await clearAll();
  convs = [];
  freshConversation();
  renderHistory();
  refreshStorage();
  await db.dropData().catch(() => {});
  resetRangeBar(true);
  Object.assign(state, { datasetName: '', sample: null, datasetKey: '', profiled: [], cards: [], chat: [] });
  state.results.clear();
  $('#dashboard').replaceChildren();
  renderChat();
  showSuggestions(STARTERS);
  enableChat(false);
  $('#dataset-name').textContent = '';
  $('#dataset-meta').textContent = '';
  $('#drop-zone').hidden = false;
  $('#export-wrap').hidden = true;
  closeExportMenu();
  saveSettings({ provider: 'wllama' }); // back to the default: CPU
  const s = getSettings();
  $('#provider').value = s.provider;
  FIELDS.forEach(([sel, key]) => { $(sel).value = s[key]; });
  showProviderPanel(s.provider);
  updateModelStatus();
  setStatus('All data deleted from this browser.');
}

// ---- Settings ----

const FIELDS = [
  ['#ollama-url', 'ollamaUrl'],
  ['#ollama-model', 'ollamaModel'],
  ['#claude-key', 'claudeKey'],
  ['#claude-model', 'claudeModel'],
];

let webllmListLoaded = false;

async function fillWebLLMModels() {
  if (webllmListLoaded) return;
  webllmListLoaded = true;
  const select = $('#webllm-model');
  const btn = $('#webllm-load');
  if (!hasWebGPU()) {
    select.replaceChildren(new Option('WebGPU not available in this browser', ''));
    btn.disabled = true;
    btn.textContent = 'Needs Chrome or Edge with WebGPU';
    return;
  }
  try {
    if (gpuStatus === 'unknown') await checkGPU();
    const models = (await listWebLLMModels()).filter((m) => gpuF16 !== false || !/f16/.test(m.id));
    const saved = compatibleModelId(getSettings().webllmModel, gpuF16);
    const chosen = models.some((m) => m.id === saved) ? saved : defaultWebLLMModel(models);
    select.replaceChildren(...models.map((m) => new Option(`${m.id} (~${(m.vramMB / 1024).toFixed(1)} GB)`, m.id)));
    select.value = chosen;
    saveSettings({ webllmModel: chosen });
    updateWebLLMButton();
  } catch {
    webllmListLoaded = false;
    select.replaceChildren(new Option('Could not load the model list', ''));
  }
}

const cachedModels = new Set();

const checkedCache = new Set();

function modelSizeGB(id) {
  const opt = [...$('#webllm-model').options].find((o) => o.value === id);
  const fromList = opt?.textContent.match(/~([\d.]+) GB/)?.[1];
  return fromList ? Number(fromList) : KNOWN_MODEL_GB[id] || null;
}

function updateWebLLMButton() {
  const id = currentWebLLMId();
  const btn = $('#webllm-load');
  const gb = modelSizeGB(id);
  btn.disabled = !id || download.active;
  if (webllmReady(id)) btn.textContent = 'Model ready ✓';
  else if (cachedModels.has(id)) btn.textContent = 'Load model (already downloaded)';
  else btn.textContent = gb ? `Download model · about ${gb} GB` : 'Download model';
  // Check the browser cache once per model (no library download needed).
  if (id && !checkedCache.has(id) && !webllmReady(id)) {
    checkedCache.add(id);
    isWebLLMCachedFast(id).then((yes) => {
      if (yes) cachedModels.add(id);
      if (yes) autoLoad('webllm');
      updateWebLLMButton();
      updateModelCard();
      updateModelStatus();
    });
  }
  updateModelCard();
}

/** A model that is already downloaded loads by itself (only for the engine the user chose). */
async function autoLoad(engine) {
  if (getSettings().provider !== engine || download.active) return;
  if (engine === 'wllama') return startCpuDownload();
  if (gpuStatus === 'unknown') await checkGPU();
  if (gpuStatus === 'ok' && getSettings().provider === 'webllm') onWebLLMLoad();
}

/** CPU / GPU switch in the header: which in-browser engine runs the model. */
function updateEngineSwitch() {
  const sw = $('#engine-switch');
  if (!sw) return;
  const p = getSettings().provider;
  sw.querySelectorAll('button[data-engine]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.engine === p)));
  const gpu = sw.querySelector('.engine-gpu');
  const noGPU = !hasWebGPU() || gpuStatus === 'none' || gpuStatus === 'software';
  gpu.classList.toggle('unavailable', noGPU);
  gpu.title = noGPU ? 'No usable GPU in this browser' : 'Run the in-browser model on your GPU';
}

const GPU_NOTICE_KEY = 'dashagent.gpuNoticeDismissed';
let gpuNoticeOpen = false;

function gpuNoticeDismissed() {
  try { return localStorage.getItem(GPU_NOTICE_KEY) === '1'; } catch { return false; }
}

// ---- CPU model (wllama) ----

const COI_KEY = 'dashagent.coi';
let cpuCached = null; // for the selected CPU model; null until checked

/** The CPU model the user picked (or the default). */
function cpuModel() {
  return cpuModelFor(getSettings().cpuModel);
}

/** Multi-threading needs cross-origin isolation; on static hosts a service worker provides it. */
function loadCoiServiceWorker() {
  if (window.crossOriginIsolated || !('serviceWorker' in navigator) || !window.isSecureContext) return false;
  if (document.querySelector('script[data-coi]')) return true;
  window.coi = { coepCredentialless: () => true, quiet: true };
  const s = document.createElement('script');
  s.src = 'coi-serviceworker.js';
  s.dataset.coi = '1';
  document.head.appendChild(s);
  return true;
}

/** Download button for the CPU model: turn on multi-threading first (one reload), then download. */
async function onCpuLoad() {
  if (wllamaReady(cpuModel().file) || download.active) return;
  let tried = false;
  try { tried = sessionStorage.getItem('dashagent.coiTried') === '1'; } catch { /* ignore */ }
  if (!window.crossOriginIsolated && !tried) {
    try {
      localStorage.setItem(COI_KEY, '1');
      sessionStorage.setItem('dashagent.coiTried', '1');
      sessionStorage.setItem('dashagent.autoDownload', '1');
    } catch { /* ignore */ }
    if (loadCoiServiceWorker()) {
      setDownloadProgress(0, 'Turning on multi-threading (the page reloads once)…');
      // If the service worker cannot take over, carry on single-threaded after a moment.
      setTimeout(() => { if (!window.crossOriginIsolated) { download.active = false; startCpuDownload(); } }, 6000);
      return;
    }
  }
  startCpuDownload();
}

async function startCpuDownload() {
  try { sessionStorage.removeItem('dashagent.autoDownload'); } catch { /* ignore */ }
  if (wllamaReady(cpuModel().file) || download.active) return;
  try {
    setDownloadProgress(0, cpuCached ? 'Loading from your browser cache' : 'Starting download');
    await loadWllama(cpuModel().file, ({ progress, text }) => setDownloadProgress(Math.min(progress, 0.99), text));
    cpuCached = true;
    setDownloadProgress(1);
    warmModel();
    refreshStorage();
  } catch (e) {
    download.error = friendlyWebLLMError(e);
    setDownloadProgress(1);
  }
}

/** The big card in the chat panel: download (or load) the in-browser model, with live progress. */
function updateModelCard() {
  const card = $('#model-card');
  const s = getSettings();
  updateEngineSwitch();
  if (s.provider === 'wllama') {
    const m = cpuModel();
    card.hidden = wllamaReady(m.file);
    if (card.hidden) return;
    card.classList.remove('no-gpu', 'expanded');
    for (const sel of ['.mc-fix', '.mc-dismiss', '.mc-nogpu']) card.querySelector(sel).hidden = true;
    card.querySelector('.mc-points').hidden = false;
    card.querySelector('.mc-sub').hidden = false;
    card.dataset.model = m.file;
    if (cpuCached === null) {
      cpuCached = false;
      const file = m.file;
      isWllamaCached(file).then((yes) => { if (file !== cpuModel().file) return; cpuCached = yes; if (yes) autoLoad('wllama'); updateModelCard(); updateModelStatus(); });
    }
    card.querySelector('.mc-heading').textContent = cpuCached ? 'Your in-browser model is ready to load' : 'Run AI in your browser';
    card.querySelector('.mc-sub').textContent = `${m.label} · about ${m.gb} GB · ${cpuCached ? 'already downloaded' : 'runs on your CPU'}`;
    const btn = $('#mc-download');
    btn.querySelector('span').textContent = cpuCached ? 'Load model' : 'Download model';
    btn.setAttribute('aria-label', cpuCached ? 'Load model' : `Download model, about ${m.gb} GB`);
    btn.hidden = download.active;
    card.querySelector('.mc-progress').hidden = !download.active && !download.error;
    card.querySelector('.mc-bar i').style.width = `${Math.round(download.pct * 100)}%`;
    card.querySelector('.mc-pct').textContent = download.active ? `${Math.round(download.pct * 100)}%` : '';
    card.querySelector('.mc-text').textContent = download.error || shortProgress(download.text);
    card.classList.toggle('busy', download.active);
    return;
  }
  const id = currentWebLLMId();
  const show = s.provider === 'webllm' && !webllmReady(id);
  card.hidden = !show;
  if (!show) return;
  const software = gpuStatus === 'software';
  const noGPU = software || gpuStatus === 'none' || !hasWebGPU();
  // A browser without a usable GPU gets a slim, dismissible notice instead of a big card.
  if (noGPU && gpuNoticeDismissed() && !gpuNoticeOpen) { card.hidden = true; return; }
  card.classList.toggle('no-gpu', noGPU);
  card.classList.toggle('expanded', noGPU && gpuNoticeOpen);
  card.querySelector('.mc-fix').hidden = !noGPU;
  card.querySelector('.mc-dismiss').hidden = !noGPU;
  card.querySelector('.mc-fix').textContent = gpuNoticeOpen ? 'Hide' : 'How to fix';
  card.querySelector('.mc-fix').setAttribute('aria-expanded', String(gpuNoticeOpen));
  card.querySelector('.mc-nogpu').hidden = !noGPU || !gpuNoticeOpen;
  card.querySelector('.mc-points').hidden = noGPU;
  card.querySelector('.mc-vulkan').hidden = !software;
  card.querySelector('.mc-webgpu').hidden = software;
  if (noGPU) {
    const long = software ? 'WebGPU is on, but not using your GPU' : 'This browser can’t run the in-browser model';
    const short = software ? 'Not using your GPU' : 'Can’t run the in-browser model';
    card.querySelector('.mc-heading').textContent = gpuNoticeOpen ? long : short;
    card.querySelector('.mc-heading').title = long;
    card.querySelector('.mc-sub').hidden = !gpuNoticeOpen;
    card.querySelector('.mc-sub').textContent = software
      ? 'Chrome is using a slow software GPU (SwiftShader). Turn on Vulkan to use your real GPU.'
      : 'WebGPU found no usable GPU here.';
    $('#mc-download').hidden = true;
    card.querySelector('.mc-progress').hidden = true;
    card.classList.remove('busy');
    return;
  }
  card.querySelector('.mc-sub').hidden = false;
  card.dataset.model = id;
  const gb = modelSizeGB(id);
  const cached = cachedModels.has(id);
  card.querySelector('.mc-heading').textContent = cached ? 'Your in-browser model is ready to load' : 'Run AI in your browser';
  card.querySelector('.mc-sub').textContent = `${friendlyModelName(id)}${gb ? ` · about ${gb} GB` : ''} · ${cached ? 'already downloaded' : 'runs on your GPU'}`;
  const btn = $('#mc-download');
  btn.querySelector('span').textContent = cached ? 'Load model' : 'Download model';
  btn.setAttribute('aria-label', cached ? 'Load model' : `Download model${gb ? `, about ${gb} GB` : ''}`);
  btn.hidden = download.active;
  const prog = card.querySelector('.mc-progress');
  prog.hidden = !download.active && !download.error;
  card.querySelector('.mc-bar i').style.width = `${Math.round(download.pct * 100)}%`;
  card.querySelector('.mc-pct').textContent = download.active ? `${Math.round(download.pct * 100)}%` : '';
  card.querySelector('.mc-text').textContent = download.error || shortProgress(download.text);
  card.classList.toggle('busy', download.active);
}

/** WebLLM's progress text is long ("Fetching param cache[12/40]: 512MB fetched. 30% completed, 12 secs elapsed…"). */
function shortProgress(text) {
  const t = String(text || '');
  const mb = /(\d+(?:\.\d+)?)\s*MB fetched/i.exec(t)?.[1];
  if (mb) return `${Math.round(Number(mb))} MB downloaded`;
  if (/loading|cache/i.test(t) && !/fetch/i.test(t)) return 'Loading into your GPU…';
  return t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

/** The model the in-browser provider will use: the picker if loaded, else the saved/default one. */
function currentWebLLMId() {
  return compatibleModelId($('#webllm-model').value || getSettings().webllmModel || DEFAULT_WEBLLM_MODEL, gpuF16);
}

/** Download (or load from cache) the in-browser model. The button that calls it states the size. */
async function onWebLLMLoad() {
  if (getSettings().provider === 'wllama') return onCpuLoad();
  const select = $('#webllm-model');
  const id = currentWebLLMId();
  if (!id || webllmReady(id) || download.active) return;
  if (gpuStatus === 'unknown') await checkGPU();
  if (gpuStatus === 'none' || gpuStatus === 'software') return; // the card explains and offers alternatives
  saveSettings({ webllmModel: id });
  const bar = $('#webllm-progress');
  const btn = $('#webllm-load');
  bar.hidden = false;
  btn.disabled = true;
  select.disabled = true;
  try {
    setDownloadProgress(0, cachedModels.has(id) ? 'Loading from your browser cache' : 'Starting download');
    await loadWebLLM(id, ({ progress, text }) => {
      bar.querySelector('div').style.width = `${Math.round(progress * 100)}%`;
      bar.querySelector('span').textContent = text.length > 60 ? `${Math.round(progress * 100)}%` : text;
      setDownloadProgress(Math.min(progress, 0.99), text);
    });
    bar.hidden = true;
    cachedModels.add(id);
    setDownloadProgress(1);
    refreshStorage(); // the model now sits in the browser cache
  } catch (e) {
    download.error = friendlyWebLLMError(e);
    if (/16-bit/.test(download.error)) {
      gpuF16 = false;
      saveSettings({ webllmModel: compatibleModelId(id, false) });
    }
    if (/GPU/.test(download.error)) gpuStatus = 'none';
    setDownloadProgress(1);
    bar.querySelector('span').textContent = download.error;
  } finally {
    select.disabled = false;
    updateWebLLMButton();
  }
}

const PRIVACY = {
  none: 'No model · your data stays on your machine',
  mock: 'Model runs in your browser · your data stays on your machine',
  webllm: 'Model runs in your browser · your data stays on your machine',
  wllama: 'Model runs in your browser · your data stays on your machine',
  ollama: 'Model runs on your machine (Ollama) · your data stays on your machine',
  claude: 'Your file stays here · Claude sees column names, 5 sample rows, your questions and query results',
};

function isLocalHost(url) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch { return true; }
}

const download = { active: false, pct: 0, text: '', error: '' };

/** Called with WebLLM download progress (0..1); shown live in the header pill. */
export function setDownloadProgress(pct, text = '') {
  download.active = pct < 1;
  download.pct = pct;
  download.text = text;
  if (download.active) download.error = '';
  updateModelStatus();
  updateModelCard();
}

function shortModel(id) {
  return String(id || '').replace(/-MLC$/, '').replace(/-q\d+f\d+(_\d+)?/, '');
}

/** Header pill: which model answers right now, and whether it is ready, working or downloading. */
function updateModelStatus() {
  const s = getSettings();
  let text;
  let tone;
  switch (s.provider) {
    case 'claude':
      text = `Claude · ${s.claudeModel || 'claude-haiku-5-5'} · ${s.claudeKey ? 'ready' : 'add API key'}`;
      tone = s.claudeKey ? 'ok' : 'warn';
      break;
    case 'ollama':
      text = `Ollama · ${s.ollamaModel || 'no model set'}`;
      tone = 'ok';
      break;
    case 'webllm':
      if (download.active) {
        text = `Downloading ${friendlyModelName(s.webllmModel) || 'model'} · ${Math.round(download.pct * 100)}%`;
        tone = 'busy';
      } else if (webllmReady(s.webllmModel)) {
        text = `In-browser · ${friendlyModelName(s.webllmModel)} · ready`;
        tone = 'ok';
      } else {
        text = `In-browser · ${friendlyModelName(s.webllmModel) || 'model'} · ${cachedModels.has(s.webllmModel) ? 'downloaded, not loaded' : 'not downloaded'}`;
        tone = 'warn';
      }
      break;
    case 'wllama':
      if (download.active) {
        text = `Downloading ${cpuModel().label} (CPU) · ${Math.round(download.pct * 100)}%`;
        tone = 'busy';
      } else if (wllamaReady(cpuModel().file)) {
        text = `In-browser CPU · ${cpuModel().label} · ready`;
        tone = 'ok';
      } else {
        text = `In-browser CPU · ${cpuModel().label} · ${cpuCached ? 'downloaded, not loaded' : 'not downloaded'}`;
        tone = 'warn';
      }
      break;
    case 'mock':
      text = 'Mock model (tests)';
      tone = 'ok';
      break;
    default:
      text = state.sample && state.datasetName ? 'Demo answers · no model' : 'No model selected';
      tone = state.sample && state.datasetName ? 'ok' : 'idle';
  }
  if (running) {
    text += ' · working…';
    tone = 'busy';
  }
  const pill = $('#model-status');
  pill.querySelector('.pill-text').textContent = text;
  pill.dataset.tone = tone;
  const bar = pill.querySelector('.pill-bar');
  bar.hidden = !download.active || s.provider !== 'webllm';
  bar.querySelector('i').style.width = `${Math.round(download.pct * 100)}%`;
}

/** The top-bar badge says exactly where data goes for the chosen model. */
function updatePrivacyBadge(provider) {
  const badge = $('#privacy-badge');
  const s = getSettings();
  let text = PRIVACY[provider] || PRIVACY.none;
  let remote = provider === 'claude';
  if (provider === 'ollama' && !isLocalHost(s.ollamaUrl)) {
    let host = s.ollamaUrl;
    try { host = new URL(s.ollamaUrl).host; } catch { /* keep raw */ }
    text = `Ollama at ${host} · it sees column names, 5 sample rows, your questions and query results`;
    remote = true;
  }
  badge.querySelector('span').textContent = text;
  badge.classList.toggle('remote', remote);
}

function showProviderPanel(provider) {
  updatePrivacyBadge(provider);
  updateModelStatus();
  document.querySelectorAll('.provider-panel').forEach((p) => { p.hidden = p.dataset.provider !== provider; });
  if (provider === 'webllm') {
    updateWebLLMButton();
    if ($('#model-settings').open) fillWebLLMModels(); // the full list costs a 6 MB library download
  }
  updateModelCard();
}

function wireSettings() {
  const s = getSettings();
  if (MOCK) $('#provider option[value=mock]').hidden = false;
  $('#provider').value = s.provider;
  if ($('#provider').value !== s.provider) $('#provider').value = 'none';
  FIELDS.forEach(([sel, key]) => {
    const el = $(sel);
    el.value = s[key];
    el.addEventListener('input', () => { saveSettings({ [key]: el.value.trim() }); updateModelStatus(); updatePrivacyBadge($('#provider').value); });
  });
  $('#ollama-cmd').textContent = `OLLAMA_ORIGINS=${location.origin} ollama serve`;
  $('#provider').addEventListener('change', (e) => {
    const provider = e.target.value;
    saveSettings({ provider, providerChosen: true });
    setTimeout(warmModel, 0);
    showProviderPanel(provider);
    if (['webllm', 'ollama', 'claude'].includes(provider)) $('#model-settings').open = true;
  });
  $('#webllm-model').addEventListener('change', (e) => { saveSettings({ webllmModel: e.target.value }); updateWebLLMButton(); updateModelStatus(); });
  $('#webllm-load').addEventListener('click', onWebLLMLoad);
  showProviderPanel($('#provider').value);
}

/** One shared tooltip for every chart point that has data-tip. */
function wireTooltip() {
  const tip = $('#tip');
  const show = (target, x, y) => {
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2))}px`;
    tip.style.top = `${Math.max(8, y - r.height - 12)}px`;
  };
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t) show(t, e.clientX, e.clientY);
  });
  document.addEventListener('pointermove', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t) show(t, e.clientX, e.clientY);
    else tip.hidden = true;
  });
  document.addEventListener('scroll', () => { tip.hidden = true; }, true);
}

/**
 * navigator.gpu can exist without a usable GPU (e.g. no adapter on this machine). If the app
 * picked the in-browser model on its own and no adapter is available, fall back to no model.
 */
let gpuStatus = 'unknown'; // 'ok' | 'software' | 'none' once checked
let gpuF16 = null; // whether the GPU supports 16-bit shaders (null until checked)

async function checkGPU() {
  let adapter = null;
  try { adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }); } catch { /* no GPU */ }
  // With only "Unsafe WebGPU" on Linux, Chrome hands out SwiftShader: a CPU stand-in far too slow for a model.
  const info = adapter?.info || {};
  const software = !!adapter && (adapter.isFallbackAdapter || /swiftshader/i.test(`${info.architecture} ${info.description}`));
  gpuStatus = !adapter ? 'none' : software ? 'software' : 'ok';
  gpuF16 = adapter ? !!adapter.features?.has?.('shader-f16') : null;
  updateModelCard();
  updateWebLLMButton();
  updateEngineSwitch();
  return gpuStatus === 'ok';
}


/** WebLLM's errors are long and technical; show one short sentence. */
export function friendlyWebLLMError(e) {
  const msg = String(e?.message || e || '');
  if (/ShaderModule|GPUPipelineError|shader-f16|f16/i.test(msg)) {
    return 'This model needs 16-bit GPU shaders, which your browser does not offer. DashAgent now picks the 32-bit version: click Download again.';
  }
  if (/compatible GPU|WebGPU|adapter/i.test(msg)) return 'No usable GPU was found for WebGPU in this browser.';
  if (/quota|storage/i.test(msg)) return 'Not enough browser storage for the model.';
  if (/network|fetch|Failed to fetch/i.test(msg)) return 'The download was interrupted. Check your connection and try again.';
  return msg.length > 90 ? `${msg.slice(0, 89)}…` : msg;
}

function boot() {
  hydrateIcons();
  wireTooltip();
  wireDataInputs();
  // The in-browser CPU model is the default for everyone; the header switch moves to the GPU.
  // The CPU is the default; only a model the user picked themselves (providerChosen) overrides it.
  // Older versions saved 'webllm' or 'none' on their own, so those move to the CPU too.
  if (!hasSavedSettings() || !getSettings().providerChosen) saveSettings({ provider: 'wllama' });
  wireSettings();
  checkGPU();
  const cpuSel = $('#cpu-model');
  cpuSel.innerHTML = '';
  for (const m of CPU_MODELS) cpuSel.add(new Option(`${m.label} · ${m.gb} GB · ${m.note}`, m.file));
  cpuSel.value = cpuModel().file;
  cpuSel.addEventListener('change', () => {
    saveSettings({ cpuModel: cpuSel.value });
    cpuCached = null; // check the cache for this model
    download.error = '';
    updateModelCard();
    updateModelStatus();
  });
  $('#model-settings .ms-done').addEventListener('click', () => { $('#model-settings').open = false; $('#ask-input').focus({ preventScroll: true }); });
  $('#model-settings').addEventListener('toggle', () => {
    if ($('#model-settings').open && $('#provider').value === 'webllm') fillWebLLMModels();
  });
  $('#mc-download').addEventListener('click', onWebLLMLoad);
  $('#mc-other').addEventListener('click', () => openModelSettings(null, '#provider'));
  const switchTo = (provider) => {
    $('#provider').value = provider;
    $('#provider').dispatchEvent(new Event('change'));
  };
  $('#mc-use-ollama').addEventListener('click', () => switchTo('ollama'));
  $('#mc-use-cpu').addEventListener('click', () => switchTo('wllama'));
  $('#engine-switch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-engine]');
    if (b) switchTo(b.dataset.engine);
  });
  // Keep multi-threading on once the CPU model was set up; continue a download across the reload.
  try {
    if (localStorage.getItem(COI_KEY) === '1') loadCoiServiceWorker();
    if (sessionStorage.getItem('dashagent.autoDownload') === '1' && getSettings().provider === 'wllama') startCpuDownload();
  } catch { /* storage blocked */ }
  $('#model-card .mc-fix').addEventListener('click', () => { gpuNoticeOpen = !gpuNoticeOpen; updateModelCard(); });
  $('#model-card .mc-dismiss').addEventListener('click', () => {
    try { localStorage.setItem(GPU_NOTICE_KEY, '1'); } catch { /* ignore */ }
    gpuNoticeOpen = false;
    updateModelCard();
  });
  // Browsers block links to chrome:// pages, so copy the address for the user to paste.
  document.querySelectorAll('.flag-copy').forEach((btn) => btn.addEventListener('click', async () => {
    const label = btn.querySelector('.flag-copy-label');
    try {
      await navigator.clipboard.writeText(btn.querySelector('code').textContent.trim());
      label.textContent = 'Copied ✓';
    } catch {
      label.textContent = 'Select and copy';
    }
    setTimeout(() => { label.textContent = 'Copy'; }, 2500);
  }));
  $('#mc-use-claude').addEventListener('click', () => switchTo('claude'));
  $('#ask-form').addEventListener('submit', onAsk);
  $('#ask-input').addEventListener('input', updateSendButton);
  $('#stop-btn').addEventListener('click', () => running?.abort());
  wireExportMenu();
  $('#range-bar').addEventListener('click', onRange);
  $('#delete-all').addEventListener('click', onDeleteAll);
  $('#chat-btn').addEventListener('click', () => { document.body.classList.add('chat-open'); $('#ask-input').focus(); });
  $('#chat-close').addEventListener('click', () => document.body.classList.remove('chat-open'));
  $('#model-status').addEventListener('click', () => openModelSettings(null, '#provider'));
  // Minimize "Ask your data" to a slim rail so the dashboard gets the room; remembered.
  const setChatMin = (min) => {
    document.body.classList.toggle('chat-min', min);
    $('#chat-rail').hidden = !min;
    try { localStorage.setItem('dashagent.chatMin', min ? '1' : '0'); } catch { /* ignore */ }
    if (!min) $('#ask-input').focus({ preventScroll: true });
  };
  $('#chat-minimize').addEventListener('click', () => setChatMin(true));
  document.querySelector('.chat-name').addEventListener('click', () => {
    if (matchMedia('(min-width: 901px)').matches) setChatMin(true);
  });
  $('#chat-rail').addEventListener('click', () => setChatMin(false));
  try { if (localStorage.getItem('dashagent.chatMin') === '1') setChatMin(true); } catch { /* ignore */ }
  $('#storage-delete').addEventListener('click', onDeleteAll);
  wireHistory();
  wireStorage();
  enableChat(false);
  showSuggestions(STARTERS);
  freshConversation();
  restoreLast();
  refreshStorage();
  chartResizer?.observe($('#dashboard'));
}

boot();
