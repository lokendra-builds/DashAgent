// Everything stays in this browser: settings in localStorage, data in IndexedDB.
// Falls back to memory when storage is blocked (private mode, file://).

const SETTINGS_KEY = 'dashagent.settings';
const DB_NAME = 'dashagent';
// 'datasets'/'dashboards' hold the pre-history single dashboard (read once for migration).
// 'conversations' holds one record per chat; 'meta' holds small flags.
const STORES = ['datasets', 'dashboards', 'conversations', 'meta'];

export const DEFAULT_SETTINGS = Object.freeze({
  provider: 'wllama', // in-browser model on the CPU by default; the header switch moves to the GPU
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'qwen2.5-coder:7b',
  claudeModel: 'claude-haiku-5-5',
  claudeKey: '',
  webllmModel: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
  cpuModel: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
});

let memorySettings = null;
const memoryItems = new Map();

export function getSettings() {
  let saved = memorySettings;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? memorySettings;
  } catch { /* blocked or corrupt: use memory */ }
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

/** True once the visitor (or the app) has saved settings in this browser. */
export function hasSavedSettings() {
  try { return localStorage.getItem(SETTINGS_KEY) !== null; } catch { return memorySettings !== null; }
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  memorySettings = next;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* memory only */ }
  return next;
}

let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => STORES.forEach((s) => {
          if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
        });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export async function putItem(store, key, value) {
  const db = await openDB();
  if (!db) { memoryItems.set(`${store}/${key}`, value); return; }
  await tx(db, store, 'readwrite', (s) => s.put(value, key));
}

export async function getItem(store, key) {
  const db = await openDB();
  if (!db) return memoryItems.get(`${store}/${key}`) ?? null;
  return (await tx(db, store, 'readonly', (s) => s.get(key))) ?? null;
}

export async function deleteItem(store, key) {
  const db = await openDB();
  if (!db) { memoryItems.delete(`${store}/${key}`); return; }
  await tx(db, store, 'readwrite', (s) => s.delete(key));
}

/** Every value in a store (order not guaranteed). */
export async function listItems(store) {
  const db = await openDB();
  if (!db) return [...memoryItems].filter(([k]) => k.startsWith(`${store}/`)).map(([, v]) => v);
  return (await tx(db, store, 'readonly', (s) => s.getAll())) || [];
}

export async function clearAll() {
  memorySettings = null;
  memoryItems.clear();
  try { localStorage.removeItem(SETTINGS_KEY); } catch { /* ignore */ }
  const db = await openDB();
  if (db) await Promise.all(STORES.map((s) => tx(db, s, 'readwrite', (st) => st.clear())));
}
