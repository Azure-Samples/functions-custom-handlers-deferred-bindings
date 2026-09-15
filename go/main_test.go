package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func encode(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal("test JSON encoding failed")
	}
	return string(data)
}

func newTestHandler(t *testing.T) (*handler, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "capture.jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal("test capture open failed")
	}
	t.Cleanup(func() { _ = file.Close() })
	return &handler{capture: &captureFile{file: file}}, path
}

func readSummaries(t *testing.T, path string) []summary {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("test capture read failed")
	}
	if len(data) == 0 || data[len(data)-1] != '\n' {
		t.Fatal("missing JSONL record terminator")
	}
	var records []summary
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		var fields map[string]json.RawMessage
		if json.Unmarshal([]byte(line), &fields) != nil || len(fields) != 11 || fields["caseId"] == nil {
			t.Fatal("summary must have exactly eleven fields including caseId")
		}
		var record summary
		if json.Unmarshal([]byte(line), &record) != nil || record.ContentKeys == nil {
			t.Fatal("invalid summary schema")
		}
		records = append(records, record)
	}
	return records
}

func TestFunctionMatrix(t *testing.T) {
	descriptor := map[string]any{
		"Source": "AzureStorageBlobs",
		"Content": map[string]any{"z": "never captured", "a": "never captured"},
	}
	cases := map[string]struct {
		binding string
		value   any
		body    string
		kind    string
		source  string
	}{
		"BlobBody":      {"blob", encode(t, "aMOpbGxvCg=="), "héllo\n", "string", ""},
		"BlobDeferred":  {"blob", descriptor, "hello", "object", "AzureStorageBlobs"},
		"BlobMetadata":  {"blob", descriptor, "", "object", "AzureStorageBlobs"},
		"ReadBody":      {"blob", "aGVsbG8=", "hello", "string", ""},
		"ReadDeferred":  {"blob", descriptor, "", "object", "AzureStorageBlobs"},
		"QueueBody":     {"item", encode(t, "queue\n"), "queue\n", "string", ""},
		"QueueDeferred": {"item", map[string]any{"Source": "AzureStorageQueues", "Content": map[string]any{"z": 1, "a": 2}}, "", "object", "AzureStorageQueues"},
	}
	if len(cases) != len(functions) {
		t.Fatal("function matrix does not cover the route table")
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if _, ok := functions[name]; !ok {
				t.Fatal("matrix function is not registered")
			}
			h, path := newTestHandler(t)
			calls := 0
			h.httpClient = fakeClient(func(r *http.Request) (*http.Response, error) {
				calls++
				return blobResponse(r, io.NopCloser(strings.NewReader("hello"))), nil
			})
			h.connectionString = testConnection
			h.container = "blog"
			raw := encode(t, map[string]any{
				"Data":     map[string]any{tc.binding: tc.value},
				"Metadata": map[string]any{"Uri": encode(t, "http://127.0.0.1:19000/account/blog/size-37.txt")},
			})
			response := httptest.NewRecorder()
			newMux(h).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/"+name, strings.NewReader(raw)))
			if response.Code != http.StatusOK {
				t.Fatal("invocation did not succeed")
			}
			want := `{"Outputs":{},"Logs":[],"ReturnValue":null}`
			if name == "ReadBody" || name == "ReadDeferred" {
				want = `{"Outputs":{"res":{"statusCode":200,"body":"captured","headers":{"Content-Type":"text/plain"}}},"Logs":[],"ReturnValue":null}`
			}
			if response.Body.String() != want || response.Header().Get("Content-Type") != "application/json" {
				t.Fatal("incorrect host response envelope")
			}
			records := readSummaries(t, path)
			if len(records) != 1 {
				t.Fatal("expected exactly one summary")
			}
			got := records[0]
			if got.Language != "go" || got.Function != name || got.InvocationBytes != len(raw) ||
				got.BindingKind != tc.kind || got.Source != tc.source || !got.URIPresent || got.Error != "" {
				t.Fatal("incorrect invocation summary")
			}
			wantCaseID := ""
			if strings.HasPrefix(name, "Blob") {
				wantCaseID = "size-37.txt"
			}
			if got.CaseID != wantCaseID {
				t.Fatal("caseId must identify only true blob triggers")
			}
			wantKeys := []string{}
			if tc.kind == "object" {
				wantKeys = []string{"a", "z"}
			}
			if !reflect.DeepEqual(got.ContentKeys, wantKeys) || got.BytesRead != len(tc.body) {
				t.Fatal("incorrect binding summary")
			}
			wantHash := ""
			if tc.body != "" {
				digest := sha256.Sum256([]byte(tc.body))
				wantHash = hex.EncodeToString(digest[:])
			}
			if got.SHA256 != wantHash {
				t.Fatal("incorrect content digest")
			}
			wantCalls := 0
			if name == "BlobDeferred" {
				wantCalls = 1
			}
			if calls != wantCalls {
				t.Fatal("unexpected storage call count")
			}
		})
	}
}

func TestHostString(t *testing.T) {
	for _, text := range []string{"", "hello", "héllo\n", "123", "null", `{"a":1}`, `"unfinished`, `"bad\q"`} {
		for _, extra := range []bool{false, true} {
			wire := text
			if extra {
				wire = encode(t, wire)
			}
			got, ok := hostString(json.RawMessage(encode(t, wire)))
			if !ok || got != text {
				t.Fatal("incorrect host string decoding")
			}
		}
	}
	inner := encode(t, "hello")
	got, ok := hostString(json.RawMessage(encode(t, encode(t, inner))))
	if !ok || got != inner {
		t.Fatal("decoded more than one extra JSON string layer")
	}
	for _, raw := range []string{"", "null", "123", "true", "[]", "{}"} {
		if _, ok := hostString(json.RawMessage(raw)); ok {
			t.Fatal("accepted a non-string binding")
		}
	}
}

func TestInvocationFailures(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"BlobBody", "{"},
		{"BlobBody", "null"},
		{"BlobBody", `{"Data":{}} {}`},
		{"BlobBody", `{"Data":[]}`},
		{"BlobBody", `{"Data":{"blob":true}}`},
		{"BlobBody", `{"Data":{"blob":null}}`},
		{"BlobBody", `{"Data":{"blob":[]}}`},
		{"BlobBody", `{"Data":{"blob":"private body"},"Metadata":42}`},
		{"QueueBody", `{"Data":{"blob":"private body"}}`},
		{"BlobDeferred", `{"Data":{"blob":"AzureStorageBlobs"}}`},
		{"BlobDeferred", `{"Data":{"blob":{"Source":"AzureStorageBlobs"}}}`},
		{"BlobMetadata", `{"Data":{"blob":{"Source":"wrong"}}}`},
	}
	for _, tc := range cases {
		h, path := newTestHandler(t)
		response := httptest.NewRecorder()
		newMux(h).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/"+tc.name, strings.NewReader(tc.raw)))
		if response.Code != http.StatusInternalServerError || response.Body.String() != "invocation failed\n" {
			t.Fatal("request failure did not return generic HTTP 500")
		}
		records := readSummaries(t, path)
		if len(records) != 1 || records[0].Error == "" || records[0].InvocationBytes != len(tc.raw) ||
			strings.Contains(records[0].Error, "private body") {
			t.Fatal("request failure was not safely captured")
		}
	}
}

func TestObservationWithoutStorageConfiguration(t *testing.T) {
	for _, name := range []string{"ReadDeferred", "QueueDeferred", "BlobMetadata"} {
		h, path := newTestHandler(t)
		spec := functions[name]
		value := map[string]any{"Source": "AzureStorageBlobs", "Content": map[string]any{"BlobName": "not-a-resolved-uri"}}
		envelope := map[string]any{"Data": map[string]any{spec.binding: value}}
		wantURI := name == "BlobMetadata"
		if wantURI {
			envelope["Metadata"] = map[string]any{"Uri": encode(t, testURI)}
		}
		raw := encode(t, envelope)
		response := httptest.NewRecorder()
		newMux(h).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/"+name, strings.NewReader(raw)))
		records := readSummaries(t, path)
		if response.Code != http.StatusOK || len(records) != 1 || records[0].URIPresent != wantURI ||
			records[0].BytesRead != 0 || records[0].SHA256 != "" {
			t.Fatal("observation path required storage or fabricated content")
		}
	}
}

func TestBlobMetadataRequiresDecodedURI(t *testing.T) {
	for _, metadata := range []map[string]any{
		{}, {"Uri": nil}, {"Uri": false}, {"Uri": ""}, {"Uri": encode(t, "")},
	} {
		h, path := newTestHandler(t)
		raw := encode(t, map[string]any{
			"Data":     map[string]any{"blob": map[string]any{"Source": "AzureStorageBlobs"}},
			"Metadata": metadata,
		})
		response := httptest.NewRecorder()
		newMux(h).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/BlobMetadata", strings.NewReader(raw)))
		records := readSummaries(t, path)
		if response.Code != http.StatusInternalServerError || len(records) != 1 ||
			records[0].Error != "blob uri required" || records[0].URIPresent || records[0].CaseID != "" {
			t.Fatal("metadata-only blob trigger accepted a missing or empty decoded URI")
		}
	}
}

func TestBlobCaseIDAllowlist(t *testing.T) {
	const prefix = "https://example.invalid/blog/folder/"
	cases := []struct {
		uri  string
		want string
	}{
		{prefix + "size-37.txt", "size-37.txt"},
		{prefix + "size-1048576.txt", "size-1048576.txt"},
		{prefix + "size-8388608.txt", "size-8388608.txt"},
		{prefix + "%73ize-37%2Etxt", "size-37.txt"},
		{prefix + "nested%2Fsize-37.txt", "size-37.txt"},
		{prefix + "size-37.txt?sig=private#private", "size-37.txt"},
		{prefix + "size-38.txt", ""},
		{prefix + "size-037.txt", ""},
		{prefix + "private-size-37.txt", ""},
		{prefix + "size-37.txt.private", ""},
		{prefix + "size-37.txt%0A", ""},
		{prefix + "size-37.txt/", ""},
		{prefix + "private?name=size-37.txt", ""},
		{prefix + "%2573ize-37.txt", ""},
		{prefix + "%zz", ""},
		{"", ""},
		{"not a URL", ""},
		{"/blog/size-37.txt", ""},
		{"ftp://example.invalid/blog/size-37.txt", ""},
	}
	for _, tc := range cases {
		for _, quoted := range []bool{false, true} {
			uri := tc.uri
			if quoted {
				uri = encode(t, uri)
			}
			h, path := newTestHandler(t)
			raw := encode(t, map[string]any{
				"Data":     map[string]any{"blob": "aGVsbG8="},
				"Metadata": map[string]any{"Uri": uri},
			})
			response := httptest.NewRecorder()
			newMux(h).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/BlobBody", strings.NewReader(raw)))
			records := readSummaries(t, path)
			if response.Code != http.StatusOK || len(records) != 1 || records[0].CaseID != tc.want {
				t.Fatal("caseId did not use the allowlisted final decoded URL path segment")
			}
			captured, err := os.ReadFile(path)
			if err != nil || strings.Contains(string(captured), "example.invalid") || strings.Contains(string(captured), "private") {
				t.Fatal("caseId leaked arbitrary URL details")
			}
		}
	}
}

func TestBindingKinds(t *testing.T) {
	for raw, want := range map[string]string{
		"": "missing", "null": "null", `""`: "string", "{}": "object", "[]": "array", "true": "boolean", "false": "boolean", "1": "number",
	} {
		if bindingKind(json.RawMessage(raw)) != want {
			t.Fatal("incorrect JSON binding kind")
		}
	}
}

func TestReadinessDoesNotCapture(t *testing.T) {
	h, path := newTestHandler(t)
	response := httptest.NewRecorder()
	newMux(h).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	data, err := os.ReadFile(path)
	if err != nil || len(data) != 0 || response.Code != http.StatusOK {
		t.Fatal("readiness probe was not independent of invocation capture")
	}
}

func TestConcurrentCapture(t *testing.T) {
	h, path := newTestHandler(t)
	mux := newMux(h)
	var wg sync.WaitGroup
	for range 24 {
		wg.Go(func() {
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/QueueBody", strings.NewReader(`{"Data":{"item":""}}`)))
			if response.Code != http.StatusOK {
				t.Error("concurrent invocation failed")
			}
		})
	}
	wg.Wait()
	records := readSummaries(t, path)
	if len(records) != 24 {
		t.Fatal("lost or interleaved capture records")
	}
	digest := sha256.Sum256(nil)
	for _, record := range records {
		if record.BytesRead != 0 || record.SHA256 != hex.EncodeToString(digest[:]) {
			t.Fatal("empty string must have the empty-content digest")
		}
	}
}

func TestCanceledInvocationIsCaptured(t *testing.T) {
	h, path := newTestHandler(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodPost, "/QueueBody", strings.NewReader(`{"Data":{"item":"hello"}}`)).WithContext(ctx)
	response := httptest.NewRecorder()
	newMux(h).ServeHTTP(response, request)
	records := readSummaries(t, path)
	if response.Code != http.StatusInternalServerError || records[0].Error != "invocation canceled" {
		t.Fatal("canceled invocation was not safely captured")
	}
}

func TestCaptureFailureDoesNotAcknowledgeInvocation(t *testing.T) {
	h, _ := newTestHandler(t)
	_ = h.capture.file.Close()
	response := httptest.NewRecorder()
	newMux(h).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/QueueBody", strings.NewReader(`{"Data":{"item":"hello"}}`)))
	if response.Code != http.StatusInternalServerError || response.Body.String() != "invocation failed\n" {
		t.Fatal("failed persistence acknowledged success")
	}
}

func TestSDKFailureIsSafelyCaptured(t *testing.T) {
	h, path := newTestHandler(t)
	h.connectionString = testConnection
	h.container = "blog"
	h.httpClient = fakeClient(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("private URL and credentials")
	})
	raw := encode(t, map[string]any{
		"Data":     map[string]any{"blob": map[string]any{"Source": "AzureStorageBlobs"}},
		"Metadata": map[string]any{"Uri": testURI},
	})
	response := httptest.NewRecorder()
	newMux(h).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/BlobDeferred", strings.NewReader(raw)))
	records := readSummaries(t, path)
	if response.Code != http.StatusInternalServerError || records[0].Error != "blob download" {
		t.Fatal("SDK error was not replaced with a static step name")
	}
	data, err := os.ReadFile(path)
	if err != nil || strings.Contains(string(data), testURI) || strings.Contains(string(data), "private") {
		t.Fatal("sensitive details were captured")
	}
}