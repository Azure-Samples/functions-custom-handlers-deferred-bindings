import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSummary } from './evidence-summary.mjs';

function fixture() {
  const provenance = Object.fromEntries([
    'run.mjs', 'publish-evidence.mjs', 'evidence-summary.mjs', 'package-lock.json',
    'go/main.go', 'go/storage.go', 'go/go.mod', 'go/go.sum', 'bin/handler.exe',
    'javascript/handler.mjs', 'python/handler.py', 'python/requirements.txt',
  ].map(file => [file, 'a'.repeat(64)]));
  const manifest = {
    completed: true, recordedAt: '2026-09-15T12:00:00.000Z', platform: 'win32',
    func: '4.13.1', hostRuntime: '4.2000.100.12345', bundleRequested: '[4.34.0, 4.35.0)',
    bundleLoaded: '4.40.2', azurite: '3.40.1',
    go: 'go version go1.27.1 windows/amd64', node: 'v24.1.2', python: 'Python 3.14.2',
    blobSizes: [37, 1048576, 8388608], results: 51, provenance,
    extensions: [
      "[2026-09-15T12:00:00Z] Loaded extension 'AzureStorageBlobs' (5.9.1)",
      "[2026-09-15T12:00:00Z] Loaded extension 'AzureStorageQueues' (5.8.2)",
    ],
    goBuild: `C:\\private\\handler.exe: go1.27.1\n\tpath\texample.com/private\n\tdep\tgithub.com/Azure/azure-sdk-for-go/sdk/storage/azblob\tv1.10.3\th1:${'a'.repeat(43)}=\n\tdep\tprivate.example/unused\tv9.9.9\th1:unused\n\tbuild\t-trimpath=true\n`,
    javascriptPackages: { '@azure/storage-blob': '12.40.1', '@azure/storage-queue': '12.39.2' },
    pythonPackages: [{ name: 'Zed_Package', version: '2.0.0' }, { name: 'azure-storage-blob', version: '12.41.3' }],
    measurements: 'HTTP invocation body bytes; application bytes consumed; hashes. Not RSS, network capture or throughput.',
  };
  const results = ['go', 'javascript', 'python'].flatMap(language => {
    const row = (name, size) => {
      const body = name.endsWith('Body');
      const bytesRead = body ? (size ?? 11) : name === 'BlobDeferred' ? 5 : 0;
      return {
        ...(size === undefined ? {} : { blobBytes: size }), language, function: name,
        caseId: name.startsWith('Blob') ? `size-${size}.txt` : '', invocationBytes: 1500,
        bindingKind: body ? 'string' : 'object',
        source: body ? '' : name.startsWith('Queue') ? 'AzureStorageQueues' : 'AzureStorageBlobs',
        contentKeys: body ? [] : ['IsEmpty', 'Length', 'MediaType'], uriPresent: name.startsWith('Blob'),
        bytesRead, sha256: bytesRead ? 'b'.repeat(64) : '', error: '',
      };
    };
    return [
      ...[37, 1048576, 8388608].flatMap(size => ['BlobBody', 'BlobDeferred', 'BlobMetadata', 'ReadBody', 'ReadDeferred'].map(name => row(name, size))),
      ...['QueueBody', 'QueueDeferred'].map(name => row(name)),
    ];
  });
  return { manifest, results };
}

function rejectChange(change, expected = /Cannot export evidence:.*Rerun the experiment/) {
  const data = fixture();
  change(data);
  assert.throws(() => buildSummary(data.manifest, data.results), expected);
}

test('reflects actual alternate versions while preserving the published environment and SDK shape', () => {
  const { manifest, results } = fixture();
  const summary = buildSummary(manifest, results);
  assert.deepEqual(summary.environment, {
    platform: 'win32', coreTools: '4.13.1', hostRuntime: '4.2000.100.12345', bundle: '4.40.2',
    storageBlobs: '5.9.1', storageQueues: '5.8.2', azurite: '3.40.1',
    go: 'go version go1.27.1 windows/amd64', node: 'v24.1.2', python: 'Python 3.14.2',
  });
  assert.deepEqual(summary.handlerSDKs, {
    goAzblob: '1.10.3', javascriptStorageBlob: '12.40.1', javascriptStorageQueue: '12.39.2', pythonStorageBlob: '12.41.3',
  });
  assert.deepEqual(summary.pythonPackages, ['azure-storage-blob==12.41.3', 'zed-package==2.0.0']);
  assert.equal(summary.results.length, 51);
  assert.deepEqual(summary.results, results);
  assert.deepEqual(Object.keys(summary), ['recordedAt', 'environment', 'scope', 'provenance', 'pythonPackages', 'handlerSDKs', 'results']);
  assert.deepEqual(summary.provenance, manifest.provenance);
});

test('is deterministic without mutating or aliasing input objects', () => {
  const { manifest, results } = fixture();
  const original = structuredClone({ manifest, results });
  const freeze = value => {
    if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(manifest);
  freeze(results);
  const first = buildSummary(manifest, results);
  assert.deepEqual(first, buildSummary(manifest, results));
  assert.deepEqual({ manifest, results }, original);
  first.results[1].contentKeys.push('not-input');
  first.results[0].language = 'changed';
  first.provenance['run.mjs'] = 'changed';
  assert.deepEqual({ manifest, results }, original);
});

for (const field of [
  'recordedAt', 'platform', 'func', 'hostRuntime', 'bundleLoaded', 'azurite', 'go', 'node', 'python',
  'extensions', 'goBuild', 'javascriptPackages', 'pythonPackages', 'measurements', 'provenance', 'blobSizes', 'results',
]) {
  test(`refuses missing actual metadata: ${field}`, () => {
    rejectChange(({ manifest }) => { delete manifest[field]; });
  });
}

test('old manifest cannot fall back to requested, pinned or guessed installed versions', () => {
  rejectChange(({ manifest }) => {
    delete manifest.bundleLoaded;
    delete manifest.azurite;
    delete manifest.javascriptPackages;
    manifest.pythonPackages = ['azure-storage-blob==12.30.1'];
  }, /missing loaded bundle version.*Rerun.*Keep historical evidence unchanged/);
});

test('does not pass through locators or extra provenance, package and result fields', () => {
  const { manifest, results } = fixture();
  const secret = 'https://private.example/SECRET?token=SECRET';
  manifest.command = secret;
  manifest.bundleRequested = secret;
  manifest.provenance['C:\\private\\SECRET'] = 'c'.repeat(64);
  manifest.provenance['../SECRET'] = secret;
  manifest.provenance['https://private.example/SECRET'] = secret;
  manifest.provenance['safe-but-not-allowed.txt'] = secret;
  manifest.provenance.__proto__ = { SECRET: secret };
  manifest.javascriptPackages.registry = secret;
  manifest.pythonPackages[0].direct_url = { url: secret };
  manifest.pythonPackages[0].path = 'C:\\private\\SECRET';
  results[0].uri = secret;
  results[0].connectionString = secret;
  results[0].content = { SECRET: secret };
  results[0].metadata = { Uri: secret };
  const serialized = JSON.stringify(buildSummary(manifest, results));
  assert(!serialized.includes('SECRET'));
  assert(!serialized.includes('private'));
  assert(!serialized.includes('direct_url'));
  assert(!serialized.includes('goBuild'));
  assert(!serialized.includes('bundleRequested'));
  assert(!serialized.includes('safe-but-not-allowed'));
});

for (const name of ['pkg @ https://private.example/SECRET', '../SECRET', 'C:\\SECRET', '@scope/pkg', 'pkg\n', '__proto__', '']) {
  test(`rejects an unsafe distribution name ${JSON.stringify(name)} without reflecting it`, () => {
    rejectChange(({ manifest }) => { manifest.pythonPackages[0].name = name; }, error => {
      assert.match(error.message, /Python distribution name/);
      assert(!error.message.includes('SECRET'));
      return true;
    });
  });
}

for (const unsafe of ['https://private.example/SECRET', 'file:///C:/SECRET', '1.2.3 @ https://private.example/SECRET', '../SECRET', '1.2.3\n', '', null]) {
  test(`rejects unsafe versions ${JSON.stringify(unsafe)} at every published version input`, () => {
    const changes = [
      ({ manifest }) => { manifest.func = unsafe; },
      ({ manifest }) => { manifest.hostRuntime = unsafe; },
      ({ manifest }) => { manifest.bundleLoaded = unsafe; },
      ({ manifest }) => { manifest.azurite = unsafe; },
      ({ manifest }) => { manifest.node = `v${unsafe}`; },
      ({ manifest }) => { manifest.python = `Python ${unsafe}`; },
      ({ manifest }) => { manifest.go = `go version go${unsafe} windows/amd64`; },
      ({ manifest }) => { manifest.extensions[0] = `Loaded extension 'AzureStorageBlobs' (${unsafe})`; },
      ({ manifest }) => { manifest.javascriptPackages['@azure/storage-blob'] = unsafe; },
      ({ manifest }) => { manifest.javascriptPackages['@azure/storage-queue'] = unsafe; },
      ({ manifest }) => { manifest.pythonPackages[0].version = unsafe; },
    ];
    // A newline terminates a Go build record rather than being part of its version token.
    if (unsafe !== '1.2.3\n') {
      changes.push(({ manifest }) => { manifest.goBuild = `\tdep\tgithub.com/Azure/azure-sdk-for-go/sdk/storage/azblob\tv${unsafe}\n`; });
    }
    for (const change of changes) {
      rejectChange(change, error => {
        assert.match(error.message, /Cannot export evidence/);
        assert(!error.message.includes('SECRET'));
        return true;
      });
    }
  });
}

test('accepts portable prerelease and local version tokens', () => {
  const { manifest, results } = fixture();
  manifest.azurite = '4.0.0-beta.2';
  manifest.pythonPackages[1].version = '13.0.0rc1.dev2+local.3';
  const summary = buildSummary(manifest, results);
  assert.equal(summary.environment.azurite, '4.0.0-beta.2');
  assert.equal(summary.handlerSDKs.pythonStorageBlob, '13.0.0rc1.dev2+local.3');
});

test('requires unambiguous installed SDKs and loaded extension metadata', () => {
  const changes = [
    ({ manifest }) => { delete manifest.javascriptPackages['@azure/storage-blob']; },
    ({ manifest }) => { delete manifest.javascriptPackages['@azure/storage-queue']; },
    ({ manifest }) => { manifest.pythonPackages = [{ name: 'unrelated', version: '1.0.0' }]; },
    ({ manifest }) => { manifest.pythonPackages.push({ name: 'Azure_Storage.Blob', version: '12.41.3' }); },
    ({ manifest }) => { manifest.pythonPackages = ['pkg @ https://private.example/SECRET']; },
    ({ manifest }) => { manifest.extensions.pop(); },
    ({ manifest }) => { manifest.extensions.push("Loaded extension 'AzureStorageBlobs' (5.9.2)"); },
    ({ manifest }) => { manifest.goBuild = '\tdep\tprivate.example/other\tv1.0.0\n'; },
    ({ manifest }) => { manifest.goBuild += '\tdep\tgithub.com/Azure/azure-sdk-for-go/sdk/storage/azblob\tv1.10.3\n'; },
    ({ manifest }) => { manifest.goBuild = '\tdep\tgithub.com/Azure/azure-sdk-for-go/sdk/storage/azblob\tv1.10.3\thttps://private.example/SECRET\n'; },
    ({ manifest }) => { manifest.goBuild = '\tdep\tgithub.com/Azure/azure-sdk-for-go/sdk/storage/azblob\tv1.10.3\n\t=>\tC:\\SECRET\t(devel)\n'; },
    ({ manifest }) => { manifest.goBuild = '\tdep\tgithub.com/Azure/azure-sdk-for-go/sdk/storage/azblob\tv1.10.3\n\t=>\tprivate.example/fork\tv2.0.0\n'; },
  ];
  changes.forEach(change => rejectChange(change));
});

test('allows identical repeated extension loads but exports only versions', () => {
  const { manifest, results } = fixture();
  manifest.extensions.push(...manifest.extensions);
  assert.equal(buildSummary(manifest, results).environment.storageBlobs, '5.9.1');
});

test('requires portable provenance hashes and supports the selected binary name', () => {
  for (const hash of ['https://private.example/SECRET', 'a'.repeat(63), `${'a'.repeat(64)}\n`, null, {}]) {
    rejectChange(({ manifest }) => { manifest.provenance['run.mjs'] = hash; });
  }
  rejectChange(({ manifest }) => { delete manifest.provenance['bin/handler.exe']; });
  const { manifest, results } = fixture();
  manifest.platform = 'linux';
  manifest.provenance['bin/handler'] = 'd'.repeat(64);
  const summary = buildSummary(manifest, results);
  assert.equal(summary.provenance['bin/handler'], 'd'.repeat(64));
  assert(!Object.hasOwn(summary.provenance, 'bin/handler.exe'));
});

for (const completed of [false, undefined, null, 1, 'true']) {
  test(`refuses incomplete runs marked ${String(completed)}`, () => {
    rejectChange(({ manifest }) => { manifest.completed = completed; }, /completed manifest/);
  });
}

test('requires exactly 51 rows and every unique case, not just a matching count', () => {
  rejectChange(data => { data.results = data.results.slice(0, 50); }, /exactly 51 results/);
  rejectChange(({ results }) => { results.push({ ...results[0] }); }, /exactly 51 results/);
  rejectChange(({ results }) => { results[50] = { ...results[0] }; }, /unique complete result matrix/);
  rejectChange(({ manifest }) => { manifest.results = 50; }, /manifest result count/);
  rejectChange(({ manifest }) => { manifest.blobSizes = [37, 37, 8388608]; }, /manifest blob sizes/);
  const { manifest, results } = fixture();
  assert.equal(buildSummary(manifest, results.reverse()).results.length, 51);
});

test('rejects malformed or unsafe values in every expected result field', () => {
  const changes = [
    row => { row.blobBytes = 42; }, row => { row.language = 'https://private.example/SECRET'; },
    row => { row.function = 'SECRET'; }, row => { row.caseId = 'C:\\SECRET'; },
    row => { row.invocationBytes = '123'; }, row => { row.invocationBytes = 0; },
    row => { row.invocationBytes = Number.MAX_SAFE_INTEGER + 1; }, row => { row.bytesRead = -1; },
    row => { row.bytesRead = NaN; }, row => { row.bindingKind = 'SECRET'; },
    row => { row.source = 'https://private.example/SECRET'; }, row => { row.contentKeys = ['SECRET']; },
    row => { row.contentKeys = ['Length', 'Length']; }, row => { row.uriPresent = 'SECRET'; },
    row => { row.sha256 = 'SECRET'; }, row => { row.error = 'https://private.example/SECRET'; },
  ];
  for (const change of changes) {
    rejectChange(({ results }) => change(results[0]), error => {
      assert.match(error.message, /Cannot export evidence/);
      assert(!error.message.includes('SECRET'));
      return true;
    });
  }
  for (const field of Object.keys(fixture().results[0])) {
    rejectChange(({ results }) => { delete results[0][field]; });
  }
  rejectChange(({ results }) => { results[15].blobBytes = 37; });
  rejectChange(data => { data.results = null; });
  rejectChange(({ results }) => { results[0] = null; });
});

test('does not publish free-text scope, timestamp or runtime output', () => {
  for (const field of ['measurements', 'recordedAt', 'platform', 'func', 'hostRuntime', 'go', 'node', 'python']) {
    rejectChange(({ manifest }) => { manifest[field] = 'https://private.example/SECRET'; });
  }
  rejectChange(({ manifest }) => { manifest.recordedAt = '2026-02-30T12:00:00.000Z'; });
});