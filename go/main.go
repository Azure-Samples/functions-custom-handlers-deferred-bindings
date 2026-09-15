package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	azlog "github.com/Azure/azure-sdk-for-go/sdk/azcore/log"
)

type summary struct {
	Language        string   `json:"language"`
	Function        string   `json:"function"`
	CaseID          string   `json:"caseId"`
	InvocationBytes int      `json:"invocationBytes"`
	BindingKind     string   `json:"bindingKind"`
	Source          string   `json:"source"`
	ContentKeys     []string `json:"contentKeys"`
	URIPresent      bool     `json:"uriPresent"`
	BytesRead       int      `json:"bytesRead"`
	SHA256          string   `json:"sha256"`
	Error           string   `json:"error"`
}

type functionSpec struct {
	binding     string
	mode        string
	blobTrigger bool
}

var functions = map[string]functionSpec{
	"BlobBody":      {binding: "blob", mode: "body", blobTrigger: true},
	"BlobDeferred":  {binding: "blob", mode: "download", blobTrigger: true},
	"BlobMetadata":  {binding: "blob", mode: "metadata", blobTrigger: true},
	"ReadBody":      {binding: "blob", mode: "body"},
	"ReadDeferred":  {binding: "blob", mode: "observe"},
	"QueueBody":     {binding: "item", mode: "body"},
	"QueueDeferred": {binding: "item", mode: "observe"},
}

var caseIDPattern = regexp.MustCompile(`^size-(37|1048576|8388608)\.txt$`)

func blobCaseID(uri string) string {
	u, err := url.Parse(uri)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return ""
	}
	segment := u.Path[strings.LastIndex(u.Path, "/")+1:]
	if caseIDPattern.MatchString(segment) {
		return segment
	}
	return ""
}

type captureFile struct {
	mu   sync.Mutex
	file *os.File
}

func (c *captureFile) append(record summary) error {
	line, err := json.Marshal(record)
	if err != nil {
		return errors.New("capture encode")
	}
	line = append(line, '\n')
	c.mu.Lock()
	defer c.mu.Unlock()
	if n, err := c.file.Write(line); err != nil || n != len(line) {
		return errors.New("capture write")
	}
	if err := c.file.Sync(); err != nil {
		return errors.New("capture sync")
	}
	return nil
}

type handler struct {
	capture          *captureFile
	connectionString string
	container        string
	httpClient       *http.Client
}

func newMux(h *handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "ready")
	})
	for name, spec := range functions {
		mux.HandleFunc("POST /"+name, func(w http.ResponseWriter, r *http.Request) {
			h.invoke(w, r, name, spec)
		})
	}
	return mux
}

func (h *handler) invoke(w http.ResponseWriter, r *http.Request, name string, spec functionSpec) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	record := summary{
		Language:    "go",
		Function:    name,
		BindingKind: "missing",
		ContentKeys: []string{},
	}
	raw, readErr := io.ReadAll(r.Body)
	closeErr := r.Body.Close()
	record.InvocationBytes = len(raw)
	switch {
	case readErr != nil:
		record.Error = "invocation read"
	case closeErr != nil:
		record.Error = "invocation close"
	default:
		if err := h.process(ctx, raw, spec, &record); err != nil {
			record.Error = err.Error()
		}
	}
	if record.Error == "" && ctx.Err() != nil {
		record.Error = "invocation canceled"
	}
	if err := h.capture.append(record); err != nil {
		http.Error(w, "invocation failed", http.StatusInternalServerError)
		return
	}
	if record.Error != "" {
		http.Error(w, "invocation failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if name == "ReadBody" || name == "ReadDeferred" {
		_, _ = io.WriteString(w, `{"Outputs":{"res":{"statusCode":200,"body":"captured","headers":{"Content-Type":"text/plain"}}},"Logs":[],"ReturnValue":null}`)
		return
	}
	_, _ = io.WriteString(w, `{"Outputs":{},"Logs":[],"ReturnValue":null}`)
}

func object(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	var value map[string]json.RawMessage
	err := json.Unmarshal(raw, &value)
	return value, err == nil && value != nil
}

func bindingKind(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return "missing"
	}
	switch raw[0] {
	case '{':
		return "object"
	case '[':
		return "array"
	case '"':
		return "string"
	case 'n':
		return "null"
	case 't', 'f':
		return "boolean"
	default:
		return "number"
	}
}

func hostString(raw json.RawMessage) (string, bool) {
	if bindingKind(raw) != "string" {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	var inner string
	if bindingKind(json.RawMessage(value)) == "string" && json.Unmarshal([]byte(value), &inner) == nil {
		value = inner
	}
	return value, true
}

func (h *handler) process(ctx context.Context, raw []byte, spec functionSpec, record *summary) error {
	if ctx.Err() != nil {
		return errors.New("invocation canceled")
	}
	envelope, ok := object(raw)
	if !ok {
		return errors.New("envelope decode")
	}
	data, ok := object(envelope["Data"])
	if !ok {
		return errors.New("data decode")
	}
	metadata := map[string]json.RawMessage{}
	if value := envelope["Metadata"]; len(value) != 0 && bindingKind(value) != "null" {
		metadata, ok = object(value)
		if !ok {
			return errors.New("metadata decode")
		}
	}
	value := data[spec.binding]
	record.BindingKind = bindingKind(value)
	if descriptor, ok := object(value); ok {
		if bindingKind(descriptor["Source"]) == "string" {
			_ = json.Unmarshal(descriptor["Source"], &record.Source)
		}
		if content, ok := object(descriptor["Content"]); ok {
			for key := range content {
				record.ContentKeys = append(record.ContentKeys, key)
			}
			sort.Strings(record.ContentKeys)
		}
	}
	uri, _ := hostString(metadata["Uri"])
	record.URIPresent = uri != ""
	if spec.blobTrigger {
		record.CaseID = blobCaseID(uri)
	}
	var payload []byte
	switch spec.mode {
	case "body":
		text, ok := hostString(value)
		if !ok {
			return errors.New("binding string required")
		}
		payload = []byte(text)
		if spec.binding == "blob" {
			var err error
			payload, err = base64.StdEncoding.DecodeString(text)
			if err != nil { return errors.New("blob base64 decode") }
		}
	case "download", "metadata":
		if record.BindingKind != "object" || record.Source != "AzureStorageBlobs" {
			return errors.New("blob descriptor required")
		}
		if !record.URIPresent {
			return errors.New("blob uri required")
		}
		if spec.mode == "metadata" {
			return nil
		}
		var err error
		payload, err = downloadPrefix(ctx, h.connectionString, h.container, uri, h.httpClient)
		record.BytesRead = len(payload)
		if err != nil {
			return err
		}
	case "observe":
		return nil
	default:
		return errors.New("function configuration")
	}
	record.BytesRead = len(payload)
	digest := sha256.Sum256(payload)
	record.SHA256 = hex.EncodeToString(digest[:])
	return nil
}

func run() error {
	azlog.SetListener(nil)
	port, err := strconv.Atoi(os.Getenv("FUNCTIONS_CUSTOMHANDLER_PORT"))
	if err != nil || port < 1 || port > 65535 {
		return errors.New("handler port configuration")
	}
	if os.Getenv("CAPTURE_PATH") == "" {
		return errors.New("capture path configuration")
	}
	file, err := os.OpenFile(os.Getenv("CAPTURE_PATH"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return errors.New("capture open")
	}
	defer file.Close()
	transport := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		IdleConnTimeout:       60 * time.Second,
		DisableCompression:    true,
	}
	defer transport.CloseIdleConnections()
	h := &handler{
		capture:          &captureFile{file: file},
		connectionString: os.Getenv("AzureWebJobsStorage"),
		container:        os.Getenv("BLOG_CONTAINER"),
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   30 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server := &http.Server{
		Handler:           newMux(h),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       60 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return errors.New("handler listen")
	}
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	select {
	case err := <-served:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("handler serve")
		}
		return nil
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			_ = server.Close()
			return errors.New("handler shutdown")
		}
		return nil
	}
}

func main() {
	if err := run(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}