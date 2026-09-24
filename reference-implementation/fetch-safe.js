import dns from 'node:dns/promises';
import net from 'node:net';

export const DEFAULTS = {
  maxBytes: 8 * 1024 * 1024,   // pages are routinely >1 MiB; the 1 MiB cap is for manifests
  timeoutMs: 15_000,
  maxRedirects: 5,
  userAgent: 'ai-evidence/0.1 (+https://github.com/DominionLabsInc/ai-evidence-manifest)'
};

export class FetchRefused extends Error {
  constructor(message, code) { super(message); this.name = 'FetchRefused'; this.code = code; }
}

/**
 * Address ranges an untrusted manifest must never be able to reach.
 * A manifest is third-party input: without this, "evidence" could point at
 * 169.254.169.254 and turn any consumer into a cloud-credential exfiltrator.
 */
function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return true;   // unparseable: refuse rather than guess
}

function isBlockedIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;          // this-network, private, loopback
  if (a === 169 && b === 254) return true;                     // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;            // private
  if (a === 192 && b === 168) return true;                     // private
  if (a === 100 && b >= 64 && b <= 127) return true;           // CGNAT
  if (a === 192 && b === 0) return true;                       // IETF protocol assignments
  if (a >= 224) return true;                                   // multicast, reserved, broadcast
  return false;
}

/** Expand any IPv6 form (including :: and embedded IPv4) to 8 numeric hextets. */
function expandIPv6(ip) {
  let s = ip.toLowerCase();
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    if (o.some(n => n > 255)) return null;
    s = s.slice(0, -v4[1].length)
      + ((o[0] << 8 | o[1]).toString(16)) + ':' + ((o[2] << 8 | o[3]).toString(16));
  }
  const [head, tail] = s.split('::');
  if (tail === undefined) {
    const parts = head.split(':');
    return parts.length === 8 ? parts.map(h => parseInt(h || '0', 16)) : null;
  }
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail ? tail.split(':').filter(Boolean) : [];
  if (h.length + t.length > 8) return null;
  const mid = Array(8 - h.length - t.length).fill('0');
  return [...h, ...mid, ...t].map(x => parseInt(x || '0', 16));
}

function isBlockedIPv6(ip) {
  const g = expandIPv6(ip);
  if (!g) return true;

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96): judge the embedded v4.
  // The URL parser rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1, so match on hextets,
  // never on the textual form.
  const firstFiveZero = g.slice(0, 5).every(x => x === 0);
  if (firstFiveZero && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true;      // :: and ::1
    return isBlockedIPv4(v4);
  }

  if (g.every(x => x === 0)) return true;                        // ::
  if ((g[0] & 0xffc0) === 0xfe80) return true;                   // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true;                   // fc00::/7 unique local
  if ((g[0] & 0xff00) === 0xff00) return true;                   // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;           // 2001:db8::/32 documentation
  return false;
}

/** Throws unless the URL is an https URL that resolves only to public addresses. */
export function normalizeInputUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new FetchRefused('no URL given', 'invalid-url');
  // "example.com" and "http://example.com" are what people actually type.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try { u = new URL(withScheme); } catch { throw new FetchRefused(`not a valid URL: ${raw}`, 'invalid-url'); }
  if (u.protocol === 'http:') u.protocol = 'https:';   // upgrade rather than refuse
  return u.toString();
}

export async function assertFetchable(rawUrl, { resolve = true } = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new FetchRefused(`not a valid URL: ${rawUrl}`, 'invalid-url'); }
  if (u.protocol !== 'https:') throw new FetchRefused(`only https is allowed, got ${u.protocol}`, 'not-https');
  if (u.username || u.password) throw new FetchRefused('credentials in URL are not allowed', 'url-credentials');

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localdomain)$/i.test(host)) {
    throw new FetchRefused(`refusing internal hostname: ${host}`, 'internal-host');
  }
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new FetchRefused(`refusing non-public address: ${host}`, 'blocked-address');
    return u;
  }
  if (resolve) {
    let addrs;
    try { addrs = await dns.lookup(host, { all: true }); }
    catch { throw new FetchRefused(`cannot resolve host: ${host}`, 'dns-failure'); }
    for (const { address } of addrs) {
      if (isBlockedAddress(address)) {
        throw new FetchRefused(`${host} resolves to a non-public address (${address})`, 'blocked-address');
      }
    }
  }
  return u;
}

/** Fetch with redirect, size and time limits. Every redirect hop is re-checked. */
export async function fetchSafe(rawUrl, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let url = rawUrl;

  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    await assertFetchable(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': o.userAgent, accept: o.accept ?? '*/*' }
      });
    } catch (e) {
      clearTimeout(timer);
      throw new FetchRefused(`request failed: ${e.message}`, 'network');
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer);
      url = new URL(res.headers.get('location'), url).toString();
      continue;
    }

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > o.maxBytes) {
      clearTimeout(timer);
      throw new FetchRefused(`response too large: ${declared} > ${o.maxBytes}`, 'too-large');
    }

    // Stream so an undeclared or lying content-length cannot exhaust memory.
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of res.body ?? []) {
        total += chunk.length;
        if (total > o.maxBytes) throw new FetchRefused(`response exceeded ${o.maxBytes} bytes`, 'too-large');
        chunks.push(chunk);
      }
    } finally { clearTimeout(timer); }

    if (res.status === 403 || res.status === 429) {
      throw new FetchRefused(
        `the site refused the request (HTTP ${res.status}). Many sites block non-browser clients; ` +
        `this page cannot be read automatically.`, 'blocked-by-site');
    }
    if (res.status === 404) throw new FetchRefused(`page not found (HTTP 404)`, 'not-found');
    if (res.status >= 400) throw new FetchRefused(`server returned HTTP ${res.status}`, 'http-error');

    return {
      url, status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body: Buffer.concat(chunks).toString('utf8'),
      bytes: total
    };
  }
  throw new FetchRefused(`too many redirects (> ${o.maxRedirects})`, 'too-many-redirects');
}
