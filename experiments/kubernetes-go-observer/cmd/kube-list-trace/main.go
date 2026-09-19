package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	kubeobserver "overcenter-research/experiments/kubernetes-go-observer"
)

func main() {
	baseURL := flag.String("base-url", "", "Kubernetes API base URL, e.g. a trusted kubectl proxy")
	authorityID := flag.String("authority-id", "", "caller-established canonical Kubernetes authority identity")
	namespace := flag.String("namespace", "", "namespace to list")
	limit := flag.Int("limit", 100, "Kubernetes LIST page size")
	maxPages := flag.Int("max-pages", 1000, "maximum pages before failing closed")
	timeout := flag.Duration("timeout", 30*time.Second, "whole-trace timeout")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	trace, err := kubeobserver.CollectListTrace(ctx, kubeobserver.Config{
		BaseURL:     *baseURL,
		AuthorityID: *authorityID,
		Namespace:   *namespace,
		Limit:       *limit,
		MaxPages:    *maxPages,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(trace); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
