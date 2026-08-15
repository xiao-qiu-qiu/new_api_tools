import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Clock3, RefreshCw, ShieldCheck } from 'lucide-react'
import {
  type ActiveProbeSummary, type EmbedConfig, type HealthState, type ModelStatusSnapshot,
  deriveHealth, formatRate, formatRelativeTime, healthClasses, healthLabels, parseActiveProbeSummary, probeHealth,
} from '../lib/model-status'
import { cn } from '../lib/utils'

const defaultConfig: EmbedConfig = { selected_models: [], time_window: '1h', refresh_interval: 60, theme: 'system' }

function PublicBadge(props: { state: HealthState; label?: string }) {
  return <span className={cn('status-pill', props.state === 'healthy' && 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300', props.state === 'degraded' && 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300', props.state === 'down' && 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300', props.state === 'empty' && 'border-border bg-muted text-muted-foreground')}><span className={cn('h-1.5 w-1.5 rounded-full', healthClasses[props.state])} />{props.label || healthLabels[props.state]}</span>
}

export function ModelStatusEmbed() {
  const apiUrl = import.meta.env.VITE_API_URL || ''
  const [config, setConfig] = useState<EmbedConfig>(defaultConfig)
  const [statuses, setStatuses] = useState<ModelStatusSnapshot[]>([])
  const [probeSummary, setProbeSummary] = useState<ActiveProbeSummary>({ enabled: false, running: false, results: [] })
  const [windowValue, setWindowValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<number>()

  const applyTheme = useCallback((theme: EmbedConfig['theme']) => {
    const dark = theme === 'dark' || theme === 'obsidian' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.dataset.statusTheme = theme
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const configResponse = await fetch(`${apiUrl}/api/model-status/embed/config`)
      const configData = await configResponse.json()
      if (!configResponse.ok || !configData.success) throw new Error('config_failed')
      const nextConfig: EmbedConfig = { ...defaultConfig, ...configData.data }
      applyTheme(nextConfig.theme)
      setConfig(nextConfig)
      const selectedWindow = windowValue || nextConfig.time_window
      if (!windowValue) setWindowValue(selectedWindow)

      const [statusResponse, probeResponse] = await Promise.all([
        fetch(`${apiUrl}/api/model-status/embed/status/batch?window=${selectedWindow}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nextConfig.selected_models || []) }),
        fetch(`${apiUrl}/api/model-status/embed/probe/summary`),
      ])
      const [statusData, probeData] = await Promise.all([statusResponse.json(), probeResponse.json()])
      if (!statusResponse.ok || !statusData.success) throw new Error('status_failed')
      setStatuses(statusData.data || [])
      setProbeSummary(parseActiveProbeSummary(probeData.data))
      setUpdatedAt(Math.floor(Date.now() / 1000))
    } catch { setError('状态数据暂时不可用') }
    finally { setLoading(false) }
  }, [apiUrl, applyTheme, windowValue])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!config.refresh_interval) return
     const timer = window.setInterval(() => void load(), config.refresh_interval * 1000)
    return () => window.clearInterval(timer)
  }, [config.refresh_interval, load])

  const probeByModel = useMemo(() => new Map(probeSummary.results.map((item) => [item.model, item])), [probeSummary.results])
  const overall = useMemo(() => statuses.reduce((acc, item) => ({ total: acc.total + item.total, ok: acc.ok + item.ok }), { total: 0, ok: 0 }), [statuses])
  const overallState = deriveHealth(overall.ok, overall.total)
  const title = config.site_title?.trim() || '模型服务状态'

  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex min-h-16 max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground"><Activity className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1"><h1 className="truncate text-base font-semibold">{title}</h1><p className="text-xs text-muted-foreground">流量状态与主动探测</p></div>
        <button type="button" className="icon-button" onClick={() => void load()} disabled={loading} aria-label="刷新状态"><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /></button>
      </div>
    </header>

    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
      <section className="mb-5 grid gap-3 sm:grid-cols-3" aria-label="总体状态">
        <div className="surface p-4"><div className="text-xs text-muted-foreground">总体状态</div><div className="mt-2"><PublicBadge state={overallState} /></div><div className="mt-2 text-xs text-muted-foreground">{overall.total ? `${formatRate(overall.ok, overall.total)} 流量成功率` : '当前窗口没有用户请求'}</div></div>
        <div className="surface p-4"><div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Activity className="h-3.5 w-3.5" />用户流量</div><div className="mt-2 text-2xl font-semibold tabular-nums">{overall.total.toLocaleString()}</div><div className="mt-1 text-xs text-muted-foreground">统计窗口 {windowValue || config.time_window}</div></div>
        <div className="surface p-4"><div className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5" />主动探测</div><div className="mt-2 text-2xl font-semibold tabular-nums">{probeSummary.results.length}</div><div className="mt-1 text-xs text-muted-foreground">{probeSummary.enabled ? `最近运行于 ${formatRelativeTime(probeSummary.last_run_at)}` : '定时探测未启用'}</div></div>
      </section>

      {error && <div className="mb-5 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">{error}</div>}

      <section className="surface overflow-hidden">
        <div className="surface-header flex-col !items-stretch gap-3 sm:flex-row sm:!items-center"><div><h2 className="surface-title">模型状态</h2><p className="mt-0.5 text-xs text-muted-foreground">灰色表示无请求，状态色由原始计数在浏览器中计算</p></div><div className="flex items-center justify-between gap-2 sm:justify-start"><select className="field h-8 w-auto min-w-24 py-0 text-xs" value={windowValue || config.time_window} onChange={(event) => setWindowValue(event.target.value)} aria-label="状态时间范围"><option value="1h">1 小时</option><option value="6h">6 小时</option><option value="12h">12 小时</option><option value="24h">24 小时</option></select><span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />{updatedAt ? formatRelativeTime(updatedAt) : '正在读取'}</span></div></div>
        {loading && !statuses.length ? <div className="flex h-64 items-center justify-center text-sm text-muted-foreground"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />正在读取状态</div> : statuses.length ? <div className="divide-y divide-border">{statuses.map((status) => {
          const state = deriveHealth(status.ok, status.total)
          const probe = probeByModel.get(status.model)
          const activeState = probeHealth(probe)
          return <article key={status.model} className="p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center gap-2"><h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={status.model}>{status.model}</h3><PublicBadge state={state} label={`流量 ${healthLabels[state]}`} />{probe && <PublicBadge state={activeState} label={`探测 ${healthLabels[activeState]}`} />}<span className="text-xs tabular-nums text-muted-foreground">{formatRate(status.ok, status.total)} · {status.total.toLocaleString()} 次</span></div>
            <div className="flex h-7 gap-0.5">{status.slots.map((slot) => <div key={slot.t} className={cn('min-w-0 flex-1 rounded-sm transition-opacity hover:opacity-70', healthClasses[deriveHealth(slot.ok, slot.n)])} title={`${new Date(slot.t * 1000).toLocaleString()} · 成功 ${slot.ok}/${slot.n}`} />)}</div>
            <div className="mt-2 flex justify-between text-[11px] text-muted-foreground"><span>{windowValue} 前</span>{probe && <span>主动探测 {probe.chat_checked ? (probe.chat_ok ? `${probe.latency_ms} ms` : probe.error_code || '异常') : '模型列表可用'}</span>}<span>现在</span></div>
          </article>
        })}</div> : <div className="flex h-64 flex-col items-center justify-center text-sm text-muted-foreground"><Activity className="mb-2 h-7 w-7 opacity-40" />尚未选择公开展示的模型</div>}
      </section>

      <footer className="mt-4 flex flex-wrap items-center justify-center gap-4 text-[11px] text-muted-foreground">
        {(['healthy', 'degraded', 'down', 'empty'] as HealthState[]).map((state) => <span key={state} className="flex items-center gap-1.5"><span className={cn('h-2 w-2 rounded-sm', healthClasses[state])} />{state === 'healthy' ? '≥95%' : state === 'degraded' ? '80–95%' : state === 'down' ? '<80%' : '无请求'}</span>)}
      </footer>
    </div>
  </main>
}
