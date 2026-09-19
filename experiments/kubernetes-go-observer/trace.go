package kubeobserver

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	TraceSchema = "overcenter.kubernetes-list-trace/v1"
	Provider    = "kubernetes"
	APIVersion  = "v1"
	OperationID = "listCoreV1NamespacedConfigMap"
)

type Config struct {
	BaseURL     string
	AuthorityID string
	Namespace   string
	Limit       int
	MaxPages    int
	Client      *http.Client
}

type Trace struct {
	Schema      string `json:"schema"`
	Provider    string `json:"provider"`
	APIVersion  string `json:"api_version"`
	OperationID string `json:"operation_id"`
	AuthorityID string `json:"authority_id"`
	Namespace   string `json:"namespace"`
	Limit       int    `json:"limit"`
	Pages       []Page `json:"pages"`
}

type Page struct {
	ObservedAt string       `json:"observed_at"`
	Request    PageRequest  `json:"request"`
	Response   PageResponse `json:"response"`
}

type PageRequest struct {
	Namespace     string  `json:"namespace"`
	ContinueToken *string `json:"continue_token"`
	Limit         int     `json:"limit"`
	Path          string  `json:"path"`
}

type PageResponse struct {
	Status     int    `json:"status"`
	BodyBase64 string `json:"body_base64"`
	BodySHA256 string `json:"body_sha256"`
}

type listEnvelope struct {
	Metadata *struct {
		Continue string `json:"continue"`
	} `json:"metadata"`
}

func CollectListTrace(ctx context.Context, cfg Config) (Trace, error) {
	trace := Trace{
		Schema:      TraceSchema,
		Provider:    Provider,
		APIVersion:  APIVersion,
		OperationID: OperationID,
		AuthorityID: cfg.AuthorityID,
		Namespace:   cfg.Namespace,
		Limit:       cfg.Limit,
		Pages:       []Page{},
	}
	if err := validateConfig(cfg); err != nil {
		return trace, err
	}

	client := cfg.Client
	if client == nil {
		client = http.DefaultClient
	}

	var continueToken *string
	for pageNumber := 1; pageNumber <= cfg.MaxPages; pageNumber++ {
		path := listPath(cfg.Namespace, cfg.Limit, continueToken)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(cfg.BaseURL, "/")+path, nil)
		if err != nil {
			return trace, fmt.Errorf("build request: %w", err)
		}
		req.Header.Set("Accept", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			return trace, fmt.Errorf("list page %d: %w", pageNumber, err)
		}
		body, readErr := io.ReadAll(resp.Body)
		closeErr := resp.Body.Close()
		if readErr != nil {
			return trace, fmt.Errorf("read list page %d: %w", pageNumber, readErr)
		}
		if closeErr != nil {
			return trace, fmt.Errorf("close list page %d: %w", pageNumber, closeErr)
		}

		bodyDigest := sha256.Sum256(body)
		requestToken := cloneStringPointer(continueToken)
		trace.Pages = append(trace.Pages, Page{
			ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
			Request: PageRequest{
				Namespace:     cfg.Namespace,
				ContinueToken: requestToken,
				Limit:         cfg.Limit,
				Path:          path,
			},
			Response: PageResponse{
				Status:     resp.StatusCode,
				BodyBase64: base64.StdEncoding.EncodeToString(body),
				BodySHA256: fmt.Sprintf("sha256:%x", bodyDigest),
			},
		})

		// Non-200 responses are evidence too. Record exact response bytes and
		// stop. The semantic layer decides whether a particular status means
		// expired, absent, retryable, or indeterminate.
		if resp.StatusCode != http.StatusOK {
			return trace, nil
		}

		// Parsing continue is transport control only. ResourceVersion, object
		// identity, completeness, and absence semantics remain outside Go.
		var envelope listEnvelope
		if err := json.Unmarshal(body, &envelope); err != nil {
			return trace, fmt.Errorf("decode list page %d: %w", pageNumber, err)
		}
		if envelope.Metadata == nil {
			return trace, fmt.Errorf("decode list page %d: metadata missing", pageNumber)
		}

		next := envelope.Metadata.Continue
		if next == "" {
			return trace, nil
		}
		if continueToken != nil && next == *continueToken {
			return trace, fmt.Errorf("list page %d: continuation did not advance", pageNumber)
		}
		continueToken = &next
	}

	return trace, fmt.Errorf("pagination exceeded max pages: %d", cfg.MaxPages)
}

func validateConfig(cfg Config) error {
	if cfg.BaseURL == "" {
		return errors.New("base URL is required")
	}
	parsed, err := url.Parse(cfg.BaseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return errors.New("base URL must be an absolute URL")
	}
	if cfg.AuthorityID == "" {
		return errors.New("authority ID is required")
	}
	if cfg.Namespace == "" {
		return errors.New("namespace is required")
	}
	if cfg.Limit <= 0 {
		return errors.New("limit must be positive")
	}
	if cfg.MaxPages <= 0 {
		return errors.New("max pages must be positive")
	}
	return nil
}

func listPath(namespace string, limit int, continueToken *string) string {
	query := url.Values{}
	query.Set("limit", fmt.Sprintf("%d", limit))
	if continueToken != nil {
		query.Set("continue", *continueToken)
	}
	return fmt.Sprintf(
		"/api/v1/namespaces/%s/configmaps?%s",
		url.PathEscape(namespace),
		query.Encode(),
	)
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
