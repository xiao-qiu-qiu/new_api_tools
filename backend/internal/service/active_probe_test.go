package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

func TestActiveProbeRetriesWithMaxTokens(t *testing.T) {
	var requests atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var payload map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode chat payload: %v", err)
		}
		messages, _ := payload["messages"].([]interface{})
		if len(messages) != 1 || messages[0].(map[string]interface{})["content"] != "1" {
			t.Fatalf("probe prompt was not minimal: %+v", payload["messages"])
		}
		if _, ok := payload["max_tokens"]; ok {
			w.WriteHeader(http.StatusOK)
			return
		}
		if _, ok := payload["max_completion_tokens"]; !ok {
			t.Fatal("first request did not include max_completion_tokens")
		}
		w.WriteHeader(http.StatusBadRequest)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	result := checkChatEndpoint(context.Background(), server.Client(), ActiveProbeConfig{
		BaseURL: server.URL,
		Token:   "test-secret",
	}, "reasoning-model", "test-secret")
	if !result.ChatOK || result.HTTPStatus != http.StatusOK {
		t.Fatalf("unexpected fallback result: %+v", result)
	}
	if requests.Load() != 2 {
		t.Fatalf("expected 2 requests, got %d", requests.Load())
	}
}

func TestActiveProbeTokenMetadataPersistsWithoutExposingSecret(t *testing.T) {
	cache.Get().Delete(probeConfigKey)
	defer cache.Get().Delete(probeConfigKey)

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer metadata-secret" {
			t.Fatalf("unexpected authorization header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"model-z"},{"id":"model-a"},{"id":"model-a"}]}`))
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	svc := NewActiveProbeService()
	view, err := svc.AddToken("metadata-secret", "初始备注", []string{"manual-b", "manual-a", "manual-a"})
	if err != nil {
		t.Fatalf("add token: %v", err)
	}
	if len(view.Tokens) != 1 || strings.Join(view.Tokens[0].Models, ",") != "manual-a,manual-b" {
		t.Fatalf("unexpected initial token metadata: %+v", view.Tokens)
	}

	models, err := svc.FetchModelsByTokenID(context.Background(), server.URL, view.Tokens[0].ID)
	if err != nil {
		t.Fatalf("fetch token models: %v", err)
	}
	if strings.Join(models, ",") != "model-a,model-z" {
		t.Fatalf("models were not normalized: %v", models)
	}
	view = svc.GetConfigView()
	if strings.Join(view.Tokens[0].Models, ",") != "model-a,model-z" {
		t.Fatalf("fetched models were not persisted: %+v", view.Tokens[0])
	}

	view, err = svc.UpdateTokenLabel(view.Tokens[0].ID, "生产分组")
	if err != nil || view.Tokens[0].Label != "生产分组" {
		t.Fatalf("update token label: view=%+v err=%v", view, err)
	}
	encoded, _ := json.Marshal(view)
	if strings.Contains(string(encoded), "metadata-secret") {
		t.Fatal("config view leaked token")
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

func TestActiveProbeUsesTokenModelVisibilityToAvoidDuplicateChatChecks(t *testing.T) {
	cache.Get().Delete(probeConfigKey)
	cache.Get().Delete(probeHistoryKey)
	defer cache.Get().Delete(probeConfigKey)
	defer cache.Get().Delete(probeHistoryKey)

	var mu sync.Mutex
	chatCalls := map[string]int{}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") == "Bearer token-a" {
			_, _ = w.Write([]byte(`{"data":[{"id":"model-a"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"model-b"}]}`))
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode chat payload: %v", err)
		}
		mu.Lock()
		chatCalls[payload.Model]++
		mu.Unlock()
		if (payload.Model == "model-a" && r.Header.Get("Authorization") != "Bearer token-a") || (payload.Model == "model-b" && r.Header.Get("Authorization") != "Bearer token-b") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	svc := NewActiveProbeService()
	if _, err := svc.SetConfig(ActiveProbeConfigInput{
		Enabled: true, BaseURL: server.URL, Models: []string{"model-a", "model-b", "model-c"},
		IntervalSeconds: 30, TimeoutSeconds: 3, ProbeMode: "chat", Token: "token-a",
	}); err != nil {
		t.Fatalf("set config: %v", err)
	}
	cfg := svc.GetConfig()
	cfg.Tokens = []activeProbeToken{{ID: "a", Label: "A", Token: "token-a"}, {ID: "b", Label: "B", Token: "token-b"}}
	if err := cache.Get().Set(probeConfigKey, cfg, 0); err != nil {
		t.Fatalf("store tokens: %v", err)
	}
	models, err := svc.FetchModelsByTokenID(context.Background(), server.URL, "a")
	if err != nil || len(models) != 1 || models[0] != "model-a" {
		t.Fatalf("fetch stored token models: models=%v err=%v", models, err)
	}

	results, err := svc.RunNow(context.Background())
	if err != nil {
		t.Fatalf("run probe: %v", err)
	}
	for _, result := range results {
		if result.Model == "model-c" {
			if result.ModelsOK || result.ChatChecked || result.ChatOK || result.ErrorCode != "model_unavailable" {
				t.Fatalf("unexpected unavailable-model result: %+v", result)
			}
			continue
		}
		if !result.ModelsOK || !result.ChatChecked || !result.ChatOK {
			t.Fatalf("unexpected result: %+v", result)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if chatCalls["model-a"] != 1 || chatCalls["model-b"] != 1 {
		t.Fatalf("expected one chat request per model, got %+v", chatCalls)
	}
	if chatCalls["model-c"] != 0 {
		t.Fatalf("unsupported model should not use chat tokens, got %+v", chatCalls)
	}
}

func TestActiveProbeLegacyTokenMigrationAndCompactWireFormat(t *testing.T) {
	cfg := ActiveProbeConfig{Token: "test-secret"}
	normalizeActiveProbeConfig(&cfg)
	if cfg.Token != "" || len(cfg.Tokens) != 1 || cfg.Tokens[0].Token != "test-secret" {
		t.Fatalf("legacy token was not migrated: %+v", cfg)
	}
	viewJSON, err := json.Marshal(activeProbeConfigView(cfg))
	if err != nil {
		t.Fatalf("marshal config view: %v", err)
	}
	if strings.Contains(string(viewJSON), "test-secret") {
		t.Fatal("config view leaked token")
	}
	resultJSON, err := json.Marshal(ActiveProbeResult{Model: "model-a", CheckedAt: 1, LatencyMS: 2, ModelsOK: true, ChatChecked: true, ChatOK: true})
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	encoded := string(resultJSON)
	for _, field := range []string{"checked_at", "latency_ms", "models_ok", "chat_ok", "error_code"} {
		if strings.Contains(encoded, field) {
			t.Fatalf("compact result contains long field %q: %s", field, encoded)
		}
	}

	var migrated ActiveProbeResult
	if err := json.Unmarshal([]byte(`{"model":"legacy-model","checked_at":10,"latency_ms":20,"models_ok":true,"chat_ok":false,"http_status":503,"error_code":"chat_http"}`), &migrated); err != nil {
		t.Fatalf("unmarshal legacy result: %v", err)
	}
	if migrated.Model != "legacy-model" || migrated.CheckedAt != 10 || migrated.LatencyMS != 20 || !migrated.ModelsOK || !migrated.ChatChecked || migrated.ChatOK || migrated.HTTPStatus != 503 || migrated.ErrorCode != "chat_http" {
		t.Fatalf("legacy result was not migrated: %+v", migrated)
	}
}
