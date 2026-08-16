export type HealthState = 'healthy' | 'degraded' | 'down' | 'empty'

export interface CompactStatusSlot {
  t: number
  n: number
  ok: number
  fail?: number
  empty?: number
}

export interface ModelStatusSnapshot {
  model: string
  window: string
  step: number
  total: number
  ok: number
  fail?: number
  empty?: number
  slots: CompactStatusSlot[]
}

export interface ActiveProbeResult {
  model: string
  checked_at: number
  latency_ms: number
  models_ok: boolean
  chat_ok: boolean
  chat_checked: boolean
  http_status?: number
  error_code?: string
}

export interface ActiveProbeSummary {
  enabled: boolean
  running: boolean
  last_run_at?: number
  results: ActiveProbeResult[]
}

export interface ActiveProbeConfig {
  enabled: boolean
  base_url: string
  models: string[]
  interval_seconds: number
  timeout_seconds: number
  probe_mode: 'models' | 'chat'
  tokens: ActiveProbeToken[]
  token_count: number
  has_token: boolean
}

export interface ActiveProbeToken {
  id: string
  label: string
  has_token: boolean
  models: string[]
  probe_models: string[]
}

export interface AvailableModel {
  model_name: string
  request_count_24h: number
}

export interface EmbedConfig {
  selected_models: string[]
  time_window: string
  refresh_interval: number
  theme: 'system' | 'light' | 'dark' | 'daylight' | 'obsidian'
  site_title?: string
}

export function parseActiveProbeResult(raw: Record<string, unknown>): ActiveProbeResult {
  return {
    model: String(raw.m ?? raw.model ?? ''),
    checked_at: Number(raw.t ?? raw.checked_at ?? 0),
    latency_ms: Number(raw.l ?? raw.latency_ms ?? 0),
    models_ok: Boolean(raw.mo ?? raw.models_ok),
    chat_checked: Boolean(raw.cc ?? raw.chat_checked ?? (raw.chat_ok !== undefined)),
    chat_ok: Boolean(raw.co ?? raw.chat_ok),
    http_status: raw.s === undefined ? Number(raw.http_status || 0) || undefined : Number(raw.s) || undefined,
    error_code: String(raw.e ?? raw.error_code ?? '') || undefined,
  }
}

export function parseActiveProbeResults(raw: unknown): ActiveProbeResult[] {
  return Array.isArray(raw)
    ? raw.map((item) => parseActiveProbeResult((item || {}) as Record<string, unknown>))
    : []
}

export function parseActiveProbeSummary(raw: Record<string, unknown> | undefined): ActiveProbeSummary {
  const results = Array.isArray(raw?.r) ? raw.r : Array.isArray(raw?.results) ? raw.results : []
  return {
    enabled: Boolean(raw?.on ?? raw?.enabled),
    running: Boolean(raw?.run ?? raw?.running),
    last_run_at: Number(raw?.t ?? raw?.last_run_at ?? 0) || undefined,
    results: parseActiveProbeResults(results),
  }
}

export function successRate(ok: number, total: number): number | null {
  if (total <= 0) return null
  return Math.round((ok / total) * 10000) / 100
}

export function deriveHealth(ok: number, total: number): HealthState {
  const rate = successRate(ok, total)
  if (rate === null) return 'empty'
  if (rate >= 95) return 'healthy'
  if (rate >= 80) return 'degraded'
  return 'down'
}

export function probeHealth(result?: ActiveProbeResult): HealthState {
  if (!result) return 'empty'
  if (result.models_ok && (!result.chat_checked || result.chat_ok)) return 'healthy'
  return 'down'
}

const healthPriority: Record<HealthState, number> = {
  empty: 0,
  healthy: 1,
  degraded: 2,
  down: 3,
}

export function worstHealth(...states: HealthState[]): HealthState {
  let result: HealthState = 'empty'
  for (const state of states) {
    if (healthPriority[state] > healthPriority[result]) result = state
  }
  return result
}

export function deriveProbeSlotHealth(slotStart: number, step: number, results: ActiveProbeResult[]): HealthState {
  const slotEnd = slotStart + step
  let state: HealthState = 'empty'
  for (const result of results) {
    if (result.checked_at < slotStart || result.checked_at >= slotEnd) continue
    state = worstHealth(state, probeHealth(result))
    if (state === 'down') break
  }
  return state
}

export const healthLabels: Record<HealthState, string> = {
  healthy: '正常',
  degraded: '波动',
  down: '异常',
  empty: '无数据',
}

export const healthClasses: Record<HealthState, string> = {
  healthy: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  down: 'bg-rose-500',
  empty: 'bg-zinc-300 dark:bg-zinc-700',
}

export function formatRate(ok: number, total: number): string {
  const rate = successRate(ok, total)
  return rate === null ? '--' : `${rate.toFixed(rate % 1 === 0 ? 0 : 1)}%`
}

export function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return '尚未探测'
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp))
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86400)} 天前`
}
