package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
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
	Enabled         bool               `json:"enabled"`
	BaseURL         string             `json:"base_url"`
	Models          []string           `json:"models"`
	IntervalSeconds int                `json:"interval_seconds"`
	TimeoutSeconds  int                `json:"timeout_seconds"`
	ProbeMode       string             `json:"probe_mode"`
	Tokens          []activeProbeToken `json:"tokens"`
	Token           string             `json:"token,omitempty"` // legacy single-token storage
}

type activeProbeToken struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	Token       string   `json:"token"`
	Models      []string `json:"models,omitempty"`
	ProbeModels []string `json:"probe_models,omitempty"`
}

type ActiveProbeConfigInput struct {
	Enabled         bool     `json:"enabled"`
	BaseURL         string   `json:"base_url"`
	Models          []string `json:"models"`
	IntervalSeconds int      `json:"interval_seconds"`
	TimeoutSeconds  int      `json:"timeout_seconds"`
	ProbeMode       string   `json:"probe_mode"`
	Token           string   `json:"token"`
	ClearToken      bool     `json:"clear_token"`
}

type ActiveProbeConfigView struct {
	Enabled         bool                   `json:"enabled"`
	BaseURL         string                 `json:"base_url"`
	Models          []string               `json:"models"`
	IntervalSeconds int                    `json:"interval_seconds"`
	TimeoutSeconds  int                    `json:"timeout_seconds"`
	ProbeMode       string                 `json:"probe_mode"`
	Tokens          []ActiveProbeTokenView `json:"tokens"`
	TokenCount      int                    `json:"token_count"`
	HasToken        bool                   `json:"has_token"`
}

type ActiveProbeTokenView struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	HasToken    bool     `json:"has_token"`
	Models      []string `json:"models"`
	ProbeModels []string `json:"probe_models"`
}

// ActiveProbeResult contains only bounded metadata. Upstream response bodies
// and credentials are never persisted or returned.
type ActiveProbeResult struct {
	Model       string `json:"m"`
	CheckedAt   int64  `json:"t"`
	LatencyMS   int64  `json:"l,omitempty"`
	ModelsOK    bool   `json:"mo,omitempty"`
	ChatChecked bool   `json:"cc,omitempty"`
	ChatOK      bool   `json:"co,omitempty"`
	HTTPStatus  int    `json:"s,omitempty"`
	ErrorCode   string `json:"e,omitempty"`
}

func (r *ActiveProbeResult) UnmarshalJSON(data []byte) error {
	type compactResult ActiveProbeResult
	if err := json.Unmarshal(data, (*compactResult)(r)); err != nil {
		return err
	}

	var legacy struct {
		Model       string `json:"model"`
		CheckedAt   int64  `json:"checked_at"`
		LatencyMS   int64  `json:"latency_ms"`
		ModelsOK    *bool  `json:"models_ok"`
		ChatChecked *bool  `json:"chat_checked"`
		ChatOK      *bool  `json:"chat_ok"`
		HTTPStatus  int    `json:"http_status"`
		ErrorCode   string `json:"error_code"`
	}
	if err := json.Unmarshal(data, &legacy); err != nil {
		return err
	}
	if legacy.Model != "" {
		r.Model = legacy.Model
	}
	if legacy.CheckedAt != 0 {
		r.CheckedAt = legacy.CheckedAt
	}
	if legacy.LatencyMS != 0 {
		r.LatencyMS = legacy.LatencyMS
	}
	if legacy.ModelsOK != nil {
		r.ModelsOK = *legacy.ModelsOK
	}
	if legacy.ChatChecked != nil {
		r.ChatChecked = *legacy.ChatChecked
	} else if legacy.ChatOK != nil {
		r.ChatChecked = true
	}
	if legacy.ChatOK != nil {
		r.ChatOK = *legacy.ChatOK
	}
	if legacy.HTTPStatus != 0 {
		r.HTTPStatus = legacy.HTTPStatus
	}
	if legacy.ErrorCode != "" {
		r.ErrorCode = legacy.ErrorCode
	}
	return nil
}

type ActiveProbeSummary struct {
	Enabled   bool                `json:"on"`
	Running   bool                `json:"run"`
	LastRunAt int64               `json:"t,omitempty"`
	Results   []ActiveProbeResult `json:"r"`
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
		ProbeMode:       "chat",
		Tokens:          envProbeTokens(),
	}
}

func envProbeTokens() []activeProbeToken {
	raw := strings.TrimSpace(os.Getenv("NEWAPI_PROBE_TOKEN"))
	if raw == "" {
		return nil
	}
	return []activeProbeToken{{ID: "env-1", Label: "环境变量令牌", Token: raw}}
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
	tokens := make([]ActiveProbeTokenView, 0, len(cfg.Tokens))
	for _, token := range cfg.Tokens {
		tokens = append(tokens, ActiveProbeTokenView{
			ID: token.ID, Label: token.Label, HasToken: token.Token != "",
			Models: append([]string(nil), token.Models...), ProbeModels: append([]string(nil), token.ProbeModels...),
		})
	}
	return ActiveProbeConfigView{
		Enabled:         cfg.Enabled,
		BaseURL:         cfg.BaseURL,
		Models:          append([]string(nil), cfg.Models...),
		IntervalSeconds: cfg.IntervalSeconds,
		TimeoutSeconds:  cfg.TimeoutSeconds,
		ProbeMode:       cfg.ProbeMode,
		Tokens:          tokens,
		TokenCount:      len(tokens),
		HasToken:        len(tokens) > 0,
	}
}

func normalizeActiveProbeConfig(cfg *ActiveProbeConfig) {
	cfg.BaseURL = strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if cfg.ProbeMode != "models" && cfg.ProbeMode != "chat" {
		cfg.ProbeMode = "chat"
	}
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

	legacyModels := normalizeProbeModelNames(cfg.Models)

	if strings.TrimSpace(cfg.Token) != "" {
		cfg.Tokens = append(cfg.Tokens, activeProbeToken{ID: "legacy-1", Label: "旧版令牌", Token: strings.TrimSpace(cfg.Token)})
		cfg.Token = ""
	}
	seenTokens := make(map[string]struct{}, len(cfg.Tokens))
	tokens := make([]activeProbeToken, 0, len(cfg.Tokens))
	for index, token := range cfg.Tokens {
		token.Token = strings.TrimSpace(token.Token)
		if token.Token == "" {
			continue
		}
		if _, exists := seenTokens[token.Token]; exists {
			continue
		}
		seenTokens[token.Token] = struct{}{}
		if token.ID == "" {
			token.ID = fmt.Sprintf("probe-%d", index+1)
		}
		if strings.TrimSpace(token.Label) == "" {
			token.Label = fmt.Sprintf("令牌 %d", index+1)
		}
		token.Label = strings.TrimSpace(token.Label)
		token.Models = normalizeProbeModelNames(token.Models)
		if token.ProbeModels == nil {
			if len(legacyModels) > 0 {
				token.ProbeModels = filterProbeModelSelection(legacyModels, token.Models)
			} else if len(token.Models) > 0 {
				token.ProbeModels = append([]string(nil), token.Models...)
			}
		} else {
			token.ProbeModels = filterProbeModelSelection(token.ProbeModels, token.Models)
		}
		tokens = append(tokens, token)
	}
	cfg.Tokens = tokens
	cfg.Models = configuredProbeModels(tokens)
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
		ProbeMode:       input.ProbeMode,
		Tokens:          current.Tokens,
	}
	if input.ClearToken {
		next.Tokens = nil
	} else if strings.TrimSpace(input.Token) != "" {
		next.Tokens = append(next.Tokens, activeProbeToken{ID: "legacy-" + fmt.Sprint(time.Now().UnixNano()), Label: "新增令牌", Token: strings.TrimSpace(input.Token)})
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
		if len(next.Tokens) == 0 {
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

func newProbeTokenID() string {
	bytes := make([]byte, 8)
	if _, err := rand.Read(bytes); err == nil {
		return "probe-" + hex.EncodeToString(bytes)
	}
	return fmt.Sprintf("probe-%d", time.Now().UnixNano())
}

func normalizeProbeModelNames(models []string) []string {
	seen := make(map[string]struct{}, len(models))
	normalized := make([]string, 0, len(models))
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		if _, exists := seen[model]; exists {
			continue
		}
		seen[model] = struct{}{}
		normalized = append(normalized, model)
	}
	sort.Strings(normalized)
	return normalized
}

func filterProbeModelSelection(selected, available []string) []string {
	selected = normalizeProbeModelNames(selected)
	if len(available) == 0 {
		return selected
	}
	availableSet := modelSet(available)
	filtered := make([]string, 0, len(selected))
	for _, model := range selected {
		if _, ok := availableSet[model]; ok {
			filtered = append(filtered, model)
		}
	}
	return filtered
}

func configuredProbeModels(tokens []activeProbeToken) []string {
	models := make([]string, 0)
	for _, token := range tokens {
		models = append(models, token.ProbeModels...)
	}
	return normalizeProbeModelNames(models)
}

func (s *ActiveProbeService) AddToken(raw, label string, models []string) (ActiveProbeConfigView, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ActiveProbeConfigView{}, errors.New("测试令牌不能为空")
	}
	cfg := s.GetConfig()
	for _, token := range cfg.Tokens {
		if token.Token == raw {
			return activeProbeConfigView(cfg), nil
		}
	}
	cfg.Tokens = append(cfg.Tokens, activeProbeToken{
		ID: newProbeTokenID(), Label: strings.TrimSpace(label), Token: raw,
		Models: normalizeProbeModelNames(models), ProbeModels: normalizeProbeModelNames(models),
	})
	normalizeActiveProbeConfig(&cfg)
	if err := cache.Get().Set(probeConfigKey, cfg, 0); err != nil {
		return ActiveProbeConfigView{}, err
	}
	return activeProbeConfigView(cfg), nil
}

func (s *ActiveProbeService) UpdateToken(id, label string, probeModels []string) (ActiveProbeConfigView, error) {
	id = strings.TrimSpace(id)
	label = strings.TrimSpace(label)
	if label == "" {
		return ActiveProbeConfigView{}, errors.New("令牌备注不能为空")
	}
	cfg := s.GetConfig()
	found := false
	for index := range cfg.Tokens {
		if cfg.Tokens[index].ID == id {
			cfg.Tokens[index].Label = label
			cfg.Tokens[index].ProbeModels = filterProbeModelSelection(probeModels, cfg.Tokens[index].Models)
			found = true
			break
		}
	}
	if !found {
		return ActiveProbeConfigView{}, errors.New("测试令牌不存在")
	}
	cfg.Models = configuredProbeModels(cfg.Tokens)
	if err := cache.Get().Set(probeConfigKey, cfg, 0); err != nil {
		return ActiveProbeConfigView{}, err
	}
	return activeProbeConfigView(cfg), nil
}

func (s *ActiveProbeService) DeleteToken(id string) (ActiveProbeConfigView, error) {
	cfg := s.GetConfig()
	filtered := make([]activeProbeToken, 0, len(cfg.Tokens))
	found := false
	for _, token := range cfg.Tokens {
		if token.ID == id {
			found = true
			continue
		}
		filtered = append(filtered, token)
	}
	if !found {
		return ActiveProbeConfigView{}, errors.New("测试令牌不存在")
	}
	cfg.Tokens = filtered
	cfg.Models = configuredProbeModels(cfg.Tokens)
	if err := cache.Get().Set(probeConfigKey, cfg, 0); err != nil {
		return ActiveProbeConfigView{}, err
	}
	return activeProbeConfigView(cfg), nil
}

func (s *ActiveProbeService) FetchModels(ctx context.Context, baseURL, token string) ([]string, error) {
	cfg := s.GetConfig()
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = cfg.BaseURL
	}
	token = strings.TrimSpace(token)
	if err := validateProbeBaseURL(baseURL); err != nil {
		return nil, err
	}
	if token == "" {
		return nil, errors.New("请填写测试令牌")
	}
	client := &http.Client{Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second}
	ok, status, errorCode, models := checkModelsEndpoint(ctx, client, baseURL, token)
	if !ok {
		if status > 0 {
			return nil, fmt.Errorf("读取模型列表失败（HTTP %d）", status)
		}
		return nil, fmt.Errorf("读取模型列表失败（%s）", errorCode)
	}
	return models, nil
}

func (s *ActiveProbeService) FetchModelsByTokenID(ctx context.Context, baseURL, tokenID string) ([]string, error) {
	tokenID = strings.TrimSpace(tokenID)
	if tokenID == "" {
		return nil, errors.New("测试令牌不存在")
	}
	cfg := s.GetConfig()
	for index := range cfg.Tokens {
		if cfg.Tokens[index].ID == tokenID {
			wasUnconfigured := cfg.Tokens[index].ProbeModels == nil
			models, err := s.FetchModels(ctx, baseURL, cfg.Tokens[index].Token)
			if err != nil {
				return nil, err
			}
			models = normalizeProbeModelNames(models)
			cfg.Tokens[index].Models = models
			if wasUnconfigured {
				cfg.Tokens[index].ProbeModels = append([]string(nil), models...)
			} else {
				cfg.Tokens[index].ProbeModels = filterProbeModelSelection(cfg.Tokens[index].ProbeModels, models)
			}
			cfg.Models = configuredProbeModels(cfg.Tokens)
			if err := cache.Get().Set(probeConfigKey, cfg, 0); err != nil {
				return nil, err
			}
			return models, nil
		}
	}
	return nil, errors.New("测试令牌不存在")
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
	if cfg.BaseURL == "" || len(cfg.Tokens) == 0 {
		return nil, errors.New("主动探测地址或测试令牌未配置")
	}
	client := &http.Client{Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second}
	tokenStates := make([]probeTokenState, 0, len(cfg.Tokens))
	modelsChanged := false
	for index, token := range cfg.Tokens {
		modelsOK, modelsStatus, modelsError, available := checkModelsEndpoint(ctx, client, cfg.BaseURL, token.Token)
		if modelsOK {
			available = normalizeProbeModelNames(available)
			cfg.Tokens[index].Models = available
			if token.ProbeModels == nil {
				cfg.Tokens[index].ProbeModels = append([]string(nil), available...)
			} else {
				cfg.Tokens[index].ProbeModels = filterProbeModelSelection(token.ProbeModels, available)
			}
			token.Models = available
			token.ProbeModels = cfg.Tokens[index].ProbeModels
			modelsChanged = true
		}
		tokenStates = append(tokenStates, probeTokenState{
			token: token, modelsOK: modelsOK, status: modelsStatus, errorCode: modelsError,
			models: modelSet(available), selected: modelSet(token.ProbeModels), restrictSelection: token.ProbeModels != nil,
		})
	}
	probeModels := configuredProbeModels(cfg.Tokens)
	cfg.Models = probeModels
	if modelsChanged {
		if err := cache.Get().Set(probeConfigKey, cfg, 0); err != nil {
			return nil, err
		}
	}
	if len(probeModels) == 0 {
		return nil, errors.New("请先在测试令牌中选择探测模型")
	}
	anyModelsOK := false
	for _, state := range tokenStates {
		if state.modelsOK {
			anyModelsOK = true
			break
		}
	}
	results := make([]ActiveProbeResult, len(probeModels))
	if !anyModelsOK {
		now := time.Now().Unix()
		for i, model := range probeModels {
			results[i] = ActiveProbeResult{
				Model:       model,
				CheckedAt:   now,
				ModelsOK:    false,
				ChatChecked: false,
				HTTPStatus:  firstTokenStatus(tokenStates),
				ErrorCode:   firstTokenError(tokenStates),
			}
		}
		if err := s.appendHistory(results); err != nil {
			return results, err
		}
		return results, nil
	}

	var wg sync.WaitGroup
	sem := make(chan struct{}, probeConcurrency)
	for i, model := range probeModels {
		wg.Add(1)
		go func(index int, modelName string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				results[index] = ActiveProbeResult{Model: modelName, CheckedAt: time.Now().Unix(), ErrorCode: "cancelled"}
				return
			}

			candidates := candidateTokenStates(tokenStates, modelName)
			result := ActiveProbeResult{
				Model: modelName, CheckedAt: time.Now().Unix(),
				ModelsOK: len(candidates) > 0,
			}
			if len(candidates) == 0 {
				result.ErrorCode = "model_unavailable"
				results[index] = result
				return
			}
			if cfg.ProbeMode == "models" {
				result.HTTPStatus = candidates[0].status
				results[index] = result
				return
			}

			result.ChatChecked = true
			for _, candidate := range candidates {
				chatResult := checkChatEndpoint(ctx, client, cfg, modelName, candidate.token.Token)
				result.LatencyMS += chatResult.LatencyMS
				result.HTTPStatus = chatResult.HTTPStatus
				result.ErrorCode = chatResult.ErrorCode
				if chatResult.ChatOK {
					result.ChatOK = true
					result.ErrorCode = ""
					break
				}
			}
			results[index] = result
		}(i, model)
	}
	wg.Wait()
	if err := s.appendHistory(results); err != nil {
		return results, err
	}
	return results, nil
}

type probeTokenState struct {
	token             activeProbeToken
	modelsOK          bool
	status            int
	errorCode         string
	models            map[string]struct{}
	selected          map[string]struct{}
	restrictSelection bool
}

func modelSet(models []string) map[string]struct{} {
	set := make(map[string]struct{}, len(models))
	for _, model := range models {
		if model != "" {
			set[model] = struct{}{}
		}
	}
	return set
}

func candidateTokenStates(states []probeTokenState, model string) []probeTokenState {
	withModel := make([]probeTokenState, 0, len(states))
	for _, state := range states {
		if !state.modelsOK {
			continue
		}
		if state.restrictSelection {
			if _, selected := state.selected[model]; !selected {
				continue
			}
		}
		if _, ok := state.models[model]; ok {
			withModel = append(withModel, state)
		}
	}
	return withModel
}

func firstTokenStatus(states []probeTokenState) int {
	for _, state := range states {
		if state.status != 0 {
			return state.status
		}
	}
	return 0
}

func firstTokenError(states []probeTokenState) string {
	for _, state := range states {
		if state.errorCode != "" {
			return state.errorCode
		}
	}
	return "models_network"
}

func checkModelsEndpoint(ctx context.Context, client *http.Client, baseURL, token string) (bool, int, string, []string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/v1/models", nil)
	if err != nil {
		return false, 0, "models_request", nil
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		return false, 0, classifyProbeError(err, "models_network"), nil
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return false, resp.StatusCode, "models_http", nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return false, resp.StatusCode, "models_body", nil
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return false, resp.StatusCode, "models_decode", nil
	}
	models := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if item.ID != "" {
			models = append(models, item.ID)
		}
	}
	return true, resp.StatusCode, "", models
}

func checkChatEndpoint(ctx context.Context, client *http.Client, cfg ActiveProbeConfig, model, token string) ActiveProbeResult {
	result := ActiveProbeResult{Model: model, CheckedAt: time.Now().Unix(), ModelsOK: true, ChatChecked: true}
	started := time.Now()
	status, errorCode := sendChatProbe(ctx, client, cfg, model, token, "max_completion_tokens")
	if errorCode == "" && status == http.StatusBadRequest {
		status, errorCode = sendChatProbe(ctx, client, cfg, model, token, "max_tokens")
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

func sendChatProbe(ctx context.Context, client *http.Client, cfg ActiveProbeConfig, model, token, tokenField string) (int, string) {
	payload := map[string]interface{}{
		"model":    model,
		"messages": []map[string]string{{"role": "user", "content": "1"}},
		"stream":   false,
	}
	payload[tokenField] = 1
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, "chat_payload"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(cfg.BaseURL, "/")+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return 0, "chat_request"
	}
	req.Header.Set("Authorization", "Bearer "+token)
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
				if result.ModelsOK && (!result.ChatChecked || result.ChatOK) {
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
	tokens := len(cfg.Tokens)
	if tokens < 1 {
		tokens = 1
	}
	// Include one model-list request per token and both possible chat parameter
	// attempts for each model/token fallback batch.
	requestWindows := tokens + 2*batches*tokens
	return time.Duration(requestWindows*cfg.TimeoutSeconds)*time.Second + probeShutdownPadding
}
