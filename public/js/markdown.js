/**
 * Lightweight Safe Markdown Renderer & Syntax Highlighter
 * Supports fenced code blocks with Run, Inspect, and Copy actions.
 */

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightCode(rawCode, lang = '') {
  const code = escapeHtml(rawCode);
  const lower = lang.toLowerCase();

  const tokens = [];
  const stash = (html) => {
    const id = `@@TOK_${tokens.length}@@`;
    tokens.push(html);
    return id;
  };

  let out = code;
  out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => stash(`<span class="tok-comment">${m}</span>`));
  if (['py', 'python', 'bash', 'sh', 'yaml', 'yml', 'toml', 'sql'].includes(lower)) {
    out = out.replace(/(^|\s)(#[^\n]*|--[^\n]*)/gm, (_, pre, c) => `${pre}${stash(`<span class="tok-comment">${c}</span>`)}`);
  } else {
    out = out.replace(/(^|[^:])(\/\/[^\n]*)/gm, (_, pre, c) => `${pre}${stash(`<span class="tok-comment">${c}</span>`)}`);
  }

  out = out.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*?`)/g, (m) =>
    stash(`<span class="tok-string">${m}</span>`)
  );
  out = out.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>');

  const kwPattern =
    /\b(const|let|var|function|async|await|return|if|else|for|while|switch|case|break|continue|import|export|from|default|class|extends|new|try|catch|finally|throw|def|elif|pass|with|as|yield|lambda|print|None|True|False|true|false|null|undefined|SELECT|FROM|WHERE|JOIN|INSERT|INTO|VALUES|UPDATE|DELETE|CREATE|TABLE|GROUP|BY|ORDER|LIMIT|type|interface)\b/g;
  out = out.replace(kwPattern, '<span class="tok-keyword">$1</span>');

  out = out.replace(/@@TOK_(\d+)@@/g, (_, idx) => tokens[Number(idx)] || '');
  return out;
}

export function extractCodeBlocks(markdown) {
  const blocks = [];
  const regex = /```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(markdown || '')) !== null) {
    blocks.push({
      lang: (match[1] || 'text').toLowerCase(),
      code: match[2].trimEnd(),
    });
  }
  return blocks;
}

const RUNNABLE_LANGS = new Set([
  'html',
  'htm',
  'svg',
  'python',
  'py',
  'python3',
  'javascript',
  'js',
  'sql',
  'sqlite',
  'sqlite3',
]);

export function isRunnableLang(lang) {
  return RUNNABLE_LANGS.has(String(lang || '').toLowerCase());
}

export function renderMarkdown(markdown, { onCodeAction = true, streaming = false } = {}) {
  if (!markdown) return streaming ? '<span class="streaming-cursor"></span>' : '';

  // Close an unclosed trailing code fence gracefully during live streaming
  let safeMd = String(markdown);
  const fenceCount = (safeMd.match(/```/g) || []).length;
  if (streaming && fenceCount % 2 === 1) {
    safeMd += '\n```';
  }

  const codeBlocks = [];
  let text = safeMd.replace(/```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    const index = codeBlocks.length;
    codeBlocks.push({ lang: (lang || 'code').trim(), code: code.replace(/\n$/, '') });
    return `\n@@CODEBLOCK_${index}@@\n`;
  });

  text = escapeHtml(text);

  text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  text = text.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  text = text.replace(/^---$/gm, '<hr>');

  text = text.replace(/^(?:[-*] .+(?:\n|$))+/gm, (block) => {
    const items = block
      .trim()
      .split('\n')
      .map((line) => `<li>${line.replace(/^[-*] /, '')}</li>`)
      .join('');
    return `<ul>${items}</ul>`;
  });

  text = text.replace(/^(?:\d+\. .+(?:\n|$))+/gm, (block) => {
    const items = block
      .trim()
      .split('\n')
      .map((line) => `<li>${line.replace(/^\d+\. /, '')}</li>`)
      .join('');
    return `<ol>${items}</ol>`;
  });

  text = text.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  const chunks = text.split(/\n{2,}/).map((chunk) => {
    const trimmed = chunk.trim();
    if (!trimmed) return '';
    if (
      trimmed.startsWith('<h') ||
      trimmed.startsWith('<ul') ||
      trimmed.startsWith('<ol') ||
      trimmed.startsWith('<blockquote') ||
      trimmed.startsWith('<hr') ||
      /^@@CODEBLOCK_\d+@@$/.test(trimmed)
    ) {
      return trimmed;
    }
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  });

  let html = chunks.join('\n');

  html = html.replace(/@@CODEBLOCK_(\d+)@@/g, (_, idx) => {
    const blk = codeBlocks[Number(idx)];
    if (!blk) return '';
    const encoded = btoa(unescape(encodeURIComponent(blk.code)));
    const canRun = isRunnableLang(blk.lang);
    const actionsHtml = onCodeAction && !streaming
      ? `<div class="code-actions">
           ${
             canRun
               ? `<button class="code-btn" data-action="run" data-lang="${escapeHtml(
                   blk.lang
                 )}" data-code="${encoded}">▶ Run</button>`
               : ''
           }
           <button class="code-btn" data-action="inspect" data-lang="${escapeHtml(
             blk.lang
           )}" data-code="${encoded}">Code</button>
           <button class="code-btn" data-action="copy" data-code="${encoded}">Copy</button>
         </div>`
      : '';

    return `<div class="code-card">
      <div class="code-header">
        <span class="code-lang">${escapeHtml(blk.lang)}</span>
        ${actionsHtml}
      </div>
      <pre><code>${highlightCode(blk.code, blk.lang)}</code></pre>
    </div>`;
  });

  if (streaming) {
    html += '<span class="streaming-cursor" aria-hidden="true"></span>';
  }

  return html;
}
