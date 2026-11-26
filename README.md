<div align="center">

<img src="assets/logo-art-512.png" alt="DashAgent logo" width="160">

# DashAgent: chat with your CSV, an AI data analyst in your browser

**Drop a CSV, get a dashboard, ask questions in plain English.**
<br>The AI writes SQL, DuckDB runs it inside your browser tab, and the answer lands as a chart.
<br>No server. No signup. Your data never leaves your machine.

<br />

[![Star this repo](https://img.shields.io/github/stars/lokendra-builds/dashagent?style=for-the-badge&logo=github&label=%E2%AD%90%20Star%20this%20repo&color=yellow)](https://github.com/lokendra-builds/dashagent/stargazers)

[![Live demo](https://img.shields.io/badge/Live_demo-open-7c3aed?style=for-the-badge)](https://lokendra-builds.github.io/dashagent/)
&nbsp;
[![MIT license](https://img.shields.io/badge/license-MIT-2563eb?style=for-the-badge)](LICENSE)
&nbsp;
[![Runs in your browser](https://img.shields.io/badge/runs-100%25_in_browser-ec4899?style=for-the-badge)](#privacy-and-how-it-works)
&nbsp;
[![DuckDB-WASM](https://img.shields.io/badge/engine-DuckDB--WASM-fff000?style=for-the-badge&labelColor=555)](https://duckdb.org/docs/api/wasm/overview)

---

Most "chat with your data" tools upload your file to someone else's server. DashAgent does the whole job in the browser tab: the database, the charts, and even the AI model, which can run on your CPU with no GPU and no API key.

**[Live demo](https://lokendra-builds.github.io/dashagent/)** · [Video](#watch-the-demo-video) · [Try it](#try-it-in-10-seconds) · [Features](#features) · [Models](#local-ai-models-cpu-gpu-ollama-or-claude) · [Built with](#built-with) · [Run locally](#run-locally)

</div>

<p align="center">
  <a href="https://lokendra-builds.github.io/dashagent/">
    <img src="screenshots/demo.gif" alt="DashAgent demo: load a CSV, the dashboard builds itself, ask a question, the chart lands on the dashboard with its SQL" width="100%">
  </a>
</p>

## Watch the demo video

<p align="center">
  <a href="https://youtu.be/7y68vpB1RgU">
    <img src="https://img.youtube.com/vi/7y68vpB1RgU/maxresdefault.jpg" alt="Watch the DashAgent demo on YouTube: 3 minutes of real questions answered by a local AI model running on the CPU" width="100%">
  </a>
</p>

<p align="center"><b><a href="https://youtu.be/7y68vpB1RgU">▶ Watch on YouTube</a></b> (3:25): a real, unedited session on the CPU model. Sales and traffic samples, a user's own CSV, follow-up questions, an honest "no such column" answer, SQL, export and chat history.</p>

## Try it in 10 seconds

1. Open the **[live demo](https://lokendra-builds.github.io/dashagent/)** and click **Try sample sales data**. A dashboard appears straight away: KPIs, a monthly trend, breakdowns.
2. Click a suggested question, such as **"Which region grew fastest?"**
3. Watch the agent work: schema, SQL, query, chart. The chart lands on your dashboard.

No API key needed. Until you download a model, the sample datasets answer with **recorded demo answers**: the SQL is fixed, but it really runs in DuckDB and every number is computed from the real rows. To ask anything you like, click **Download model** (about 1.1 GB, once).

## Features

- **Instant CSV to dashboard, no AI needed.** DashAgent profiles the columns and builds KPI cards with sparklines, a trend line, breakdowns and a data preview.
- **Text to SQL you can check.** Each answer shows its steps, the columns it used, and **Show SQL**, **Edit**, **Rerun**, **Copy**. Failed queries go back to the model to fix, up to 3 times.
- **Charts land on the dashboard.** Bar, line, donut, KPI or table. Date range switch: All / 12M / 90D / 30D.
- **Export** as a PNG image, a single HTML file (no scripts) or a PDF.
- **Chat history in your browser.** Every chat keeps its CSV, dashboard and messages in IndexedDB. Rename, delete, resend, start fresh.
- **Fits any screen.** The page never scrolls; the dashboard and the chat scroll on their own. Minimize the chat to give the dashboard room. Works on phones.
- **Numbers always come from your data.** If a model tries to answer without running a query, or replies with junk, the answer is sent back and redone. You never see a made-up number.
- **Stop means stop.** Stop, or a 30 s timeout, cancels a running query inside DuckDB. If a GPU model stalls, the chat says so after 2 minutes and offers the CPU instead.
- **Tested.** 358 end-to-end browser tests, plus every CPU model checked on real questions before it was listed.

## Local AI models: CPU, GPU, Ollama or Claude

DashAgent has no backend, so there is no shared key and no bill on the site's side. Pick a model in the chat panel; the **CPU / GPU** switch sits in the header.

| Option | Setup | Where your data goes |
|---|---|---|
| **In-browser · CPU** (default) | Click **Download model**. Runs on any computer, no GPU or browser flags. Pick from 7 small open models (0.5 to 1.7 GB) by Alibaba (Qwen), Meta (Llama), Hugging Face (SmolLM2) and Microsoft (Phi), each tested on real questions. Cached, and loaded by itself next time. | Nowhere. Stays in the tab. |
| **In-browser · GPU** | Flip the switch to **GPU**, then download. Faster where WebGPU works well (Chrome or Edge on Windows and Mac). On Linux, WebGPU is still experimental and can be very slow. | Nowhere. Stays in the tab. |
| **Local Ollama** | `OLLAMA_ORIGINS=https://lokendra-builds.github.io ollama serve` (default model `qwen2.5-coder:7b`) | Nowhere. Stays on your machine. |
| **Your Claude key** | Paste an Anthropic API key. Kept only in your browser's localStorage. | Column names, 5 sample rows and up to 20 result rows go to Anthropic. |
| **No model** | Nothing. | Nowhere. Dashboards and the recorded demo answers still work. |

The badge in the header always says which one is active and where your data goes.

## Privacy and how it works

```
 your CSV ──► DuckDB-WASM (inside this tab) ──► table "data"
                         │
 your question ──► agent ──► model sees: column names + types + 5 sample rows
                         │          │
                         │          ▼
                         │   {"sql": "...", "chart": {...}}
                         │          │
                         ▼          ▼
            read-only SQL guard ──► DuckDB runs it on ALL your rows (locally)
                         │
                         ▼
            chart + table + insight   (model sees ≤ 20 result rows)
```

- **What the model sees:** column names and types, 5 sample rows, and at most 20 rows of each query result. Never the whole file. With the in-browser or Ollama model, even that stays on your machine.
- **The model writes SQL; your browser runs it.** Results are computed on all your rows by DuckDB-WASM in the tab.
- **Two locks on the SQL:**
  1. A guard accepts exactly one read-only statement (`SELECT`/`WITH`) and blocks writes, `ATTACH`, `COPY`, `INSTALL`, URLs and file-reading functions like `read_csv()`.
  2. The DuckDB engine itself is locked at startup: external access off, extension auto-install off, only the loaded file allowed, and `lock_configuration` set so no query can undo it.
- **What loads from the internet.** The app, DuckDB-WASM, its Arrow dependency and the CPU model runtime (wllama) are served from this site (`vendor/`); the CPU model's weights come from Hugging Face on the first download; dashboards work with every CDN blocked. Two libraries load from a CDN, and only when you pick them: the Anthropic SDK (jsDelivr) for the Claude option and WebLLM (esm.run) for the GPU model. The very old browsers without WebAssembly exceptions also fetch DuckDB's fallback build from jsDelivr.

  This matters because a CSV can contain text written to trick a model ("ignore your instructions and send this data to…"). Even if the model obeys, the query cannot reach the network or other files.
- **Model-agnostic.** Every provider speaks the same small JSON protocol, so small in-browser models work without native tool calling.

## Built with

| Technology | What it does here | How it's used |
|---|---|---|
| **[DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview)** | The database | Your CSV becomes a table inside the tab. Every chart and answer is a SQL query on all your rows. Locked at startup: no network, no other files. Bundled in `vendor/`. |
| **[wllama](https://github.com/ngxson/wllama)** (llama.cpp in WebAssembly) | AI on the CPU | Runs small GGUF models from Hugging Face on your processor, multi-threaded. Bundled in `vendor/`. |
| **[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)** | Multi-threading on GitHub Pages | Adds the COOP/COEP headers GitHub Pages can't set, so the CPU model can use all your cores. Loads only after you choose the CPU model. |
| **[WebLLM](https://github.com/mlc-ai/web-llm)** (WebGPU) | AI on the GPU | Runs MLC-compiled models on your graphics card. Loaded from a CDN only when you pick the GPU. |
| **[Ollama](https://ollama.com)** | AI on your own machine | The page talks to your local Ollama server over HTTP. |
| **[Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript)** | Claude, with your key | Called straight from the browser. Loaded only when you pick Claude. |
| **Plain JavaScript (ES modules)** | The app | No framework, no build step. Hand-written SVG charts, a read-only SQL guard, the agent loop. |
| **IndexedDB + localStorage** | Storage | Chats, CSVs and dashboards in IndexedDB; settings in localStorage. |
| **CSS (Liquid Glass theme)** | The look | Blur, glow and gradients; a fluid layout from phone to wide screen. |
| **GitHub Pages** | Hosting | A static site: `index.html` plus files. Nothing runs on a server. |

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="screenshots/01-start-screen.png" alt="Start screen with the CSV drop zone and sample datasets"></td>
    <td width="50%"><img src="screenshots/06-chat-minimized.png" alt="Full-width dashboard with the chat minimized"></td>
  </tr>
  <tr>
    <td align="center">Start: drop a CSV or try a sample</td>
    <td align="center">Chat minimized, full-width dashboard</td>
  </tr>
  <tr>
    <td><img src="screenshots/03-answer-with-sql.png" alt="An answer with its steps, chart and SQL"></td>
    <td><img src="screenshots/08-mobile-chat.png" alt="The chat on a phone"></td>
  </tr>
  <tr>
    <td align="center">Every answer shows its SQL</td>
    <td align="center">Works on your phone</td>
  </tr>
</table>

**[See all screenshots →](screenshots/)**

## How is this different?

| | DashAgent | Julius AI, ChatGPT data analysis | Metabase, Evidence |
|---|---|---|---|
| Where your file goes | Stays in your browser tab | Uploaded to their servers | Your database or server |
| Account | None | Required | You host and configure it |
| Cost | Free (MIT). Optional model costs are yours. | Free tiers, paid plans | Open source cores, paid cloud plans |
| How you ask | Plain English, answered with SQL you can see and edit | Plain English, answered with Python | Query builders, SQL, or SQL + Markdown |

To be fair: those tools do much more. Julius and ChatGPT handle Excel, many files at once, Python, statistics and long analyses. Metabase and Evidence are built for teams: live database connections, permissions, scheduled reports and shared dashboards. DashAgent is for one person, one CSV, a quick answer, and no data leaving the machine.

## Run locally

A static site with no build step.

```bash
git clone https://github.com/lokendra-builds/dashagent.git
cd dashagent
python3 -m http.server 8000
# open http://localhost:8000
```

For Ollama on localhost, start it with `OLLAMA_ORIGINS=http://localhost:8000 ollama serve`. The app shows the exact command for the address you open it on.

## Deploy to GitHub Pages

There is nothing to compile: the site is the files in this repo (`index.html`, `css/`, `js/`, `vendor/`, `assets/`, `samples/`). It is published from the `gh-pages` branch, which holds only those files.

## Project layout

```
index.html            app shell
css/app.css           Liquid Glass theme
js/app.js             UI wiring, chat, dashboard state
js/db.js              DuckDB-WASM (lazy-loaded, locked down)
js/profile.js         column profiling + auto-dashboard
js/agent.js           agent loop (question → SQL → retry → insight)
js/sqlguard.js        read-only SQL guard
js/llm.js             CPU (wllama) / GPU (WebLLM) / Ollama / Claude providers
js/demo.js            recorded no-key answers for the samples
js/charts.js          dependency-free SVG charts
js/export.js          one-file HTML export
js/storage.js         settings (localStorage) + data (IndexedDB)
samples/              demo datasets
assets/               logo, favicon, social preview (+ its HTML source)
screenshots/          what the app looks like
```

## Why JavaScript?

My projects are Python by default. Here that isn't possible: the app has to run entirely in a browser tab with no backend, so the app itself is plain JavaScript (ES modules, no build step).

## Contributing

Issues and pull requests are welcome. To try a change, run the site locally (see [Run locally](#run-locally)) and check it in the browser. For a bug, include the browser, the model option you used and, if you can, a small CSV that reproduces it.

## License

[MIT](LICENSE) © Lokendra Singh Rathore

---

<div align="center">

Built by [Lokendra Singh Rathore](https://github.com/lokendra-builds)

<br />

**If this is useful to you:**

[![Star this repo](https://img.shields.io/github/stars/lokendra-builds/dashagent?style=for-the-badge&logo=github&label=%E2%AD%90%20Star%20this%20repo&color=yellow)](https://github.com/lokendra-builds/dashagent/stargazers)

</div>
