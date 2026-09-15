// Local-only experiment. Runs real Functions listeners, never an Azure account.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { BlobServiceClient } from '@azure/storage-blob';
import { QueueServiceClient } from '@azure/storage-queue';
import { buildSummary, MEASUREMENTS, PROVENANCE_FILES } from './evidence-summary.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const handlerFile = process.platform === 'win32' ? 'bin/handler.exe' : 'bin/handler';
const runDir = join(root, 'artifacts', new Date().toISOString().replaceAll(':', '-'));
await mkdir(runDir, { recursive: true });
const func = process.env.BLOG_FUNC;
const azurite = process.env.BLOG_AZURITE;
const python = process.env.BLOG_PYTHON;
assert(func && azurite && python, 'Set BLOG_FUNC, BLOG_AZURITE and BLOG_PYTHON to executable paths.');
const children = new Set();
// Fail rather than accidentally querying somebody else's local host.
for (const port of [18100, 18101, 18102, 18200]) {
  await new Promise((done, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(done));
  });
}
function launch(exe, args, cwd, env, name) {
  const child = spawn(exe, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
  children.add(child);
  child.stdout.pipe(createWriteStream(join(runDir, `${name}.stdout.log`)));
  child.stderr.pipe(createWriteStream(join(runDir, `${name}.stderr.log`)));
  child.on('error', e => console.error(`${name} process failed: ${e.code}`));
  return child;
}
function stop(child) {
  if (!child || !children.has(child)) return;
  if (process.platform === 'win32' && child.exitCode === null) {
    const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    assert.equal(killed.status, 0, 'Failed to stop the experiment process tree');
  }
  else child.kill('SIGTERM');
  children.delete(child);
}
const digest = b => createHash('sha256').update(b).digest('hex');
async function records(path) {
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}
async function until(check, label, child, ms = 150000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw Error(`${label}: process exited ${child.exitCode}`);
    if (await check()) return;
    await delay(500);
  }
  throw Error(`Timed out: ${label}`);
}
async function jsonFile(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n');
}
function captureCommand(exe, args, label) {
  const captured = spawnSync(exe, args, { encoding: 'utf8' });
  assert(!captured.error && captured.status === 0, `Could not collect ${label}. Check the supplied executable and rerun.`);
  assert(captured.stdout?.trim(), `Missing ${label} output. Check the supplied executable and rerun.`);
  return captured.stdout.trim();
}
async function installedPackage(entry, name) {
  // Resolve symlinks, then find the owning package, not a parent CLI's version.
  let directory = dirname(await realpath(resolve(entry)));
  while (true) {
    const path = join(directory, 'package.json');
    if (existsSync(path)) {
      const pkg = JSON.parse(await readFile(path, 'utf8'));
      if (pkg.name === name) {
        assert(typeof pkg.version === 'string' && pkg.version.length > 0, `Missing installed ${name} version.`);
        return pkg.version;
      }
    }
    const parent = dirname(directory);
    assert(parent !== directory, `Cannot locate installed ${name} package metadata. Supply its real script and install dependencies before rerunning.`);
    directory = parent;
  }
}
const results = [];
const duplicates = [];
// The randomly generated key belongs only to this disposable local emulator.
const account = 'blogaccount';
const key = randomBytes(32).toString('base64');
const connection = `DefaultEndpointsProtocol=http;AccountName=${account};AccountKey=${key};BlobEndpoint=http://127.0.0.1:18100/${account};QueueEndpoint=http://127.0.0.1:18101/${account};TableEndpoint=http://127.0.0.1:18102/${account};`;
let runError;
try {
  const emulator = launch(process.execPath, [azurite, '--silent', '--skipApiVersionCheck', '--location', join(runDir, 'storage'), '--blobPort', '18100', '--queuePort', '18101', '--tablePort', '18102'], root, { AZURITE_ACCOUNTS: `${account}:${key}` }, 'azurite');
  const blobs = BlobServiceClient.fromConnectionString(connection);
  const queues = QueueServiceClient.fromConnectionString(connection);
  await until(async () => {
    try { await blobs.getProperties(); return true; } catch { return false; }
  }, 'Azurite readiness', emulator, 30000);

  for (const language of ['go', 'javascript', 'python']) {
    const appDir = join(runDir, language);
    const capture = join(appDir, 'captures.jsonl');
    const container = `blog-${language}`;
    const queueBody = `body-${language}`;
    const queueDeferred = `deferred-${language}`;
    await blobs.getContainerClient(container).create();
    await queues.getQueueClient(queueBody).create();
    await queues.getQueueClient(queueDeferred).create();
    const exe = language === 'go' ? join(root, handlerFile) : language === 'javascript' ? process.execPath : python;
    const args = language === 'go' ? [] : [join(root, language, language === 'python' ? 'handler.py' : 'handler.mjs')];
    await jsonFile(join(appDir, 'host.json'), {
      version: '2.0', extensionBundle: { id: 'Microsoft.Azure.Functions.ExtensionBundle', version: '[4.34.0, 4.35.0)' },
      customHandler: { description: { defaultExecutablePath: exe, arguments: args }, enableForwardingHttpRequest: false },
      extensions: { queues: { maxPollingInterval: '00:00:01', batchSize: 1 }, blobs: { maxDegreeOfParallelism: 1 } },
      logging: { logLevel: { default: 'Information' } },
    });
    for (const [name, deferred] of [['BlobBody', false], ['BlobDeferred', true], ['BlobMetadata', true]]) {
      await jsonFile(join(appDir, name, 'function.json'), { bindings: [{ name: 'blob', type: 'blobTrigger', direction: 'in', dataType: 'binary', path: `${container}/{name}`, connection: 'AzureWebJobsStorage', properties: { supportsDeferredBinding: deferred } }] });
    }
    for (const [name, route, deferred] of [['ReadBody', 'body', false], ['ReadDeferred', 'deferred', true]]) {
      await jsonFile(join(appDir, name, 'function.json'), { bindings: [
        { name: 'req', type: 'httpTrigger', direction: 'in', authLevel: 'anonymous', methods: ['get'], route: `${route}/{name}` },
        { name: 'blob', type: 'blob', direction: 'in', dataType: 'binary', path: `${container}/{name}`, connection: 'AzureWebJobsStorage', properties: { supportsDeferredBinding: deferred } },
        { name: 'res', type: 'http', direction: 'out' },
      ] });
    }
    for (const [name, queueName, deferred] of [['QueueBody', queueBody, false], ['QueueDeferred', queueDeferred, true]]) {
      await jsonFile(join(appDir, name, 'function.json'), { bindings: [{ name: 'item', type: 'queueTrigger', direction: 'in', queueName, connection: 'AzureWebJobsStorage', properties: { supportsDeferredBinding: deferred } }] });
    }
    const port = 18200;
    const host = launch(func, ['start', '--port', String(port), '--no-build', '--verbose'], appDir, {
      FUNCTIONS_WORKER_RUNTIME: 'custom', AzureWebJobsStorage: connection, BLOG_CONTAINER: container,
      CAPTURE_PATH: capture, AzureFunctionsWebHost__hostid: `deferred-blog-${language}`,
      FUNCTIONS_WORKER_PROCESS_COUNT: '1', AZURE_LOG_LEVEL: '',
    }, `host-${language}`);
    await until(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/admin/host/status`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) return false;
        const status = await r.json();
        return status.id === `deferred-blog-${language}` && status.state === 'Running';
      } catch { return false; }
    }, `${language} Functions host readiness`, host);
    for (const size of [37, 1024 * 1024, 8 * 1024 * 1024]) {
      const payload = Buffer.alloc(size, 'x');
      payload.write('HELLO');
      const name = `size-${size}.txt`;
      const before = (await records(capture)).length;
      await blobs.getContainerClient(container).getBlockBlobClient(name).uploadData(payload, { blobHTTPHeaders: { blobContentType: 'text/plain' } });
      await until(async () => {
        const rows = (await records(capture)).slice(before);
        const bad = rows.find(r => r.error);
        if (bad) throw Error(`${language}/${bad.function}: ${bad.error}`);
        return ['BlobBody', 'BlobDeferred', 'BlobMetadata'].every(f => rows.some(r => r.function === f && r.caseId === name));
      }, `${language} blob triggers size ${size}`, host);
      const candidates = (await records(capture)).slice(before).filter(r => r.function.startsWith('Blob') && r.caseId === name);
      const rows = ['BlobBody', 'BlobDeferred', 'BlobMetadata'].map(f => candidates.find(r => r.function === f));
      duplicates.push(...candidates.filter(r => !rows.includes(r)));
      for (const r of rows) {
        if (r.function === 'BlobBody') { assert.equal(r.bytesRead, size); assert.equal(r.sha256, digest(payload)); }
        if (r.function === 'BlobDeferred') { assert.equal(r.bytesRead, 5); assert.equal(r.sha256, digest(Buffer.from('HELLO'))); assert(r.uriPresent); }
        if (r.function === 'BlobMetadata') { assert.equal(r.bytesRead, 0); assert(r.uriPresent); }
        if (r.function === 'BlobBody') assert(r.invocationBytes >= 4 * Math.ceil(size / 3));
        else { assert.equal(r.source, 'AzureStorageBlobs'); assert(r.invocationBytes > 200 && r.invocationBytes < 4096); }
        assert.equal(r.error, '');
        results.push({ blobBytes: size, ...r });
      }
      for (const route of ['body', 'deferred']) {
        const n = (await records(capture)).length;
        const res = await fetch(`http://127.0.0.1:${port}/api/${route}/${name}`, { signal: AbortSignal.timeout(30000) });
        assert.equal(res.status, 200, `${language} ${route} input HTTP status`);
        await res.text();
        const entries = (await records(capture)).slice(n).filter(r => r.function === (route === 'body' ? 'ReadBody' : 'ReadDeferred'));
        assert.equal(entries.length, 1);
        if (route === 'body') { assert.equal(entries[0].bytesRead, size); assert.equal(entries[0].sha256, digest(payload)); }
        else { assert.equal(entries[0].source, 'AzureStorageBlobs'); assert.equal(entries[0].uriPresent, false); }
        results.push({ blobBytes: size, ...entries[0] });
      }
      await jsonFile(join(runDir, 'results.json'), results);
      console.log(`${language}: ${size} byte blob, three triggers and two input bindings passed`);
    }
    const before = (await records(capture)).length;
    for (const q of [queueBody, queueDeferred]) await queues.getQueueClient(q).sendMessage(Buffer.from('HELLO queue').toString('base64'));
    await until(async () => {
      const rows = (await records(capture)).slice(before);
      const bad = rows.find(r => r.error);
      if (bad) throw Error(`${language}/${bad.function}: ${bad.error}`);
      return ['QueueBody', 'QueueDeferred'].every(f => rows.some(r => r.function === f));
    }, `${language} queue triggers`, host);
    const queueRows = (await records(capture)).slice(before).filter(r => r.function.startsWith('Queue'));
    for (const f of ['QueueBody', 'QueueDeferred']) {
      const row = queueRows.find(r => r.function === f);
      assert(row);
      assert.equal(row.error, '');
      if (f === 'QueueBody') { assert.equal(row.bytesRead, 11); assert.equal(row.sha256, digest(Buffer.from('HELLO queue'))); }
      else { assert.equal(row.source, 'AzureStorageQueues'); assert.equal(row.bindingKind, 'object'); assert(row.contentKeys.includes('Length')); }
      results.push(row);
    }
    const all = await records(capture);
    assert(all.every(r => !r.error && r.invocationBytes > 0 && r.language === language));
    await jsonFile(join(runDir, 'results.json'), results);
    stop(host);
    console.log(`${language}: queue control and deferred observation captured`);
  }
  assert.equal(results.length, 51);
  await jsonFile(join(runDir, 'duplicates.json'), duplicates);
  const provenance = {};
  for (const file of [...PROVENANCE_FILES, handlerFile]) {
    provenance[file] = digest(await readFile(join(root, file)));
  }
  const hostLog = await readFile(join(runDir, 'host-go.stdout.log'), 'utf8');
  const bundleVersions = hostLog.split(/\r?\n/).filter(line => line.includes('Loading extension bundle from '))
    .map(line => line.match(/[\\/]([^\\/\s'"]+)[\\/]bin[\\/]?['"]?\s*$/)?.[1]);
  assert(bundleVersions.length > 0 && bundleVersions.every(value => value && value === bundleVersions[0]), 'Cannot identify one loaded bundle version from host stdout. Retain the logs and rerun with verbose logging.');
  const handlerRequire = createRequire(join(root, 'javascript', 'handler.mjs'));
  const runnerRequire = createRequire(import.meta.url);
  const manifest = {
    completed: true, recordedAt: new Date().toISOString(), platform: process.platform,
    node: process.version, func: captureCommand(func, ['--version'], 'Core Tools version'),
    go: captureCommand('go', ['version'], 'Go version'),
    python: captureCommand(python, ['--version'], 'Python version'),
    bundleRequested: '[4.34.0, 4.35.0)', blobSizes: [37, 1048576, 8388608], results: results.length,
    bundleLoaded: bundleVersions[0],
    azurite: await installedPackage(azurite, 'azurite'),
    javascriptPackages: {
      '@azure/storage-blob': await installedPackage(handlerRequire.resolve('@azure/storage-blob'), '@azure/storage-blob'),
      '@azure/storage-queue': await installedPackage(runnerRequire.resolve('@azure/storage-queue'), '@azure/storage-queue'),
    },
    provenance, goBuild: captureCommand('go', ['version', '-m', join(root, handlerFile)], 'Go binary build metadata'),
    hostRuntime: hostLog.match(/Function Runtime Version: (\S+)/)?.[1],
    extensions: hostLog.split('\n').filter(l => /Loaded extension 'AzureStorage(Blobs|Queues)'/.test(l)).map(l => l.trim()),
    pythonPackages: JSON.parse(captureCommand(python, ['-c', 'import importlib.metadata as metadata, json; print(json.dumps([{"name": d.metadata["Name"], "version": d.version} for d in metadata.distributions()]))'], 'Python distribution metadata')),
    measurements: MEASUREMENTS,
  };
  buildSummary(manifest, results); // Fail closed before marking this run publishable.
  await jsonFile(join(runDir, 'manifest.json'), manifest);
  console.log(`PASS ${results.length} observations. Evidence: ${runDir}`);
} catch (error) {
  runError = error;
  throw error;
} finally {
  const cleanupErrors = [];
  for (const child of [...children]) {
    try { stop(child); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(runError ? [runError, ...cleanupErrors] : cleanupErrors, 'Experiment cleanup failed after attempting every owned child stop.');
  }
}