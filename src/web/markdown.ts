/**
 * Rendu Markdown minimal et sûr : tout le texte est échappé avant mise en forme,
 * le code est inséré via textContent, et seuls les liens http(s) sont conservés.
 * Gère : blocs de code (y compris non fermés pendant le streaming), titres,
 * listes, citations, séparateurs, paragraphes, code inline, gras, italique, liens.
 */

export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let text: string[] = [];

  const flushText = () => {
    if (text.length) {
      const div = document.createElement('div');
      div.innerHTML = renderBlocks(text);
      frag.append(...Array.from(div.childNodes));
      text = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(lines[i]);
    if (!fence) {
      text.push(lines[i]);
      continue;
    }
    flushText();
    const marker = fence[1];
    const code: string[] = [];
    i++;
    while (i < lines.length && !lines[i].trim().startsWith(marker)) {
      code.push(lines[i]);
      i++;
    }
    frag.append(codeBlock(code.join('\n'), fence[2]));
  }
  flushText();
  return frag;
}

/** Bloc de code avec en-tête (langage) et bouton « copier » (géré par délégation dans main.ts). */
export function codeBlock(code: string, language: string, title?: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'codeblock';
  const bar = document.createElement('div');
  bar.className = 'codebar';
  const label = document.createElement('span');
  label.textContent = title ?? (language || 'code');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy';
  btn.textContent = 'Copier';
  bar.append(label, btn);
  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  codeEl.textContent = code;
  pre.append(codeEl);
  wrap.append(bar, pre);
  return wrap;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${tag}>`);
      list = undefined;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${renderBlocks(quote)}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    let m: RegExpExecArray | null;
    if (!line.trim()) {
      flushAll();
    } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      flushPara();
      flushList();
      quote.push(m[1]);
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flushAll();
      const level = Math.min(m[1].length + 2, 6); // h3..h6 : on reste sous le titre de la page
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
    } else if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flushPara();
      flushQuote();
      const ordered = /\d/.test(m[1]);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(m[2]);
    } else if (list && /^\s{2,}\S/.test(line)) {
      // Continuation d'un élément de liste.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      flushQuote();
      para.push(line);
    }
  }
  flushAll();
  return out.join('');
}

function inline(raw: string): string {
  // Extrait le code inline avant tout, pour ne pas le mettre en forme.
  const codes: string[] = [];
  let s = raw.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  s = s.replace(/\*\*(?=\S)([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(?=\S)([^_]+?)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_(?=\S)([^_]+?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([^~]+?)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}
