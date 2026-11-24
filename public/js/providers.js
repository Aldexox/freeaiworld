/**
 * Unified Multi-Provider Free AI Inference (Streaming + Multimodal Attachments),
 * Live Catalog Sync, Localhost Site Hosting & Document Extraction.
 */

import { CURATED_MODELS, PROVIDERS } from './catalog.js';

const STORAGE_KEYS_KEY = 'omnifree_provider_keys_v1';

export function loadProviderKeys() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveProviderKeys(keys) {
  localStorage.setItem(STORAGE_KEYS_KEY, JSON.stringify(keys));
}

let serverCaps = null;

export async function getServerInfo() {
  if (serverCaps !== null) return serverCaps;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (res.ok) {
      serverCaps = await res.json();
      return serverCaps;
    }
  } catch {
    // static fallback
  }
  serverCaps = { proxy: false, runner: false, hoster: false, hasNode: false };
  return serverCaps;
}

export async function checkServerProxy() {
  const info = await getServerInfo();
  return Boolean(info?.proxy);
}

async function smartFetch(url, { method = 'GET', headers = {}, body = null, stream = false, signal = undefined } = {}) {
  const hasProxy = await checkServerProxy();
  if (hasProxy) {
    if (method === 'GET') {
      const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`;
      return fetch(proxyUrl, { method: 'GET', headers, signal });
    }
    return fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, method, headers, body, stream }),
      signal,
    });
  }

  const init = { method, headers: { ...headers }, signal };
  if (body !== null && method !== 'GET') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers['Content-Type']) {
      init.headers['Content-Type'] = 'application/json';
    }
  }
  return fetch(url, init);
}

export async function executeCodeRemote({ language, code }) {
  const info = await getServerInfo();
  if (!info.runner) {
    return { unsupported: true, error: 'Local server runner is not active.' };
  }
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language, code }),
  });
  return res.json();
}

/**
 * Host generated HTML/CSS/JS site on the local OmniFree server (http://127.0.0.1:<port>/hosted/...)
 */
export async function hostWebsiteLocal({ html, name = '' }) {
  const info = await getServerInfo();
  if (!info.hoster) {
    return { ok: false, error: 'Localhost hosting requires running via python server.py.' };
  }
  const res = await fetch('/api/host', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, name }),
  });
  return res.json();
}

/**
 * Extract plain text from .pdf or .docx via local server.
 */
export async function extractDocumentRemote({ filename, base64 }) {
  const info = await getServerInfo();
  if (!info.proxy) {
    return { ok: false, text: '', error: 'Document extraction requires python server.py.' };
  }
  const res = await fetch('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, base64 }),
  });
  return res.json();
}

export async function syncLiveGlobalCatalog(keys = loadProviderKeys()) {
  const merged = [...CURATED_MODELS];
  const seenIds = new Set(merged.map((m) => m.id));
  const syncStatus = {
    openrouterCount: 0,
    pollinationsTextCount: 0,
    pollinationsImageCount: 0,
    ollamaCount: 0,
  };

  const tasks = [
    smartFetch('https://openrouter.ai/api/v1/models')
      .then(async (res) => {
        if (!res.ok) return;
        const json = await res.json();
        const list = Array.isArray(json.data) ? json.data : [];
        const freeOnes = list.filter((m) => {
          const p = Number(m?.pricing?.prompt);
          const c = Number(m?.pricing?.completion);
          return (p === 0 && c === 0) || String(m.id).endsWith(':free');
        });
        syncStatus.openrouterCount = freeOnes.length;
        for (const m of freeOnes) {
          const uid = `openrouter::${m.id}`;
          if (seenIds.has(uid)) continue;
          seenIds.add(uid);
          const idLower = String(m.id).toLowerCase();
          const caps = ['writing', 'everyday'];
          let bestFor = 'Everyday Use & Writing';
          if (
            idLower.includes('coder') ||
            idLower.includes('code') ||
            idLower.includes('deepseek') ||
            idLower.includes('qwen') ||
            idLower.includes('llama') ||
            idLower.includes('mistral') ||
            idLower.includes('gemma')
          ) {
            caps.push('coding');
            if (idLower.includes('coder') || idLower.includes('code')) {
              bestFor = 'Coding & App Building';
            }
          }
          if (idLower.includes('vl') || idLower.includes('vision') || idLower.includes('multimodal')) {
            caps.push('vision');
            bestFor = 'Photos & Visual Analysis';
          }
          if (idLower.includes('r1') || idLower.includes('thinking') || idLower.includes('reason')) {
            caps.push('reasoning');
            bestFor = 'Complex Reasoning & Coding';
          }
          merged.push({
            id: uid,
            modelId: m.id,
            name: m.name || m.id,
            provider: 'openrouter',
            origin: m.id.split('/')[0] || 'OpenRouter Community',
            capabilities: caps,
            bestFor,
            context: m.context_length ? `${Math.round(m.context_length / 1024)}K` : '32K',
            freeTier: 'Free Key ($0)',
            description: (m.description || 'Live OpenRouter free-tier model.').slice(0, 180),
          });
        }
      })
      .catch(() => {}),

    smartFetch('https://text.pollinations.ai/models')
      .then(async (res) => {
        if (!res.ok) return;
        const list = await res.json();
        if (!Array.isArray(list)) return;
        syncStatus.pollinationsTextCount = list.length;
        for (const m of list) {
          const modelName = typeof m === 'string' ? m : m.name;
          if (!modelName) continue;
          const uid = `pollinations::${modelName}`;
          if (seenIds.has(uid)) continue;
          seenIds.add(uid);
          const lower = modelName.toLowerCase();
          const caps = ['writing', 'everyday'];
          let bestFor = 'Everyday Use';
          if (
            lower.includes('code') ||
            lower.includes('qwen') ||
            lower.includes('deepseek') ||
            lower.includes('gpt') ||
            lower.includes('openai') ||
            lower.includes('claude') ||
            lower.includes('gemini') ||
            lower.includes('llama')
          ) {
            caps.push('coding');
            if (lower.includes('code')) bestFor = 'Coding';
          }
          if (m.vision || lower.includes('openai') || lower.includes('gemini')) {
            caps.push('vision');
          }
          if (lower.includes('reason') || lower.includes('r1')) caps.push('reasoning');
          merged.push({
            id: uid,
            modelId: modelName,
            name: `${m.description || modelName} (Pollinations)`,
            provider: 'pollinations',
            origin: m.provider || 'Pollinations Network',
            capabilities: caps,
            bestFor,
            context: m.maxInputChars ? `${Math.round(m.maxInputChars / 1000)}K chars` : '64K',
            freeTier: '100% Free · No Key',
            description: m.description || `Live Pollinations free text model (${modelName}).`,
          });
        }
      })
      .catch(() => {}),

    smartFetch('https://image.pollinations.ai/models')
      .then(async (res) => {
        if (!res.ok) return;
        const list = await res.json();
        if (!Array.isArray(list)) return;
        syncStatus.pollinationsImageCount = list.length;
        for (const modelName of list) {
          if (typeof modelName !== 'string') continue;
          const uid = `pollinations-img::${modelName}`;
          if (seenIds.has(uid)) continue;
          seenIds.add(uid);
          merged.push({
            id: uid,
            modelId: modelName,
            name: `${modelName} (Pollinations Image)`,
            provider: 'pollinations',
            origin: 'Pollinations Image Network',
            capabilities: ['image', 'photo'],
            bestFor: 'Photo & Art Generation',
            context: 'Image',
            freeTier: '100% Free · No Key',
            description: `Live Pollinations image generation model: ${modelName}.`,
          });
        }
      })
      .catch(() => {}),

    (async () => {
      const hasProxy = await checkServerProxy();
      const ollamaBase = (keys.ollama || 'http://127.0.0.1:11434').replace(/\/+$/, '');
      try {
        const res = hasProxy
          ? await fetch(`/api/ollama/tags?base=${encodeURIComponent(ollamaBase)}`)
          : await fetch(`${ollamaBase}/api/tags`);
        if (!res.ok) return;
        const data = await res.json();
        const models = Array.isArray(data.models) ? data.models : [];
        syncStatus.ollamaCount = models.length;
        for (const m of models) {
          const uid = `ollama::${m.name}`;
          if (seenIds.has(uid)) continue;
          seenIds.add(uid);
          merged.push({
            id: uid,
            modelId: m.name,
            name: `${m.name} (Local Ollama)`,
            provider: 'ollama',
            origin: 'Local Machine',
            capabilities: ['coding', 'writing', 'everyday'],
            bestFor: 'Private Offline AI',
            context: 'Local',
            freeTier: '100% Local Free',
            description: `Locally installed Ollama model (${m.details?.parameter_size || 'local weights'}).`,
          });
        }
      } catch {
        // Ollama not running locally
      }
    })(),
  ];

  await Promise.allSettled(tasks);
  return { models: merged, syncStatus };
}

/**
 * Convert a message + optional attachments into provider-specific payloads.
 */
function buildOpenAIMessages(messages) {
  return messages.map((msg) => {
    const atts = msg.attachments || [];
    if (msg.role !== 'user' || atts.length === 0) {
      return { role: msg.role, content: msg.content };
    }

    const parts = [];
    let textBlock = msg.content || '';
    const imageUrls = [];

    for (const att of atts) {
      if (att.kind === 'image' && att.dataUrl) {
        imageUrls.push(att.dataUrl);
      } else if (att.kind === 'video') {
        textBlock += `\n\n[Attached Video: ${att.name} (${att.durationLabel || 'video'}, ${att.width || '?'}x${att.height || '?'}) — ${att.frames?.length || 0} sampled keyframes attached]`;
        for (const frameUrl of att.frames || []) {
          imageUrls.push(frameUrl);
        }
      } else if (att.textContent) {
        textBlock += `\n\n--- Attached File: ${att.name} ---\n${att.textContent.slice(0, 45000)}`;
      } else {
        textBlock += `\n\n[Attached File: ${att.name} (${att.mimeType || 'binary'})]`;
      }
    }

    if (imageUrls.length === 0) {
      return { role: 'user', content: textBlock };
    }

    parts.push({ type: 'text', text: textBlock });
    for (const url of imageUrls) {
      parts.push({ type: 'image_url', image_url: { url } });
    }
    return { role: 'user', content: parts };
  });
}

function buildGeminiPayload(messages, temperature, maxTokens) {
  const systemMsg = messages.find((m) => m.role === 'system')?.content;
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const parts = [];
      let textBlock = m.content || '';
      const atts = m.attachments || [];

      for (const att of atts) {
        if (att.kind === 'image' && att.base64) {
          parts.push({ inlineData: { mimeType: att.mimeType || 'image/png', data: att.base64 } });
        } else if (att.kind === 'pdf' && att.base64 && att.size <= 12 * 1024 * 1024) {
          parts.push({ inlineData: { mimeType: 'application/pdf', data: att.base64 } });
        } else if (att.kind === 'video') {
          textBlock += `\n\n[Attached Video: ${att.name} (${att.durationLabel || 'video'}) — sampled frames attached]`;
          for (const frameUrl of att.frames || []) {
            const b64 = frameUrl.split(',')[1];
            if (b64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
          }
        } else if (att.textContent) {
          textBlock += `\n\n--- Attached File: ${att.name} ---\n${att.textContent.slice(0, 60000)}`;
        }
      }

      parts.unshift({ text: textBlock });
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });

  const payload = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };
  if (systemMsg) {
    payload.systemInstruction = { parts: [{ text: systemMsg }] };
  }
  return payload;
}

function buildOllamaMessages(messages) {
  return messages.map((msg) => {
    const atts = msg.attachments || [];
    if (msg.role !== 'user' || atts.length === 0) {
      return { role: msg.role, content: msg.content };
    }
    let textBlock = msg.content || '';
    const images = [];
    for (const att of atts) {
      if (att.kind === 'image' && att.base64) {
        images.push(att.base64);
      } else if (att.kind === 'video') {
        textBlock += `\n\n[Attached Video: ${att.name}]`;
        for (const frameUrl of att.frames || []) {
          const b64 = frameUrl.split(',')[1];
          if (b64) images.push(b64);
        }
      } else if (att.textContent) {
        textBlock += `\n\n--- Attached File: ${att.name} ---\n${att.textContent.slice(0, 40000)}`;
      }
    }
    const out = { role: 'user', content: textBlock };
    if (images.length > 0) out.images = images;
    return out;
  });
}

async function emitSmoothChunks(fullText, onToken, signal) {
  const parts = fullText.match(/\S+\s*|\n+/g) || [fullText];
  let acc = '';
  for (let i = 0; i < parts.length; i += 2) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const slice = parts.slice(i, i + 2).join('');
    acc += slice;
    onToken(slice, acc);
    await new Promise((r) => setTimeout(r, 14));
  }
  return acc;
}

async function consumeSSEStream(res, { extractDelta, onToken, signal }) {
  const contentType = (res.headers.get('Content-Type') || '').toLowerCase();
  if (!res.body || (!contentType.includes('text/event-stream') && !contentType.includes('ndjson'))) {
    const rawText = await res.text();
    let parsedText = rawText;
    try {
      const json = JSON.parse(rawText);
      const maybe =
        json?.choices?.[0]?.message?.content ||
        json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ||
        json?.message?.content;
      if (maybe) parsedText = maybe;
    } catch {
      // keep rawText
    }
    if (!parsedText) throw new Error('Provider returned an empty response.');
    return emitSmoothChunks(parsedText, onToken, signal);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';

  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw new DOMException('Aborted', 'AbortError');
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith(':') || line === 'data: [DONE]') continue;

      const jsonStr = line.startsWith('data:') ? line.slice(5).trim() : line;
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const eventObj = JSON.parse(jsonStr);
        const delta = extractDelta(eventObj);
        if (delta) {
          fullText += delta;
          onToken(delta, fullText);
        }
      } catch {
        // Ignore partial lines
      }
    }
  }

  if (!fullText && buffer.trim()) {
    try {
      const obj = JSON.parse(buffer.trim());
      const maybe =
        obj?.choices?.[0]?.message?.content ||
        obj?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ||
        obj?.message?.content;
      if (maybe) return emitSmoothChunks(maybe, onToken, signal);
    } catch {
      return emitSmoothChunks(buffer, onToken, signal);
    }
  }

  return fullText;
}

export async function generateTextStream({
  model,
  messages,
  temperature = 0.7,
  maxTokens = 2048,
  keys = loadProviderKeys(),
  signal = undefined,
  onToken = () => {},
}) {
  if (!model) throw new Error('No model selected.');
  if (model.provider === 'external') {
    throw new Error(`${model.name} is an external web/desktop tool. Click "Open Tool" in the Models directory.`);
  }

  const provider = model.provider;
  const apiKey = (keys[provider] || '').trim();

  if (PROVIDERS[provider]?.requiresKey && !apiKey) {
    throw new Error(
      `${PROVIDERS[provider].name} requires a free API key. Click "API Keys" in the top bar to add it, or choose a "No Key" Pollinations model.`
    );
  }

  if (provider === 'pollinations') {
    const formattedMsgs = buildOpenAIMessages(messages);
    if (apiKey) {
      const res = await smartFetch('https://gen.pollinations.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: {
          model: model.modelId,
          messages: formattedMsgs,
          temperature,
          max_tokens: maxTokens,
          stream: true,
        },
        stream: true,
        signal,
      });
      if (!res.ok) await throwFriendlyHttpError(res, 'Pollinations');
      const text = await consumeSSEStream(res, {
        extractDelta: (o) => o?.choices?.[0]?.delta?.content || '',
        onToken,
        signal,
      });
      return { text };
    }

    const res = await smartFetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: model.modelId,
        messages: formattedMsgs,
        temperature,
        stream: true,
        private: true,
      },
      stream: true,
      signal,
    });
    if (res.ok) {
      const text = await consumeSSEStream(res, {
        extractDelta: (o) => o?.choices?.[0]?.delta?.content || '',
        onToken,
        signal,
      });
      if (text) return { text };
    }

    const fallbackRes = await smartFetch('https://text.pollinations.ai/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: model.modelId,
        messages: formattedMsgs,
        seed: Math.floor(Math.random() * 100000),
        private: true,
      },
      signal,
    });
    if (!fallbackRes.ok) await throwFriendlyHttpError(fallbackRes, 'Pollinations');
    const plain = await fallbackRes.text();
    const text = await emitSmoothChunks(plain, onToken, signal);
    return { text };
  }

  if (provider === 'gemini') {
    const payload = buildGeminiPayload(messages, temperature, maxTokens);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model.modelId
    )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

    const res = await smartFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      stream: true,
      signal,
    });
    if (!res.ok) await throwFriendlyHttpError(res, 'Google Gemini');

    const text = await consumeSSEStream(res, {
      extractDelta: (o) =>
        o?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '',
      onToken,
      signal,
    });
    if (!text) {
      throw new Error('Gemini returned an empty response (possibly filtered or rate-limited).');
    }
    return { text };
  }

  if (provider === 'ollama') {
    const base = (apiKey || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const res = await smartFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: model.modelId,
        messages: buildOllamaMessages(messages),
        stream: true,
        options: { temperature },
      },
      stream: true,
      signal,
    });
    if (!res.ok) await throwFriendlyHttpError(res, 'Ollama');

    const text = await consumeSSEStream(res, {
      extractDelta: (o) => o?.message?.content || '',
      onToken,
      signal,
    });
    return { text };
  }

  const endpointMap = {
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    cerebras: 'https://api.cerebras.ai/v1/chat/completions',
    mistral: 'https://api.mistral.ai/v1/chat/completions',
    github: 'https://models.inference.ai.azure.com/chat/completions',
    huggingface: 'https://router.huggingface.co/v1/chat/completions',
  };

  const targetUrl = endpointMap[provider];
  if (!targetUrl) throw new Error(`Unsupported provider: ${provider}`);

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = window.location.origin;
    headers['X-Title'] = 'OmniFree AI Studio';
  }

  const res = await smartFetch(targetUrl, {
    method: 'POST',
    headers,
    body: {
      model: model.modelId,
      messages: buildOpenAIMessages(messages),
      temperature,
      max_tokens: maxTokens,
      stream: true,
    },
    stream: true,
    signal,
  });
  if (!res.ok) await throwFriendlyHttpError(res, PROVIDERS[provider].name);

  const text = await consumeSSEStream(res, {
    extractDelta: (o) => {
      const c = o?.choices?.[0]?.delta?.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((part) => part.text || '').join('');
      return '';
    },
    onToken,
    signal,
  });
  return { text };
}

export async function generateText(opts) {
  let final = '';
  const res = await generateTextStream({
    ...opts,
    onToken: (_, acc) => {
      final = acc;
    },
  });
  return { text: res.text || final };
}

async function throwFriendlyHttpError(res, providerName) {
  const raw = await res.text().catch(() => '');
  let msg = '';
  try {
    const parsed = JSON.parse(raw);
    msg = parsed?.error?.message || parsed?.message || parsed?.detail || '';
  } catch {
    msg = raw.slice(0, 220);
  }
  throw new Error(msg || `${providerName} returned HTTP ${res.status}`);
}

export async function generateImage({
  model,
  prompt,
  width = 1024,
  height = 1024,
  seed = null,
  keys = loadProviderKeys(),
}) {
  if (!model) throw new Error('No image model selected.');
  const actualSeed = seed !== null && seed !== '' ? Number(seed) : Math.floor(Math.random() * 9999999);

  if (model.provider === 'pollinations') {
    const apiKey = (keys.pollinations || '').trim();
    const encodedPrompt = encodeURIComponent(prompt.trim());
    const base = apiKey
      ? `https://gen.pollinations.ai/image/${encodedPrompt}`
      : `https://image.pollinations.ai/prompt/${encodedPrompt}`;

    const qs = new URLSearchParams({
      model: model.modelId,
      width: String(width),
      height: String(height),
      seed: String(actualSeed),
      nologo: 'true',
    });
    const fullUrl = `${base}?${qs.toString()}`;
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

    const hasProxy = await checkServerProxy();
    if (hasProxy || apiKey) {
      const res = await smartFetch(fullUrl, { method: 'GET', headers });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Image generation failed (${res.status}): ${errText.slice(0, 200)}`);
      }
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) {
        throw new Error('Upstream did not return an image. Please retry or switch model.');
      }
      const objectUrl = URL.createObjectURL(blob);
      return { objectUrl, sourceUrl: fullUrl, seed: actualSeed };
    }

    return { objectUrl: fullUrl, sourceUrl: fullUrl, seed: actualSeed };
  }

  if (model.provider === 'huggingface') {
    const apiKey = (keys.huggingface || '').trim();
    if (!apiKey) {
      throw new Error(
        'Hugging Face image models require a free HF token. Add it in "API Keys" or pick a Pollinations FLUX model (No Key Needed).'
      );
    }

    const targetUrl = `https://router.huggingface.co/hf-inference/models/${model.modelId}`;
    const res = await smartFetch(targetUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        inputs: prompt.trim(),
        parameters: {
          width: Number(width),
          height: Number(height),
        },
      },
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData?.error || `Hugging Face image error (${res.status})`);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    return { objectUrl, sourceUrl: targetUrl, seed: actualSeed };
  }

  throw new Error(`Provider ${model.provider} does not support image generation.`);
}

export async function testProviderConnection(providerId, keyValue) {
  const keys = { ...loadProviderKeys(), [providerId]: keyValue };
  if (providerId === 'ollama') {
    const base = (keyValue || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const hasProxy = await checkServerProxy();
    const res = hasProxy
      ? await fetch(`/api/ollama/tags?base=${encodeURIComponent(base)}`)
      : await fetch(`${base}/api/tags`);
    const data = await res.json();
    if (!data.models || !res.ok) {
      throw new Error('Could not connect to Ollama at ' + base);
    }
    return `Connected! Found ${data.models.length} local model(s).`;
  }

  const probeModel = CURATED_MODELS.find(
    (m) => m.provider === providerId && !m.capabilities.includes('image')
  );
  if (!probeModel) {
    throw new Error('No text test model configured for this provider.');
  }

  const reply = await generateText({
    model: probeModel,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    temperature: 0,
    maxTokens: 16,
    keys,
  });

  return `Connected (${probeModel.name}): "${reply.text.trim().slice(0, 40)}"`;
}
