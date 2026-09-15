package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

const testConnection = "BlobEndpoint=http://127.0.0.1:19000/account;AccountName=account;AccountKey=a2V5"
const testURI = "http://127.0.0.1:19000/account/blog/folder/hello%20world.txt"

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func fakeClient(f roundTripFunc) *http.Client {
	return &http.Client{
		Transport: f,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func blobResponse(r *http.Request, body io.ReadCloser) *http.Response {
	return &http.Response{
		StatusCode: http.StatusPartialContent,
		Header:     http.Header{"Content-Range": []string{"bytes 0-4/37"}},
		Body:       body,
		Request:    r,
	}
}

type trackedBody struct {
	reader   io.Reader
	read     int
	closed   bool
	closeErr error
}

func (b *trackedBody) Read(p []byte) (int, error) {
	n, err := b.reader.Read(p)
	b.read += n
	return n, err
}

func (b *trackedBody) Close() error {
	b.closed = true
	return b.closeErr
}

func TestValidatedBlobName(t *testing.T) {
	for _, tc := range []struct {
		connection string
		uri        string
		want       string
	}{
		{testConnection, testURI, "folder/hello world.txt"},
		{testConnection, "http://127.0.0.1:19000/account/blog/a%2Fb.txt", "a/b.txt"},
		{testConnection, "http://127.0.0.1:19000/account/blog/%252e%252e.txt", "%2e%2e.txt"},
		{"BlobEndpoint=https://account.blob.core.windows.net/;AccountName=account;AccountKey=a2V5", "https://account.blob.core.windows.net/blog/hello.txt", "hello.txt"},
	} {
		name, err := validatedBlobName(tc.connection, "blog", tc.uri)
		if err != nil || name != tc.want {
			t.Fatal("valid blob name was not preserved")
		}
	}
}

func TestRejectedURIsNeverReachTransport(t *testing.T) {
	for _, uri := range []string{
		"", "/account/blog/file", "ftp://127.0.0.1:19000/account/blog/file",
		"https://127.0.0.1:19000/account/blog/file",
		"http://127.0.0.1:19001/account/blog/file",
		"http://127.0.0.1.evil:19000/account/blog/file",
		"http://user:pass@127.0.0.1:19000/account/blog/file",
		"http://127.0.0.1:19000/account2/blog/file",
		"http://127.0.0.1:19000/account/blog2/file",
		"http://127.0.0.1:19000/account/other/file",
		"http://127.0.0.1:19000/account/blog/../other/file",
		"http://127.0.0.1:19000/account/blog/%2e%2e/other/file",
		"http://127.0.0.1:19000/account/blog/a%2F..%2Ffile",
		"http://127.0.0.1:19000/account/blog/%5cfile",
		"http://127.0.0.1:19000/account/blog/%00file",
		"http://127.0.0.1:19000/account/blog//file",
		"http://127.0.0.1:19000/account/blog/",
		"http://127.0.0.1:19000/account/blog/file?sig=private",
		"http://127.0.0.1:19000/account/blog/file?",
		"http://127.0.0.1:19000/account/blog/file#private",
		"http://127.0.0.1:19000/account/blog/file#",
		"http://127.0.0.1:19000/account/blog/%zz",
	} {
		client := fakeClient(func(*http.Request) (*http.Response, error) {
			t.Error("invalid URI reached the transport")
			return nil, errors.New("unexpected transport")
		})
		if _, err := downloadPrefix(context.Background(), testConnection, "blog", uri, client); err == nil {
			t.Fatal("invalid URI was accepted")
		}
	}
}

func TestInvalidStorageConfiguration(t *testing.T) {
	for _, connection := range []string{
		"", "UseDevelopmentStorage=true", "AccountName=account;AccountKey=a2V5",
		testConnection + ";BlobEndpoint=http://elsewhere",
		testConnection + ";blobendpoint=http://elsewhere",
		testConnection + ";malformed",
		"BlobEndpoint=http://127.0.0.1:19000/account?sig=private;AccountName=account;AccountKey=a2V5",
	} {
		if _, err := validatedBlobName(connection, "blog", testURI); err == nil {
			t.Fatal("invalid storage configuration accepted")
		}
	}
	for _, container := range []string{"", "ab", "Blog", "blog/other", "-blog", "blog-", "blog--test", strings.Repeat("a", 64)} {
		if _, err := validatedBlobName(testConnection, container, testURI); err == nil {
			t.Fatal("invalid container accepted")
		}
	}
}

func TestDownloadPrefixRangeAndBodyLifetime(t *testing.T) {
	for _, tc := range []struct {
		body     string
		closeErr error
		wantRead int
		wantErr  string
	}{
		{"hello", nil, 5, ""},
		{"", nil, 0, "blob range length"},
		{"four", nil, 4, "blob range length"},
		{strings.Repeat("x", 128), nil, 6, "blob range length"},
		{"hello", errors.New("private close details"), 5, "blob close"},
	} {
		body := &trackedBody{reader: strings.NewReader(tc.body), closeErr: tc.closeErr}
		calls := 0
		client := fakeClient(func(r *http.Request) (*http.Response, error) {
			calls++
			rangeHeader := r.Header.Get("X-Ms-Range")
			if rangeHeader == "" {
				rangeHeader = strings.Join(r.Header["x-ms-range"], ",")
			}
			if r.Method != http.MethodGet || rangeHeader != "bytes=0-4" {
				t.Error("SDK request did not ask for bytes zero through four")
			}
			if r.URL.Scheme != "http" || r.URL.Host != "127.0.0.1:19000" ||
				r.URL.Path != "/account/blog/folder/hello world.txt" || r.URL.RawQuery != "" || r.Header.Get("Authorization") == "" {
				t.Error("SDK request did not use the validated target and configured credentials")
			}
			return blobResponse(r, body), nil
		})
		data, err := downloadPrefix(context.Background(), testConnection, "blog", testURI, client)
		if calls != 1 || !body.closed || body.read != tc.wantRead || len(data) != tc.wantRead {
			t.Fatal("incorrect request count, read limit, or body cleanup")
		}
		if tc.wantErr == "" {
			if err != nil || string(data) != tc.body {
				t.Fatal("five-byte range read failed")
			}
		} else if err == nil || err.Error() != tc.wantErr {
			t.Fatal("range failure was not safely reported")
		}
	}
}

type failedReader struct{}

func (failedReader) Read([]byte) (int, error) {
	return 0, errors.New("private read details")
}

func TestDownloadReadFailureClosesBody(t *testing.T) {
	body := &trackedBody{reader: failedReader{}}
	client := fakeClient(func(r *http.Request) (*http.Response, error) {
		return blobResponse(r, body), nil
	})
	_, err := downloadPrefix(context.Background(), testConnection, "blog", testURI, client)
	if err == nil || err.Error() != "blob read" || !body.closed {
		t.Fatal("failed read did not close its body and sanitize the error")
	}
}

func TestMalformedSDKResponseClosesBody(t *testing.T) {
	body := &trackedBody{reader: strings.NewReader("hello")}
	client := fakeClient(func(r *http.Request) (*http.Response, error) {
		response := blobResponse(r, body)
		response.Header.Set("Content-Length", "invalid")
		return response, nil
	})
	_, err := downloadPrefix(context.Background(), testConnection, "blog", testURI, client)
	if err == nil || err.Error() != "blob download" || !body.closed {
		t.Fatal("SDK response decoding failure leaked its body or error details")
	}
}

func TestDownloadCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	client := fakeClient(func(r *http.Request) (*http.Response, error) {
		cancel()
		if r.Context().Err() == nil {
			t.Error("request cancellation did not reach the SDK transport")
		}
		return nil, r.Context().Err()
	})
	_, err := downloadPrefix(ctx, testConnection, "blog", testURI, client)
	if err == nil || err.Error() != "blob download" {
		t.Fatal("canceled download did not return a safe error")
	}
}

func TestDownloadDoesNotFollowRedirects(t *testing.T) {
	calls := 0
	client := fakeClient(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{
			StatusCode: http.StatusTemporaryRedirect,
			Header:     http.Header{"Location": []string{"https://elsewhere.invalid/private"}},
			Body:       io.NopCloser(strings.NewReader("")),
			Request:    r,
		}, nil
	})
	_, err := downloadPrefix(context.Background(), testConnection, "blog", testURI, client)
	if err == nil || err.Error() != "blob download" || calls != 1 {
		t.Fatal("redirect escaped the validated storage target")
	}
}