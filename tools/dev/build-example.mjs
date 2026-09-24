import fs from 'node:fs';
import { sha256OfText, textFragment } from '../../reference-implementation/normalize.js';

const ev = (url, text, extra = {}) => ({
  url, text,
  ...extra,
  locator: { ...(extra.locator ?? {}), fragment: textFragment(text) },
  integrity: { sha256: sha256OfText(text) },
  source_type: extra.source_type ?? 'first-party',
  authority: extra.authority ?? 'publisher',
  verification: extra.verification ?? { verified: true, verified_at: '2026-09-24', method: 'publisher-confirmed' }
});

const manifest = {
  manifest: {
    version: '2.0.0',
    site: 'https://example.com',
    generated_at: '2026-09-24T09:00:00Z',
    generator: 'ai-evidence/0.1.0',
    language: 'en'
  },
  publisher: {
    name: 'Example Corp',
    url: 'https://example.com',
    same_as: ['https://github.com/example-corp', 'https://www.linkedin.com/company/example-corp']
  },
  claims: [
    {
      id: 'org-identity',
      type: 'organization',
      claim: 'Example Corp is an independent software company registered in Delaware, United States.',
      importance: 'primary',
      evidence: [
        ev('https://example.com/about', 'Example Corp is an independent software company, registered in Delaware and operating since 2019.',
           { title: 'About — Example Corp', locator: { section: 'company-identity' }, published_at: '2024-02-11', modified_at: '2026-06-02' }),
        ev('https://example.com/legal/registration', 'Example Corp, Inc. — Delaware File Number 7741820.',
           { title: 'Registration — Example Corp', locator: { section: 'registration' }, source_type: 'public-record', authority: 'regulator',
             verification: { verified: true, verified_at: '2026-09-24', method: 'externally-verified' } })
      ]
    },
    {
      id: 'capability-document-extraction',
      type: 'capability',
      claim: 'Example Corp extracts structured data from scanned documents without sending them to third parties.',
      importance: 'primary',
      evidence: [ev('https://example.com/platform', 'Our extraction pipeline converts scanned documents into structured records entirely within your own infrastructure.',
        { title: 'Platform — Example Corp', locator: { section: 'extraction' }, modified_at: '2026-08-19' })]
    },
    {
      id: 'capability-on-premise-deployment',
      type: 'capability',
      claim: 'The platform can run fully on-premise with no outbound network access.',
      importance: 'primary',
      evidence: [ev('https://example.com/docs/deployment', 'Example Platform runs in an air-gapped configuration with no outbound network access required.',
        { title: 'Deployment — Example Corp Docs', locator: { section: 'air-gapped' }, modified_at: '2026-07-30' })]
    },
    {
      id: 'product-example-platform',
      type: 'product',
      claim: 'Example Platform is the company’s document-processing product.',
      evidence: [ev('https://example.com/platform', 'Example Platform is our document-processing product for regulated industries.',
        { title: 'Platform — Example Corp', locator: { section: 'overview' } })]
    },
    {
      id: 'service-implementation-support',
      type: 'service',
      claim: 'Example Corp provides implementation support during deployment.',
      evidence: [ev('https://example.com/services', 'We provide hands-on implementation support for the first ninety days of any deployment.',
        { title: 'Services — Example Corp', locator: { section: 'implementation' } })]
    },
    {
      id: 'technical-claim-throughput',
      type: 'technical_claim',
      claim: 'The platform processed 1,200 pages per minute on the published benchmark hardware.',
      evidence: [ev('https://example.com/benchmarks', 'On the reference configuration described below, the platform sustained 1,200 pages per minute across a 10,000-page corpus.',
        { title: 'Benchmarks — Example Corp', locator: { section: 'throughput' }, published_at: '2026-05-04',
          verification: { verified: true, verified_at: '2026-09-24', method: 'manually-reviewed' } })]
    },
    {
      id: 'certification-soc2',
      type: 'certification',
      claim: 'Example Corp holds a SOC 2 Type II report.',
      evidence: [ev('https://example.com/trust', 'Example Corp completed a SOC 2 Type II audit covering security and availability, with the report available under NDA.',
        { title: 'Trust — Example Corp', locator: { section: 'soc2' },
          verification: { verified: true, verified_at: '2026-09-24', method: 'publisher-confirmed' } })]
    }
  ]
};

fs.writeFileSync(new URL('../../examples/ai.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');

const minimal = {
  manifest: { version: '2.0.0', site: 'https://example.com' },
  claims: [{
    id: 'capability-autonomous-ai', type: 'capability',
    claim: 'The company develops autonomous AI systems.',
    evidence: [{
      url: 'https://example.com/research',
      text: 'Our research program develops autonomous AI systems.',
      integrity: { sha256: sha256OfText('Our research program develops autonomous AI systems.') },
      source_type: 'first-party', authority: 'publisher',
      verification: { verified: true, verified_at: '2026-09-24', method: 'publisher-confirmed' }
    }]
  }]
};
fs.writeFileSync(new URL('../../examples/minimal.json', import.meta.url), JSON.stringify(minimal, null, 2) + '\n');
console.log('examples written');
