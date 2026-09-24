#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { validateManifest, parseManifest, LIMITS } from '../reference-implementation/validate.js';
import { extractFromSite, extractFromPage, toManifest } from '../reference-implementation/extract.js';
import { fetchSafe, FetchRefused, normalizeInputUrl } from '../reference-implementation/fetch-safe.js';
import { loadConfig, writeConfig, initConfig, generate, CONFIG_FILENAME } from '../reference-implementation/config.js';

const C = process.stdout.isTTY
  ? { red: s => `\x1b[31m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m` }
  : { red: s => s, yellow: s => s, green: s => s, dim: s => s, bold: s => s };

const USAGE = `ai-evidence — reference tooling for the AI Evidence Manifest

Usage:
  ai-evidence init <url>            Create ai-evidence.config.json for a site
  ai-evidence generate              Read the config, find evidence, write ai.json
  ai-evidence validate <file|url>   Validate a manifest
  ai-evidence check <file|url>      Re-check that evidence is still present at source
  ai-evidence extract <url>         One-shot generate without a config file

Typical use:
  ai-evidence init https://example.com
  ai-evidence generate              # writes ai.json — commit it, serve it at /ai.json

Validate options:
  --offline        Do not fetch evidence URLs (default for local files)
  --online         Fetch evidence URLs (default when validating a URL)
  --strict         Treat warnings as failures
  --json           Machine-readable output

Generate options:
  --config <file>  Config to read (default ai-evidence.config.json)
  --out <file>     Manifest to write (default ai.json)

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
      if (['out', 'max-pages', 'per-type', 'config'].includes(key)) out.flags[key] = argv[++i];
      else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

const isUrl = s => /^https?:\/\//i.test(s);

async function readManifest(target) {
  if (isUrl(target)) {
    const res = await fetchSafe(target, { accept: 'application/json' });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} fetching ${target}`);
    if (!/json/i.test(res.contentType)) {
      process.stderr.write(C.yellow(`warning: ${target} served as "${res.contentType || 'no content-type'}"; expected application/json\n`));
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
    onPage: (u, n, err) => process.stderr.write(`  ${String(n).padStart(3)}  ${err ? C.yellow(err.slice(0, 60)) + ' ' : ''}${C.dim(u)}\n`)
  });

  const check = await validateManifest(res.manifest, { offline: true });
  if (!check.valid) {
    process.stderr.write(C.red(`\n  refusing to write an invalid manifest:\n`));
    for (const e of check.errors) process.stderr.write(`    ${e.where} ${e.message}\n`);
    return 1;
  }

  const json = JSON.stringify(res.manifest, null, 2) + '\n';
  fs.writeFileSync(out, json);
  process.stderr.write(`\n  wrote ${C.bold(out)} — ${res.manifest.claims.length} claims, ${(Buffer.byteLength(json) / 1024).toFixed(1)} KiB\n`);
  if (res.pinned) process.stderr.write(C.dim(`  ${res.pinned} pinned claim(s) kept from the config\n`));
  process.stderr.write(C.dim(`  found claims are marked automatically-generated; review before relying on them\n`));
  process.stderr.write(C.dim(`  serve it at ${new URL('/ai.json', cfg.site)}\n\n`));
  for (const e of res.errors) process.stderr.write(C.yellow(`  skipped ${e.url}: ${e.error}\n`));
  return 0;
}

async function cmdCheck(args) {
  return cmdValidate({ ...args, flags: { ...args.flags, online: true, offline: false } });
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (!cmd || args.flags.help || cmd === 'help') { process.stdout.write(USAGE); process.exit(cmd ? 0 : 2); }
const handlers = { init: cmdInit, generate: cmdGenerate, validate: cmdValidate, extract: cmdExtract, check: cmdCheck };
if (!handlers[cmd]) { process.stderr.write(C.red(`unknown command: ${cmd}\n\n`) + USAGE); process.exit(2); }
process.exit(await handlers[cmd](args));
