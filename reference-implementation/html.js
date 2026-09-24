/**
 * Small, dependency-free HTML reading helpers.
 *
 * This is deliberately not a full HTML parser. It exists to read text and
 * declared metadata out of a fetched page well enough to (a) confirm a quote is
 * present and (b) propose candidate evidence. It never executes anything, and
 * script/style content is discarded before any text is returned.
 *
 * Known limits, stated plainly: content rendered only by client-side JavaScript
 * is invisible here, and pathological markup may be read imperfectly. Both
 * failure modes are safe — they cause evidence to be missed, never fabricated.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©',
  reg: '®', trade: '™', deg: '°', times: '×', middot: '·'
};

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(cp) {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '�';
  if (cp >= 0xd800 && cp <= 0xdfff) return '�';
  try { return String.fromCodePoint(cp); } catch { return '�'; }
}

/** Remove elements whose contents are never visible text. */
function stripNonContent(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, ' ');
}

export function extractText(html) {
  return decodeEntities(stripNonContent(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/gu, ' ')
    .trim();
}

export function extractTitle(html) {
  const m = stripNonContent(html).match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/gu, ' ').trim() : null;
}

/** name= and property= meta tags, keyed by whichever attribute was present. */
export function extractMeta(html) {
  const out = {};
  for (const m of stripNonContent(html).matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = m[1];
    const key = attrs.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1];
    const content = attrs.match(/\bcontent\s*=\s*["']([\s\S]*?)["']/i)?.[1];
    if (key && content != null) out[key.toLowerCase()] = decodeEntities(content).replace(/\s+/gu, ' ').trim();
  }
  return out;
}

/** Parsed application/ld+json blocks. Unparseable blocks are skipped, not guessed at. */
export function extractJsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      for (const node of flattenGraph(parsed)) out.push(node);
    } catch { /* a malformed block is ignored; we never infer its contents */ }
  }
  return out;
}

function flattenGraph(node) {
  if (Array.isArray(node)) return node.flatMap(flattenGraph);
  if (node && typeof node === 'object') {
    return node['@graph'] ? [node, ...flattenGraph(node['@graph'])] : [node];
  }
  return [];
}

/**
 * Visible text blocks with their nearest element id, used to locate candidate
 * evidence and to build stable locators.
 */
export function extractBlocks(html) {
  const cleaned = stripNonContent(html);
  const blocks = [];
  const re = /<(h1|h2|h3|h4|p|li|blockquote|dd|figcaption|td)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (const m of cleaned.matchAll(re)) {
    const [, tag, attrs, inner] = m;
    const text = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/gu, ' ').trim();
    if (!text) continue;
    blocks.push({
      tag: tag.toLowerCase(),
      id: attrs.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] ?? null,
      section: nearestSectionId(cleaned, m.index),
      text
    });
  }
  return blocks;
}

/** id of the closest enclosing element that has one, searching backwards. */
function nearestSectionId(html, index) {
  const before = html.slice(0, index);
  const matches = [...before.matchAll(/<(?:section|article|main|div|header)\b[^>]*\bid\s*=\s*["']([^"']+)["']/gi)];
  return matches.length ? matches[matches.length - 1][1] : null;
}
