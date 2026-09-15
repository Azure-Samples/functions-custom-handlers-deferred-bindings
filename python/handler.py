import hashlib
import base64
import json
import logging
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from azure.core.pipeline.policies import RedirectPolicy
from azure.storage.blob import BlobServiceClient


FUNCTIONS = {
    f"{binding}{mode}"
    for binding in ("Blob", "Read", "Queue")
    for mode in ("Body", "Deferred")
} | {"BlobMetadata"}
CAPTURE_LOCK = threading.Lock()
MISSING = object()
MAX_INVOCATION_BYTES = 64 * 1024 * 1024

azure_logger = logging.getLogger("azure")
azure_logger.addHandler(logging.NullHandler())
azure_logger.propagate = False


def unwrap_string(value):
    if not isinstance(value, str):
        raise ValueError("string")
    try:
        decoded = json.loads(value)
    except (ValueError, RecursionError):
        return value
    return decoded if isinstance(decoded, str) else value


def binding_kind(value):
    if value is MISSING:
        return "missing"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, str):
        return "string"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, list):
        return "array"
    if isinstance(value, (int, float)):
        return "number"
    return "other"


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_key")
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError("json_constant")


def blob_case_id(uri):
    if not uri:
        return ""
    try:
        parsed = urlsplit(uri)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return ""
        segment = unquote(parsed.path, errors="strict").rsplit("/", 1)[-1]
        return segment if re.fullmatch(r"size-(37|1048576|8388608)\.txt", segment) else ""
    except ValueError:
        return ""


def validated_blob_name(service_url, uri, container):
    if not container or any(c in container for c in "/\\%?#"):
        raise ValueError("container")
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in uri):
        raise ValueError("uri")
    if "\\" in uri:
        raise ValueError("uri")
    expected = urlsplit(service_url)
    actual = urlsplit(uri)
    if (
        expected.scheme not in ("http", "https")
        or not expected.hostname
        or (actual.scheme, actual.hostname, actual.port)
        != (expected.scheme, expected.hostname, expected.port)
        or actual.username is not None
        or actual.password is not None
        or actual.query
        or actual.fragment
    ):
        raise ValueError("uri")
    prefix = expected.path.rstrip("/") + "/"
    if not actual.path.startswith(prefix):
        raise ValueError("account_path")
    encoded_container, separator, encoded_blob = actual.path[len(prefix):].partition("/")
    if not separator or unquote(encoded_container, errors="strict") != container:
        raise ValueError("container")
    blob_name = unquote(encoded_blob, errors="strict")
    if (
        not blob_name
        or blob_name.startswith("/")
        or "\\" in blob_name
        or any(ord(c) < 32 or ord(c) == 127 for c in blob_name)
        or any(part in (".", "..") for part in blob_name.split("/"))
    ):
        raise ValueError("blob_name")
    return blob_name


def capture_invocation(function, raw, record):
    record["error"] = "envelope"
    envelope = json.loads(
        raw, object_pairs_hook=unique_object, parse_constant=reject_constant
    )
    if not isinstance(envelope, dict):
        raise ValueError("envelope")
    data = envelope.get("Data")
    metadata = envelope.get("Metadata", {})
    if not isinstance(data, dict) or not isinstance(metadata, dict):
        raise ValueError("envelope")

    record["error"] = "binding"
    binding_name = "item" if function.startswith("Queue") else "blob"
    binding = data.get(binding_name, MISSING)
    record["bindingKind"] = binding_kind(binding)
    if isinstance(binding, dict):
        source = binding.get("Source", "")
        content = binding.get("Content", {})
        if not isinstance(source, str) or not isinstance(content, dict):
            raise ValueError("descriptor")
        record["source"] = source
        record["contentKeys"] = sorted(content)

    record["error"] = "metadata_uri"
    uri = metadata.get("Uri")
    if uri is not None:
        uri = unwrap_string(uri)
    record["uriPresent"] = bool(uri)
    if function in ("BlobBody", "BlobDeferred", "BlobMetadata"):
        record["caseId"] = blob_case_id(uri)

    if function.endswith("Body"):
        record["error"] = "body"
        body = unwrap_string(binding).encode("utf-8")
        if binding_name == "blob":
            body = base64.b64decode(body, validate=True)
        record["bytesRead"] = len(body)
        record["sha256"] = hashlib.sha256(body).hexdigest()
    elif function in ("BlobDeferred", "BlobMetadata"):
        record["error"] = "blob_descriptor"
        if not isinstance(binding, dict) or record["source"] != "AzureStorageBlobs" or not uri:
            raise ValueError("blob_descriptor")
        if function == "BlobDeferred":
            record["error"] = "storage_config"
            container = os.environ["BLOG_CONTAINER"]
            with BlobServiceClient.from_connection_string(
                os.environ["AzureWebJobsStorage"],
                logging_enable=False,
                redirect_policy=RedirectPolicy(permit_redirects=False),
                # This installed Storage SDK constructs RedirectPolicy(**kwargs) itself.
                permit_redirects=False,
                connection_timeout=5,
                read_timeout=15,
                retry_total=0,
                retry_connect=0,
                retry_read=0,
                retry_status=0,
            ) as service:
                record["error"] = "uri_validation"
                blob_name = validated_blob_name(service.url, uri, container)
                record["error"] = "blob_download"
                with service.get_blob_client(container=container, blob=blob_name) as client:
                    body = client.download_blob(offset=0, length=5).readall()
                record["bytesRead"] = len(body)
                record["sha256"] = hashlib.sha256(body).hexdigest()
                record["error"] = "blob_length"
                if len(body) != 5:
                    raise ValueError("blob_length")
    elif function == "QueueDeferred":
        record["error"] = "queue_descriptor"
        if not isinstance(binding, dict):
            raise ValueError("queue_descriptor")
    # ReadDeferred only observes the binding and metadata, even if either is absent.
    record["error"] = ""


def append_capture(record):
    with CAPTURE_LOCK:
        path = Path(os.environ["CAPTURE_PATH"])
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(record, separators=(",", ":")) + "\n")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def reply(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.close_connection = True
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {"error": "request_failed"})

    def do_GET(self):
        if self.path == "/":
            self.reply(200, {"ready": True})
        else:
            self.reply(404, {"error": "request_failed"})

    def do_POST(self):
        record = {
            "language": "python",
            "function": "",
            "caseId": "",
            "invocationBytes": 0,
            "bindingKind": "missing",
            "source": "",
            "contentKeys": [],
            "uriPresent": False,
            "bytesRead": 0,
            "sha256": "",
            "error": "request_body",
        }
        function = self.path[1:] if self.path.startswith("/") else ""
        if function in FUNCTIONS:
            record["function"] = function
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if (
                self.headers.get_all("Transfer-Encoding")
                or len(lengths) != 1
                or not lengths[0].isascii()
                or not lengths[0].isdecimal()
            ):
                raise ValueError("request_body")
            length = int(lengths[0])
            if not 0 <= length <= MAX_INVOCATION_BYTES:
                raise ValueError("request_body")
            raw = self.rfile.read(length)
            record["invocationBytes"] = len(raw)
            if len(raw) != length:
                raise ValueError("request_body")
            record["error"] = "function"
            if function not in FUNCTIONS:
                raise ValueError("function")
            capture_invocation(function, raw, record)
        except Exception:
            pass

        try:
            append_capture(record)
        except Exception:
            self.reply(500, {"error": "invocation_failed"})
            return
        if record["error"]:
            self.reply(500, {"error": "invocation_failed"})
            return
        outputs = {}
        if function.startswith("Read"):
            outputs["res"] = {
                "statusCode": 200,
                "body": "captured",
                "headers": {"Content-Type": "text/plain"},
            }
        self.reply(200, {"Outputs": outputs, "Logs": [], "ReturnValue": None})


class QuietServer(ThreadingHTTPServer):
    def handle_error(self, _request, _client_address):
        pass


if __name__ == "__main__":
    try:
        if not os.environ.get("CAPTURE_PATH"):
            raise ValueError("capture_config")
        port = int(os.environ.get("FUNCTIONS_CUSTOMHANDLER_PORT", "8080"))
        with QuietServer(("127.0.0.1", port), Handler) as server:
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("startup_failed") from None