// Model providers. Every provider is the same function: llm(messages, {signal}) -> Promise<string>.
// None of them cost the site owner anything: the model runs in the tab (WebLLM), on the
// visitor's machine (Ollama), or on the visitor's own Claude API key.

const ANTHROPIC_SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.14.0/+esm';
export const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.89';

/** An error the user fixes in Model settings; `code` tells the UI which setting to open. */
function setupError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ---- Claude (visitor's own key, official SDK, called straight from the browser) ----

function splitSystem(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  return { system, rest };
}

function claudeLLM({ claudeKey, claudeModel }) {
  let clientPromise = null;
  return async (messages, { signal } = {}) => {
    if (!claudeKey) throw setupError('Add your Claude API key in Model settings to start chatting.', 'MISSING_KEY');
    clientPromise ??= import(ANTHROPIC_SDK_URL).then(({ default: Anthropic }) => new Anthropic({
      apiKey: claudeKey,
      dangerouslyAllowBrowser: true, // the key is the visitor's own and never leaves their browser except to Anthropic
      maxRetries: 2,
    }));
    const client = await clientPromise;
    const { system, rest } = splitSystem(messages);
    const response = await client.messages.create({
      model: claudeModel || 'claude-haiku-5-5',
      max_tokens: 16000,
      ...(system ? { system } : {}),
      messages: rest,
    }, { signal });
    if (response.stop_reason === 'refusal') {
      throw new Error('Claude declined this request. Try rephrasing the question.');
    }
    return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  };
}

// ---- Ollama (visitor's machine) ----

function ollamaLLM({ ollamaUrl, ollamaModel }) {
  const base = String(ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
  return async (messages, { signal } = {}) => {
    let res;
    try {
      res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollamaModel, messages, stream: false, options: { temperature: 0 } }),
        signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw setupError(`Could not reach Ollama at ${base}. Is it running, and started with OLLAMA_ORIGINS=${location.origin}?`, 'OLLAMA_UNREACHABLE');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama error ${res.status}: ${text.slice(0, 200) || res.statusText}`);
    }
    const data = await res.json();
    return data?.message?.content ?? '';
  };
}

// ---- WebLLM (in this tab, on the GPU, in a Web Worker) ----

// Default in-browser model: small, good at SQL. Size is its GPU memory need from WebLLM's config.
export const DEFAULT_WEBLLM_MODEL = 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC';
export const KNOWN_MODEL_GB = {
  [DEFAULT_WEBLLM_MODEL]: 1.6,
  'Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC': 1.9,
};

/**
 * "f16" models need the GPU's shader-f16 feature. Many GPUs (e.g. NVIDIA on Linux via Vulkan)
 * don't expose it, so use the same model's f32 build there.
 */
export function compatibleModelId(id, hasF16) {
  if (hasF16 !== false) return id;
  return String(id || '').replace('q4f16_1', 'q4f32_1').replace('q0f16', 'q0f32');
}

/** "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC" -> "Qwen2.5 Coder 1.5B" */
export function friendlyModelName(id) {
  return String(id || '').replace(/-(Instruct|Chat|it)\b.*$/i, '').replace(/-q\d+f\d+.*$/i, '').replace(/-/g, ' ');
}

/**
 * Whether a model's files are already in the browser cache, read straight from Cache Storage
 * (WebLLM keeps weights in "webllm/model"), so no library download is needed to answer.
 */
export async function isWebLLMCachedFast(modelId) {
  try {
    if (!modelId || !('caches' in window)) return false;
    const names = (await caches.keys()).filter((n) => n.startsWith('webllm/model'));
    for (const name of names) {
      const keys = await (await caches.open(name)).keys();
      if (keys.some((r) => r.url.includes(`/${modelId}/`))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

let webllmEngine = null;
let webllmEngineModel = '';

export function hasWebGPU() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/** Instruction-tuned chat models from WebLLM's own runtime list, smallest first. */
export async function listWebLLMModels() {
  const { prebuiltAppConfig } = await import(WEBLLM_URL);
  return prebuiltAppConfig.model_list
    .filter((m) => /instruct|-it-|chat/i.test(m.model_id) && !/embed|vision/i.test(m.model_id))
    .map((m) => ({ id: m.model_id, vramMB: Math.round(m.vram_required_MB || 0), lowResource: !!m.low_resource_required }))
    .sort((a, b) => a.vramMB - b.vramMB);
}

/** Pick a sensible default: a small Qwen coder model (good at SQL), else the smallest. */
export function defaultWebLLMModel(models) {
  return (models.find((m) => /qwen2\.5-coder-1\.5b-instruct-q4f16/i.test(m.id))
    || models.find((m) => /qwen.*coder/i.test(m.id) && m.vramMB < 3000)
    || models.find((m) => m.vramMB >= 800) || models[0])?.id || '';
}

/**
 * True when the model's weights are already in the browser cache, so loading it needs no
 * download. Never throws: any error (unknown id, no Cache API, library unreachable) is false.
 */
export async function isWebLLMCached(modelId) {
  try {
    if (!modelId) return false;
    const { hasModelInCache } = await import(WEBLLM_URL);
    return (await hasModelInCache(modelId)) === true;
  } catch {
    return false;
  }
}

/** Downloads (first time) and loads a model. Only call this after the user clicks. */
export async function loadWebLLM(modelId, onProgress = () => {}) {
  if (webllmEngine && webllmEngineModel === modelId) return;
  const { CreateWebWorkerMLCEngine } = await import(WEBLLM_URL);
  const worker = new Worker(new URL('./webllm-worker.js', import.meta.url), { type: 'module' });
  if (webllmEngine) await webllmEngine.unload?.();
  webllmEngine = await CreateWebWorkerMLCEngine(worker, modelId, {
    initProgressCallback: (p) => onProgress({ progress: p.progress ?? 0, text: p.text ?? '' }),
  });
  webllmEngineModel = modelId;
}

export function webllmReady(modelId) {
  return !!webllmEngine && (!modelId || webllmEngineModel === modelId);
}

/**
 * Join a streamed chat completion into text. If the first piece takes longer than firstMs, or the
 * gap between pieces passes nextMs, call onStall() and throw GPU_STALLED instead of waiting forever.
 */
export async function collectStream(stream, { firstMs = 90_000, nextMs = 30_000, totalMs = 120_000, onStall = () => {} } = {}) {
  let it = null;
  const stalled = (ms, work) => {
    let timer;
    const stall = new Promise((_, reject) => {
      timer = setTimeout(() => reject(setupError(
        'The GPU is too slow or stopped responding. Switch to CPU in the header (it works on every computer) and ask again.', 'GPU_STALLED')), ms);
    });
    return Promise.race([work, stall]).catch((e) => {
      if (e?.code === 'GPU_STALLED') { onStall(); it?.return?.()?.catch?.(() => {}); }
      throw e;
    }).finally(() => clearTimeout(timer));
  };
  // The stream itself may be a promise that never resolves when the GPU hangs.
  const started = performance.now();
  it = (await stalled(firstMs, Promise.resolve(stream)))[Symbol.asyncIterator]();
  let text = '';
  let first = true;
  for (;;) {
    const elapsed = performance.now() - started;
    // A GPU that crawls (a token every few seconds) never finishes either: cap the whole reply.
    const ms = Math.max(1, Math.min(first ? firstMs - elapsed : nextMs, totalMs - elapsed));
    const step = await stalled(ms, it.next());
    if (step.done) return text;
    first = false;
    text += step.value?.choices?.[0]?.delta?.content ?? '';
  }
}

function webllmLLM({ webllmModel }) {
  return async (messages, { signal } = {}) => {
    if (!webllmReady(webllmModel)) throw setupError('Download the in-browser model first (Settings → Download model).', 'MODEL_NOT_DOWNLOADED');
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    const onAbort = () => webllmEngine.interruptGenerate();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const stream = webllmEngine.chat.completions.create({ messages, temperature: 0, max_tokens: 1024, stream: true });
      const text = await collectStream(stream, { onStall: () => webllmEngine.interruptGenerate() });
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      return text;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

// ---- wllama: the in-browser model on the CPU (no GPU, no flags) ----
// llama.cpp compiled to WebAssembly, bundled in vendor/wllama. Multi-threaded when the page is
// cross-origin isolated (coi-serviceworker.js), otherwise single-threaded (much slower).
const WLLAMA_URL = new URL('../vendor/wllama/index.js', import.meta.url).href;
const WLLAMA_WASM = new URL('../vendor/wllama/wasm/wllama.wasm', import.meta.url).href;
// Small GGUF models for the CPU. Each file stays under the browser's 2 GB ArrayBuffer limit,
// so the 3B and Phi models use a 3-bit file instead of the usual 4-bit one.
export const CPU_MODELS = Object.freeze([
  { company: 'Alibaba', name: 'Qwen2.5 Coder 0.5B', repo: 'Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF', file: 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf', gb: 0.5, note: 'fastest, often wrong' },
  { company: 'Alibaba', name: 'Qwen2.5 Coder 1.5B', repo: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF', file: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf', gb: 1.1, note: 'recommended' },
  { company: 'Alibaba', name: 'Qwen2.5 Coder 3B', repo: 'Qwen/Qwen2.5-Coder-3B-Instruct-GGUF', file: 'qwen2.5-coder-3b-instruct-q3_k_m.gguf', gb: 1.7, note: 'most accurate, slower' },
  { company: 'Alibaba', name: 'Qwen3 1.7B', repo: 'unsloth/Qwen3-1.7B-GGUF', file: 'Qwen3-1.7B-Q4_K_M.gguf', gb: 1.1, note: 'good at general chat', thinks: true, noThink: true },
  { company: 'Meta', name: 'Llama 3.2 1B', repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF', file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', gb: 0.8, note: 'fast, often wrong' },
  { company: 'Hugging Face', name: 'SmolLM2 1.7B', repo: 'HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF', file: 'smollm2-1.7b-instruct-q4_k_m.gguf', gb: 1.1, note: 'light, sometimes wrong' },
  { company: 'Microsoft', name: 'Phi-3.5 mini', repo: 'bartowski/Phi-3.5-mini-instruct-GGUF', file: 'Phi-3.5-mini-instruct-Q3_K_S.gguf', gb: 1.7, note: 'accurate, slow' },
].map((m) => Object.freeze({ ...m, label: `${m.company} | ${m.name}` })));
export const DEFAULT_CPU_MODEL = 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf';
export const CPU_MODEL = CPU_MODELS.find((m) => m.file === DEFAULT_CPU_MODEL);

/** The CPU model for a saved file name (unknown names fall back to the default). */
export function cpuModelFor(file) {
  return CPU_MODELS.find((m) => m.file === file) || CPU_MODEL;
}

let wllamaEngine = null;
let wllamaLoadedFile = null;

/** Whether this model (default: any) is loaded and ready to answer. */
export function wllamaReady(file) {
  return !!wllamaLoadedFile && (!file || cpuModelFor(file).file === wllamaLoadedFile);
}

/** Whether the model's file is already in wllama's browser cache. */
export async function isWllamaCached(file = DEFAULT_CPU_MODEL) {
  const m = cpuModelFor(file);
  try {
    const { ModelManager } = await import(WLLAMA_URL);
    const models = await new ModelManager().getModels();
    return models.some((x) => String(x.url || '').includes(m.file));
  } catch {
    return false;
  }
}

/** Download (first time) and load a CPU model. Only call this after the user clicks. */
export async function loadWllama(file = DEFAULT_CPU_MODEL, onProgress = () => {}) {
  const m = cpuModelFor(file);
  if (wllamaLoadedFile === m.file) return;
  const { Wllama } = await import(WLLAMA_URL);
  if (wllamaEngine && wllamaLoadedFile) { // switching models: free the old one first
    await wllamaEngine.exit().catch(() => {});
    wllamaEngine = null;
    wllamaLoadedFile = null;
  }
  wllamaEngine ??= new Wllama({ default: WLLAMA_WASM }, { suppressNativeLog: true });
  await wllamaEngine.loadModelFromHF({ repo: m.repo, file: m.file }, {
    n_gpu_layers: 0, // CPU only
    n_ctx: 4096,
    progressCallback: ({ loaded, total }) => onProgress({
      progress: total ? loaded / total : 0,
      text: `${Math.round(loaded / 1e6)}MB fetched`,
    }),
  });
  wllamaLoadedFile = m.file;
  wllamaQueue.reset(); // a newly loaded model has an empty cache
}

export function wllamaMultithread() {
  return !!wllamaEngine?.isMultithread?.();
}

/**
 * One request at a time on the CPU engine. Warm-ups are best-effort: the same text is never warmed
 * twice, and a warm-up still waiting in line is dropped when a real request arrives.
 */
export function makeWarmQueue() {
  let tail = Promise.resolve();
  let seq = 0;
  let warmed = null;
  const enqueue = (fn) => {
    const job = tail.then(fn, fn);
    tail = job.catch(() => {});
    return job;
  };
  return {
    run(fn) { seq++; return enqueue(fn); },
    warm(key, fn) {
      if (key === warmed) return Promise.resolve();
      warmed = key;
      const my = ++seq;
      return enqueue(async () => { if (my === seq) await fn(); else warmed = null; });
    },
    reset() { warmed = null; },
  };
}
const wllamaQueue = makeWarmQueue();
const noGrammar = new Set(); // models whose JSON grammar failed to load
const queued = (fn) => wllamaQueue.run(fn);

function wllamaLLM(settings) {
  const withNoThink = (m, msgs) => (m.noThink ? msgs.map((x, i) => (i === 0 && x.role === 'system' ? { ...x, content: `${x.content}\n/no_think` } : x)) : msgs);
  const call = (messages, opts) => queued(() => ask(messages, opts));
  const ask = async (messages, { signal, json = false } = {}) => {
    if (!wllamaReady(settings.cpuModel || DEFAULT_CPU_MODEL)) throw setupError('Download the in-browser model first (Settings → Download model).', 'MODEL_NOT_DOWNLOADED');
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    const m = cpuModelFor(settings.cpuModel);
    // Qwen3 can skip its thinking on request; models that must think get room for it.
    const msgs = withNoThink(m, messages);
    const mustThink = m.thinks && !m.noThink;
    const complete = (strict) => wllamaEngine.createChatCompletion({
      messages: msgs,
      max_tokens: mustThink ? 2048 : json ? 300 : 400,
      temperature: 0,
      cache_prompt: true, // reuse the already-read instructions and schema between calls
      // Strict JSON for the SQL step: no half-written replies, and shorter output.
      ...(strict ? { response_format: { type: 'json_object' } } : {}),
      ...(m.noThink ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      abortSignal: signal,
    });
    const strict = json && !mustThink && !noGrammar.has(m.file);
    try {
      let reply;
      try {
        reply = await complete(strict);
      } catch (e) {
        // Some models' vocabularies can't build the JSON grammar: ask again without it.
        if (!strict || signal?.aborted || !/sampler|grammar/i.test(String(e?.message || e))) throw e;
        noGrammar.add(m.file);
        reply = await complete(false);
      }
      return reply?.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      throw e;
    }
  };
  call.fast = true; // CPU: the app writes the answer sentence itself instead of a second model call
  // Read the long instructions once, in the background, so the first question is as quick as the rest.
  call.warm = (system) => wllamaQueue.warm(`${settings.cpuModel}\n${system}`, async () => {
    if (!wllamaReady(settings.cpuModel || DEFAULT_CPU_MODEL)) return;
    const m = cpuModelFor(settings.cpuModel);
    await wllamaEngine.createChatCompletion({
      messages: withNoThink(m, [{ role: 'system', content: system }, { role: 'user', content: 'Ready?' }]),
      max_tokens: 1, temperature: 0, cache_prompt: true,
    }).catch(() => {});
  });
  return call;
}

// ---- Mock (tests and demos: ?mock=1) ----

function mockLLM() {
  const call = async (messages, { signal } = {}) => {
    const delay = window.__mockDelayMs || 0;
    if (delay) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
      });
    }
    window.__mockSeen = [...(window.__mockSeen || []), JSON.parse(JSON.stringify(messages))];
    const replies = window.__mockReplies || [];
    if (!replies.length) throw new Error('Mock model has no scripted replies left.');
    const reply = replies.shift();
    if (reply && typeof reply === 'object') throw setupError(reply.error, reply.code); // scripted failure
    return reply;
  };
  call.warm = async (system) => { window.__mockWarm = [...(window.__mockWarm || []), system]; };
  return call;
}

/** Returns llm(messages, {signal}) for the chosen provider, or null for "No model". */
export function makeLLM(settings) {
  switch (settings?.provider) {
    case 'claude': return claudeLLM(settings);
    case 'ollama': return ollamaLLM(settings);
    case 'webllm': return webllmLLM(settings);
    case 'wllama': return wllamaLLM(settings);
    case 'mock': return mockLLM();
    default: return null;
  }
}
