// Protocol fixtures, not a substitute for the real-host experiment.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'artifacts', `fixtures-${Date.now()}`);
await mkdir(out, { recursive: true });
const report = [];
for (const [index, language] of ['go', 'javascript', 'python'].entries()) {
  const port = 18300 + index;
  const exe = language === 'go' ? join(root, 'bin/handler.exe') : language === 'javascript' ? process.execPath : process.env.BLOG_PYTHON;
  const args = language === 'go' ? [] : [join(root, language, language === 'python' ? 'handler.py' : 'handler.mjs')];
  const capture = join(out, `${language}.jsonl`);
  const child = spawn(exe, args, { env: { ...process.env, FUNCTIONS_CUSTOMHANDLER_PORT: String(port), CAPTURE_PATH: capture, AzureWebJobsStorage: '', BLOG_CONTAINER: '' }, stdio: 'ignore' });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      if (child.exitCode !== null) throw Error(`${language} exited`);
      try { ready = (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (!ready) await delay(100);
    }
    assert(ready);
    const body = Buffer.from('héllo\n');
    const descriptor = { Source: 'AzureStorageBlobs', Version: '1.0', Content: { Length: 100, MediaType: 'application/json' }, ContentType: 'application/json' };
    const cases = [
      ['BlobBody', { Data: { blob: body.toString('base64') }, Metadata: { note: 'héllo 🌻', Uri: JSON.stringify('http://127.0.0.1/account/blog/size-37.txt') } }, 200, 7],
      ['BlobMetadata', { Data: { blob: descriptor }, Metadata: { Uri: JSON.stringify('http://127.0.0.1/account/blog/size-37.txt') } }, 200, 0],
      ['BlobMetadata', { Data: { blob: descriptor }, Metadata: {} }, 500, 0],
      ['BlobDeferred', { Data: { blob: descriptor }, Metadata: { Uri: 'https://untrusted.invalid/blog/size-37.txt' } }, 500, 0],
      ['ReadDeferred', { Data: { blob: descriptor }, Metadata: {} }, 200, 0],
      ['QueueBody', { Data: { item: 'hello' }, Metadata: {} }, 200, 5],
      ['BlobBody', null, 500, 0],
    ];
    for (const [name, envelope, status, bytes] of cases) {
      const wire = envelope === null ? '{broken' : JSON.stringify(envelope);
      if (name === 'BlobBody' && status === 200) assert.notEqual(Buffer.byteLength(wire), wire.length, 'fixture must distinguish UTF-8 bytes from characters');
      const response = await fetch(`http://127.0.0.1:${port}/${name}`, { method: 'POST', body: wire, signal: AbortSignal.timeout(10000) });
      await response.text();
      assert.equal(response.status, status, `${language} ${name} status`);
      const rows = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
      const row = rows.at(-1);
      assert.equal(row.invocationBytes, Buffer.byteLength(wire), 'UTF-8 invocation byte accounting');
      assert.equal(row.bytesRead, bytes);
      if (name === 'BlobBody' && status === 200) assert.equal(row.sha256, createHash('sha256').update(body).digest('hex'));
      if (name === 'BlobMetadata' && status === 200) assert.equal(row.caseId, 'size-37.txt');
      assert.equal(Boolean(row.error), status === 500);
      report.push({ language, function: name, status, invocationBytes: row.invocationBytes, passed: true });
    }
  } finally {
    if (child.exitCode === null) {
      if (process.platform === 'win32') assert.equal(spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).status, 0);
      else child.kill('SIGTERM');
    }
  }
}
await writeFile(join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`PASS ${report.length} cross-language protocol fixtures. Evidence: ${out}`);