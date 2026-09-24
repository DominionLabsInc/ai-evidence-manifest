import fs from 'node:fs';
import { fetchSafe, normalizeInputUrl } from './fetch-safe.js';
import { extractFromPage, toManifest, EXTRACT_DEFAULTS } from './extract.js';

export const CONFIG_FILENAME = 'ai-evidence.config.json';

export const CONFIG_DEFAULTS = {
  discover: 'sitemap',     // 'sitemap' | 'links' | 'none'
  include: [],             // path patterns to keep; empty means "everything discovered"
  exclude: [],             // path patterns to drop, applied after include
  types: [],               // claim types to keep; empty means all
  maxPages: EXTRACT_DEFAULTS.maxPages,
  maxPerType: EXTRACT_DEFAULTS.maxPerType,
  pin: []                  // hand-written claims, always included, never overwritten
};

/** `/blog/*` style matching. Deliberately simpler than glob: one `*` wildcard, no regex. */
function matches(pathname, pattern) {
  const re = new RegExp('^' + pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(pathname);
}

export function loadConfig(file = CONFIG_FILENAME) {
  if (!fs.existsSync(file)) {
    const e = new Error(`no ${file} found. Run "ai-evidence init <url>" to create one.`);
    e.code = 'no-config';
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { const err = new Error(`${file} is not valid JSON: ${e.message}`); err.code = 'bad-config'; throw err; }

  if (!parsed.site) { const e = new Error(`${file} must have a "site"`); e.code = 'bad-config'; throw e; }
  const cfg = { ...CONFIG_DEFAULTS, ...parsed, site: normalizeInputUrl(parsed.site) };

  for (const [key, want] of [['include', 'array'], ['exclude', 'array'], ['types', 'array'], ['pin', 'array']]) {
    if (!Array.isArray(cfg[key])) { const e = new Error(`${file}: "${key}" must be an ${want}`); e.code = 'bad-config'; throw e; }
  }
  if (!['sitemap', 'links', 'none'].includes(cfg.discover)) {
    const e = new Error(`${file}: "discover" must be one of sitemap, links, none`); e.code = 'bad-config'; throw e;
  }
  return cfg;
}

export function writeConfig(cfg, file = CONFIG_FILENAME) {
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return file;
}

/** Build a starter config, checking whether the site actually has a sitemap. */
export async function initConfig(siteInput) {
  const site = normalizeInputUrl(siteInput);
  const origin = new URL(site).origin;
  let discover = 'links';
  try {
    const sm = await fetchSafe(new URL('/sitemap.xml', origin).toString(), { accept: 'application/xml,text/xml' });
    if (sm.status >= 200 && sm.status < 300 && /<loc>/i.test(sm.body)) discover = 'sitemap';
  } catch { /* absent or unreachable: fall back to following links */ }

  return {
    site: origin + '/',
    discover,
    include: [],
    exclude: ['/privacy', '/terms', '/legal/*'],
    types: ['organization', 'capability', 'product', 'service', 'technical_claim', 'certification', 'statistic'],
    maxPages: CONFIG_DEFAULTS.maxPages,
    maxPerType: CONFIG_DEFAULTS.maxPerType,
    pin: []
  };
}

async function discoverUrls(cfg) {
  const origin = new URL(cfg.site).origin;
  const urls = new Set([cfg.site]);

  if (cfg.discover === 'sitemap') {
    try {
      const sm = await fetchSafe(new URL('/sitemap.xml', origin).toString(), { accept: 'application/xml,text/xml' });
      for (const m of sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        const u = m[1].trim();
        if (u.startsWith(origin) && !/\.(pdf|png|jpe?g|gif|svg|webp|zip|xml|json)$/i.test(u)) urls.add(u);
      }
    } catch { /* reported by the caller as zero discovered pages */ }
  } else if (cfg.discover === 'links') {
    try {
      const home = await fetchSafe(cfg.site, { accept: 'text/html' });
      for (const m of home.body.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
        let u; try { u = new URL(m[1], cfg.site); } catch { continue; }
        if (u.origin !== origin) continue;
        if (/\.(pdf|png|jpe?g|gif|svg|webp|zip|xml|json|css|js)$/i.test(u.pathname)) continue;
        urls.add(u.toString().split('#')[0]);
      }
    } catch { /* same */ }
  }

  return [...urls].filter(u => {
    const { pathname } = new URL(u);
    if (cfg.include.length && !cfg.include.some(p => matches(pathname, p))) return false;
    if (cfg.exclude.some(p => matches(pathname, p))) return false;
    return true;
  }).slice(0, cfg.maxPages);
}

/**
 * Generate a manifest from a configuration.
 *
 * Pinned claims are emitted first and untouched: a hand-written claim is the
 * publisher's own work and must survive regeneration unchanged.
 */
export async function generate(cfg, { onPage } = {}) {
  const pages = await discoverUrls(cfg);
  const found = [];
  const errors = [];
  const clientRendered = [];

  for (const url of pages) {
    try {
      const r = await extractFromPage(url, { maxPerType: cfg.maxPerType, maxCandidatesPerPage: EXTRACT_DEFAULTS.maxCandidatesPerPage });
      const kept = cfg.types.length ? r.candidates.filter(c => cfg.types.includes(c.type)) : r.candidates;
      found.push(...kept);
      if (r.note?.code === 'client-rendered') clientRendered.push({ url, reasons: r.note.reasons });
      onPage?.(url, kept.length, null, r.note);
    } catch (e) {
      errors.push({ url, error: e.message });
      onPage?.(url, 0, e.message);
    }
  }

  const perType = new Map();
  const capped = found.filter(c => {
    if (!cfg.maxPerType) return true;
    const n = (perType.get(c.type) ?? 0) + 1;
    perType.set(c.type, n);
    return n <= cfg.maxPerType;
  });

  const manifest = toManifest(new URL(cfg.site).origin, capped);
  if (cfg.pin.length) {
    const pinnedIds = new Set(cfg.pin.map(c => c.id));
    manifest.claims = [...cfg.pin, ...manifest.claims.filter(c => !pinnedIds.has(c.id))];
  }
  return { manifest, pages, errors, clientRendered, pinned: cfg.pin.length, found: capped.length };
}
