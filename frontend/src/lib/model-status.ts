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
  has_token: boolean
}

export interface AvailableModel {
  model_name: string
  request_count_24h: number
}

export interface EmbedConfig {
  selected_models: string[]
  time_window: string
  refresh_interval: number
  theme: 'system' | 'light' | 'dark'
  site_title?: string
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
  if (result.models_ok && result.chat_ok) return 'healthy'
  if (result.models_ok) return 'degraded'
  return 'down'
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
