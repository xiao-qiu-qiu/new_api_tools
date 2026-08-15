package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/new-api-tools/backend/internal/cache"
)

func TestActiveProbeRunsModelsAndChatWithoutExposingToken(t *testing.T) {
	cache.Get().Delete(probeConfigKey)
	cache.Get().Delete(probeHistoryKey)
	defer cache.Get().Delete(probeConfigKey)
	defer cache.Get().Delete(probeHistoryKey)

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Fatalf("unexpected authorization header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"model-a"},{"id":"model-b"}]}`))
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode chat payload: %v", err)
		}
		if payload["model"] == "" {
			t.Fatalf("model is required")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"pong"}}]}`))
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	svc := NewActiveProbeService()
	view, err := svc.SetConfig(ActiveProbeConfigInput{
		Enabled: true, BaseURL: server.URL, Models: []string{"model-a", "model-b"},
		IntervalSeconds: 30, TimeoutSeconds: 3, Token: "test-secret",
	})
	if err != nil {
		t.Fatalf("set config: %v", err)
	}
	if !view.HasToken {
		t.Fatal("expected token marker")
	}
	encodedView, _ := json.Marshal(view)
	if strings.Contains(string(encodedView), "test-secret") {
		t.Fatal("config view leaked probe token")
	}

	results, err := svc.RunNow(context.Background())
	if err != nil {
		t.Fatalf("run probe: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	for _, result := range results {
		if !result.ModelsOK || !result.ChatOK || result.HTTPStatus != http.StatusOK {
			t.Fatalf("unexpected probe result: %+v", result)
		}
	}

	history := svc.GetHistory("model-a", 10)
	if len(history) != 1 || history[0].Model != "model-a" {
		t.Fatalf("unexpected history: %+v", history)
	}
	if summary := svc.GetSummary(); len(summary.Results) != 2 || summary.LastRunAt == 0 {
		t.Fatalf("unexpected summary: %+v", summary)
	}
}

func TestActiveProbeRetriesWithMaxCompletionTokens(t *testing.T) {
	var requests atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var payload map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode chat payload: %v", err)
		}
		if _, ok := payload["max_completion_tokens"]; ok {
			w.WriteHeader(http.StatusOK)
			return
		}
		if _, ok := payload["max_tokens"]; !ok {
			t.Fatal("first request did not include max_tokens")
		}
		w.WriteHeader(http.StatusBadRequest)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	result := checkChatEndpoint(context.Background(), server.Client(), ActiveProbeConfig{
		BaseURL: server.URL,
		Token:   "test-secret",
	}, "reasoning-model")
	if !result.ChatOK || result.HTTPStatus != http.StatusOK {
		t.Fatalf("unexpected fallback result: %+v", result)
	}
	if requests.Load() != 2 {
		t.Fatalf("expected 2 requests, got %d", requests.Load())
	}
}

func TestActiveProbeRunTimeoutAccountsForConcurrencyBatches(t *testing.T) {
	cfg := ActiveProbeConfig{TimeoutSeconds: 20, Models: []string{"a", "b", "c", "d"}}
	if got, want := activeProbeRunTimeout(cfg), 70*time.Second; got != want {
		t.Fatalf("four models: got %s, want %s", got, want)
	}
	cfg.Models = append(cfg.Models, "e")
	if got, want := activeProbeRunTimeout(cfg), 110*time.Second; got != want {
		t.Fatalf("five models: got %s, want %s", got, want)
	}
}
