/**
 * A channel's canvas as notes: the canvas file Slack serves as HTML, read back
 * into the markdown the apps render (the desktop's `rv_slack::canvas`, same
 * rules). Only the tags a canvas holds are understood; anything else keeps its text.
 */

type Doc = Record<string, unknown>;

const record = (v: unknown): Doc => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : {});

/** Where a conversation's canvas lives: its file id, from `conversations.info`. */
export function canvasFile(conversation: unknown): string | null {
  const properties = record(record(conversation).properties);
  const direct = record(properties.canvas).file_id;
  if (typeof direct === 'string' && direct !== '') return direct;
  const tabs = Array.isArray(properties.tabs) ? properties.tabs : [];
  for (const tab of tabs) {
    const t = record(tab);
    const id = record(t.data).file_id;
    if (t.type === 'canvas' && typeof id === 'string' && id !== '') return id;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

function entities(text: string): string {
  return text.replace(/&([#a-zA-Z0-9]{1,10});/g, (whole, name: string) => {
    if (name in ENTITIES) return ENTITIES[name];
    const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : name.startsWith('#') ? parseInt(name.slice(1), 10) : NaN;
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function attribute(tag: string, key: string): string | null {
  const m = new RegExp(`${key}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? entities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

function isItem(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('- ') || /^\d+\. /.test(t);
}

/** The markdown of a canvas's HTML. */
export function canvasMarkdown(html: string): string {
  const lower = html.toLowerCase();
  const open = lower.indexOf('<body');
  const start = open < 0 ? 0 : lower.indexOf('>', open) + 1;
  const close = lower.lastIndexOf('</body>');
  const body = html.slice(start, close >= start ? close : html.length);

  const blocks: string[] = [];
  const lists: { ordered: boolean; next: number }[] = [];
  let line = '';
  let pre = false;
  let quote = false;
  let link: string | null = null;
  let skip = 0;
  let listEnded = false;

  const flush = () => {
    let out = line.replace(/\s+$/, '');
    line = '';
    if (out.trim() === '') return;
    if (quote) out = `> ${out}`;
    const last = blocks[blocks.length - 1];
    if (!listEnded && last !== undefined && isItem(out) && isItem(last.split('\n').pop() ?? '')) blocks[blocks.length - 1] = `${last}\n${out}`;
    else blocks.push(out);
    listEnded = false;
  };

  const tag = (raw: string) => {
    const inner = raw.replace(/^<|\/?>$/g, '').replace(/\/$/, '');
    const closing = inner.startsWith('/');
    const body = closing ? inner.slice(1) : inner;
    const name = (body.split(/\s/)[0] ?? '').toLowerCase();
    if (['script', 'style', 'head', 'title'].includes(name)) { skip = Math.max(0, skip + (closing ? -1 : 1)); return; }
    if (skip > 0) return;
    if (/^h[1-6]$/.test(name) && !closing) {
      flush();
      line += `${'#'.repeat(Math.min(3, Number(name[1])))} `;
      return;
    }
    switch (name) {
      case 'p': case 'div': case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': flush(); return;
      case 'br': if (pre) line += '\n'; else flush(); return;
      case 'ul': case 'ol':
        flush();
        if (closing) { lists.pop(); listEnded = lists.length === 0; } else lists.push({ ordered: name === 'ol', next: 1 });
        return;
      case 'li': {
        flush();
        if (closing) return;
        line += '  '.repeat(Math.max(0, lists.length - 1));
        const list = lists[lists.length - 1];
        if (list?.ordered) { line += `${list.next}. `; list.next += 1; } else line += '- ';
        const classes = (attribute(body, 'class') ?? '').split(/\s+/);
        if (classes.includes('checked')) line += '[x] ';
        else if (classes.includes('unchecked') || classes.includes('checklist-item')) line += '[ ] ';
        return;
      }
      case 'b': case 'strong': line += '**'; return;
      case 'i': case 'em': line += '_'; return;
      case 's': case 'del': case 'strike': line += '~'; return;
      case 'code': if (!pre) line += '`'; return;
      case 'pre':
        if (closing) { line += '\n```'; pre = false; flush(); } else { flush(); pre = true; line += '```\n'; }
        return;
      case 'blockquote': flush(); quote = !closing; return;
      case 'hr': flush(); blocks.push('---'); return;
      case 'a':
        if (closing) { if (link !== null) { line += `](${link})`; link = null; } return; }
        link = attribute(body, 'href');
        if (link !== null && !/^https?:\/\//.test(link)) link = null;
        if (link !== null) line += '[';
        return;
      case 'td': case 'th': if (closing) line += ' | '; return;
      case 'tr': if (closing) flush(); return;
      default: return;
    }
  };

  const textRun = (raw: string) => {
    if (skip > 0) return;
    const text = entities(raw);
    if (pre) { line += text; return; }
    const collapsed = text.split(/\s+/).filter(Boolean).join(' ');
    if (collapsed === '') {
      if (/\s/.test(text) && line !== '' && !line.endsWith(' ')) line += ' ';
      return;
    }
    if (/^\s/.test(text) && line !== '' && !line.endsWith(' ')) line += ' ';
    line += collapsed;
    if (/\s$/.test(text)) line += ' ';
  };

  let rest = body;
  while (rest !== '') {
    const at = rest.indexOf('<');
    if (at === 0) {
      const end = rest.indexOf('>');
      const cut = end < 0 ? rest.length : end + 1;
      tag(rest.slice(0, cut));
      rest = rest.slice(cut);
    } else if (at > 0) {
      textRun(rest.slice(0, at));
      rest = rest.slice(at);
    } else {
      textRun(rest);
      rest = '';
    }
  }
  flush();
  return blocks.join('\n\n');
}
