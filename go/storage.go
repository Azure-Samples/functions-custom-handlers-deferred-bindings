package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/blob"
)

func storageURL(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" ||
		u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || strings.Contains(value, "#") {
		return nil, errors.New("blob url validation")
	}
	if strings.ContainsAny(u.Path, "\\") || strings.Contains(u.Path, "//") {
		return nil, errors.New("blob path validation")
	}
	for _, c := range u.Path {
		if c < 32 || c == 127 {
			return nil, errors.New("blob path validation")
		}
	}
	for _, part := range strings.Split(u.Path, "/") {
		if part == "." || part == ".." {
			return nil, errors.New("blob path validation")
		}
	}
	return u, nil
}

func validatedBlobName(connectionString, container, uri string) (string, error) {
	fields := make(map[string]string)
	seen := make(map[string]bool)
	for _, field := range strings.Split(strings.TrimRight(connectionString, ";"), ";") {
		key, value, ok := strings.Cut(field, "=")
		canonical := strings.ToLower(key)
		if !ok || key == "" || seen[canonical] {
			return "", errors.New("storage configuration")
		}
		seen[canonical] = true
		fields[key] = value
	}
	endpoint, err := storageURL(fields["BlobEndpoint"])
	if err != nil {
		return "", errors.New("blob endpoint configuration")
	}
	if len(container) < 3 || len(container) > 63 || strings.HasPrefix(container, "-") ||
		strings.HasSuffix(container, "-") || strings.Contains(container, "--") {
		return "", errors.New("container configuration")
	}
	for _, c := range container {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
			return "", errors.New("container configuration")
		}
	}
	u, err := storageURL(uri)
	if err != nil {
		return "", err
	}
	if u.Scheme != endpoint.Scheme || u.Host != endpoint.Host {
		return "", errors.New("blob origin validation")
	}
	prefix := strings.TrimSuffix(endpoint.Path, "/") + "/" + container + "/"
	if !strings.HasPrefix(u.Path, prefix) {
		return "", errors.New("blob container validation")
	}
	name := strings.TrimPrefix(u.Path, prefix)
	if name == "" || strings.HasSuffix(name, "/") {
		return "", errors.New("blob name validation")
	}
	return name, nil
}

func downloadPrefix(ctx context.Context, connectionString, container, uri string, httpClient *http.Client) ([]byte, error) {
	name, err := validatedBlobName(connectionString, container, uri)
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, errors.New("blob canceled")
	}
	options := &azblob.ClientOptions{}
	options.Transport = httpClient
	options.Retry.MaxRetries = -1
	client, err := azblob.NewClientFromConnectionString(connectionString, options)
	if err != nil {
		return nil, errors.New("blob client creation")
	}
	var httpResponse *http.Response
	ctx = policy.WithCaptureResponse(ctx, &httpResponse)
	response, err := client.DownloadStream(ctx, container, name, &azblob.DownloadStreamOptions{
		Range: blob.HTTPRange{Offset: 0, Count: 5},
	})
	if err != nil {
		if httpResponse != nil && httpResponse.Body != nil {
			_ = httpResponse.Body.Close()
		}
		return nil, errors.New("blob download")
	}
	if response.Body == nil {
		return nil, errors.New("blob response body")
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 6))
	closeErr := response.Body.Close()
	if readErr != nil {
		return data, errors.New("blob read")
	}
	if closeErr != nil {
		return data, errors.New("blob close")
	}
	if ctx.Err() != nil {
		return data, errors.New("blob canceled")
	}
	if len(data) != 5 {
		return data, errors.New("blob range length")
	}
	return data, nil
}