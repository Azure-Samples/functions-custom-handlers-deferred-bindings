// Publication boundary. Never copy raw manifest objects or diagnostic text out.
export const MEASUREMENTS = 'HTTP invocation body bytes; application bytes consumed; hashes. Not RSS, network capture or throughput.';
export const PROVENANCE_FILES = Object.freeze([
  'run.mjs', 'publish-evidence.mjs', 'evidence-summary.mjs', 'package-lock.json',
  'go/main.go', 'go/storage.go', 'go/go.mod', 'go/go.sum',
  'javascript/handler.mjs', 'python/handler.py', 'python/requirements.txt',
]);
const VERSION = /^\d+(?:\.\d+)*(?:[a-zA-Z][a-zA-Z0-9]*)?(?:[-+._][a-zA-Z0-9]+)*$/;
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const HASH = /^[a-f0-9]{64}$/;
const LANGUAGES = ['go', 'javascript', 'python'];
const SIZES = [37, 1048576, 8388608];
const BLOB_FUNCTIONS = ['BlobBody', 'BlobDeferred', 'BlobMetadata', 'ReadBody', 'ReadDeferred'];
const QUEUE_FUNCTIONS = ['QueueBody', 'QueueDeferred'];
const CONTENT_KEYS = ['IsEmpty', 'Length', 'MediaType'];
const GO_AZBLOB = 'github.com/Azure/azure-sdk-for-go/sdk/storage/azblob';

function requireValue(condition, field) {
  if (!condition) {
    // Do not interpolate untrusted values, even in an error message.
    throw new Error(`Cannot export evidence: invalid or missing ${field}. Rerun the experiment with the updated runner to collect actual metadata and all 51 observations. Keep historical evidence unchanged.`);
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matches(value, pattern) {
  // JS's $ anchor alone also matches before a final newline.
  return typeof value === 'string' && value.length <= 200 && pattern.exec(value)?.[0] === value;
}

function version(value, field) {
  requireValue(matches(value, VERSION), field);
  return value;
}

function loadedExtensions(lines) {
  requireValue(Array.isArray(lines) && lines.length > 0, 'extensions');
  const versions = new Map();
  for (const line of lines) {
    requireValue(typeof line === 'string', 'extensions');
    const match = line.match(/Loaded extension '(AzureStorageBlobs|AzureStorageQueues)' \(([^()\r\n]+)\)\s*$/);
    requireValue(match, 'extensions');
    const value = version(match[2], 'extension version');
    requireValue(!versions.has(match[1]) || versions.get(match[1]) === value, 'consistent extension versions');
    versions.set(match[1], value);
  }
  requireValue(versions.has('AzureStorageBlobs') && versions.has('AzureStorageQueues'), 'both loaded storage extensions');
  return { storageBlobs: versions.get('AzureStorageBlobs'), storageQueues: versions.get('AzureStorageQueues') };
}

function goAzblob(build) {
  requireValue(typeof build === 'string' && build.length > 0, 'goBuild');
  const lines = build.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const dependencies = lines.map(line => line.split(/\s+/));
  const indices = dependencies.flatMap((parts, index) => parts[0] === 'dep' && parts[1] === GO_AZBLOB ? [index] : []);
  requireValue(indices.length === 1, 'one Go azblob build dependency');
  const index = indices[0];
  const parts = dependencies[index];
  // A replacement may be local or another module. Do not claim the original version.
  requireValue(dependencies[index + 1]?.[0] !== '=>', 'unreplaced Go azblob build dependency');
  requireValue((parts.length === 3 || parts.length === 4) && parts[2].startsWith('v'), 'Go azblob build version');
  requireValue(parts.length === 3 || matches(parts[3], /^h1:[A-Za-z0-9+/]{43}=$/), 'Go azblob build checksum');
  return version(parts[2].slice(1), 'Go azblob build version');
}

function pythonDistributions(packages) {
  requireValue(Array.isArray(packages) && packages.length > 0, 'pythonPackages name/version metadata');
  const names = new Set();
  const entries = packages.map(pkg => {
    requireValue(object(pkg) && matches(pkg.name, NAME), 'Python distribution name');
    const name = pkg.name.toLowerCase().replace(/[-_.]+/g, '-');
    requireValue(!names.has(name), 'unique Python distribution names');
    names.add(name);
    return { name, version: version(pkg.version, 'Python distribution version') };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const sdk = entries.find(pkg => pkg.name === 'azure-storage-blob');
  requireValue(sdk, 'installed Python azure-storage-blob');
  return { packages: entries.map(pkg => `${pkg.name}==${pkg.version}`), sdk: sdk.version };
}

function portableProvenance(manifest) {
  requireValue(object(manifest.provenance), 'provenance');
  const files = [...PROVENANCE_FILES, manifest.platform === 'win32' ? 'bin/handler.exe' : 'bin/handler'];
  return Object.fromEntries(files.map(file => {
    const hash = manifest.provenance[file];
    requireValue(matches(hash, HASH), 'provenance SHA-256 hashes for runner sources and binary');
    return [file, hash];
  }));
}

function portableResults(results) {
  requireValue(Array.isArray(results) && results.length === 51, 'exactly 51 results');
  const remaining = new Set(LANGUAGES.flatMap(language => [
    ...SIZES.flatMap(size => BLOB_FUNCTIONS.map(name => `${language}/${name}/${size}`)),
    ...QUEUE_FUNCTIONS.map(name => `${language}/${name}`),
  ]));
  const safe = results.map(row => {
    requireValue(object(row) && LANGUAGES.includes(row.language), 'result language');
    const isBlob = BLOB_FUNCTIONS.includes(row.function);
    requireValue(isBlob || QUEUE_FUNCTIONS.includes(row.function), 'result function');
    requireValue(isBlob ? SIZES.includes(row.blobBytes) : !Object.hasOwn(row, 'blobBytes'), 'result blob size');
    const key = `${row.language}/${row.function}${isBlob ? `/${row.blobBytes}` : ''}`;
    requireValue(remaining.delete(key), 'unique complete result matrix');
    requireValue(row.caseId === (row.function.startsWith('Blob') ? `size-${row.blobBytes}.txt` : ''), 'result caseId');
    requireValue(Number.isSafeInteger(row.invocationBytes) && row.invocationBytes > 0, 'result invocationBytes');
    requireValue(Number.isSafeInteger(row.bytesRead) && row.bytesRead >= 0, 'result bytesRead');
    requireValue(['string', 'object'].includes(row.bindingKind), 'result bindingKind');
    requireValue(['', 'AzureStorageBlobs', 'AzureStorageQueues'].includes(row.source), 'result source');
    requireValue(Array.isArray(row.contentKeys) && row.contentKeys.every(key => CONTENT_KEYS.includes(key)) && new Set(row.contentKeys).size === row.contentKeys.length, 'result contentKeys');
    requireValue(typeof row.uriPresent === 'boolean', 'result uriPresent');
    requireValue(row.sha256 === '' || matches(row.sha256, HASH), 'result sha256');
    requireValue(row.error === '', 'successful results');
    return {
      ...(isBlob ? { blobBytes: row.blobBytes } : {}),
      language: row.language, function: row.function, caseId: row.caseId,
      invocationBytes: row.invocationBytes, bindingKind: row.bindingKind, source: row.source,
      contentKeys: [...row.contentKeys].sort(), uriPresent: row.uriPresent,
      bytesRead: row.bytesRead, sha256: row.sha256, error: '',
    };
  });
  requireValue(remaining.size === 0, 'complete result matrix');
  return safe;
}

export function buildSummary(manifest, results) {
  requireValue(object(manifest) && manifest.completed === true, 'completed manifest');
  requireValue(manifest.results === 51, 'manifest result count');
  requireValue(Array.isArray(manifest.blobSizes) && manifest.blobSizes.length === SIZES.length && SIZES.every(size => manifest.blobSizes.includes(size)), 'manifest blob sizes');
  requireValue(matches(manifest.recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) && Number.isFinite(Date.parse(manifest.recordedAt)) && new Date(manifest.recordedAt).toISOString() === manifest.recordedAt, 'recordedAt');
  requireValue(matches(manifest.platform, /^[a-z][a-z0-9]*$/), 'platform');
  requireValue(manifest.measurements === MEASUREMENTS, 'measurement scope');
  const coreTools = version(manifest.func, 'Core Tools version');
  const hostRuntime = version(manifest.hostRuntime, 'loaded host runtime version');
  const bundle = version(manifest.bundleLoaded, 'loaded bundle version');
  const azurite = version(manifest.azurite, 'installed Azurite version');
  const extensions = loadedExtensions(manifest.extensions);
  requireValue(typeof manifest.node === 'string' && manifest.node.startsWith('v'), 'Node version');
  const node = `v${version(manifest.node.slice(1), 'Node version')}`;
  const go = typeof manifest.go === 'string' && manifest.go.match(/^go version go(\S+) ([a-z][a-z0-9]*)\/([a-z0-9]+)$/);
  requireValue(go && go[0] === manifest.go, 'Go version');
  version(go[1], 'Go version');
  requireValue(typeof manifest.python === 'string' && manifest.python.startsWith('Python '), 'Python version');
  const python = `Python ${version(manifest.python.slice(7), 'Python version')}`;
  requireValue(object(manifest.javascriptPackages), 'installed JavaScript packages');
  const javascriptStorageBlob = version(manifest.javascriptPackages['@azure/storage-blob'], 'installed JavaScript storage-blob');
  const javascriptStorageQueue = version(manifest.javascriptPackages['@azure/storage-queue'], 'installed JavaScript storage-queue');
  const distributions = pythonDistributions(manifest.pythonPackages);
  return {
    recordedAt: manifest.recordedAt,
    environment: { platform: manifest.platform, coreTools, hostRuntime, bundle, ...extensions, azurite, go: `go version go${go[1]} ${go[2]}/${go[3]}`, node, python },
    scope: MEASUREMENTS,
    provenance: portableProvenance(manifest),
    pythonPackages: distributions.packages,
    handlerSDKs: { goAzblob: goAzblob(manifest.goBuild), javascriptStorageBlob, javascriptStorageQueue, pythonStorageBlob: distributions.sdk },
    results: portableResults(results),
  };
}