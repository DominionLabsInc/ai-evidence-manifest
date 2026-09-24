#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { validateManifest, parseManifest, stampVerification, LIMITS } from '../reference-implementation/validate.js';
import { extractFromSite, extractFromPage, toManifest } from '../reference-implementation/extract.js';
import { fetchSafe, FetchRefused, normalizeInputUrl } from '../reference-implementation/fetch-safe.js';
import { loadConfig, writeConfig, initConfig, generate, CONFIG_FILENAME, WELL_KNOWN_PATH, ALIAS_PATH } from '../reference-implementation/config.js';
import { repairManifest, SIMILARITY_THRESHOLD } from '../reference-implementation/repair.js';

const C = process.stdout.isTTY
  ? { red: s => `\x1b[31m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m` }
  : { red: s => s, yellow: s => s, green: s => s, dim: s => s, bold: s => s };

const USAGE = `ai-evidence — reference tooling for the AI Evidence Manifest

Usage:
  ai-evidence init <url>            Create ai-evidence.config.json for a site
  ai-evidence generate              Read the config, find evidence, write ai.json
  ai-evidence validate <file|url>   Validate a manifest
  ai-evidence check <file> --update Re-check evidence and record the result in the file
  ai-evidence repair <file>         Re-check, relocate drifted quotes, rewrite the file
  ai-evidence extract <url>         One-shot generate without a config file

Typical use:
  ai-evidence init https://example.com
  ai-evidence generate              # writes the manifest; commit it and serve it

Validate options:
  --offline        Do not fetch evidence URLs (default for local files)
  --online         Fetch evidence URLs (default when validating a URL)
  --strict         Treat warnings as failures
  --json           Machine-readable output

Check options:
  --update         Write the freshness result back into the manifest
  --interval <n>   Days between intended re-checks, recorded in the manifest

Repair options:
  --prune          Remove evidence that could not be confirmed, and any claim
                   left with none
  --threshold <n>  Word-overlap required to accept a relocated quote
                   (default 0.6, 0-1). Below it, the entry is reported lost.
  --dry-run        Report what would change without writing

Generate options:
  --config <file>  Config to read (default ai-evidence.config.json)
  --out <dir|file> Where to write (default: the site root of the current
                   directory, producing .well-known/ai-evidence.json and the
                   short alias ai.json)
  --no-alias       Write only the canonical .well-known path

Extract options:
  --out <file>     Write the manifest (default: stdout)
  --max-pages <n>  Pages to visit (default 20)
  --per-type <n>   Max claims per type (default 6, 0 disables)
  --page-only      Only the given page, do not discover other URLs

Exit codes: 0 valid, 1 invalid, 2 usage or transport error
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (['out', 'max-pages', 'per-type', 'config', 'interval', 'threshold'].includes(key)) out.flags[key] = argv[++i];
      else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

const isUrl = s => /^https?:\/\//i.test(s);

/**
 * Given a bare origin, try the canonical well-known path first and fall back to
 * the short alias, per SPEC 2.1. A full URL is fetched as given.
 */
async function resolveManifestUrl(target) {
  const u = new URL(target);
  if (u.pathname !== '/' && u.pathname !== '') return [target];
  return [new URL('/' + WELL_KNOWN_PATH, u).toString(), new URL('/' + ALIAS_PATH, u).toString()];
}

async function readManifest(target) {
  if (isUrl(target)) {
    const candidates = await resolveManifestUrl(target);
    let res, lastError;
    for (const candidate of candidates) {
      try {
        res = await fetchSafe(candidate, { accept: 'application/ai-evidence+json, application/json' });
        break;
      } catch (e) { lastError = e; }
    }
    if (!res) throw lastError;
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} fetching ${target}`);
    // SPEC 2.2: never reject on content type alone; misconfigured static hosts
    // are common and the document is self-describing.
    if (!/json/i.test(res.contentType)) {
      process.stderr.write(C.yellow(`warning: ${res.url} served as "${res.contentType || 'no content-type'}"; expected application/ai-evidence+json or application/json\n`));
    }
    return { raw: res.body, source: res.url };
  }
  const p = path.resolve(target);
  if (!fs.existsSync(p)) throw new Error(`no such file: ${p}`);
  return { raw: fs.readFileSync(p, 'utf8'), source: p };
}

function report(result, source, asJson) {
  if (asJson) { process.stdout.write(JSON.stringify({ source, ...result }, null, 2) + '\n'); return; }
  const { stats, errors, warnings, valid } = result;
  process.stdout.write(`\n${C.bold(source)}\n`);
  process.stdout.write(C.dim(`  ${stats.claims} claims · ${stats.evidence} evidence records`));
  if (!result.offline) process.stdout.write(C.dim(` · ${stats.reachable}/${stats.checkedUrls} URLs reachable · ${stats.textPresent} quotes still present`));
  process.stdout.write('\n\n');
  for (const f of errors) process.stdout.write(`  ${C.red('error')}   ${C.dim(f.where)} ${f.message}  ${C.dim('[' + f.code + ']')}\n`);
  for (const f of warnings) process.stdout.write(`  ${C.yellow('warning')} ${C.dim(f.where)} ${f.message}  ${C.dim('[' + f.code + ']')}\n`);
  if (errors.length || warnings.length) process.stdout.write('\n');
  const verdict = valid ? C.green('VALID') : C.red('INVALID');
  process.stdout.write(`  ${verdict}  ${errors.length} error(s), ${warnings.length} warning(s)${result.strict ? C.dim(' (strict)') : ''}\n\n`);
}

async function cmdValidate(args) {
  const target = args._[1];
  if (!target) { process.stderr.write(USAGE); return 2; }
  let raw, source;
  try { ({ raw, source } = await readManifest(target)); }
  catch (e) { process.stderr.write(C.red(`error: ${e.message}\n`)); return 2; }

  let parsed;
  try { parsed = parseManifest(raw); }
  catch (e) {
    if (args.flags.json) process.stdout.write(JSON.stringify({ source, valid: false, errors: [{ code: 'malformed-json', message: e.message }] }, null, 2) + '\n');
    else process.stdout.write(`\n${C.bold(source)}\n\n  ${C.red('error')} ${e.message}  ${C.dim('[malformed-json]')}\n\n  ${C.red('INVALID')}\n\n`);
    return 1;
  }

  const offline = args.flags.offline ? true : args.flags.online ? false : !isUrl(target);
  const result = await validateManifest(parsed.manifest, { offline, strict: !!args.flags.strict, rawBytes: parsed.bytes });
  report(result, source, !!args.flags.json);
  return result.valid ? 0 : 1;
}

async function cmdExtract(args) {
  const target = args._[1];
  if (!target || !isUrl(target)) { process.stderr.write(USAGE); return 2; }
  const opts = {
    maxPages: args.flags['max-pages'] ? Number(args.flags['max-pages']) : undefined,
    maxPerType: args.flags['per-type'] !== undefined ? Number(args.flags['per-type']) : undefined,
    onPage: args.flags.json ? undefined : (u, n, err) => process.stderr.write(`  ${String(n).padStart(3)}  ${err ? C.red(err) + ' ' : ''}${C.dim(u)}\n`)
  };
  for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];

  let manifest, meta;
  try {
    if (args.flags['page-only']) {
      const r = await extractFromPage(target, opts);
      manifest = toManifest(new URL(target).origin, r.candidates);
      meta = { pages: [{ url: target, candidates: r.candidates.length }], errors: [], candidateCount: r.candidates.length, droppedByCap: 0 };
    } else {
      meta = await extractFromSite(target, opts);
      manifest = meta.manifest;
    }
  } catch (e) {
    process.stderr.write(C.red(`error: ${e instanceof FetchRefused ? `${e.code}: ${e.message}` : e.message}\n`));
    return 2;
  }

  const json = JSON.stringify(manifest, null, 2);
  if (args.flags.out) {
    fs.writeFileSync(args.flags.out, json + '\n');
    process.stderr.write(`\n  wrote ${C.bold(args.flags.out)} — ${manifest.claims.length} claims, ${(Buffer.byteLength(json) / 1024).toFixed(1)} KiB\n`);
  } else {
    process.stdout.write(json + '\n');
  }
  process.stderr.write(C.dim(`  every claim is marked verification.method=automatically-generated.\n  Review and promote to publisher-confirmed before publishing.\n\n`));
  if (meta.errors?.length) for (const e of meta.errors) process.stderr.write(C.yellow(`  skipped ${e.url}: ${e.error}\n`));
  return 0;
}

async function cmdInit(args) {
  const target = args._[1];
  if (!target) { process.stderr.write(USAGE); return 2; }
  const file = args.flags.config ?? CONFIG_FILENAME;
  if (fs.existsSync(file) && !args.flags.force) {
    process.stderr.write(C.red(`error: ${file} already exists (use --force to overwrite)\n`));
    return 2;
  }
  let cfg;
  try { cfg = await initConfig(target); }
  catch (e) { process.stderr.write(C.red(`error: ${e instanceof FetchRefused ? e.message : e.message}\n`)); return 2; }
  writeConfig(cfg, file);
  process.stdout.write(`\n  wrote ${C.bold(file)}\n`);
  process.stdout.write(C.dim(`  discovery: ${cfg.discover}${cfg.discover === 'sitemap' ? ' (sitemap.xml found)' : ' (no sitemap.xml; following links)'}\n`));
  process.stdout.write(C.dim(`  edit it if you want, then run: ai-evidence generate\n\n`));
  return 0;
}

async function cmdGenerate(args) {
  const file = args.flags.config ?? CONFIG_FILENAME;
  const out = args.flags.out ?? 'ai.json';
  let cfg;
  try { cfg = loadConfig(file); }
  catch (e) { process.stderr.write(C.red(`error: ${e.message}\n`)); return 2; }

  process.stderr.write(`\n  reading ${C.bold(file)} — ${cfg.site}\n`);
  const res = await generate(cfg, {
    onPage: (u, n, err, note) => {
      const flag = note?.code === 'client-rendered' ? C.yellow(' content appears to be rendered in the browser') : '';
      process.stderr.write(`  ${String(n).padStart(3)}  ${err ? C.yellow(err.slice(0, 60)) + ' ' : ''}${C.dim(u)}${flag}\n`);
    }
  });

  const check = await validateManifest(res.manifest, { offline: true });
  if (!check.valid) {
    process.stderr.write(C.red(`\n  refusing to write an invalid manifest:\n`));
    for (const e of check.errors) process.stderr.write(`    ${e.where} ${e.message}\n`);
    return 1;
  }

  // Every quote was read out of the live page moments ago, so presence is true
  // by construction. Recording that costs nothing and saves every consumer a
  // refetch they would otherwise have to make blind.
  stampVerification(res.manifest, { stats: { evidence: countEvidence(res.manifest), textPresent: countEvidence(res.manifest) }, seen: allPresent(res.manifest) },
    { method: 'generated-from-source', recheckIntervalDays: cfg.recheckIntervalDays ?? 7 });

  const json = JSON.stringify(res.manifest, null, 2) + '\n';
  const targets = args.flags.out
    ? [args.flags.out]
    : args.flags['no-alias'] ? [WELL_KNOWN_PATH] : [WELL_KNOWN_PATH, ALIAS_PATH];
  for (const t of targets) {
    fs.mkdirSync(path.dirname(path.resolve(t)), { recursive: true });
    fs.writeFileSync(t, json);
  }
  process.stderr.write(`\n  wrote ${C.bold(targets.join(' and '))} — ${res.manifest.claims.length} claims, ${(Buffer.byteLength(json) / 1024).toFixed(1)} KiB\n`);
  if (res.pinned) process.stderr.write(C.dim(`  ${res.pinned} pinned claim(s) kept from the config\n`));
  const v = res.manifest.manifest.verification;
  process.stderr.write(C.dim(`  ${v.evidence_present}/${v.evidence_total} quotes read from the live pages and confirmed present\n`));
  process.stderr.write(C.dim(`  what a human adds: which claims matter, and whether the types are right\n`));
  process.stderr.write(C.dim(`  serve it at ${new URL('/' + WELL_KNOWN_PATH, cfg.site)}\n\n`));
  for (const e of res.errors) process.stderr.write(C.yellow(`  skipped ${e.url}: ${e.error}\n`));
  if (res.clientRendered.length) {
    process.stderr.write(C.yellow(`\n  ${res.clientRendered.length} page(s) returned no claims and look client-rendered:\n`));
    for (const p of res.clientRendered.slice(0, 5)) process.stderr.write(C.dim(`    ${p.url} — ${p.reasons[0]}\n`));
    process.stderr.write(C.dim(`  Fetching cannot see content assembled in the browser. Point the config at\n  server-rendered URLs, or generate from your build output.\n`));
  }
  return 0;
}

function countEvidence(m) { return m.claims.reduce((n, c) => n + c.evidence.length, 0); }
function allPresent(m) {
  const out = [];
  m.claims.forEach((c, ci) => c.evidence.forEach((_, ei) => out.push({ ci, ei, present: true })));
  return out;
}

async function cmdRepair(args) {
  const target = args._[1];
  if (!target || isUrl(target)) {
    process.stderr.write(C.red('error: repair needs a local manifest file to rewrite\n'));
    return 2;
  }
  let raw, source;
  try { ({ raw, source } = await readManifest(target)); }
  catch (e) { process.stderr.write(C.red(`error: ${e.message}\n`)); return 2; }
  let parsed;
  try { parsed = parseManifest(raw); }
  catch (e) { process.stderr.write(C.red(`error: ${e.message}\n`)); return 1; }

  process.stdout.write(`\n${C.bold(source)}\n\n`);
  const res = await repairManifest(parsed.manifest, {
    threshold: args.flags.threshold ? Number(args.flags.threshold) : undefined,
    prune: !!args.flags.prune,
    onEvent: e => {
      if (e.kind === 'relocated') {
        process.stdout.write(`  ${C.yellow('relocated')} ${e.where} ${C.dim(`(overlap ${e.score})`)}\n`);
        process.stdout.write(C.dim(`     was: ${e.before.slice(0, 84)}\n     now: ${e.after.slice(0, 84)}\n`));
      } else if (e.kind === 'lost') {
        process.stdout.write(`  ${C.red('lost')}      ${e.where} ${C.dim('no sufficiently similar text on the page')}\n`);
        process.stdout.write(C.dim(`     was: ${e.text.slice(0, 84)}\n`));
      } else if (e.kind === 'unreachable') {
        process.stdout.write(`  ${C.red('unreachable')} ${e.where} ${C.dim(e.reason)}\n`);
      } else if (e.kind === 'claims-dropped') {
        process.stdout.write(`  ${C.red('dropped')}   ${e.count} claim(s) left with no evidence\n`);
      }
    }
  });

  const c = res.counts;
  process.stdout.write(`\n  ${c.present ?? 0} present · ${c.relocated ?? 0} relocated · ${c.lost ?? 0} lost · ${c.unreachable ?? 0} unreachable\n`);

  if (args.flags['dry-run']) {
    process.stdout.write(C.dim('  --dry-run: nothing written\n\n'));
    return (c.lost || c.unreachable) ? 1 : 0;
  }

  const after = await validateManifest(res.manifest, { offline: false });
  stampVerification(res.manifest, after, { method: 'automated-recheck' });
  fs.writeFileSync(path.resolve(target), JSON.stringify(res.manifest, null, 2) + '\n');
  const v = res.manifest.manifest.verification;
  process.stdout.write(`  wrote ${C.bold(target)} — ${v.evidence_present}/${v.evidence_total} confirmed present\n`);
  if (c.lost && !args.flags.prune) process.stdout.write(C.dim(`  ${c.lost} unconfirmed entr(ies) kept without last_seen; use --prune to remove them\n`));
  process.stdout.write('\n');
  return after.errors.length ? 1 : 0;
}

async function cmdCheck(args) {
  const target = args._[1];
  if (!args.flags.update) return cmdValidate({ ...args, flags: { ...args.flags, online: true, offline: false } });

  if (!target || isUrl(target)) {
    process.stderr.write(C.red('error: --update needs a local file to write back to\n'));
    return 2;
  }
  let raw, source;
  try { ({ raw, source } = await readManifest(target)); }
  catch (e) { process.stderr.write(C.red(`error: ${e.message}\n`)); return 2; }

  let parsed;
  try { parsed = parseManifest(raw); }
  catch (e) { process.stderr.write(C.red(`error: ${e.message}\n`)); return 1; }

  const result = await validateManifest(parsed.manifest, { offline: false, strict: !!args.flags.strict, rawBytes: parsed.bytes });
  stampVerification(parsed.manifest, result, {
    method: 'automated-recheck',
    recheckIntervalDays: args.flags.interval ? Number(args.flags.interval) : undefined
  });
  fs.writeFileSync(path.resolve(target), JSON.stringify(parsed.manifest, null, 2) + '\n');

  report(result, source, !!args.flags.json);
  const v = parsed.manifest.manifest.verification;
  process.stdout.write(C.dim(`  recorded in ${target}: ${v.evidence_present}/${v.evidence_total} present at ${v.checked_at}\n\n`));
  return result.valid ? 0 : 1;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (!cmd || args.flags.help || cmd === 'help') { process.stdout.write(USAGE); process.exit(cmd ? 0 : 2); }
const handlers = { init: cmdInit, generate: cmdGenerate, validate: cmdValidate, extract: cmdExtract, check: cmdCheck, repair: cmdRepair };
if (!handlers[cmd]) { process.stderr.write(C.red(`unknown command: ${cmd}\n\n`) + USAGE); process.exit(2); }
process.exit(await handlers[cmd](args));
