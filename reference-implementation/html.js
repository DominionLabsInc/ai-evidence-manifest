import { parse } from 'parse5';

/**
 * HTML reading, built on parse5 — the same spec-compliant parser jsdom uses.
 *
 * An earlier version did this with regular expressions. That was wrong for a
 * verification tool: mis-parsed markup (an attribute containing `>`, unclosed
 * tags, CDATA) can mangle a paragraph, which makes a quote that IS on the page
 * read as absent and causes `check` to report drift that does not exist. False
 * alarms are worse than missed evidence, so correctness wins over having no
 * dependencies.
 *
 * Nothing here executes anything. Script, style, noscript, template and svg
 * subtrees are skipped entirely before any text is returned.
 */

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'object', 'canvas']);
const BLOCK = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'li', 'blockquote', 'dd', 'figcaption', 'td', 'th']);
const SECTIONING = new Set(['section', 'article', 'main', 'div', 'header', 'aside', 'nav', 'footer']);

const isElement = n => typeof n.tagName === 'string';
const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value ?? null;
const collapse = s => s.replace(/\s+/gu, ' ').trim();

function* walk(node, ancestors = []) {
  for (const child of node.childNodes ?? []) {
    if (isElement(child)) {
      if (SKIP.has(child.tagName)) continue;
      yield { node: child, ancestors };
      yield* walk(child, [...ancestors, child]);
    } else {
      yield { node: child, ancestors };
    }
  }
}

// Elements that imply a break in the text. Without these, adjacent blocks run
// together ("sign.unclosed") and a quote can appear to span a boundary it never
// crossed.
const SEPARATES = new Set([
  ...BLOCK, ...SECTIONING, 'br', 'hr', 'tr', 'ul', 'ol', 'dl', 'dt', 'table',
  'figure', 'address', 'pre', 'form', 'label', 'option', 'h5', 'h6'
]);

/** Concatenated text of a subtree, skipping non-content elements. */
function textOf(node) {
  if (node.nodeName === '#text') return node.value ?? '';
  if (isElement(node) && SKIP.has(node.tagName)) return '';
  let out = '';
  for (const child of node.childNodes ?? []) {
    if (isElement(child) && SEPARATES.has(child.tagName)) out += ' ';
    out += textOf(child);
    if (isElement(child) && SEPARATES.has(child.tagName)) out += ' ';
  }
  return out;
}

function documentOf(html) {
  return typeof html === 'string' ? parse(html) : html;
}

function findAll(doc, predicate) {
  const out = [];
  for (const { node, ancestors } of walk(doc)) {
    if (isElement(node) && predicate(node)) out.push({ node, ancestors });
  }
  return out;
}

/** All visible text on the page, whitespace-collapsed. */
export function extractText(html) {
  const doc = documentOf(html);
  const body = findAll(doc, n => n.tagName === 'body')[0]?.node;
  return collapse(textOf(body ?? doc));
}

export function extractTitle(html) {
  const t = findAll(documentOf(html), n => n.tagName === 'title')[0]?.node;
  // <title> sits inside <head>, which walk() skips, so read it from the raw tree
  if (t) return collapse(textOf(t)) || null;
  const doc = documentOf(html);
  const found = deepFind(doc, n => isElement(n) && n.tagName === 'title');
  return found ? collapse(textOf(found)) || null : null;
}

function deepFind(node, predicate) {
  for (const child of node.childNodes ?? []) {
    if (predicate(child)) return child;
    const nested = deepFind(child, predicate);
    if (nested) return nested;
  }
  return null;
}

function deepFindAll(node, predicate, out = []) {
  for (const child of node.childNodes ?? []) {
    if (predicate(child)) out.push(child);
    deepFindAll(child, predicate, out);
  }
  return out;
}

/** name= and property= meta tags, keyed by whichever attribute was present. */
export function extractMeta(html) {
  const out = {};
  for (const m of deepFindAll(documentOf(html), n => isElement(n) && n.tagName === 'meta')) {
    const key = attr(m, 'name') ?? attr(m, 'property');
    const content = attr(m, 'content');
    if (key && content != null) out[key.toLowerCase()] = collapse(content);
  }
  return out;
}

/** Parsed application/ld+json blocks. Unparseable blocks are skipped, never guessed at. */
export function extractJsonLd(html) {
  const out = [];
  const scripts = deepFindAll(documentOf(html), n =>
    isElement(n) && n.tagName === 'script' && /application\/ld\+json/i.test(attr(n, 'type') ?? ''));
  for (const s of scripts) {
    const raw = s.childNodes?.map(c => c.value ?? '').join('').trim();
    if (!raw) continue;
    try {
      for (const node of flattenGraph(JSON.parse(raw))) out.push(node);
    } catch { /* malformed: ignored rather than inferred */ }
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

/** Visible text blocks with their own id and nearest sectioning ancestor id. */
export function extractBlocks(html) {
  const doc = documentOf(html);
  const blocks = [];
  for (const { node, ancestors } of walk(doc)) {
    if (!isElement(node) || !BLOCK.has(node.tagName)) continue;
    const text = collapse(textOf(node));
    if (!text) continue;
    let section = null;
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i];
      if (SECTIONING.has(a.tagName) && attr(a, 'id')) { section = attr(a, 'id'); break; }
    }
    blocks.push({ tag: node.tagName, id: attr(node, 'id'), section, text });
  }
  return blocks;
}

/**
 * Does this look like a page whose content is assembled in the browser?
 *
 * Fetching alone cannot see client-rendered content. Reporting "no claims
 * found" without saying why leads a publisher to conclude their site has
 * nothing worth publishing, so this is surfaced explicitly.
 */
export function looksClientRendered(html) {
  const doc = documentOf(html);
  const text = extractText(doc);
  const scripts = deepFindAll(doc, n => isElement(n) && n.tagName === 'script');
  const scriptBytes = scripts.reduce((n, s) => n + (attr(s, 'src') ? 0 : (s.childNodes?.[0]?.value?.length ?? 0)), 0);
  const roots = deepFindAll(doc, n => isElement(n) && ['root', 'app', '__next', '__nuxt'].includes(attr(n, 'id') ?? ''));

  const reasons = [];
  if (text.length < 400) reasons.push(`only ${text.length} characters of visible text`);
  if (roots.length && text.length < 1500) reasons.push(`an empty-looking app root (#${attr(roots[0], 'id')})`);
  if (scripts.length > 8 && text.length < 1500) reasons.push(`${scripts.length} script tags but little text`);
  if (scriptBytes > text.length * 4 && text.length < 2000) reasons.push('far more inline script than text');

  return { likely: reasons.length > 0, reasons, textLength: text.length, scriptCount: scripts.length };
}

/** Kept for callers that pass raw strings around; parse5 handles entities itself. */
export function decodeEntities(s) {
  const doc = parse(`<body>${s}</body>`);
  return textOf(deepFind(doc, n => isElement(n) && n.tagName === 'body') ?? doc);
}
