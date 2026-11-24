import { CURATED_MODELS, PROVIDERS } from './catalog.js';
import {
  checkServerProxy,
  executeCodeRemote,
  extractDocumentRemote,
  generateImage,
  generateText,
  generateTextStream,
  hostWebsiteLocal,
  loadProviderKeys,
  saveProviderKeys,
  syncLiveGlobalCatalog,
  testProviderConnection,
} from './providers.js';
import { escapeHtml, extractCodeBlocks, isRunnableLang, renderMarkdown } from './markdown.js';

const PREFS_KEY = 'omnifree_studio_prefs_v3';

const state = {
  models: [...CURATED_MODELS],
  keys: loadProviderKeys(),
  activeTab: 'coding',
  codingHistory: [],
  writingHistory: [],
  codingAttachments: [],
  writingAttachments: [],
  imageRefAttachment: null,
  images: [],
  selectedStyle: '',
  artifactLang: 'html',
  codingAbort: null,
  writingAbort: null,
  modelFilters: {
    search: '',
    provider: 'all',
    cap: 'all',
  },
  prefs: loadPrefs(),
};

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch {
    return {};
  }
}

function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
}

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  bindNavigation();
  bindCodingStudio();
  bindWritingStudio();
  bindImageStudio();
  bindModelsDirectory();
  bindKeysModal();
  bindLightbox();
  bindIframeConsoleBridge();
  bindAttachmentHandlers('coding');
  bindAttachmentHandlers('writing');

  populateAllModelSelectors();
  renderKeysModal();
  renderModelsGrid();
  updateWordCount();
  updateConnectedKeysBadge();

  if (state.prefs.writingDraft) {
    document.getElementById('writing-document').value = state.prefs.writingDraft;
    updateWordCount();
  }

  const proxyOnline = await checkServerProxy();
  const dot = document.getElementById('proxy-status-dot');
  const keysBtn = document.getElementById('open-keys-btn');
  if (proxyOnline) {
    dot.classList.add('online');
    keysBtn.title = 'Localhost hosting, streaming proxy & code runner active — Click to manage API keys';
  } else {
    keysBtn.title = 'Browser direct mode — Click to manage API keys';
  }

  await refreshGlobalCatalog(false);
});

function initTheme() {
  const saved = state.prefs.theme || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('theme-toggle-btn').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    state.prefs.theme = next;
    savePrefs();
  });
}

// ==================== NAVIGATION ====================
function bindNavigation() {
  document.querySelectorAll('.nav-pill').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.nav-pill').forEach((btn) => {
    const isActive = btn.dataset.tab === tabId;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
  document.querySelectorAll('.studio-view').forEach((view) => {
    view.classList.toggle('active', view.id === `view-${tabId}`);
  });
}

// ==================== HELPERS ====================
function isModelReady(model) {
  const provider = PROVIDERS[model.provider];
  if (!provider || model.provider === 'external') return false;
  if (!provider.requiresKey) return true;
  return Boolean((state.keys[model.provider] || '').trim());
}

function getModelById(uid) {
  return state.models.find((m) => m.id === uid) || state.models[0];
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function decodeBase64Utf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

function updateConnectedKeysBadge() {
  const count = Object.entries(state.keys).filter(
    ([prov, val]) => PROVIDERS[prov]?.requiresKey && String(val || '').trim().length > 0
  ).length;
  const badge = document.getElementById('keys-connected-badge');
  badge.textContent = count > 0 ? `API Keys (${count})` : 'API Keys';
}

function populateSelect(selectEl, models, preferredId) {
  const runnable = models.filter((m) => m.provider !== 'external');
  const ready = runnable.filter((m) => isModelReady(m));
  const needsKey = runnable.filter((m) => !isModelReady(m));

  selectEl.innerHTML = '';

  if (ready.length > 0) {
    const groupReady = document.createElement('optgroup');
    groupReady.label = 'Ready Now';
    for (const m of ready) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.name}`;
      groupReady.appendChild(opt);
    }
    selectEl.appendChild(groupReady);
  }

  if (needsKey.length > 0) {
    const groupLocked = document.createElement('optgroup');
    groupLocked.label = 'Free Key Required';
    for (const m of needsKey) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `🔑 ${m.name}`;
      groupLocked.appendChild(opt);
    }
    selectEl.appendChild(groupLocked);
  }

  if (preferredId && runnable.some((m) => m.id === preferredId)) {
    selectEl.value = preferredId;
  } else if (ready.length > 0) {
    selectEl.value = ready[0].id;
  } else if (runnable.length > 0) {
    selectEl.value = runnable[0].id;
  }
}

function populateAllModelSelectors() {
  const codingModels = state.models.filter((m) => m.capabilities.includes('coding'));
  const writingModels = state.models.filter((m) => m.capabilities.includes('writing'));
  const imageModels = state.models.filter((m) => m.capabilities.includes('image'));

  populateSelect(
    document.getElementById('coding-model-select'),
    codingModels,
    state.prefs.codingModel || 'pollinations::qwen-coder'
  );
  populateSelect(
    document.getElementById('writing-model-select'),
    writingModels,
    state.prefs.writingModel || 'pollinations::openai'
  );
  populateSelect(
    document.getElementById('image-model-select'),
    imageModels,
    state.prefs.imageModel || 'pollinations-img::flux'
  );

  const provFilter = document.getElementById('models-provider-filter');
  const prevVal = provFilter.value;
  provFilter.innerHTML = '<option value="all">All Providers</option>';
  for (const prov of Object.values(PROVIDERS)) {
    const opt = document.createElement('option');
    opt.value = prov.id;
    opt.textContent = `${prov.name}`;
    provFilter.appendChild(opt);
  }
  if (prevVal) provFilter.value = prevVal;

  document.getElementById('model-count-badge').textContent = String(state.models.length);
  updateImageModelNote();
}

function updateImageModelNote() {
  const imageModel = getModelById(document.getElementById('image-model-select').value);
  document.getElementById('image-model-note').textContent = imageModel ? imageModel.description : '';
}

// ==================== ATTACHMENTS (PHOTOS, VIDEOS, PDFs, DOCS, FILES) ====================
function bindAttachmentHandlers(studio) {
  const attachBtn = document.getElementById(`${studio}-attach-btn`);
  const fileInput = document.getElementById(`${studio}-file-input`);
  const dropzone = document.getElementById(`${studio}-form`);
  const textarea = document.getElementById(`${studio}-input`);

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    if (fileInput.files?.length) {
      await handleAttachedFiles(studio, Array.from(fileInput.files));
      fileInput.value = '';
    }
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) {
      await handleAttachedFiles(studio, Array.from(e.dataTransfer.files));
    }
  });

  textarea.addEventListener('paste', async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items.filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (files.length > 0) {
      await handleAttachedFiles(studio, files);
    }
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsText(file);
  });
}

async function sampleVideoFrames(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Could not decode video'));
    });

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 360;
    const canvas = document.createElement('canvas');
    const maxW = 640;
    const scale = width > maxW ? maxW / width : 1;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');

    const timestamps = duration > 0.5 ? [0.1 * duration, 0.5 * duration, 0.85 * duration] : [0];
    const frames = [];
    for (const t of timestamps) {
      video.currentTime = t;
      await new Promise((resolve) => {
        video.onseeked = resolve;
        setTimeout(resolve, 600);
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL('image/jpeg', 0.72));
    }

    return {
      frames,
      width,
      height,
      durationLabel: `${duration.toFixed(1)}s`,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handleAttachedFiles(studio, files) {
  const listKey = studio === 'coding' ? 'codingAttachments' : 'writingAttachments';
  for (const file of files) {
    const lower = file.name.toLowerCase();
    try {
      if (file.type.startsWith('image/')) {
        const dataUrl = await readAsDataUrl(file);
        const base64 = dataUrl.split(',')[1] || '';
        state[listKey].push({
          id: `${Date.now()}-${Math.random()}`,
          kind: 'image',
          name: file.name,
          mimeType: file.type,
          size: file.size,
          dataUrl,
          base64,
        });
      } else if (file.type.startsWith('video/')) {
        showToast(`Processing video frames for ${file.name}...`, 'info');
        const info = await sampleVideoFrames(file);
        state[listKey].push({
          id: `${Date.now()}-${Math.random()}`,
          kind: 'video',
          name: file.name,
          mimeType: file.type,
          size: file.size,
          ...info,
        });
      } else if (lower.endsWith('.pdf')) {
        const dataUrl = await readAsDataUrl(file);
        const base64 = dataUrl.split(',')[1] || '';
        const extracted = await extractDocumentRemote({ filename: file.name, base64 });
        state[listKey].push({
          id: `${Date.now()}-${Math.random()}`,
          kind: 'pdf',
          name: file.name,
          mimeType: 'application/pdf',
          size: file.size,
          base64,
          textContent: extracted?.text || '',
        });
        if (!extracted?.text) {
          showToast(`Attached ${file.name}. Use a Gemini model for native scanned-PDF reading.`, 'info');
        }
      } else if (lower.endsWith('.docx')) {
        const dataUrl = await readAsDataUrl(file);
        const base64 = dataUrl.split(',')[1] || '';
        const extracted = await extractDocumentRemote({ filename: file.name, base64 });
        state[listKey].push({
          id: `${Date.now()}-${Math.random()}`,
          kind: 'document',
          name: file.name,
          mimeType: file.type,
          size: file.size,
          textContent: extracted?.text || '',
        });
      } else {
        const textContent = await readAsText(file);
        state[listKey].push({
          id: `${Date.now()}-${Math.random()}`,
          kind: 'file',
          name: file.name,
          mimeType: file.type || 'text/plain',
          size: file.size,
          textContent,
        });
      }
    } catch (err) {
      showToast(`Could not attach ${file.name}: ${err.message}`, 'error');
    }
  }
  renderAttachmentStrip(studio);
}

function renderAttachmentStrip(studio) {
  const listKey = studio === 'coding' ? 'codingAttachments' : 'writingAttachments';
  const strip = document.getElementById(`${studio}-attachments`);
  const items = state[listKey];

  if (items.length === 0) {
    strip.hidden = true;
    strip.innerHTML = '';
    return;
  }

  strip.hidden = false;
  strip.innerHTML = '';

  for (const att of items) {
    const chip = document.createElement('div');
    chip.className = 'att-chip';

    if (att.kind === 'image' && att.dataUrl) {
      const img = document.createElement('img');
      img.src = att.dataUrl;
      img.alt = att.name;
      chip.appendChild(img);
    } else if (att.kind === 'video' && att.frames?.[0]) {
      const img = document.createElement('img');
      img.src = att.frames[0];
      img.alt = att.name;
      chip.appendChild(img);
    } else {
      const icon = document.createElement('span');
      icon.textContent = att.kind === 'pdf' ? '📄' : att.kind === 'document' ? '📝' : '📎';
      chip.appendChild(icon);
    }

    const name = document.createElement('span');
    name.className = 'att-chip-name';
    name.textContent = att.name;
    chip.appendChild(name);

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'att-chip-remove';
    rm.textContent = '✕';
    rm.addEventListener('click', () => {
      state[listKey] = state[listKey].filter((x) => x.id !== att.id);
      renderAttachmentStrip(studio);
    });
    chip.appendChild(rm);

    strip.appendChild(chip);
  }
}

// ==================== 1. CODING STUDIO + WORKBENCH + LOCALHOST HOSTING ====================
const CODING_SYSTEM_PROMPTS = {
  fullstack:
    'You are an expert Full-Stack Software Engineer. Write clean, runnable, self-contained code in fenced markdown blocks with the exact language tag (```html, ```python, ```javascript, or ```sql). When building a website or web app, provide a complete single self-contained HTML file (with inline CSS and JS) so it can be hosted live on localhost immediately. Keep explanations concise.',
  debugger:
    'You are a Senior Debugging Specialist. Identify the root cause briefly and provide the complete fixed, runnable code in a fenced markdown block.',
  reviewer:
    'You are a Principal Engineer performing a code review. Highlight real bugs, edge cases, and security issues concisely, then provide improved runnable code.',
  refactor:
    'You are a clean-architecture specialist. Refactor the code for clarity and performance while preserving behavior, returning runnable code in a fenced markdown block.',
  sql:
    'You are a SQL & Data Engineer. Provide valid SQLite-compatible SQL scripts (CREATE TABLE, INSERT, and SELECT queries) in ```sql fenced blocks so they can execute directly.',
};

function bindCodingStudio() {
  const modelSelect = document.getElementById('coding-model-select');
  modelSelect.addEventListener('change', () => {
    state.prefs.codingModel = modelSelect.value;
    savePrefs();
  });

  document.getElementById('coding-clear-btn').addEventListener('click', () => {
    if (state.codingAbort) state.codingAbort.abort();
    state.codingHistory = [];
    state.codingAttachments = [];
    renderAttachmentStrip('coding');
    hideWorkbench();
    document.getElementById('toggle-workbench-btn').hidden = true;
    renderChatEmpty(
      'coding-messages',
      'New coding session started. Ask to build a website or run Python/JS/SQL — results appear automatically once complete.'
    );
  });

  document.getElementById('toggle-workbench-btn').addEventListener('click', () => {
    document.getElementById('coding-split').classList.toggle('workbench-hidden');
  });

  document.getElementById('close-workbench-btn').addEventListener('click', hideWorkbench);

  document.querySelectorAll('.starter-card[data-studio="coding"]').forEach((card) => {
    card.addEventListener('click', () => {
      document.getElementById('coding-input').value = card.dataset.prompt;
      submitCodingMessage();
    });
  });

  const inputEl = document.getElementById('coding-input');
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitCodingMessage();
    }
  });

  document.getElementById('coding-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.codingAbort) {
      state.codingAbort.abort();
      return;
    }
    submitCodingMessage();
  });

  document.querySelectorAll('.wb-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchWorkbenchTab(btn.dataset.wbTab));
  });

  document.getElementById('wb-run-btn').addEventListener('click', () => {
    const code = document.getElementById('artifact-editor').value;
    if (!code.trim()) return showToast('No code loaded yet.', 'error');
    executeCodeInWorkbench(code, state.artifactLang);
  });

  document.getElementById('terminal-clear-btn').addEventListener('click', () => {
    document.getElementById('terminal-output').textContent = '';
    document.getElementById('terminal-exit-badge').textContent = '';
    document.getElementById('terminal-exit-badge').className = 'exit-badge';
    document.getElementById('terminal-status-dot').className = 'term-dot';
  });

  document.getElementById('artifact-copy-btn').addEventListener('click', async () => {
    const code = document.getElementById('artifact-editor').value;
    if (!code) return showToast('No code to copy.', 'error');
    await navigator.clipboard.writeText(code);
    showToast('Code copied!', 'success');
  });

  document.getElementById('artifact-download-btn').addEventListener('click', () => {
    const code = document.getElementById('artifact-editor').value;
    if (!code) return showToast('No code to save.', 'error');
    const extMap = {
      html: 'html',
      htm: 'html',
      python: 'py',
      py: 'py',
      javascript: 'js',
      js: 'js',
      typescript: 'ts',
      ts: 'ts',
      css: 'css',
      sql: 'sql',
      json: 'json',
      svg: 'svg',
    };
    const ext = extMap[state.artifactLang] || 'txt';
    downloadTextFile(`freeaiworld-output.${ext}`, code);
  });

  document.getElementById('coding-messages').addEventListener('click', handleCodeActionClick);
}

function hideWorkbench() {
  document.getElementById('coding-split').classList.add('workbench-hidden');
}

function switchWorkbenchTab(tabName) {
  document.getElementById('coding-split').classList.remove('workbench-hidden');
  document.getElementById('toggle-workbench-btn').hidden = false;
  document.querySelectorAll('.wb-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.wbTab === tabName);
  });
  document.querySelectorAll('.wb-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `wb-panel-${tabName}`);
  });
}

async function handleCodeActionClick(e) {
  const btn = e.target.closest('.code-btn');
  if (!btn) return;
  const action = btn.dataset.action;
  const code = decodeBase64Utf8(btn.dataset.code);
  const lang = (btn.dataset.lang || 'text').toLowerCase();

  if (action === 'copy') {
    await navigator.clipboard.writeText(code);
    const orig = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = orig), 1300);
  } else if (action === 'inspect') {
    loadCodeIntoWorkbench(code, lang);
    switchWorkbenchTab('code');
  } else if (action === 'run') {
    loadCodeIntoWorkbench(code, lang);
    await executeCodeInWorkbench(code, lang);
  }
}

function loadCodeIntoWorkbench(code, lang = 'text') {
  state.artifactLang = lang.toLowerCase();
  document.getElementById('artifact-editor').value = code;
  document.getElementById('artifact-meta').textContent = `${lang.toUpperCase()} · ${code.split('\n').length} lines`;
}

function bindIframeConsoleBridge() {
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.__omnifreeConsole !== true) return;
    const { level, args } = event.data;
    const screen = document.getElementById('terminal-output');
    screen.textContent += `[browser:${level}] ${args.join(' ')}\n`;
    screen.scrollTop = screen.scrollHeight;
  });
}

function buildHtmlWithConsoleBridge(rawHtml) {
  const bridge = `<script>
(function(){
  const send = (level, args) => {
    try {
      parent.postMessage({
        __omnifreeConsole: true,
        level: level,
        args: Array.from(args).map(a => typeof a === 'object' ? JSON.stringify(a) : String(a))
      }, '*');
    } catch (_) {}
  };
  ['log','warn','error','info'].forEach(fn => {
    const orig = console[fn];
    console[fn] = function(){ send(fn, arguments); return orig.apply(console, arguments); };
  });
  window.addEventListener('error', e => send('error', [e.message + ' (line ' + e.lineno + ')']));
})();
</script>`;
  if (/<head[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(/<head[^>]*>/i, (m) => `${m}\n${bridge}`);
  }
  return `${bridge}\n${rawHtml}`;
}

async function runBrowserJsSandbox(code) {
  const started = performance.now();
  const workerSource = `self.onmessage = async () => {
    const __logs = [];
    const console = {
      log: (...a) => __logs.push(a.map(x => typeof x === 'object' ? JSON.stringify(x, null, 2) : String(x)).join(' ')),
      info: (...a) => console.log(...a),
      warn: (...a) => __logs.push('[warn] ' + a.map(String).join(' ')),
      error: (...a) => __logs.push('[error] ' + a.map(String).join(' ')),
    };
    try {
      const __result = await (async () => { ${code}\n })();
      if (__result !== undefined) {
        __logs.push(typeof __result === 'object' ? JSON.stringify(__result, null, 2) : String(__result));
      }
      self.postMessage({ ok: true, logs: __logs });
    } catch (err) {
      self.postMessage({ ok: false, logs: __logs, error: err && err.stack ? err.stack : String(err) });
    }
  };`;
  const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: 'application/javascript' }));

  return new Promise((resolve) => {
    const worker = new Worker(blobUrl);
    const timer = setTimeout(() => {
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
      resolve({
        ok: false,
        command: 'sandbox-js main.js',
        stdout: '',
        stderr: 'Execution timed out after 5s.',
        exitCode: 124,
        durationMs: Math.round(performance.now() - started),
      });
    }, 5000);

    worker.onmessage = (e) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
      const { ok, logs: outLogs, error } = e.data;
      resolve({
        ok,
        command: 'sandbox-js main.js',
        stdout: (outLogs || []).join('\n'),
        stderr: error || '',
        exitCode: ok ? 0 : 1,
        durationMs: Math.round(performance.now() - started),
      });
    };

    worker.onerror = (err) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
      resolve({
        ok: false,
        command: 'sandbox-js main.js',
        stdout: '',
        stderr: err.message || 'JavaScript syntax/runtime error',
        exitCode: 1,
        durationMs: Math.round(performance.now() - started),
      });
    };

    worker.postMessage('run');
  });
}

function renderTerminalResult({ command, stdout, stderr, exitCode, durationMs, ok }) {
  const cmdLabel = document.getElementById('terminal-cmd-label');
  const exitBadge = document.getElementById('terminal-exit-badge');
  const dot = document.getElementById('terminal-status-dot');
  const screen = document.getElementById('terminal-output');

  cmdLabel.textContent = `freeaiworld:~/workspace$ ${command}`;
  exitBadge.textContent = `${ok ? '✓' : '✕'} exit ${exitCode} · ${durationMs}ms`;
  exitBadge.className = `exit-badge ${ok ? 'ok' : 'err'}`;
  dot.className = `term-dot ${ok ? 'ok' : 'err'}`;

  screen.innerHTML = '';
  const cmdSpan = document.createElement('span');
  cmdSpan.className = 'term-line-cmd';
  cmdSpan.textContent = `$ ${command}\n\n`;
  screen.appendChild(cmdSpan);

  if (stdout) {
    screen.appendChild(document.createTextNode(stdout + (stdout.endsWith('\n') ? '' : '\n')));
  }
  if (stderr) {
    const errSpan = document.createElement('span');
    errSpan.className = 'term-line-err';
    errSpan.textContent = `\n${stderr}\n`;
    screen.appendChild(errSpan);
  }
  if (!stdout && !stderr) {
    const infoSpan = document.createElement('span');
    infoSpan.className = 'term-line-info';
    infoSpan.textContent = '(Process finished with no printed output)\n';
    screen.appendChild(infoSpan);
  }
  screen.scrollTop = screen.scrollHeight;
}

async function executeCodeInWorkbench(code, lang) {
  const lower = (lang || '').toLowerCase();

  // 1. HTML / SVG -> Host on localhost (http://127.0.0.1:<port>/hosted/...) and load in Result pane!
  if (lower === 'html' || lower === 'htm' || lower === 'svg') {
    const iframe = document.getElementById('artifact-iframe');
    const empty = document.getElementById('result-empty-state');
    const hostLink = document.getElementById('hosted-url-link');
    empty.hidden = true;
    iframe.hidden = false;

    const htmlPayload =
      lower === 'svg'
        ? `<!DOCTYPE html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0f172a">${code}</body></html>`
        : code;

    const hosted = await hostWebsiteLocal({ html: htmlPayload, name: `build-${Date.now()}` }).catch(() => ({ ok: false }));

    if (hosted?.ok && hosted.path) {
      iframe.removeAttribute('sandbox');
      iframe.src = hosted.path;
      hostLink.href = hosted.url;
      hostLink.textContent = `localhost ↗`;
      hostLink.hidden = false;

      document.getElementById('terminal-cmd-label').textContent = `freeaiworld:~/workspace$ serve ${hosted.url}`;
      document.getElementById('terminal-output').textContent =
        `$ Website built and hosted live at:\n  ${hosted.url}\n\nReady in Result pane or open in a new tab.`;
      document.getElementById('terminal-exit-badge').textContent = '✓ hosted';
      document.getElementById('terminal-exit-badge').className = 'exit-badge ok';
      document.getElementById('terminal-status-dot').className = 'term-dot ok';
      showToast(`Hosted live at ${hosted.url}`, 'success');
    } else {
      hostLink.hidden = true;
      iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
      iframe.srcdoc = buildHtmlWithConsoleBridge(htmlPayload);
      document.getElementById('terminal-cmd-label').textContent = 'freeaiworld:~/workspace$ preview index.html';
      document.getElementById('terminal-output').textContent = '$ Rendered preview (start server.py for localhost URL hosting).\n';
      document.getElementById('terminal-exit-badge').textContent = '✓ preview';
      document.getElementById('terminal-exit-badge').className = 'exit-badge ok';
      document.getElementById('terminal-status-dot').className = 'term-dot ok';
    }

    switchWorkbenchTab('result');
    return;
  }

  // Hide localhost link when running non-web code
  document.getElementById('hosted-url-link').hidden = true;

  // 2. Python or SQL -> Execute on local Python 3.12 runner
  if (['py', 'python', 'python3', 'sql', 'sqlite', 'sqlite3'].includes(lower)) {
    switchWorkbenchTab('terminal');
    document.getElementById('terminal-cmd-label').textContent = `freeaiworld:~/workspace$ running ${lower}...`;
    document.getElementById('terminal-output').textContent = `Running ${lower} snippet...\n`;

    try {
      const res = await executeCodeRemote({ language: lower, code });
      if (res.unsupported) {
        renderTerminalResult({
          command: lower,
          stdout: '',
          stderr: res.error || 'Runner unavailable. Start via python server.py to execute Python/SQL locally.',
          exitCode: 1,
          durationMs: 0,
          ok: false,
        });
        return;
      }
      renderTerminalResult(res);
    } catch (err) {
      renderTerminalResult({
        command: lower,
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        durationMs: 0,
        ok: false,
      });
    }
    return;
  }

  // 3. JavaScript -> Try local Node if present, else isolated Web Worker sandbox
  if (lower === 'js' || lower === 'javascript') {
    switchWorkbenchTab('terminal');
    document.getElementById('terminal-cmd-label').textContent = 'freeaiworld:~/workspace$ running javascript...';
    const remote = await executeCodeRemote({ language: 'javascript', code }).catch(() => ({ unsupported: true }));
    if (!remote.unsupported) {
      renderTerminalResult(remote);
      return;
    }
    const sandboxRes = await runBrowserJsSandbox(code);
    renderTerminalResult(sandboxRes);
    return;
  }

  switchWorkbenchTab('code');
}

async function submitCodingMessage() {
  const inputEl = document.getElementById('coding-input');
  const prompt = inputEl.value.trim();
  const attachments = [...state.codingAttachments];
  if (!prompt && attachments.length === 0) return;

  const finalPrompt = prompt || 'Analyze the attached file(s) and help me build or fix this.';
  const model = getModelById(document.getElementById('coding-model-select').value);
  const role = document.getElementById('coding-role-select').value;
  const lang = document.getElementById('coding-lang-select').value;
  const sendBtn = document.getElementById('coding-send-btn');

  clearEmptyState('coding-messages');
  inputEl.value = '';
  state.codingAttachments = [];
  renderAttachmentStrip('coding');

  const userMsg = { role: 'user', content: finalPrompt, attachments };
  state.codingHistory.push(userMsg);
  appendChatMessage('coding-messages', userMsg);

  const msgEl = appendChatMessage('coding-messages', {
    role: 'assistant',
    modelName: model.name,
    streaming: true,
  });

  const controller = new AbortController();
  state.codingAbort = controller;
  sendBtn.textContent = '■ Stop';
  sendBtn.classList.add('stop-mode');

  let latestText = '';
  let rafScheduled = false;
  const bubble = msgEl.querySelector('.msg-bubble');
  const scrollBox = document.getElementById('coding-messages');

  const schedulePaint = () => {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      bubble.innerHTML = renderMarkdown(latestText, { streaming: true });
      scrollBox.scrollTop = scrollBox.scrollHeight;
    });
  };

  try {
    const sysPrompt =
      CODING_SYSTEM_PROMPTS[role] +
      (lang !== 'Auto' ? `\nTarget language: ${lang}.` : '');
    const messages = [{ role: 'system', content: sysPrompt }, ...state.codingHistory.slice(-10)];

    const { text } = await generateTextStream({
      model,
      messages,
      temperature: 0.35,
      maxTokens: 3400,
      keys: state.keys,
      signal: controller.signal,
      onToken: (_, accumulated) => {
        latestText = accumulated;
        schedulePaint();
      },
    });

    const finalText = text || latestText;
    state.codingHistory.push({ role: 'assistant', content: finalText });
    finalizeStreamMessage(msgEl, { content: finalText, modelName: model.name });

    const blocks = extractCodeBlocks(finalText);
    if (blocks.length > 0) {
      const targetBlock =
        blocks.find((b) => isRunnableLang(b.lang)) ||
        blocks.reduce((a, b) => (b.code.length > a.code.length ? b : a));
      loadCodeIntoWorkbench(targetBlock.code, targetBlock.lang);

      const autoRun = document.getElementById('autorun-toggle').checked;
      if (autoRun && isRunnableLang(targetBlock.lang)) {
        await executeCodeInWorkbench(targetBlock.code, targetBlock.lang);
      } else {
        switchWorkbenchTab('code');
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (latestText) {
        state.codingHistory.push({ role: 'assistant', content: latestText });
        finalizeStreamMessage(msgEl, { content: latestText + '\n\n*(Stopped)*', modelName: model.name });
      } else {
        finalizeStreamMessage(msgEl, { error: 'Generation stopped.', modelName: model.name });
      }
    } else {
      finalizeStreamMessage(msgEl, { error: err.message, modelName: model.name });
    }
  } finally {
    state.codingAbort = null;
    sendBtn.textContent = 'Send';
    sendBtn.classList.remove('stop-mode');
  }
}

// ==================== 2. WRITING STUDIO ====================
const WRITING_MODE_PROMPTS = {
  blog: 'You are an accomplished editorial writer. Produce engaging, well-structured articles with crisp headings and strong flow.',
  slides:
    'You are an executive presentation designer. Structure content into clear slides (Slide Title, 3-5 concise bullets, visual suggestion, and brief speaker notes) ready to export or convert into a PDF deck.',
  email: 'You are an expert communications strategist. Write clear, concise, high-reply emails.',
  story: 'You are an acclaimed fiction author. Write vivid, atmospheric prose with strong pacing.',
  academic: 'You are a rigorous research analyst. Summarize attached documents, PDFs, or media accurately with key takeaways.',
  polish: 'You are a senior editor. Improve clarity, grammar, and rhythm while preserving the author’s voice.',
};

function bindWritingStudio() {
  const modelSelect = document.getElementById('writing-model-select');
  modelSelect.addEventListener('change', () => {
    state.prefs.writingModel = modelSelect.value;
    savePrefs();
  });

  document.getElementById('writing-clear-btn').addEventListener('click', () => {
    if (state.writingAbort) state.writingAbort.abort();
    state.writingHistory = [];
    state.writingAttachments = [];
    renderAttachmentStrip('writing');
    renderChatEmpty('writing-messages', 'Writing chat cleared. Your Document Canvas is preserved.');
  });

  document.querySelectorAll('.starter-card[data-studio="writing"]').forEach((card) => {
    card.addEventListener('click', () => {
      document.getElementById('writing-input').value = card.dataset.prompt;
      submitWritingMessage();
    });
  });

  const inputEl = document.getElementById('writing-input');
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitWritingMessage();
    }
  });

  document.getElementById('writing-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.writingAbort) {
      state.writingAbort.abort();
      return;
    }
    submitWritingMessage();
  });

  const docEl = document.getElementById('writing-document');
  docEl.addEventListener('input', () => {
    updateWordCount();
    state.prefs.writingDraft = docEl.value;
    savePrefs();
  });

  document.getElementById('doc-copy-btn').addEventListener('click', async () => {
    if (!docEl.value) return showToast('Document Canvas is empty.', 'error');
    await navigator.clipboard.writeText(docEl.value);
    showToast('Draft copied!', 'success');
  });

  document.getElementById('doc-download-md').addEventListener('click', () => {
    if (!docEl.value) return showToast('Document Canvas is empty.', 'error');
    downloadTextFile('freeaiworld-draft.md', docEl.value);
  });

  document.getElementById('doc-clear-btn').addEventListener('click', () => {
    docEl.value = '';
    state.prefs.writingDraft = '';
    savePrefs();
    updateWordCount();
  });

  document.getElementById('doc-polish-btn').addEventListener('click', () => {
    const draft = docEl.value.trim();
    if (!draft) return showToast('Add a draft first to polish it.', 'error');
    document.getElementById('writing-input').value = `Polish and elevate this draft while keeping its core meaning:\n\n${draft}`;
    submitWritingMessage();
  });
}

function updateWordCount() {
  const raw = document.getElementById('writing-document').value;
  const trimmed = raw.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  document.getElementById('doc-word-count').textContent = `${words} words`;
}

async function submitWritingMessage() {
  const inputEl = document.getElementById('writing-input');
  const prompt = inputEl.value.trim();
  const attachments = [...state.writingAttachments];
  if (!prompt && attachments.length === 0) return;

  const finalPrompt = prompt || 'Analyze and summarize the attached document(s) or media.';
  const model = getModelById(document.getElementById('writing-model-select').value);
  const mode = document.getElementById('writing-mode-select').value;
  const tone = document.getElementById('writing-tone-select').value;
  const length = document.getElementById('writing-length-select').value;
  const sendBtn = document.getElementById('writing-send-btn');

  clearEmptyState('writing-messages');
  inputEl.value = '';
  state.writingAttachments = [];
  renderAttachmentStrip('writing');

  const userMsg = { role: 'user', content: finalPrompt, attachments };
  state.writingHistory.push(userMsg);
  appendChatMessage('writing-messages', userMsg);

  const msgEl = appendChatMessage('writing-messages', {
    role: 'assistant',
    modelName: model.name,
    streaming: true,
  });

  const controller = new AbortController();
  state.writingAbort = controller;
  sendBtn.textContent = '■ Stop';
  sendBtn.classList.add('stop-mode');

  let latestText = '';
  let rafScheduled = false;
  const bubble = msgEl.querySelector('.msg-bubble');
  const scrollBox = document.getElementById('writing-messages');

  const schedulePaint = () => {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      bubble.innerHTML = renderMarkdown(latestText, { streaming: true });
      scrollBox.scrollTop = scrollBox.scrollHeight;
    });
  };

  try {
    const sysPrompt = `${WRITING_MODE_PROMPTS[mode]}\nTone: ${tone}.\nLength: ${length}.\nFormat cleanly in Markdown.`;
    const messages = [{ role: 'system', content: sysPrompt }, ...state.writingHistory.slice(-10)];

    const { text } = await generateTextStream({
      model,
      messages,
      temperature: 0.75,
      maxTokens: 2800,
      keys: state.keys,
      signal: controller.signal,
      onToken: (_, accumulated) => {
        latestText = accumulated;
        schedulePaint();
      },
    });

    const finalText = text || latestText;
    state.writingHistory.push({ role: 'assistant', content: finalText });
    finalizeStreamMessage(msgEl, {
      content: finalText,
      modelName: model.name,
      writingActions: true,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      if (latestText) {
        state.writingHistory.push({ role: 'assistant', content: latestText });
        finalizeStreamMessage(msgEl, {
          content: latestText + '\n\n*(Stopped)*',
          modelName: model.name,
          writingActions: true,
        });
      } else {
        finalizeStreamMessage(msgEl, { error: 'Generation stopped.', modelName: model.name });
      }
    } else {
      finalizeStreamMessage(msgEl, { error: err.message, modelName: model.name });
    }
  } finally {
    state.writingAbort = null;
    sendBtn.textContent = 'Write';
    sendBtn.classList.remove('stop-mode');
  }
}

// ==================== SHARED CHAT RENDERING ====================
function clearEmptyState(containerId) {
  const container = document.getElementById(containerId);
  const empty = container.querySelector('.welcome-hero');
  if (empty) empty.remove();
}

function renderChatEmpty(containerId, message) {
  const container = document.getElementById(containerId);
  container.innerHTML = `<div class="welcome-hero"><div class="hero-glow">✦</div><h2>Ready</h2><p>${escapeHtml(message)}</p></div>`;
}

function appendChatMessage(containerId, { role, content = '', attachments = [], modelName = '', streaming = false }) {
  const container = document.getElementById(containerId);
  const wrapper = document.createElement('div');
  wrapper.className = `msg ${role}`;

  if (role === 'user' && attachments.length > 0) {
    const attList = document.createElement('div');
    attList.className = 'msg-att-list';
    for (const att of attachments) {
      if (att.kind === 'image' && att.dataUrl) {
        const img = document.createElement('img');
        img.className = 'msg-att-thumb';
        img.src = att.dataUrl;
        img.alt = att.name;
        attList.appendChild(img);
      } else if (att.kind === 'video' && att.frames?.[0]) {
        const img = document.createElement('img');
        img.className = 'msg-att-thumb';
        img.src = att.frames[0];
        img.alt = att.name;
        attList.appendChild(img);
      } else {
        const pill = document.createElement('span');
        pill.className = 'msg-att-pill';
        pill.textContent = `📎 ${att.name}`;
        attList.appendChild(pill);
      }
    }
    wrapper.appendChild(attList);
  }

  if (role === 'assistant') {
    const head = document.createElement('div');
    head.className = 'msg-head';
    head.innerHTML = `<span class="msg-spark">✦</span><span>${escapeHtml(modelName || 'Assistant')}</span>`;
    wrapper.appendChild(head);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (streaming) {
    bubble.innerHTML = '<span class="streaming-cursor" aria-hidden="true"></span>';
  } else if (role === 'user') {
    bubble.textContent = content;
  } else {
    bubble.innerHTML = renderMarkdown(content);
  }

  wrapper.appendChild(bubble);
  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;
  return wrapper;
}

function finalizeStreamMessage(msgEl, { content = '', error = '', writingActions = false }) {
  const bubble = msgEl.querySelector('.msg-bubble');

  if (error) {
    msgEl.classList.add('error');
    bubble.textContent = `Error: ${error}`;
    return;
  }

  bubble.innerHTML = renderMarkdown(content, { streaming: false });

  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-subtle';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(content);
    showToast('Copied!', 'success');
  });
  actions.appendChild(copyBtn);

  if (writingActions) {
    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'btn-subtle';
    replaceBtn.textContent = 'Use as Draft';
    replaceBtn.addEventListener('click', () => {
      const docEl = document.getElementById('writing-document');
      docEl.value = content;
      state.prefs.writingDraft = content;
      savePrefs();
      updateWordCount();
      showToast('Loaded into Document Canvas.', 'success');
    });

    const appendBtn = document.createElement('button');
    appendBtn.className = 'btn-subtle';
    appendBtn.textContent = '+ Append';
    appendBtn.addEventListener('click', () => {
      const docEl = document.getElementById('writing-document');
      docEl.value = docEl.value ? `${docEl.value.trim()}\n\n${content}` : content;
      state.prefs.writingDraft = docEl.value;
      savePrefs();
      updateWordCount();
      showToast('Appended to Document Canvas.', 'success');
    });

    actions.appendChild(replaceBtn);
    actions.appendChild(appendBtn);
  }

  msgEl.appendChild(actions);
  msgEl.parentElement.scrollTop = msgEl.parentElement.scrollHeight;
}

// ==================== 3. IMAGE STUDIO (GALLERY REVEALS WHEN DONE) ====================
function bindImageStudio() {
  const modelSelect = document.getElementById('image-model-select');
  modelSelect.addEventListener('change', () => {
    state.prefs.imageModel = modelSelect.value;
    savePrefs();
    updateImageModelNote();
  });

  document.querySelectorAll('#image-style-pills .chip').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#image-style-pills .chip').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      state.selectedStyle = pill.dataset.style;
    });
  });

  document.querySelectorAll('.quick-idea[data-img-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('image-prompt-input').value = btn.dataset.imgPrompt;
    });
  });

  document.getElementById('enhance-prompt-btn').addEventListener('click', enhanceImagePrompt);
  document.getElementById('generate-image-btn').addEventListener('click', runImageGeneration);

  const refBtn = document.getElementById('image-ref-btn');
  const refInput = document.getElementById('image-ref-input');
  const refPreview = document.getElementById('image-ref-preview');
  const refThumb = document.getElementById('image-ref-thumb');
  const refName = document.getElementById('image-ref-name');
  const refClear = document.getElementById('image-ref-clear');

  refBtn.addEventListener('click', () => refInput.click());
  refInput.addEventListener('change', async () => {
    const file = refInput.files?.[0];
    if (!file) return;
    const dataUrl = await readAsDataUrl(file);
    const base64 = dataUrl.split(',')[1] || '';
    state.imageRefAttachment = {
      kind: 'image',
      name: file.name,
      mimeType: file.type || 'image/png',
      dataUrl,
      base64,
    };
    refThumb.src = dataUrl;
    refName.textContent = file.name;
    refPreview.hidden = false;
    refInput.value = '';
    showToast(`Attached reference photo: ${file.name}`, 'success');
  });
  refClear.addEventListener('click', () => {
    state.imageRefAttachment = null;
    refPreview.hidden = true;
    refThumb.src = '';
    refName.textContent = '';
  });
}

async function enhanceImagePrompt() {
  const input = document.getElementById('image-prompt-input');
  const raw = input.value.trim();
  if (!raw) return showToast('Enter a short idea first.', 'error');

  const btn = document.getElementById('enhance-prompt-btn');
  btn.disabled = true;
  btn.textContent = 'Enhancing...';

  try {
    const enhancerModel =
      state.models.find((m) => m.provider !== 'external' && !m.capabilities.includes('image') && isModelReady(m)) ||
      CURATED_MODELS[0];
    const { text } = await generateText({
      model: enhancerModel,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert visual prompt writer. Expand the idea into one vivid, detailed image generation prompt under 60 words. Output ONLY the prompt text.',
        },
        { role: 'user', content: raw },
      ],
      temperature: 0.7,
      maxTokens: 150,
      keys: state.keys,
    });
    input.value = text.trim().replace(/^["']|["']$/g, '');
    showToast('Prompt enhanced!', 'success');
  } catch (err) {
    showToast(`Could not enhance: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✦ Enhance';
  }
}

async function runImageGeneration() {
  const promptInput = document.getElementById('image-prompt-input');
  let basePrompt = promptInput.value.trim();
  if (!basePrompt && !state.imageRefAttachment) return showToast('Enter a prompt or upload a reference photo.', 'error');

  const btn = document.getElementById('generate-image-btn');
  btn.disabled = true;

  if (state.imageRefAttachment) {
    btn.innerHTML = '<span class="spinner-inline"></span> Reading reference photo...';
    try {
      const visionModel =
        state.models.find(
          (m) => m.provider !== 'external' && m.capabilities.includes('vision') && isModelReady(m)
        ) ||
        state.models.find((m) => m.provider !== 'external' && !m.capabilities.includes('image') && isModelReady(m)) ||
        CURATED_MODELS[0];
      const { text } = await generateText({
        model: visionModel,
        messages: [
          {
            role: 'user',
            content: basePrompt
              ? `Describe the attached reference photo in vivid visual detail and merge it with this user request: "${basePrompt}". Output ONLY a single clean image generation prompt under 75 words.`
              : 'Describe the attached reference photo in vivid visual detail (subject, style, colors, lighting, composition) as a single clean image generation prompt under 75 words. Output ONLY the prompt.',
            attachments: [state.imageRefAttachment],
          },
        ],
        temperature: 0.5,
        maxTokens: 180,
        keys: state.keys,
      });
      if (text?.trim()) {
        basePrompt = text.trim().replace(/^["']|["']$/g, '');
      }
    } catch {
      if (!basePrompt) basePrompt = `Inspired by ${state.imageRefAttachment.name}`;
    }
  }

  const fullPrompt = state.selectedStyle ? `${basePrompt}, ${state.selectedStyle}` : basePrompt;
  const model = getModelById(document.getElementById('image-model-select').value);
  const [width, height] = document.getElementById('image-aspect-select').value.split('x').map(Number);
  const seed = document.getElementById('image-seed-input').value.trim();

  btn.innerHTML = '<span class="spinner-inline"></span> Creating image...';

  try {
    const result = await generateImage({
      model,
      prompt: fullPrompt,
      width,
      height,
      seed: seed || null,
      keys: state.keys,
    });

    state.images.unshift({
      id: Date.now(),
      url: result.objectUrl,
      prompt: fullPrompt,
      basePrompt,
      modelName: model.name,
      width,
      height,
      seed: result.seed,
    });

    // Reveal the gallery pane only once the image creation is complete
    document.getElementById('image-layout').classList.remove('gallery-hidden');
    renderImageGallery();
    showToast('Image created!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Image';
  }
}

function renderImageGallery() {
  const grid = document.getElementById('image-gallery-grid');
  document.getElementById('gallery-count').textContent = `${state.images.length} image${state.images.length === 1 ? '' : 's'}`;

  if (state.images.length === 0) return;
  grid.innerHTML = '';

  for (const item of state.images) {
    const card = document.createElement('div');
    card.className = 'image-card';

    const wrap = document.createElement('div');
    wrap.className = 'image-thumb-wrap';
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = item.prompt;
    img.loading = 'lazy';
    wrap.appendChild(img);
    wrap.addEventListener('click', () => openLightbox(item));

    const body = document.createElement('div');
    body.className = 'image-card-body';

    const promptEl = document.createElement('div');
    promptEl.className = 'image-card-prompt';
    promptEl.textContent = item.prompt;

    const meta = document.createElement('div');
    meta.className = 'image-card-meta';
    meta.textContent = `${item.modelName} · ${item.width}×${item.height}`;

    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const dl = document.createElement('a');
    dl.className = 'btn-subtle';
    dl.href = item.url;
    dl.download = `freeaiworld-${item.seed || item.id}.png`;
    dl.textContent = 'Download';

    const reuse = document.createElement('button');
    reuse.className = 'btn-subtle';
    reuse.textContent = 'Reuse Seed';
    reuse.addEventListener('click', () => {
      document.getElementById('image-prompt-input').value = item.basePrompt;
      document.getElementById('image-seed-input').value = item.seed || '';
    });

    actions.appendChild(dl);
    actions.appendChild(reuse);
    body.appendChild(promptEl);
    body.appendChild(meta);
    body.appendChild(actions);

    card.appendChild(wrap);
    card.appendChild(body);
    grid.appendChild(card);
  }
}

// ==================== 4. GLOBAL AI TOOLS & MODELS DIRECTORY ====================
function bindModelsDirectory() {
  document.getElementById('sync-catalog-btn').addEventListener('click', () => refreshGlobalCatalog(true));
  document.getElementById('models-search-input').addEventListener('input', (e) => {
    state.modelFilters.search = e.target.value.trim().toLowerCase();
    renderModelsGrid();
  });
  document.getElementById('models-provider-filter').addEventListener('change', (e) => {
    state.modelFilters.provider = e.target.value;
    renderModelsGrid();
  });
  document.querySelectorAll('#models-cap-filter .chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#models-cap-filter .chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.modelFilters.cap = btn.dataset.cap;
      renderModelsGrid();
    });
  });
}

async function refreshGlobalCatalog(announce = true) {
  const syncBtn = document.getElementById('sync-catalog-btn');
  const summaryBar = document.getElementById('sync-summary-bar');
  syncBtn.disabled = true;
  syncBtn.textContent = '↻ Syncing...';

  try {
    const { models, syncStatus } = await syncLiveGlobalCatalog(state.keys);
    state.models = models;
    populateAllModelSelectors();
    renderModelsGrid();

    summaryBar.textContent =
      `${models.length} free AI models & tools ` +
      `(OpenRouter :free: ${syncStatus.openrouterCount} · Pollinations: ${
        syncStatus.pollinationsTextCount + syncStatus.pollinationsImageCount
      } · Local Ollama: ${syncStatus.ollamaCount})`;
    if (announce) showToast('Catalog updated!', 'success');
  } catch {
    summaryBar.textContent = `Showing ${state.models.length} curated free AI models & tools.`;
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = '↻ Sync Live';
  }
}

function renderModelsGrid() {
  const grid = document.getElementById('models-grid');
  const { search, provider, cap } = state.modelFilters;

  const filtered = state.models.filter((m) => {
    if (provider !== 'all' && m.provider !== provider) return false;
    if (cap === 'nokey' && PROVIDERS[m.provider]?.requiresKey) return false;
    if (cap !== 'all' && cap !== 'nokey' && !m.capabilities.includes(cap)) return false;
    if (search) {
      const hay = `${m.name} ${m.modelId} ${m.origin} ${m.bestFor || ''} ${m.description} ${m.provider}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="welcome-hero"><h2>No matches</h2><p>Try clearing filters.</p></div>';
    return;
  }

  grid.innerHTML = '';
  for (const m of filtered) {
    const prov = PROVIDERS[m.provider] || { name: m.provider, requiresKey: true };
    const ready = isModelReady(m);
    const isExternal = m.provider === 'external';

    const card = document.createElement('article');
    card.className = 'model-card';

    const badgeClass = prov.requiresKey ? 'badge-key' : 'badge-free';
    const badgeText = isExternal
      ? m.freeTier
      : prov.requiresKey
      ? ready
        ? 'Connected'
        : 'Free Key'
      : 'Free · No Key';

    card.innerHTML = `
      <div class="model-card-top">
        <div>
          <div class="model-card-title">${escapeHtml(m.name)}</div>
          <div class="model-card-id">${escapeHtml(m.modelId)}</div>
        </div>
        <span class="badge ${badgeClass}">${escapeHtml(badgeText)}</span>
      </div>
      ${
        m.bestFor
          ? `<div class="best-for-pill">★ Best for: ${escapeHtml(m.bestFor)}</div>`
          : ''
      }
      <p class="model-card-desc">${escapeHtml(m.description)}</p>
      <div class="model-card-tags">
        <span class="badge badge-tag">${escapeHtml(prov.name)}</span>
        <span class="badge badge-tag">${escapeHtml(m.origin)}</span>
        <span class="badge badge-tag">${escapeHtml(m.context)}</span>
      </div>
      <div class="model-card-footer">
        <span class="micro-hint">${escapeHtml(m.freeTier)}</span>
        <div class="msg-actions"></div>
      </div>
    `;

    const actions = card.querySelector('.msg-actions');
    if (isExternal && m.externalUrl) {
      const link = document.createElement('a');
      link.className = 'btn-send';
      link.href = m.externalUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open Tool ↗';
      actions.appendChild(link);
    } else if (m.capabilities.includes('image')) {
      const btn = document.createElement('button');
      btn.className = 'btn-send';
      btn.textContent = 'Use in Image';
      btn.addEventListener('click', () => activateModelInStudio(m, 'image'));
      actions.appendChild(btn);
    } else {
      if (m.capabilities.includes('coding')) {
        const btn = document.createElement('button');
        btn.className = 'btn-send';
        btn.textContent = 'Code';
        btn.addEventListener('click', () => activateModelInStudio(m, 'coding'));
        actions.appendChild(btn);
      }
      if (m.capabilities.includes('writing') || m.capabilities.includes('pdf')) {
        const btn = document.createElement('button');
        btn.className = 'btn-subtle';
        btn.textContent = 'Write';
        btn.addEventListener('click', () => activateModelInStudio(m, 'writing'));
        actions.appendChild(btn);
      }
    }

    grid.appendChild(card);
  }
}

function activateModelInStudio(model, studio) {
  if (studio === 'coding') {
    document.getElementById('coding-model-select').value = model.id;
    state.prefs.codingModel = model.id;
  } else if (studio === 'writing') {
    document.getElementById('writing-model-select').value = model.id;
    state.prefs.writingModel = model.id;
  } else if (studio === 'image') {
    document.getElementById('image-model-select').value = model.id;
    state.prefs.imageModel = model.id;
    updateImageModelNote();
  }
  savePrefs();
  switchTab(studio);

  if (!isModelReady(model)) {
    showToast(`Selected ${model.name}. Add your free ${PROVIDERS[model.provider].name} key to run it.`, 'info');
  } else {
    showToast(`Using ${model.name}`, 'success');
  }
}

// ==================== API KEYS MODAL ====================
function bindKeysModal() {
  const modal = document.getElementById('keys-modal');
  const open = () => {
    renderKeysModal();
    modal.hidden = false;
  };
  const close = () => {
    modal.hidden = true;
  };

  document.getElementById('open-keys-btn').addEventListener('click', open);
  document.getElementById('close-keys-btn').addEventListener('click', close);
  document.getElementById('cancel-keys-btn').addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  document.getElementById('save-keys-btn').addEventListener('click', async () => {
    document.querySelectorAll('[data-provider-input]').forEach((input) => {
      state.keys[input.dataset.providerInput] = input.value.trim();
    });
    saveProviderKeys(state.keys);
    updateConnectedKeysBadge();
    populateAllModelSelectors();
    renderModelsGrid();
    close();
    showToast('API keys saved locally.', 'success');
    await refreshGlobalCatalog(false);
  });
}

function renderKeysModal() {
  const list = document.getElementById('keys-provider-list');
  list.innerHTML = '';

  for (const prov of Object.values(PROVIDERS)) {
    if (prov.id === 'external') continue;
    const card = document.createElement('div');
    card.className = 'provider-key-card';
    const currentVal = state.keys[prov.id] || '';
    const isOllama = prov.id === 'ollama';

    card.innerHTML = `
      <div class="provider-key-head">
        <strong>${escapeHtml(prov.name)} <span class="badge ${prov.requiresKey ? 'badge-key' : 'badge-free'}">${escapeHtml(prov.badge)}</span></strong>
        <a href="${escapeHtml(prov.signupUrl)}" target="_blank" rel="noopener noreferrer">Get Free ${isOllama ? 'App' : 'Key'} ↗</a>
      </div>
      <div class="micro-hint">${escapeHtml(prov.description)}</div>
      <div class="provider-key-input-row">
        <input
          type="${isOllama ? 'text' : 'password'}"
          class="clean-input"
          data-provider-input="${escapeHtml(prov.id)}"
          value="${escapeHtml(currentVal)}"
          placeholder="${escapeHtml(prov.keyPlaceholder)}"
        />
        <button type="button" class="btn-subtle" data-test-provider="${escapeHtml(prov.id)}">Test</button>
      </div>
      <div class="provider-test-msg"></div>
    `;

    card.querySelector('[data-test-provider]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const inputVal = card.querySelector('[data-provider-input]').value.trim();
      const msgEl = card.querySelector('.provider-test-msg');
      btn.disabled = true;
      msgEl.textContent = 'Testing...';
      msgEl.style.color = 'var(--text-muted)';
      try {
        const resMsg = await testProviderConnection(prov.id, inputVal);
        msgEl.textContent = resMsg;
        msgEl.style.color = 'var(--success)';
      } catch (err) {
        msgEl.textContent = err.message;
        msgEl.style.color = 'var(--danger)';
      } finally {
        btn.disabled = false;
      }
    });

    list.appendChild(card);
  }
}

// ==================== LIGHTBOX ====================
function bindLightbox() {
  const modal = document.getElementById('lightbox-modal');
  const close = () => (modal.hidden = true);
  document.getElementById('close-lightbox-btn').addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
}

function openLightbox(item) {
  const modal = document.getElementById('lightbox-modal');
  document.getElementById('lightbox-img').src = item.url;
  document.getElementById('lightbox-prompt').textContent = item.prompt;
  const dl = document.getElementById('lightbox-download-link');
  dl.href = item.url;
  dl.download = `omnifree-${item.seed || item.id}.png`;

  document.getElementById('lightbox-reuse-btn').onclick = () => {
    document.getElementById('image-prompt-input').value = item.basePrompt;
    document.getElementById('image-seed-input').value = item.seed || '';
    modal.hidden = true;
  };
  modal.hidden = false;
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
