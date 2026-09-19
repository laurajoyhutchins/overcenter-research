package kubeobserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func cfg(baseURL string) Config {
	return Config{
		BaseURL:     baseURL,
		AuthorityID: "kind:test-cluster",
		Namespace:   "proof",
		Limit:       1,
		MaxPages:    10,
	}
}

func listBody(rv, next string) string {
	return fmt.Sprintf(`{"apiVersion":"v1","kind":"ConfigMapList","metadata":{"resourceVersion":%q,"continue":%q},"items":[]}`, rv, next)
}

func decodedBody(t *testing.T, page Page) []byte {
	t.Helper()
	body, err := base64.StdEncoding.DecodeString(page.Response.BodyBase64)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestCollectsCompletePaginationWithoutMintingSemantics(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := calls.Add(1)
		if got := r.URL.Query().Get("limit"); got != "1" {
			t.Fatalf("limit = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch call {
		case 1:
			if got := r.URL.Query().Get("continue"); got != "" {
				t.Fatalf("first continue = %q", got)
			}
			fmt.Fprint(w, listBody("500", "token-1"))
		case 2:
			if got := r.URL.Query().Get("continue"); got != "token-1" {
				t.Fatalf("second continue = %q", got)
			}
			fmt.Fprint(w, listBody("500", ""))
		default:
			t.Fatalf("unexpected request %d", call)
		}
	}))
	defer server.Close()

	trace, err := CollectListTrace(context.Background(), cfg(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	if len(trace.Pages) != 2 {
		t.Fatalf("pages = %d", len(trace.Pages))
	}
	if trace.Pages[0].Request.ContinueToken != nil {
		t.Fatalf("first continuation must be null")
	}
	if got := *trace.Pages[1].Request.ContinueToken; got != "token-1" {
		t.Fatalf("second continuation = %q", got)
	}
	if trace.OperationID != OperationID || trace.AuthorityID != "kind:test-cluster" {
		t.Fatalf("trace identity = %#v", trace)
	}
	if !strings.HasPrefix(trace.Pages[0].Response.BodySHA256, "sha256:") {
		t.Fatalf("body digest = %q", trace.Pages[0].Response.BodySHA256)
	}
}

func TestRecords410AndStopsWithoutInterpretingIt(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusGone)
		fmt.Fprint(w, `{"kind":"Status","code":410,"reason":"Expired"}`)
	}))
	defer server.Close()

	trace, err := CollectListTrace(context.Background(), cfg(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 || len(trace.Pages) != 1 {
		t.Fatalf("calls=%d pages=%d", calls.Load(), len(trace.Pages))
	}
	if trace.Pages[0].Response.Status != 410 {
		t.Fatalf("status=%d", trace.Pages[0].Response.Status)
	}
	if got := string(decodedBody(t, trace.Pages[0])); !strings.Contains(got, `"code":410`) {
		t.Fatalf("body=%q", got)
	}
}

func TestResourceVersionDriftIsPreservedForSemanticLayer(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			fmt.Fprint(w, listBody("500", "next"))
			return
		}
		fmt.Fprint(w, listBody("501", ""))
	}))
	defer server.Close()

	trace, err := CollectListTrace(context.Background(), cfg(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	if len(trace.Pages) != 2 {
		t.Fatalf("pages=%d", len(trace.Pages))
	}
	var first, second struct {
		Metadata struct {
			ResourceVersion string `json:"resourceVersion"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(decodedBody(t, trace.Pages[0]), &first); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(decodedBody(t, trace.Pages[1]), &second); err != nil {
		t.Fatal(err)
	}
	if first.Metadata.ResourceVersion != "500" || second.Metadata.ResourceVersion != "501" {
		t.Fatalf("resourceVersions=%q,%q", first.Metadata.ResourceVersion, second.Metadata.ResourceVersion)
	}
}

func TestRepeatedContinuationFailsInsteadOfLooping(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, listBody("500", "same"))
	}))
	defer server.Close()

	_, err := CollectListTrace(context.Background(), cfg(server.URL))
	if err == nil || !strings.Contains(err.Error(), "continuation did not advance") {
		t.Fatalf("err=%v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls=%d", calls.Load())
	}
}

func TestCancellationAbortsTransport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := CollectListTrace(ctx, cfg(server.URL))
	if err == nil || !strings.Contains(err.Error(), "context deadline exceeded") {
		t.Fatalf("err=%v", err)
	}
}

func TestMalformedSuccessfulPageFailsAcquisition(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"apiVersion":"v1","kind":"ConfigMapList","items":[]}`)
	}))
	defer server.Close()

	_, err := CollectListTrace(context.Background(), cfg(server.URL))
	if err == nil || !strings.Contains(err.Error(), "metadata missing") {
		t.Fatalf("err=%v", err)
	}
}
