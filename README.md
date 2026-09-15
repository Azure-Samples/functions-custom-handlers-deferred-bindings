# Deferred bindings with Azure Functions custom handlers

These Go, JavaScript and Python samples compare ordinary Blob bindings with
deferred bindings in Azure Functions custom handlers. Each handler is a plain
HTTP server. No Functions language worker or custom host build is required for
the tested configuration.

The main example receives a Blob trigger without the blob body in the invocation,
then reads a five-byte range directly through the Azure Storage SDK. Controls
show what happens with ordinary Blob bindings, Blob input bindings and Storage
Queue triggers.

> This is a local experiment using released components, not a production service
> or a blanket compatibility guarantee. The tested host and extension versions
> are listed in [EXPERIMENTS.md](EXPERIMENTS.md#environment-actually-observed).
> The custom-handler documentation does not define a complete deferred
> SDK-binding contract for HTTP. Verify the payload on the versions you deploy.

## What is included

| Content | Purpose |
| --- | --- |
| [Go handler](go/main.go) and [storage helper](go/storage.go) | HTTP custom handler and bounded Blob SDK read |
| [JavaScript handler](javascript/handler.mjs) | Equivalent Node.js HTTP server |
| [Python handler](python/handler.py) | Equivalent Python HTTP server |
| [Binding example](examples/BlobDeferred/function.json) and [host example](examples/host.json) | Configuration to adapt for your app |
| [Experiment runner](run-experiment.ps1) | Builds Go, runs fixtures, starts isolated Azurite and invokes real Functions listeners |
| [Methods and results](EXPERIMENTS.md) | Measurements, prerequisites, limitations and source references |

The example configurations are not complete per-language deployment packages.
The runner generates separate local app directories with the right executable
paths, bindings and ephemeral storage configuration for each language.

## Prerequisites

The complete runner is tested on **Windows x64 with PowerShell 7**. It runs all
three languages, so install all of the following even if you plan to adapt only
one handler:

- Go 1.26.0, Node.js 22.20.0 and Python 3.13.15, as used for the retained results.
- Azure Functions Core Tools 4.12.0.
- Azurite 3.35.0.
- Network access to install dependencies and obtain extension bundle 4.34.0.

These are tested versions, not minimum-version claims. The runner uses ports
18100–18102, 18200 and 18300–18302. Keep them free and do not run multiple copies
at once. It leaves the usual Azurite ports alone. JavaScript dependencies use
public npm versions in this checkout. The methods document distinguishes them
from the mirror-sourced versions used for the historical results.

## Run the comparison

From a PowerShell 7 terminal in the repository root:

```powershell
npm ci --ignore-scripts
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r python/requirements.txt
```

If you installed Core Tools and Azurite through npm globally, locate their entry
points and run:

```powershell
$globalModules = (npm root -g).Trim()
./run-experiment.ps1 `
	-FuncExecutable "$globalModules/azure-functions-core-tools/bin/func.exe" `
	-AzuriteScript "$globalModules/azurite/dist/src/azurite.js"
```

For other installation layouts, pass the actual Core Tools executable and
Azurite JavaScript entry point. Do not pass the PowerShell command shims. The
Python executable defaults to the virtual environment created above.

The script runs Go tests and vet, builds the Go handler, checks shared protocol
fixtures, and starts a separate local Functions host for each language. Uploads
to the isolated emulator trigger the Blob functions. HTTP requests exercise Blob
input bindings, and queue messages exercise the queue controls.

A successful run ends with **PASS 51 observations**, after the **21 protocol
fixtures** pass. Results and logs are saved to a timestamped artifacts directory.
Processes started by the runner are stopped on completion or failure. If you
interrupt or terminate the runner externally, check for leftover test processes
before running it again.

No Azure subscription or cloud credentials are needed. The local emulator uses
a randomly generated account key supplied to the test processes. Dependencies
and extension bundles may still require internet access.

## What the numbers mean

The result records measure the HTTP invocation body's size and verify the bytes
consumed by the handler. They do not measure total network traffic, process
memory, cold start, throughput or Azure cost. Retained measurements are historical
evidence from the original experiment, not results of every fresh checkout.

Deferred Blob input bindings and deferred Queue triggers are deliberately
included as boundary cases. Do not assume every deferred descriptor is a usable
resource locator. **The queue observation function returns success without
processing the deferred message**, allowing normal queue acknowledgement. Keep
these tests on disposable queues, never on real work.

## Adapting a sample

Start with [EXPERIMENTS.md](EXPERIMENTS.md#boundaries-and-deployment). Supply the
target platform's executable or interpreter and dependencies, configure storage
authentication, and retain the URI validation in the handler. `BLOG_CONTAINER`
must match the allowed Blob container. The full experiment servers also need
`CAPTURE_PATH` for their measurement output.

The tests use polling Blob triggers on Azurite. They do not validate Event Grid
subscriptions or cloud deployment. A plan that requires event-based Blob
triggers needs different trigger setup and its own verification.

## Contributing

Run `npm test` for evidence-export tests and follow the full comparison above
when changing a handler or the runner. See [CONTRIBUTING.md](CONTRIBUTING.md) and
the [MIT license](LICENSE.md).

## Resources

- [Azure Functions custom handlers](https://learn.microsoft.com/azure/azure-functions/functions-custom-handlers)
- [Blob trigger configuration and metadata](https://learn.microsoft.com/azure/azure-functions/functions-bindings-storage-blob-trigger)
- [Event Grid-based Blob triggers](https://learn.microsoft.com/azure/azure-functions/functions-event-grid-blob-trigger)
