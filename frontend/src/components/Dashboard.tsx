import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, ArrowUpRight, CircleDollarSign, Clock3, KeyRound, RefreshCw, Server, Users } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch, createAuthHeaders } from '../lib/api'
import { cn } from '../lib/utils'

type Period = '24h' | '3d' | '7d' | '14d'
interface Overview { total_users: number; active_users: number; total_tokens: number; active_tokens: number; total_channels: number; active_channels: number; total_models: number }
interface Usage { total_requests: number; total_quota_used: number; average_response_time: number; total_prompt_tokens: number; total_completion_tokens: number }
interface ModelUsage { model_name: string; request_count: number; quota_used: number }
interface Trend { date?: string; hour?: string; timestamp?: number; request_count: number }

const periods: { value: Period; label: string }[] = [
  { value: '24h', label: '24 小时' }, { value: '3d', label: '3 天' }, { value: '7d', label: '7 天' }, { value: '14d', label: '14 天' },
]

function compactNumber(value: number) { return new Intl.NumberFormat('zh-CN', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value || 0) }
function quota(value: number) { return `$${((value || 0) / 500000).toFixed(2)}` }

export function Dashboard() {
  const { token } = useAuth()
  const [period, setPeriod] = useState<Period>('24h')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [models, setModels] = useState<ModelUsage[]>([])
  const [trends, setTrends] = useState<Trend[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const apiUrl = import.meta.env.VITE_API_URL || ''

  const load = useCallback(async (fresh = false) => {
    setLoading(true)
    setError('')
    const headers = createAuthHeaders(token)
    const cache = fresh ? '&no_cache=true' : ''
    try {
      const trendPath = period === '24h' ? `/api/dashboard/trends/hourly?hours=24${cache}` : `/api/dashboard/trends/daily?days=${period.replace('d', '')}${cache}`
      const responses = await Promise.all([
        apiFetch(`${apiUrl}/api/dashboard/overview?period=${period}${cache}`, { headers }),
        apiFetch(`${apiUrl}/api/dashboard/usage?period=${period}${cache}`, { headers }),
        apiFetch(`${apiUrl}/api/dashboard/models?period=${period}&limit=8${cache}`, { headers }),
        apiFetch(`${apiUrl}${trendPath}`, { headers }),
      ])
      if (responses.some((response) => !response.ok)) throw new Error('request_failed')
      const [overviewData, usageData, modelData, trendData] = await Promise.all(responses.map((response) => response.json()))
      setOverview(overviewData.data)
      setUsage(usageData.data)
      setModels(modelData.data || [])
      setTrends(trendData.data || [])
    } catch {
      setError('总览数据加载失败，请检查数据库连接后重试。')
    } finally { setLoading(false) }
  }, [apiUrl, period, token])

  useEffect(() => { void load() }, [load])

  const maxTrend = useMemo(() => Math.max(1, ...trends.map((item) => Number(item.request_count) || 0)), [trends])
  const maxModel = useMemo(() => Math.max(1, ...models.map((item) => Number(item.request_count) || 0)), [models])
  const stats = [
    { label: '总请求', value: compactNumber(usage?.total_requests || 0), detail: `${compactNumber((usage?.total_prompt_tokens || 0) + (usage?.total_completion_tokens || 0))} tokens`, icon: Activity },
    { label: '额度消耗', value: quota(usage?.total_quota_used || 0), detail: '按 NewAPI 额度折算', icon: CircleDollarSign },
    { label: '用户', value: compactNumber(overview?.total_users || 0), detail: `${overview?.active_users || 0} 个活跃`, icon: Users },
    { label: '令牌', value: compactNumber(overview?.total_tokens || 0), detail: `${overview?.active_tokens || 0} 个启用`, icon: KeyRound },
    { label: '渠道', value: compactNumber(overview?.total_channels || 0), detail: `${overview?.active_channels || 0} 个在线`, icon: Server },
    { label: '平均响应', value: `${Math.round(usage?.average_response_time || 0)} ms`, detail: `${overview?.total_models || 0} 个模型`, icon: Clock3 },
  ]

  return <div>
    <div className="page-heading">
      <div><h2 className="page-title">运营总览</h2><p className="page-description">请求、额度、用户和渠道的实时摘要。</p></div>
      <div className="flex items-center gap-2">
        <div className="segmented">{periods.map((item) => <button key={item.value} type="button" className={cn('segmented-item', period === item.value && 'segmented-item-active')} onClick={() => setPeriod(item.value)}>{item.label}</button>)}</div>
        <button type="button" className="icon-button border border-border" onClick={() => void load(true)} disabled={loading} aria-label="刷新总览"><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /></button>
      </div>
    </div>

    {error && <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">{error}</div>}

    <section className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6" aria-label="关键指标">
      {stats.map((stat) => { const Icon = stat.icon; return <div key={stat.label} className="surface p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs text-muted-foreground">{stat.label}</span><Icon className="h-4 w-4 text-muted-foreground" /></div><div className="text-xl font-semibold tabular-nums">{loading ? '--' : stat.value}</div><div className="mt-1 truncate text-xs text-muted-foreground">{loading ? '正在读取' : stat.detail}</div></div> })}
    </section>

    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,1fr)]">
      <section className="surface min-w-0">
        <div className="surface-header"><div><h3 className="surface-title">请求趋势</h3><p className="mt-0.5 text-xs text-muted-foreground">{periods.find((item) => item.value === period)?.label}内的请求变化</p></div><span className="text-sm font-semibold tabular-nums">{compactNumber(usage?.total_requests || 0)}</span></div>
        <div className="h-72 px-4 pb-4 pt-6">
          {trends.length ? <div className="flex h-full items-end gap-1.5 border-b border-border">{trends.map((item, index) => <div key={`${item.timestamp || item.hour || item.date}-${index}`} className="group relative flex h-full flex-1 items-end" title={`${item.hour || item.date || ''}: ${item.request_count} 请求`}><div className="w-full rounded-t-sm bg-primary/75 transition-colors group-hover:bg-primary" style={{ height: `${Math.max(2, Number(item.request_count) / maxTrend * 100)}%` }} /></div>)}</div> : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无趋势数据</div>}
        </div>
      </section>

      <section className="surface min-w-0">
        <div className="surface-header"><div><h3 className="surface-title">热门模型</h3><p className="mt-0.5 text-xs text-muted-foreground">按请求量排序</p></div><ArrowUpRight className="h-4 w-4 text-muted-foreground" /></div>
        <div className="divide-y divide-border">{models.length ? models.map((model, index) => <div key={model.model_name} className="px-4 py-3"><div className="mb-2 flex items-center gap-3"><span className="w-5 text-xs text-muted-foreground">{index + 1}</span><span className="min-w-0 flex-1 truncate text-sm font-medium" title={model.model_name}>{model.model_name}</span><span className="text-xs tabular-nums text-muted-foreground">{compactNumber(model.request_count)}</span></div><div className="ml-8 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Number(model.request_count) / maxModel * 100}%` }} /></div></div>) : <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">暂无模型数据</div>}</div>
      </section>
    </div>
  </div>
}
