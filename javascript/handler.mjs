import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { BlobServiceClient } from '@azure/storage-blob';

const failureMessage = 'Invocation failed.';
const functions = new Map([
  ['BlobBody', { binding: 'blob', mode: 'body', blobTrigger: true }],
  ['BlobDeferred', { binding: 'blob', mode: 'download', blobTrigger: true }],
  ['BlobMetadata', { binding: 'blob', mode: 'metadata', blobTrigger: true }],
  ['ReadBody', { binding: 'blob', mode: 'body', http: true }],
  ['ReadDeferred', { binding: 'blob', mode: 'capture', http: true }],
  ['QueueBody', { binding: 'item', mode: 'body' }],
  ['QueueDeferred', { binding: 'item', mode: 'capture' }],
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireCondition(condition) {
  if (!condition) {
    throw new Error(failureMessage);
  }
}

function bindingKind(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function decodeBody(value) {
  requireCondition(typeof value === 'string');
  // Unwrap one host-quoting layer only when it contains another string.
  try {
    const decoded = JSON.parse(value);
    if (typeof decoded === 'string') return decoded;
  } catch {
    // Ordinary text need not be valid JSON.
  }
  return value;
}

function blobCaseId(uri) {
  try {
    const parsed = new URL(uri);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname === '') return '';
    const segment = decodeURIComponent(parsed.pathname).split('/').at(-1);
    const match = /^size-(37|1048576|8388608)\.txt$/.exec(segment);
    return match !== null && match[0] === segment ? segment : '';
  } catch {
    return '';
  }
}

function validatedBlobClient(decodedUri) {
  const uri = new URL(decodedUri);
  const service = BlobServiceClient.fromConnectionString(process.env.AzureWebJobsStorage, {
    retryOptions: { maxTries: 1, tryTimeoutInMs: 15_000 },
    // In 12.33.0 this is forwarded to core-client, but absent from StoragePipelineOptions.
    redirectOptions: { maxRetries: 0 },
  });
  const configured = new URL(service.url);
  const container = process.env.BLOG_CONTAINER;
  requireCondition(typeof container === 'string' && /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(container));
  requireCondition(!container.includes('--'));
  requireCondition(
    (uri.protocol === 'http:' || uri.protocol === 'https:') &&
      uri.protocol === configured.protocol &&
      uri.host === configured.host &&
      uri.username === '' && uri.password === '' &&
      uri.search === '' && uri.hash === '',
  );

  // Azurite's service URL includes the account in its path.
  const prefix = configured.pathname.endsWith('/') ? configured.pathname : `${configured.pathname}/`;
  requireCondition(uri.pathname.startsWith(prefix));
  const relativePath = uri.pathname.slice(prefix.length);
  const separator = relativePath.indexOf('/');
  requireCondition(separator > 0);
  requireCondition(decodeURIComponent(relativePath.slice(0, separator)) === container);
  const blobName = decodeURIComponent(relativePath.slice(separator + 1));
  requireCondition(blobName.length > 0 && !/[\\\u0000-\u001f\u007f]/u.test(blobName));
  requireCondition(!blobName.split('/').some((part) => part === '.' || part === '..'));

  // The incoming URL supplies a name, never credentials or a client endpoint.
  return service.getContainerClient(container).getBlobClient(blobName);
}

function readFiveBytes(stream, record) {
  requireCondition(stream !== undefined && stream !== null);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    function finish(success) {
      if (settled) return;
      settled = true;
      stream.removeListener('readable', readAvailable);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onFailure);
      // Retain the static error handler for errors emitted during destruction.
      stream.destroy();
      if (success) resolve(Buffer.concat(chunks, record.bytesRead));
      else reject(new Error(failureMessage));
    }

    function onFailure() {
      finish(false);
    }

    function onEnd() {
      finish(record.bytesRead === 5);
    }

    function readAvailable() {
      try {
        // One sentinel byte detects a server that ignores the five-byte range.
        while (!settled && record.bytesRead < 6) {
          const chunk = stream.read(6 - record.bytesRead);
          if (chunk === null) break;
          requireCondition(Buffer.isBuffer(chunk));
          chunks.push(chunk);
          record.bytesRead += chunk.length;
          if (record.bytesRead === 6) finish(false);
        }
      } catch {
        finish(false);
      }
    }

    stream.on('readable', readAvailable);
    stream.once('end', onEnd);
    stream.on('error', onFailure);
    stream.once('close', onFailure);
    readAvailable();
    if (stream.readableEnded) onEnd();
    else if (stream.destroyed) onFailure();
  });
}

function respond(response, statusCode, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function invoke(request, response, name, definition) {
  const record = {
    language: 'javascript',
    function: name,
    caseId: '',
    invocationBytes: 0,
    bindingKind: 'missing',
    source: '',
    contentKeys: [],
    uriPresent: false,
    bytesRead: 0,
    sha256: '',
    error: '',
  };

  try {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
      record.invocationBytes += chunk.length;
    }
    const rawBody = Buffer.concat(chunks, record.invocationBytes);
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
    requireCondition(isObject(envelope) && isObject(envelope.Data));
    const binding = Object.hasOwn(envelope.Data, definition.binding) ? envelope.Data[definition.binding] : undefined;
    record.bindingKind = bindingKind(binding);
    if (isObject(binding)) {
      record.source = typeof binding.Source === 'string' ? binding.Source : '';
      record.contentKeys = isObject(binding.Content) ? Object.keys(binding.Content).sort() : [];
    }
    const metadataUri = isObject(envelope.Metadata) ? envelope.Metadata.Uri : undefined;
    const uri = typeof metadataUri === 'string' ? decodeBody(metadataUri) : '';
    record.uriPresent = uri.length > 0;
    if (definition.blobTrigger) record.caseId = blobCaseId(uri);

    if (definition.mode === 'body') {
      const bytes = Buffer.from(decodeBody(binding), definition.binding === 'blob' ? 'base64' : 'utf8');
      record.bytesRead = bytes.length;
      record.sha256 = createHash('sha256').update(bytes).digest('hex');
    } else if (definition.mode === 'download' || definition.mode === 'metadata') {
      requireCondition(isObject(binding) && binding.Source === 'AzureStorageBlobs' && record.uriPresent);
      if (definition.mode === 'download') {
        const blob = validatedBlobClient(uri);
        const download = await blob.download(0, 5, {
          abortSignal: AbortSignal.timeout(30_000),
          maxRetryRequests: 0,
        });
        const bytes = await readFiveBytes(download.readableStreamBody, record);
        record.sha256 = createHash('sha256').update(bytes).digest('hex');
      }
    }
    // Capture-only cases deliberately make no descriptor reconstruction assumptions.
  } catch {
    record.error = failureMessage;
  }

  try {
    appendFileSync(process.env.CAPTURE_PATH, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    respond(response, 500, { error: failureMessage });
    return;
  }

  if (record.error !== '') {
    respond(response, 500, { error: failureMessage });
    return;
  }
  const outputs = definition.http
    ? { res: { statusCode: 200, body: 'captured', headers: { 'Content-Type': 'text/plain' } } }
    : {};
  respond(response, 200, { Outputs: outputs, Logs: [], ReturnValue: null });
}

function start() {
  const portText = process.env.FUNCTIONS_CUSTOMHANDLER_PORT;
  requireCondition(typeof portText === 'string' && /^\d+$/.test(portText));
  const port = Number(portText);
  requireCondition(Number.isInteger(port) && port > 0 && port <= 65535);
  requireCondition(typeof process.env.CAPTURE_PATH === 'string' && process.env.CAPTURE_PATH.length > 0);

  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];
    if (request.method === 'GET' && path === '/') {
      request.resume();
      respond(response, 200, { ready: true });
      return;
    }
    const name = path.slice(1);
    const definition = functions.get(name);
    if (request.method !== 'POST' || !path.startsWith('/') || !definition) {
      request.resume();
      respond(response, 404, { error: 'Not found.' });
      return;
    }
    void invoke(request, response, name, definition).catch(() => {
      respond(response, 500, { error: failureMessage });
    });
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
  server.on('error', () => {
    process.stderr.write('Handler server failed.\n');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1');
}

try {
  start();
} catch {
  process.stderr.write('Handler startup failed.\n');
  process.exitCode = 1;
}