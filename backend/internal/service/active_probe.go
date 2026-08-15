package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/new-api-tools/backend/internal/cache"
	"github.com/new-api-tools/backend/internal/logger"
)

const (
	probeConfigKey       = "model_status:probe:config"
	probeHistoryKey      = "model_status:probe:history"
	probeHistoryCap      = 200
	probeConcurrency     = 4
	probeShutdownPadding = 10 * time.Second
)

type ActiveProbeConfig struct {
	Enabled         bool     `json:"enabled"`
	BaseURL         string   `json:"base_url"`
	Models          []string `json:"models"`
	IntervalSeconds int      `json:"interval_seconds"`
	TimeoutSeconds  int      `json:"timeout_seconds"`
	Token           string   `json:"token"`
}

type ActiveProbeConfigInput struct {
	Enabled         bool     `json:"enabled"`
	BaseURL         string   `json:"base_url"`
	Models          []string `json:"models"`
	IntervalSeconds int      `json:"interval_seconds"`
	TimeoutSeconds  int      `json:"timeout_seconds"`
	Token           string   `json:"token"`
	ClearToken      bool     `json:"clear_token"`
}

type ActiveProbeConfigView struct {
	Enabled         bool     `json:"enabled"`
	BaseURL         string   `json:"base_url"`
	Models          []string `json:"models"`
	IntervalSeconds int      `json:"interval_seconds"`
	TimeoutSeconds  int      `json:"timeout_seconds"`
	HasToken        bool     `json:"has_token"`
}

// ActiveProbeResult contains only bounded metadata. Upstream response bodies
// and credentials are never persisted or returned.
type ActiveProbeResult struct {
	Model      string `json:"model"`
	CheckedAt  int64  `json:"checked_at"`
	LatencyMS  int64  `json:"latency_ms"`
	ModelsOK   bool   `json:"models_ok"`
	ChatOK     bool   `json:"chat_ok"`
	HTTPStatus int    `json:"http_status,omitempty"`
	ErrorCode  string `json:"error_code,omitempty"`
}

type ActiveProbeSummary struct {
	Enabled   bool                `json:"enabled"`
	Running   bool                `json:"running"`
	LastRunAt int64               `json:"last_run_at,omitempty"`
	Results   []ActiveProbeResult `json:"results"`
}

type ActiveProbeService struct {
	mu      sync.Mutex
	running bool
}

var activeProbe = &ActiveProbeService{}

func NewActiveProbeService() *ActiveProbeService {
	return activeProbe
}

func defaultActiveProbeConfig() ActiveProbeConfig {
	return ActiveProbeConfig{
		Enabled:         false,
		BaseURL:         strings.TrimRight(strings.TrimSpace(os.Getenv("NEWAPI_BASEURL")), "/"),
		Models:          []string{},
		IntervalSeconds: 300,
		TimeoutSeconds:  20,
		Token:           strings.TrimSpace(os.Getenv("NEWAPI_PROBE_TOKEN")),
	}
}

func (s *ActiveProbeService) GetConfig() ActiveProbeConfig {
	cfg := defaultActiveProbeConfig()
	var stored ActiveProbeConfig
	if found, err := cache.Get().GetJSON(probeConfigKey, &stored); err == nil && found {
		cfg = stored
	}
	normalizeActiveProbeConfig(&cfg)
	return cfg
}

func (s *ActiveProbeService) GetConfigView() ActiveProbeConfigView {
	return activeProbeConfigView(s.GetConfig())
}

func activeProbeConfigView(cfg ActiveProbeConfig) ActiveProbeConfigView {
	return ActiveProbeConfigView{
		Enabled:         cfg.Enabled,
		BaseURL:         cfg.BaseURL,
		Models:          append([]string(nil), cfg.Models...),
		IntervalSeconds: cfg.IntervalSeconds,
		TimeoutSeconds:  cfg.TimeoutSeconds,
		HasToken:        cfg.Token != "",
	}
}

func normalizeActiveProbeConfig(cfg *ActiveProbeConfig) {
	cfg.BaseURL = strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if cfg.IntervalSeconds < 30 {
		cfg.IntervalSeconds = 30
	}
	if cfg.IntervalSeconds > 86400 {
		cfg.IntervalSeconds = 86400
	}
	if cfg.TimeoutSeconds < 3 {
		cfg.TimeoutSeconds = 3
	}
	if cfg.TimeoutSeconds > 120 {
		cfg.TimeoutSeconds = 120
	}

	seen := make(map[string]struct{}, len(cfg.Models))
	models := make([]string, 0, len(cfg.Models))
	for _, model := range cfg.Models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		if _, exists := seen[model]; exists {
			continue
		}
		seen[model] = struct{}{}
		models = append(models, model)
	}
	cfg.Models = models
}

func validateProbeBaseURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return errors.New("NEWAPI 地址格式不正确")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New("NEWAPI 地址仅支持 http 或 https")
	}
	return nil
}

func (s *ActiveProbeService) SetConfig(input ActiveProbeConfigInput) (ActiveProbeConfigView, error) {
	current := s.GetConfig()
	next := ActiveProbeConfig{
		Enabled:         input.Enabled,
		BaseURL:         input.BaseURL,
		Models:          input.Models,
		IntervalSeconds: input.IntervalSeconds,
		TimeoutSeconds:  input.TimeoutSeconds,
		Token:           current.Token,
	}
	if input.ClearToken {
		next.Token = ""
	} else if strings.TrimSpace(input.Token) != "" {
		next.Token = strings.TrimSpace(input.Token)
	}
	normalizeActiveProbeConfig(&next)
	if next.BaseURL != "" {
		if err := validateProbeBaseURL(next.BaseURL); err != nil {
			return ActiveProbeConfigView{}, err
		}
	}
	if next.Enabled {
		if next.BaseURL == "" {
			return ActiveProbeConfigView{}, errors.New("开启主动探测前请填写 NEWAPI 地址")
		}
		if next.Token == "" {
			return ActiveProbeConfigView{}, errors.New("开启主动探测前请填写测试令牌")
		}
		if len(next.Models) == 0 {
			return ActiveProbeConfigView{}, errors.New("开启主动探测前请至少选择一个模型")
		}
	}
	if err := cache.Get().Set(probeConfigKey, next, 0); err != nil {
		return ActiveProbeConfigView{}, err
	}
	return activeProbeConfigView(next), nil
}

func (s *ActiveProbeService) IsRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

func (s *ActiveProbeService) setRunning(running bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if running && s.running {
		return false
	}
	s.running = running
	return true
}

func (s *ActiveProbeService) RunNow(ctx context.Context) ([]ActiveProbeResult, error) {
	if !s.setRunning(true) {
		return nil, errors.New("主动探测正在运行")
	}
	defer s.setRunning(false)

	cfg := s.GetConfig()
	if cfg.BaseURL == "" || cfg.Token == "" {
		return nil, errors.New("主动探测地址或测试令牌未配置")
	}
	if len(cfg.Models) == 0 {
		return nil, errors.New("主动探测模型未配置")
	}

	client := &http.Client{Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second}
	modelsOK, modelsStatus, modelsError := checkModelsEndpoint(ctx, client, cfg)
	results := make([]ActiveProbeResult, len(cfg.Models))
	if !modelsOK {
		now := time.Now().Unix()
		for i, model := range cfg.Models {
			results[i] = ActiveProbeResult{
				Model:      model,
				CheckedAt:  now,
				ModelsOK:   false,
				ChatOK:     false,
				HTTPStatus: modelsStatus,
				ErrorCode:  modelsError,
			}
		}
		if err := s.appendHistory(results); err != nil {
			return results, err
		}
		return results, nil
	}

	var wg sync.WaitGroup
	sem := make(chan struct{}, probeConcurrency)
	for i, model := range cfg.Models {
		wg.Add(1)
		go func(index int, modelName string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				results[index] = ActiveProbeResult{
					Model: modelName, CheckedAt: time.Now().Unix(), ModelsOK: true,
					ErrorCode: "cancelled",
				}
				return
			}
			results[index] = checkChatEndpoint(ctx, client, cfg, modelName)
		}(i, model)
	}
	wg.Wait()
	if err := s.appendHistory(results); err != nil {
		return results, err
	}
	return results, nil
}

func checkModelsEndpoint(ctx context.Context, client *http.Client, cfg ActiveProbeConfig) (bool, int, string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.BaseURL+"/v1/models", nil)
	if err != nil {
		return false, 0, "models_request"
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	resp, err := client.Do(req)
	if err != nil {
		return false, 0, classifyProbeError(err, "models_network")
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false, resp.StatusCode, "models_http"
	}
	return true, resp.StatusCode, ""
}

func checkChatEndpoint(ctx context.Context, client *http.Client, cfg ActiveProbeConfig, model string) ActiveProbeResult {
	result := ActiveProbeResult{Model: model, CheckedAt: time.Now().Unix(), ModelsOK: true}
	started := time.Now()
	status, errorCode := sendChatProbe(ctx, client, cfg, model, "max_tokens")
	if errorCode == "" && status == http.StatusBadRequest {
		status, errorCode = sendChatProbe(ctx, client, cfg, model, "max_completion_tokens")
	}
	result.LatencyMS = time.Since(started).Milliseconds()
	if errorCode != "" {
		result.ErrorCode = errorCode
		return result
	}
	result.HTTPStatus = status
	result.ChatOK = status >= 200 && status < 300
	if !result.ChatOK {
		result.ErrorCode = "chat_http"
	}
	return result
}

func sendChatProbe(ctx context.Context, client *http.Client, cfg ActiveProbeConfig, model, tokenField string) (int, string) {
	payload := map[string]interface{}{
		"model":    model,
		"messages": []map[string]string{{"role": "user", "content": "ping"}},
		"stream":   false,
	}
	payload[tokenField] = 1
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, "chat_payload"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.BaseURL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return 0, "chat_request"
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return 0, classifyProbeError(err, "chat_network")
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, ""
}

func classifyProbeError(err error, fallback string) string {
	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
		return "timeout"
	}
	return fallback
}

func (s *ActiveProbeService) appendHistory(batch []ActiveProbeResult) error {
	var history []ActiveProbeResult
	if _, err := cache.Get().GetJSON(probeHistoryKey, &history); err != nil {
		return err
	}
	history = append(history, batch...)

	perModel := make(map[string]int)
	trimmed := make([]ActiveProbeResult, 0, len(history))
	for i := len(history) - 1; i >= 0; i-- {
		item := history[i]
		if perModel[item.Model] >= probeHistoryCap {
			continue
		}
		perModel[item.Model]++
		trimmed = append(trimmed, item)
	}
	for left, right := 0, len(trimmed)-1; left < right; left, right = left+1, right-1 {
		trimmed[left], trimmed[right] = trimmed[right], trimmed[left]
	}
	return cache.Get().Set(probeHistoryKey, trimmed, 0)
}

func (s *ActiveProbeService) GetHistory(model string, limit int) []ActiveProbeResult {
	if limit <= 0 || limit > probeHistoryCap {
		limit = 48
	}
	var history []ActiveProbeResult
	if found, err := cache.Get().GetJSON(probeHistoryKey, &history); err != nil || !found {
		return []ActiveProbeResult{}
	}
	filtered := make([]ActiveProbeResult, 0, limit)
	for i := len(history) - 1; i >= 0 && len(filtered) < limit; i-- {
		if model == "" || history[i].Model == model {
			filtered = append(filtered, history[i])
		}
	}
	for left, right := 0, len(filtered)-1; left < right; left, right = left+1, right-1 {
		filtered[left], filtered[right] = filtered[right], filtered[left]
	}
	return filtered
}

func (s *ActiveProbeService) GetSummary() ActiveProbeSummary {
	history := s.GetHistory("", probeHistoryCap)
	latest := make(map[string]ActiveProbeResult)
	var lastRun int64
	for _, item := range history {
		if item.CheckedAt >= latest[item.Model].CheckedAt {
			latest[item.Model] = item
		}
		if item.CheckedAt > lastRun {
			lastRun = item.CheckedAt
		}
	}
	results := make([]ActiveProbeResult, 0, len(latest))
	for _, item := range latest {
		results = append(results, item)
	}
	sort.Slice(results, func(i, j int) bool { return results[i].Model < results[j].Model })
	return ActiveProbeSummary{
		Enabled:   s.GetConfig().Enabled,
		Running:   s.IsRunning(),
		LastRunAt: lastRun,
		Results:   results,
	}
}

func RunActiveProbeScheduler(stop <-chan struct{}) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	var lastRun time.Time
	logger.L.System("[主动探测] 调度器已启动，功能默认关闭")

	for {
		select {
		case <-ticker.C:
			svc := NewActiveProbeService()
			cfg := svc.GetConfig()
			if !cfg.Enabled || svc.IsRunning() {
				continue
			}
			interval := time.Duration(cfg.IntervalSeconds) * time.Second
			if !lastRun.IsZero() && time.Since(lastRun) < interval {
				continue
			}
			lastRun = time.Now()
			ctx, cancel := context.WithTimeout(context.Background(), activeProbeRunTimeout(cfg))
			results, err := svc.RunNow(ctx)
			cancel()
			if err != nil {
				logger.L.Warn("[主动探测] 执行失败: " + err.Error())
				continue
			}
			passed := 0
			for _, result := range results {
				if result.ModelsOK && result.ChatOK {
					passed++
				}
			}
			logger.L.System(fmt.Sprintf("[主动探测] 完成 %d 个模型，通过 %d 个", len(results), passed))
		case <-stop:
			logger.L.System("[主动探测] 调度器已停止")
			return
		}
	}
}

func activeProbeRunTimeout(cfg ActiveProbeConfig) time.Duration {
	batches := (len(cfg.Models) + probeConcurrency - 1) / probeConcurrency
	// Include /v1/models and both possible chat parameter attempts per batch.
	requestWindows := 1 + 2*batches
	return time.Duration(requestWindows*cfg.TimeoutSeconds)*time.Second + probeShutdownPadding
}
