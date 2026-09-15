// Export only summaries safe to accompany the article, never raw host logs.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { buildSummary } from './evidence-summary.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2];
const outputName = process.argv[3] || 'results.json';
assert(/^[a-z0-9-]+\.json$/.exec(outputName)?.[0] === outputName, 'Output must be a simple JSON filename');
assert(source, 'Pass a completed artifacts run directory');
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
const results = JSON.parse(await readFile(join(source, 'results.json'), 'utf8'));
const summary = buildSummary(manifest, results);
await mkdir(join(root, 'evidence'), { recursive: true });
await writeFile(join(root, 'evidence', outputName), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(`Exported 51 sanitized observations to evidence/${outputName}`);