# Reproducing the deferred binding experiment

This file documents the sample's methods, measurements and known limitations.
Start with [README.md](README.md) for setup and an overview of the repository.

## What ran

Three standalone HTTP custom handlers were exercised through Azure Functions
Core Tools, using real Blob and Queue listeners backed by an isolated Azurite
instance. No worker SDK, custom Go worker, modified host executable, Collector
component, Azure account or cloud deployment is involved in these tests.

The full matrix per language is:

| Function | Binding | Deferred flag | Handler action |
| --- | --- | --- | --- |
| BlobBody | blobTrigger | false | Decode binary/base64, hash complete content |
| BlobDeferred | blobTrigger | true | Read five bytes through Storage SDK, verify hash |
| BlobMetadata | blobTrigger | true | Inspect notification, no handler download |
| ReadBody | HTTP trigger plus blob input | false | Decode and hash complete content |
| ReadDeferred | HTTP trigger plus blob input | true | Inspect descriptor and missing URI, no reconstruction |
| QueueBody | queueTrigger | false | Decode and hash 11-byte queue message |
| QueueDeferred | queueTrigger | true | Observe descriptor, do not claim message retrieval |

The first five functions run for 37-byte, 1 MiB and 8 MiB blobs. The two queue
functions each run once. Seventeen observations per language, 51 in one complete
run. We ran the entire matrix successfully three times. The second run adds
explicit blob-name correlation and stronger queue and payload-size assertions.
The third executes the documented PowerShell wrapper, including its build and
fixture prerequisites, to check the reader's reproduction path.

## Environment actually observed

| Component | Version |
| --- | --- |
| OS | Windows, x64 |
| Core Tools | 4.12.0 |
| Functions host | 4.1048.200.26180 |
| Extension bundle loaded | 4.34.0 |
| Host Storage Blobs / Queues extensions | 5.3.7 / 5.3.7 |
| Azurite | 3.35.0, with `--skipApiVersionCheck` |
| Go | 1.26.0 |
| Go azblob | 1.8.0 |
| Node.js | 22.20.0 |
| JavaScript storage-blob / storage-queue | 12.33.0 / 12.31.0 |
| Python | 3.13.15 |
| Python azure-storage-blob | 12.30.1 |

The host logs explicitly record loading the bundle and both storage extension
versions. Azurite's API-version check bypass is local test configuration, not a
production recommendation. These values describe the test environment, not
minimum requirements or a compatibility certification.

The original JavaScript dependencies came from a package mirror. For a public
checkout, this repository uses npmjs.org and pins storage-blob 12.31.0 and
storage-queue 12.29.0 instead. Historical evidence retains the original versions.
New runs record the installed SDK versions rather than copying that table.

The relocated repository was validated on September 15, 2026 with those public
JavaScript versions. Go tests and vet, 21 protocol fixtures and all 51 real-host
observations passed. The recorded environment and results are in
[evidence/repo-validation.json](evidence/repo-validation.json). The 47
evidence-export tests also passed. Direct PyPI artifact downloads encountered a
TLS handshake failure on the validation machine, so Python packages were
installed through that machine's configured mirror. No certificate checks were
disabled, and no Python mirror configuration is required or included here.

The retained runs were recorded on September 10, 2026. They describe a specific
tested combination, not a latest-release claim or date-wide Azure availability.

## Run it locally

This orchestration script is currently **Windows-only**, using PowerShell 7,
Node, Go, Python, Core Tools and Azurite. The handler sources use portable APIs,
but other operating systems have not been tested. Run from this directory.

1. Install JavaScript dependencies with `npm ci --ignore-scripts`.
2. Create a dedicated Python environment with `python -m venv .venv` and install
   with `.venv/Scripts/python.exe -m pip install -r python/requirements.txt`.
   The direct SDK version is pinned. The complete resolved Python dependency
   list from the measured run is retained in the evidence.
3. Locate the actual Core Tools executable and Azurite JavaScript entry point.
   With an npm installation these are usually below the global npm directory,
   in azure-functions-core-tools/bin and azurite/dist/src respectively. Pass
   their full paths, not the PowerShell launch shims.
4. Invoke [run-experiment.ps1](run-experiment.ps1) with `-FuncExecutable` pointing
   at the Core Tools executable and `-AzuriteScript` pointing at the Azurite
   JavaScript entry point. `-PythonExecutable` defaults to the local virtual
   environment's interpreter.

The script builds the Go handler from current source with `GOWORK=off`, runs its
tests and vet, executes 21 shared protocol fixtures, then runs the host matrix.
No cloud credentials are needed. The driver creates a random key for a temporary
local account and passes it only to child processes. It does not use the existing
Azurite account or an Azure connection string from the shell.

The runner checks that ports 18100–18102 and 18200 are free before launching.
The fixture servers use 18300–18302. Do not run two copies concurrently. The
matrix identifies its host by the host-status ID and starts one language at a
time. Process trees are stopped on normal completion or assertion failure.
External termination of Node can still interrupt cleanup. Check those ports if
a run is interrupted. Existing services on the normal Azurite ports are untouched.

Generated app configuration, storage data and diagnostic logs remain under an
ignored artifacts directory. It is intentionally disposable. Do not publish that
directory wholesale. Host diagnostics can contain machine paths and operational
details even though the handler summaries omit credentials and payload bodies.

## Reading the results

The primary reference run is `2026-09-10T15-48-36.637Z`. Its sanitized
51 observations and source/binary hashes are in [evidence/results.json](evidence/results.json).
The earlier complete run is retained in [evidence/first-run.json](evidence/first-run.json).
The wrapper-verification run is retained in [evidence/wrapper-run.json](evidence/wrapper-run.json).
These are historical results from the original experiment. Their provenance
hashes identify the sources and binaries used then, not necessarily the current
repository contents. Raw historical host logs are not distributed here. Use
[publish-evidence.mjs](publish-evidence.mjs) with a completed run directory to
export sanitized evidence from another run.

The exporter accepts manifests from the current runner, which records actual
installed versions and Python distribution names and versions without local
package origins. Old manifests lacking those fields cannot be re-exported by
guessing versions. The historical summaries are preserved as collected.

Pass a new output filename for each exported run, for example
`node publish-evidence.mjs <run-directory> public-install.json`. The exporter
refuses to overwrite existing evidence, including the historical reference run.

Each row records:

- `invocationBytes`, the raw HTTP request body's byte length at handler entry.
- `bytesRead`, decoded blob/message bytes consumed by the application. For the
  ranged case, bytes returned by the SDK and consumed by the handler.
- `sha256`, a content check against known test data, not a speed measurement.
- `bindingKind`, descriptor source and `contentKeys`, describing the observed
  wire shape without retaining the full payload.
- `uriPresent` and `caseId`, with the case ID restricted to known test filenames.

There is no HTTP header accounting, packet capture, storage-traffic measurement,
host RSS measurement, allocation profile, latency comparison or cold-start
benchmark. Concurrent functions can affect one another's storage activity, so
this setup should not be reused unchanged for any of those claims.

The three languages have different HTTP libraries and validation details. The
comparison establishes that the tested host envelopes work in each, not that
the implementations are interchangeable or equally efficient.

## Why the checks are meaningful

The ordinary path checks a full content hash, not merely an HTTP 200. Deferred
reads check the requested range's length and hash. The metadata-only path checks
URI availability without a handler download. The final runner selects one
matching observation per expected case and records additional Blob-trigger
matches present in each collection window. It correlates those observations by
filename and function, bounds deferred Blob-trigger envelope sizes, verifies
ordinary queue content, and requires all 51 selected cases. This does not prove
there were exactly 51 host invocations or detect every possible late duplicate.

The shared fixture suite checks exact UTF-8 byte accounting, malformed envelopes,
missing URI failure, and download rejection without trusted storage configuration.
It also verifies that metadata-only handling works without storage credentials.
These fixture calls are deliberately distinguished from the real-host runs.

Two preliminary runs failed at the ordinary 37-byte control because the initial
handler treated the 52-character base64 representation as the blob itself. The
hash/length assertions caught it. The handlers were corrected to decode binary
bindings, with `dataType: binary` explicit in the final configuration. None of
the failed attempts supplies a published performance result.

## Boundaries and deployment

- Blob input observations verify descriptor delivery and missing `Metadata.Uri`.
  They do not implement a generic resolved input-binding client.
- Deferred queue observations verify a changed representation, not successful
  recovery of the original deferred message body. That capture-only function
  returns success, which normally lets the host delete the queue message. Queue
  deletion itself is not asserted by the harness. Do not point it at real work.
- Event Grid, Event Hubs, Service Bus, Cosmos DB, managed identity and live Azure
  deployment are discussed from documentation/source, not reported as tested.
- The range-read examples use immutable test blobs. ETag/version races and
  production retry/idempotency decisions remain application responsibilities.
- The samples are experiment servers, not hardened public ingestion services.
  Keep them off public endpoints. Request limits and cancellation differ across
  implementations; use an appropriate production server and limits when adapting.

For an Azure deployment, prepare a separate app directory. Include the host
configuration, per-function configuration, the target-platform executable or
interpreter code, and its dependencies. Replace local absolute launch paths with
paths valid in that package. Configure runtime and storage settings on the app,
not by shipping a local secrets file. Node/Python runtime availability is a
deployment prerequisite; using a custom handler does not install an interpreter.

The example Blob trigger uses polling. If the target plan requires Event Grid,
set up the event-based Blob trigger and subscription and verify the received
envelope there. Do not deploy this polling experiment to Flex Consumption as-is.

## Source-backed claims

The host and extension independently participate in deferred binding. The flag
requests a different type; the extension must know how to supply it.

- [Host binding-property reader](https://github.com/Azure/azure-functions-host/blob/9211552f/src/WebJobs.Script/Binding/Extensibility/ScriptBindingContext.cs)
  and [binding type selection](https://github.com/Azure/azure-functions-host/blob/9211552f/src/WebJobs.Script/Binding/GeneralScriptBindingProvider.cs).
- [Custom-handler HTTP value conversion](https://github.com/Azure/azure-functions-host/blob/9211552f/src/WebJobs.Script.Grpc/Http/RpcScriptInvocationContextExtensions.cs)
  uses object conversion with JSON serialization fallback. The live test is the
  primary evidence for the exact HTTP shape in the tested host.
- [Storage Blob extension converters at the inspected source revision](https://github.com/Azure/azure-sdk-for-net/blob/68ee33c4a4114da0d0e4ddc0d0df5eae8ed4b9d6/sdk/storage/Microsoft.Azure.WebJobs.Extensions.Storage.Blobs/src/Config/BlobsExtensionConfigProvider.cs)
  construct the locator content for trigger and input bindings.
- [Queue deferred converter](https://github.com/Azure/azure-sdk-for-net/blob/68ee33c4a4114da0d0e4ddc0d0df5eae8ed4b9d6/sdk/storage/Microsoft.Azure.WebJobs.Extensions.Storage.Queues/src/Triggers/StorageQueueMessageToParameterBindingDataConverter.cs)
  serializes the message representation into deferred content.
- [Event Hubs converter](https://github.com/Azure/azure-sdk-for-net/blob/6bcc7855e2b45888aae00b048a0f847f77134cff/sdk/eventhub/Microsoft.Azure.WebJobs.Extensions.EventHubs/src/Config/EventHubExtensionConfigProvider.cs)
  carries AMQP message data. [Service Bus converter](https://github.com/Azure/azure-sdk-for-net/blob/bbbda46d858e4fbb4f439b4907bde834450bd786/sdk/servicebus/Microsoft.Azure.WebJobs.Extensions.ServiceBus/src/Config/ServiceBusExtensionConfigProvider.cs)
  carries lock-token and AMQP message data. Neither should be described as lazy
  retrieval of an external object merely because its value is deferred.
- [Blob trigger metadata and connection documentation](https://learn.microsoft.com/en-us/azure/azure-functions/functions-bindings-storage-blob-trigger)
  describes URI metadata, trigger sources, and plan restrictions.
- [Event Grid-based Blob trigger setup](https://learn.microsoft.com/en-us/azure/azure-functions/functions-event-grid-blob-trigger)
  is distinct from receiving an ordinary Event Grid event containing a blob URL.

Additional bindings with expressions can affect the host's deferred-trigger
selection. This matrix does not cover every combination. Inspect the effective
payload instead of assuming a flag guarantees a particular shape.