import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Check, ChevronDown, ExternalLink, KeyRound, Loader2, Play, RefreshCw, Save, Search, Settings2, ShieldCheck, Trash2 } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch, createAuthHeaders } from '../lib/api'
import {
  type ActiveProbeConfig, type ActiveProbeSummary, type ActiveProbeToken, type AvailableModel, type HealthState, type ModelStatusSnapshot,
  deriveHealth, formatRate, formatRelativeTime, healthClasses, healthLabels, parseActiveProbeSummary, probeHealth,
} from '../lib/model-status'
import { cn } from '../lib/utils'
import { useToast } from './Toast'

type ViewMode = 'traffic' | 'probe'
type DisplayModel = AvailableModel & { hasTraffic: boolean; hasProbe: boolean }
const windowOptions = [{ value: '1h', label: '1 小时' }, { value: '6h', label: '6 小时' }, { value: '12h', label: '12 小时' }, { value: '24h', label: '24 小时' }]
const emptyProbeConfig: ActiveProbeConfig = { enabled: false, base_url: '', models: [], interval_seconds: 300, timeout_seconds: 20, probe_mode: 'chat', tokens: [], token_count: 0, has_token: false }
const themeOptions = [{ value: 'system', label: '跟随系统' }, { value: 'light', label: '新版浅色' }, { value: 'dark', label: '新版深色' }, { value: 'daylight', label: '白昼' }, { value: 'obsidian', label: '黑曜石' }] as const

function configuredTokenModels(tokens: ActiveProbeToken[]) {
  return Array.from(new Set(tokens.flatMap((item) => item.probe_models || []))).sort()
}

function StateBadge(props: { state: HealthState; label?: string }) {
  return <span className={cn('status-pill', props.state === 'healthy' && 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300', props.state === 'degraded' && 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300', props.state === 'down' && 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300', props.state === 'empty' && 'border-border bg-muted text-muted-foreground')}><span className={cn('h-1.5 w-1.5 rounded-full', healthClasses[props.state])} />{props.label || healthLabels[props.state]}</span>
}

export function ModelStatusMonitor() {
  const { token } = useAuth()
  const { showToast } = useToast()
  const apiUrl = import.meta.env.VITE_API_URL || ''
  const headers = useMemo(() => createAuthHeaders(token), [token])
  const [view, setView] = useState<ViewMode>('traffic')
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([])
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [statuses, setStatuses] = useState<ModelStatusSnapshot[]>([])
  const [windowValue, setWindowValue] = useState('1h')
  const [themeValue, setThemeValue] = useState('system')
  const [refreshInterval, setRefreshInterval] = useState(60)
  const [probeConfig, setProbeConfig] = useState<ActiveProbeConfig>(emptyProbeConfig)
  const [probeToken, setProbeToken] = useState('')
  const [probeTokenLabel, setProbeTokenLabel] = useState('')
  const [probeTokenModels, setProbeTokenModels] = useState<string[]>([])
  const [fetchingProbeModels, setFetchingProbeModels] = useState(false)
  const [fetchingStoredTokenId, setFetchingStoredTokenId] = useState('')
  const [expandedTokenIds, setExpandedTokenIds] = useState<string[]>([])
  const [tokenLabels, setTokenLabels] = useState<Record<string, string>>({})
  const [savingTokenId, setSavingTokenId] = useState('')
  const [dirtyTokenIds, setDirtyTokenIds] = useState<string[]>([])
  const [probeSummary, setProbeSummary] = useState<ActiveProbeSummary>({ enabled: false, running: false, results: [] })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [search, setSearch] = useState('')

  const loadBase = useCallback(async () => {
    try {
      const [modelsResponse, configResponse, probeResponse, summaryResponse] = await Promise.all([
        apiFetch(`${apiUrl}/api/model-status/models`, { headers }),
        apiFetch(`${apiUrl}/api/model-status/config/selected`, { headers }),
        apiFetch(`${apiUrl}/api/model-status/probe/config`, { headers }),
        fetch(`${apiUrl}/api/model-status/embed/probe/summary`),
      ])
      const [modelsData, configData, probeData, summaryData] = await Promise.all([modelsResponse.json(), configResponse.json(), probeResponse.json(), summaryResponse.json()])
      const selected = Array.isArray(configData.data) ? configData.data : []
      const nextProbe = probeData.data || emptyProbeConfig
      setAvailableModels(modelsData.data || [])
      setSelectedModels(selected)
      setWindowValue(configData.time_window || '1h')
      setThemeValue(configData.theme || 'system')
      setRefreshInterval(Number(configData.refresh_interval ?? 60))
      setProbeConfig(nextProbe)
      setTokenLabels(Object.fromEntries((nextProbe.tokens || []).map((item: { id: string; label: string }) => [item.id, item.label])))
      setDirtyTokenIds([])
      setProbeSummary(parseActiveProbeSummary(summaryData.data))
    } catch { showToast('error', '模型监控配置加载失败') }
  }, [apiUrl, headers, showToast])

  const loadStatuses = useCallback(async () => {
    if (!selectedModels.length) { setStatuses([]); setLoading(false); return }
    setLoading(true)
    try {
      const response = await apiFetch(`${apiUrl}/api/model-status/status/batch?window=${windowValue}`, { method: 'POST', headers, body: JSON.stringify(selectedModels) })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error('status_failed')
      setStatuses(data.data || [])
      const summaryResponse = await fetch(`${apiUrl}/api/model-status/embed/probe/summary`)
      const summaryData = await summaryResponse.json()
      if (summaryData.success) setProbeSummary(parseActiveProbeSummary(summaryData.data))
    } catch { showToast('error', '模型状态读取失败') }
    finally { setLoading(false) }
  }, [apiUrl, headers, selectedModels, showToast, windowValue])

  useEffect(() => { void loadBase() }, [loadBase])
  useEffect(() => { void loadStatuses() }, [loadStatuses])
  useEffect(() => {
    if (!refreshInterval) return
    const timer = window.setInterval(() => void loadStatuses(), refreshInterval * 1000)
    return () => window.clearInterval(timer)
  }, [loadStatuses, refreshInterval])

  const probeByModel = useMemo(() => new Map(probeSummary.results.map((item) => [item.model, item])), [probeSummary.results])
  const tokenOwnersByModel = useMemo(() => {
    const owners = new Map<string, Array<{ id: string; label: string }>>()
    probeConfig.tokens.forEach((item) => (item.models || []).forEach((model) => owners.set(model, [...(owners.get(model) || []), { id: item.id, label: item.label }])))
    return owners
  }, [probeConfig.tokens])
  const displayModels = useMemo<DisplayModel[]>(() => {
    const catalog = new Map<string, DisplayModel>()
    const add = (name: string, count: number, source: 'traffic' | 'probe' | 'selected') => {
      const model = name.trim()
      if (!model) return
      const current = catalog.get(model) || { model_name: model, request_count_24h: 0, hasTraffic: false, hasProbe: false }
      current.request_count_24h = Math.max(current.request_count_24h, Number(count) || 0)
      current.hasTraffic ||= source === 'traffic'
      current.hasProbe ||= source === 'probe'
      catalog.set(model, current)
    }
    availableModels.forEach((item) => add(item.model_name, item.request_count_24h, 'traffic'))
    probeConfig.models.forEach((model) => add(model, 0, 'probe'))
    probeConfig.tokens.forEach((item) => (item.models || []).forEach((model) => add(model, 0, 'probe')))
    probeSummary.results.forEach((item) => add(item.model, 0, 'probe'))
    selectedModels.forEach((model) => add(model, 0, 'selected'))
    return [...catalog.values()].sort((left, right) => right.request_count_24h - left.request_count_24h || left.model_name.localeCompare(right.model_name))
  }, [availableModels, probeConfig.models, probeConfig.tokens, probeSummary.results, selectedModels])
  const filteredModels = useMemo(() => displayModels.filter((item) => item.model_name.toLowerCase().includes(search.toLowerCase())), [displayModels, search])
  const overall = useMemo(() => statuses.reduce((acc, item) => ({ total: acc.total + item.total, ok: acc.ok + item.ok }), { total: 0, ok: 0 }), [statuses])

  const toggleModel = (model: string) => setSelectedModels((current) => current.includes(model) ? current.filter((item) => item !== model) : [...current, model])

  const saveDisplayConfig = async () => {
    setSaving(true)
    try {
      const responses = await Promise.all([
        apiFetch(`${apiUrl}/api/model-status/selected`, { method: 'PUT', headers, body: JSON.stringify({ models: selectedModels }) }),
        apiFetch(`${apiUrl}/api/model-status/config/window`, { method: 'PUT', headers, body: JSON.stringify({ time_window: windowValue }) }),
        apiFetch(`${apiUrl}/api/model-status/config/theme`, { method: 'PUT', headers, body: JSON.stringify({ theme: themeValue }) }),
        apiFetch(`${apiUrl}/api/model-status/config/refresh`, { method: 'PUT', headers, body: JSON.stringify({ refresh_interval: refreshInterval }) }),
      ])
      if (responses.some((response) => !response.ok)) throw new Error('save_failed')
      showToast('success', '展示配置已保存')
      setModelPickerOpen(false)
      await loadStatuses()
    } catch { showToast('error', '展示配置保存失败') }
    finally { setSaving(false) }
  }

  const updateProbe = <K extends keyof ActiveProbeConfig>(key: K, value: ActiveProbeConfig[K]) => setProbeConfig((current) => ({ ...current, [key]: value }))
  const markTokenDirty = (id: string) => setDirtyTokenIds((current) => current.includes(id) ? current : [...current, id])
  const setTokenProbeModels = (id: string, models: string[]) => {
    setProbeConfig((current) => ({ ...current, tokens: current.tokens.map((item) => item.id === id ? { ...item, probe_models: Array.from(new Set(models)).sort() } : item) }))
    markTokenDirty(id)
  }
  const saveProbeConfig = async () => {
    setSaving(true)
    try {
      const response = await apiFetch(`${apiUrl}/api/model-status/probe/config`, {
        method: 'PUT', headers, body: JSON.stringify({
          enabled: probeConfig.enabled, base_url: probeConfig.base_url, models: probeConfig.models,
          interval_seconds: probeConfig.interval_seconds, timeout_seconds: probeConfig.timeout_seconds,
          probe_mode: probeConfig.probe_mode,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error?.message || 'save_failed')
      setProbeConfig(data.data)
      setTokenLabels(Object.fromEntries(data.data.tokens.map((item: { id: string; label: string }) => [item.id, item.label])))
      setProbeToken('')
      setProbeSummary((current) => ({ ...current, enabled: data.data.enabled }))
      showToast('success', '主动探测配置已保存')
    } catch (error) { showToast('error', error instanceof Error && error.message !== 'save_failed' ? error.message : '主动探测配置保存失败') }
    finally { setSaving(false) }
  }

  const fetchProbeModels = async () => {
    if (!probeToken.trim()) { showToast('error', '请先填写测试令牌'); return }
    setFetchingProbeModels(true)
    try {
      const response = await apiFetch(`${apiUrl}/api/model-status/probe/token-models`, { method: 'POST', headers, body: JSON.stringify({ base_url: probeConfig.base_url, token: probeToken }) })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error?.message || '读取模型列表失败')
      const models = Array.isArray(data.data) ? data.data.map(String) : []
      setProbeTokenModels(models)
      showToast('success', `已读取 ${models.length} 个模型，可直接添加令牌`)
    } catch (error) { showToast('error', error instanceof Error ? error.message : '读取模型列表失败') }
    finally { setFetchingProbeModels(false) }
  }

  const fetchStoredTokenModels = async (id: string) => {
    setFetchingStoredTokenId(id)
    try {
      const response = await apiFetch(`${apiUrl}/api/model-status/probe/tokens/${encodeURIComponent(id)}/models`, { method: 'POST', headers, body: JSON.stringify({ base_url: probeConfig.base_url }) })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error?.message || '读取模型列表失败')
      const models = Array.isArray(data.data) ? data.data.map(String) : []
      setProbeConfig((current) => {
        const tokens = current.tokens.map((item) => {
          if (item.id !== id) return item
          const selected = item.probe_models == null ? models : item.probe_models.filter((model) => models.includes(model))
          return { ...item, models, probe_models: selected }
        })
        return { ...current, tokens, models: configuredTokenModels(tokens) }
      })
      showToast('success', `已刷新 ${models.length} 个可用模型`)
    } catch (error) { showToast('error', error instanceof Error ? error.message : '读取模型列表失败') }
    finally { setFetchingStoredTokenId('') }
  }

  const addProbeToken = async () => {
    if (!probeToken.trim()) { showToast('error', '请先填写测试令牌'); return }
    setSaving(true)
    try {
      const response = await apiFetch(`${apiUrl}/api/model-status/probe/tokens`, { method: 'POST', headers, body: JSON.stringify({ token: probeToken, label: probeTokenLabel, models: probeTokenModels }) })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error?.message || '添加令牌失败')
      setProbeConfig(data.data)
      setTokenLabels(Object.fromEntries(data.data.tokens.map((item: { id: string; label: string }) => [item.id, item.label])))
      const added = data.data.tokens.find((item: { id: string }) => !probeConfig.tokens.some((current) => current.id === item.id))
      if (added) setDirtyTokenIds((current) => current.filter((id) => id !== added.id))
      if (added) setExpandedTokenIds((current) => [...current, added.id])
      setProbeToken('')
      setProbeTokenLabel('')
      setProbeTokenModels([])
      showToast('success', '测试令牌已添加')
    } catch (error) { showToast('error', error instanceof Error ? error.message : '添加令牌失败') }
    finally { setSaving(false) }
  }

  const saveProbeToken = async (id: string) => {
    const label = (tokenLabels[id] || '').trim()
    if (!label) { showToast('error', '令牌备注不能为空'); return }
    const item = probeConfig.tokens.find((tokenItem) => tokenItem.id === id)
    if (!item) return
    setSavingTokenId(id)
    try {
      const response = await apiFetch(`${apiUrl}/api/model-status/probe/tokens/${encodeURIComponent(id)}`, { method: 'PATCH', headers, body: JSON.stringify({ label, probe_models: item.probe_models || [] }) })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error?.message || '更新备注失败')
      setProbeConfig(data.data)
      setTokenLabels(Object.fromEntries(data.data.tokens.map((item: { id: string; label: string }) => [item.id, item.label])))
      setDirtyTokenIds((current) => current.filter((tokenId) => tokenId !== id))
      showToast('success', '令牌配置已更新')
    } catch (error) { showToast('error', error instanceof Error ? error.message : '更新令牌配置失败') }
    finally { setSavingTokenId('') }
  }

  const removeProbeToken = async (id: string) => {
    try {
      const response = await apiFetch(`${apiUrl}/api/model-status/probe/tokens/${encodeURIComponent(id)}`, { method: 'DELETE', headers })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error?.message || '删除令牌失败')
      setProbeConfig(data.data)
      setExpandedTokenIds((current) => current.filter((item) => item !== id))
      setTokenLabels((current) => { const next = { ...current }; delete next[id]; return next })
      setDirtyTokenIds((current) => current.filter((item) => item !== id))
      showToast('success', '测试令牌已删除')
    } catch (error) { showToast('error', error instanceof Error ? error.message : '删除令牌失败') }
  }

  const runProbe = async () => {
    if (dirtyTokenIds.length > 0) { showToast('error', '请先保存令牌内的模型选择'); return }
    setRunning(true)
    try {
      const response = await apiFetch(`${apiUrl}/api/model-status/probe/run`, { method: 'POST', headers })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error?.message || 'probe_failed')
      const [summaryResponse, configResponse] = await Promise.all([
        fetch(`${apiUrl}/api/model-status/embed/probe/summary`),
        apiFetch(`${apiUrl}/api/model-status/probe/config`, { headers }),
      ])
      const [summaryData, configData] = await Promise.all([summaryResponse.json(), configResponse.json()])
      setProbeSummary(parseActiveProbeSummary(summaryData.data))
      if (configData.success) {
        setProbeConfig(configData.data)
        setTokenLabels(Object.fromEntries(configData.data.tokens.map((item: { id: string; label: string }) => [item.id, item.label])))
      }
      showToast('success', `主动探测完成，共 ${data.data.length} 个模型`)
    } catch (error) { showToast('error', error instanceof Error && error.message !== 'probe_failed' ? error.message : '主动探测执行失败') }
    finally { setRunning(false) }
  }

  return <div>
    <div className="page-heading">
      <div><h2 className="page-title">模型状态</h2><p className="page-description">区分真实用户流量与独立主动探测，空数据不再视为正常。</p></div>
      <div className="flex items-center gap-2">
        <button type="button" className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-muted" onClick={() => window.open('/embed.html', '_blank')}><ExternalLink className="h-4 w-4" />公开状态页</button>
        <button type="button" className="icon-button border border-border" onClick={() => void loadStatuses()} disabled={loading} aria-label="刷新状态"><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /></button>
      </div>
    </div>

    <div className="mb-5 grid gap-3 sm:grid-cols-3">
      <div className="surface p-4"><div className="text-xs text-muted-foreground">流量请求</div><div className="mt-2 text-2xl font-semibold tabular-nums">{overall.total.toLocaleString()}</div><div className="mt-1 text-xs text-muted-foreground">成功率 {formatRate(overall.ok, overall.total)}</div></div>
      <div className="surface p-4"><div className="text-xs text-muted-foreground">流量健康度</div><div className="mt-2"><StateBadge state={deriveHealth(overall.ok, overall.total)} /></div><div className="mt-2 text-xs text-muted-foreground">按当前 {windowValue} 窗口计算</div></div>
      <div className="surface p-4"><div className="text-xs text-muted-foreground">主动探测</div><div className="mt-2 flex items-center gap-2"><StateBadge state={probeSummary.results.length ? (probeSummary.results.every((item) => probeHealth(item) === 'healthy') ? 'healthy' : 'degraded') : 'empty'} label={probeSummary.enabled ? '已启用' : '未启用'} /></div><div className="mt-2 text-xs text-muted-foreground">{formatRelativeTime(probeSummary.last_run_at)}</div></div>
    </div>

    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="segmented"><button type="button" className={cn('segmented-item', view === 'traffic' && 'segmented-item-active')} onClick={() => setView('traffic')}>流量状态</button><button type="button" className={cn('segmented-item', view === 'probe' && 'segmented-item-active')} onClick={() => setView('probe')}>主动探测</button></div>
      <div className="flex items-center gap-2">
        <div className="segmented">{windowOptions.map((item) => <button key={item.value} type="button" className={cn('segmented-item', windowValue === item.value && 'segmented-item-active')} onClick={() => setWindowValue(item.value)}>{item.label}</button>)}</div>
        <button type="button" className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-muted" onClick={() => setModelPickerOpen((value) => !value)}><Settings2 className="h-4 w-4" />展示设置</button>
      </div>
    </div>

    {modelPickerOpen && <section className="surface mb-5">
      <div className="surface-header"><div><h3 className="surface-title">展示设置</h3><p className="mt-0.5 text-xs text-muted-foreground">选择公开页与管理端要显示的模型</p></div><button type="button" className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground" onClick={() => void saveDisplayConfig()} disabled={saving}>{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存</button></div>
      <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-[220px_220px_220px_1fr]">
        <div><label className="field-label">默认时间范围</label><select className="field" value={windowValue} onChange={(event) => setWindowValue(event.target.value)}>{windowOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
        <div><label className="field-label">公开页主题</label><select className="field" value={themeValue} onChange={(event) => setThemeValue(event.target.value)}>{themeOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
        <div><label className="field-label">自动刷新</label><select className="field" value={refreshInterval} onChange={(event) => setRefreshInterval(Number(event.target.value))}><option value={0}>关闭</option><option value={30}>30 秒</option><option value={60}>60 秒</option><option value={120}>2 分钟</option><option value={300}>5 分钟</option></select></div>
        <div><label htmlFor="model-search" className="field-label">监控模型 · 已选 {selectedModels.length}</label><div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input id="model-search" className="field pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索模型" /></div></div>
      </div>
      <div className="grid max-h-64 grid-cols-1 overflow-y-auto border-t border-border p-2 sm:grid-cols-2 lg:grid-cols-3">{filteredModels.map((item) => { const checked = selectedModels.includes(item.model_name); return <button key={item.model_name} type="button" onClick={() => toggleModel(item.model_name)} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted"><span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}>{checked && <Check className="h-3 w-3" />}</span><span className="min-w-0 flex-1 truncate text-sm">{item.model_name}</span><span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[11px]', item.hasProbe ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300' : 'bg-muted text-muted-foreground')}>{item.hasTraffic && item.hasProbe ? '流量 + 探测' : item.hasProbe ? '探测' : item.hasTraffic ? '流量' : '已选择'}</span>{item.hasTraffic && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{Number(item.request_count_24h || 0).toLocaleString()}</span>}</button> })}</div>
    </section>}

    {view === 'traffic' ? <section className="surface overflow-hidden">
      <div className="surface-header"><div><h3 className="surface-title">用户流量健康度</h3><p className="mt-0.5 text-xs text-muted-foreground">状态与颜色由前端根据原始计数推导</p></div><Activity className="h-4 w-4 text-muted-foreground" /></div>
      {loading ? <div className="flex h-64 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />读取状态</div> : statuses.length ? <div className="divide-y divide-border">{statuses.map((status) => { const state = deriveHealth(status.ok, status.total); const probe = probeByModel.get(status.model); return <div key={status.model} className="p-4"><div className="mb-3 flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium" title={status.model}>{status.model}</span><StateBadge state={state} /><span className="text-xs tabular-nums text-muted-foreground">{formatRate(status.ok, status.total)} · {status.total.toLocaleString()} 请求</span>{probe && <span className="text-xs text-muted-foreground">探测 {probe.chat_ok ? `${probe.latency_ms} ms` : '异常'}</span>}</div><div className="flex h-6 gap-0.5">{status.slots.map((slot) => <div key={slot.t} className={cn('min-w-0 flex-1 rounded-sm', healthClasses[deriveHealth(slot.ok, slot.n)])} title={`${new Date(slot.t * 1000).toLocaleString()} · ${slot.ok}/${slot.n}`} />)}</div><div className="mt-2 flex justify-between text-[11px] text-muted-foreground"><span>{windowValue} 前</span><span>现在</span></div></div> })}</div> : <div className="flex h-64 flex-col items-center justify-center text-sm text-muted-foreground"><Activity className="mb-2 h-7 w-7 opacity-40" />请先在展示设置中选择模型</div>}
    </section> : <div className="grid gap-5 xl:grid-cols-[minmax(340px,0.8fr)_minmax(0,1.2fr)]">
      <section className="surface">
        <div className="surface-header"><div><h3 className="surface-title">探测配置</h3><p className="mt-0.5 text-xs text-muted-foreground">默认关闭，使用独立测试令牌</p></div><KeyRound className="h-4 w-4 text-muted-foreground" /></div>
        <div className="space-y-4 p-4">
          <label className="flex items-center justify-between gap-4"><span><span className="block text-sm font-medium">启用定时探测</span><span className="block text-xs text-muted-foreground">按间隔自动运行</span></span><button type="button" role="switch" aria-checked={probeConfig.enabled} className={cn('relative h-6 w-11 rounded-full transition-colors', probeConfig.enabled ? 'bg-primary' : 'bg-muted-foreground/30')} onClick={() => updateProbe('enabled', !probeConfig.enabled)}><span className={cn('absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', probeConfig.enabled ? 'translate-x-5' : 'translate-x-0')} /></button></label>
          <div><label className="field-label">NewAPI 地址</label><input className="field" value={probeConfig.base_url} onChange={(event) => updateProbe('base_url', event.target.value)} placeholder="http://new-api:3000" /></div>
          <div><label className="field-label">探测方式</label><select className="field" value={probeConfig.probe_mode} onChange={(event) => updateProbe('probe_mode', event.target.value as ActiveProbeConfig['probe_mode'])}><option value="chat">模型列表 + 最小聊天校验</option><option value="models">仅模型列表（零聊天 token）</option></select><p className="mt-1 text-xs text-muted-foreground">聊天请求设置 1 个输出 token 上限；输入、缓存和渠道注入仍按上游实际统计。</p></div>
          <div className="space-y-2">
            <div className="flex items-end justify-between gap-3"><label className="field-label mb-0">测试令牌 · 已配置 {probeConfig.token_count}</label><span className="text-xs text-muted-foreground">展开配置探测模型</span></div>
            {probeConfig.tokens.length > 0 && <div className="overflow-hidden rounded-md border border-border">
              {probeConfig.tokens.map((item, index) => {
                const models = item.models || []
                const selectedProbeModels = item.probe_models || []
                const expanded = expandedTokenIds.includes(item.id)
                const duplicateCount = models.filter((model) => (tokenOwnersByModel.get(model)?.length || 0) > 1).length
                return <div key={item.id} className={cn(index > 0 && 'border-t border-border')}>
                  <div className="flex min-w-0 items-center bg-muted/20">
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/60" aria-expanded={expanded} onClick={() => setExpandedTokenIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}>
                      <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.label || '未命名令牌'}</span><span className="block text-xs text-muted-foreground">{models.length ? `探测 ${selectedProbeModels.length} / ${models.length} 个模型` : '尚未读取模型'}{duplicateCount > 0 ? ` · ${duplicateCount} 个重叠` : ''}</span></span>
                      {duplicateCount > 0 && <span className="hidden shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 sm:inline">存在共用模型</span>}
                      <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
                    </button>
                    <button type="button" className="icon-button mr-2 h-8 w-8 shrink-0" onClick={() => void removeProbeToken(item.id)} aria-label={`删除${item.label || '令牌'}`} title="删除令牌"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                  {expanded && <div className="space-y-3 border-t border-border p-3">
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                      <input className="field" value={tokenLabels[item.id] ?? item.label} onChange={(event) => { setTokenLabels((current) => ({ ...current, [item.id]: event.target.value })); markTokenDirty(item.id) }} placeholder="令牌备注" />
                      <button type="button" className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50" onClick={() => void saveProbeToken(item.id)} disabled={savingTokenId === item.id || !(tokenLabels[item.id] || '').trim() || !dirtyTokenIds.includes(item.id)}>{savingTokenId === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存配置</button>
                      <button type="button" className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50" onClick={() => void fetchStoredTokenModels(item.id)} disabled={Boolean(fetchingStoredTokenId) || saving} title="重新读取此令牌支持的模型">{fetchingStoredTokenId === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}刷新模型</button>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-sm font-medium">参与主动探测</div><div className="text-xs text-muted-foreground">已选择 {selectedProbeModels.length} / {models.length} 个模型</div></div><div className="flex gap-1"><button type="button" className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setTokenProbeModels(item.id, models)}>全选</button><button type="button" className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setTokenProbeModels(item.id, [])}>清空</button></div></div>
                    <div className="max-h-48 overflow-y-auto rounded-md bg-muted/35 p-2">
                      {models.length > 0 ? <div className="grid gap-1 sm:grid-cols-2">{models.map((model) => { const owners = tokenOwnersByModel.get(model) || []; const shared = owners.length > 1; const checked = selectedProbeModels.includes(model); return <button type="button" key={model} onClick={() => setTokenProbeModels(item.id, checked ? selectedProbeModels.filter((selected) => selected !== model) : [...selectedProbeModels, model])} className={cn('flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-background', checked ? 'border-primary/40 bg-background' : 'border-transparent', shared && 'text-amber-900 dark:text-amber-200')} title={shared ? `同时属于：${owners.map((owner) => owner.label).join('、')}` : model}><span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background')}>{checked && <Check className="h-3 w-3" />}</span><span className="min-w-0 flex-1 truncate">{model}</span>{shared && <span className="shrink-0 text-[10px] opacity-70">共用 {owners.length}</span>}</button> })}</div> : <div className="py-4 text-center text-xs text-muted-foreground">点击“刷新模型”读取此令牌的可用模型</div>}
                    </div>
                  </div>}
                </div>
              })}
            </div>}
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px]"><input className="field" type="password" value={probeToken} onChange={(event) => { setProbeToken(event.target.value); setProbeTokenModels([]) }} placeholder="粘贴新的测试令牌" autoComplete="new-password" /><input className="field" value={probeTokenLabel} onChange={(event) => setProbeTokenLabel(event.target.value)} placeholder="备注（可选）" /></div>
            <div className="flex flex-wrap gap-2"><button type="button" className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-muted" onClick={() => void fetchProbeModels()} disabled={fetchingProbeModels || saving || !probeToken.trim()}>{fetchingProbeModels ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}添加前读取</button><button type="button" className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground" onClick={() => void addProbeToken()} disabled={saving || fetchingProbeModels || !probeToken.trim()}><KeyRound className="h-4 w-4" />添加令牌</button>{probeTokenModels.length > 0 && <span className="self-center text-xs text-emerald-600">已读取 {probeTokenModels.length} 个模型，将随令牌保存</span>}</div>
          </div>
          <div className="grid grid-cols-2 gap-3"><div><label className="field-label">间隔（秒）</label><input className="field" type="number" min={30} max={86400} value={probeConfig.interval_seconds} onChange={(event) => updateProbe('interval_seconds', Number(event.target.value))} /></div><div><label className="field-label">超时（秒）</label><input className="field" type="number" min={3} max={120} value={probeConfig.timeout_seconds} onChange={(event) => updateProbe('timeout_seconds', Number(event.target.value))} /></div></div>
          <div className="flex gap-2"><button type="button" className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md border border-border text-sm hover:bg-muted" onClick={() => void runProbe()} disabled={running || saving}>{running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}立即探测</button><button type="button" className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground" onClick={() => void saveProbeConfig()} disabled={saving || running}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存配置</button></div>
        </div>
      </section>
      <section className="surface overflow-hidden">
        <div className="surface-header"><div><h3 className="surface-title">最近探测结果</h3><p className="mt-0.5 text-xs text-muted-foreground">先验证模型归属，再发起最小聊天请求</p></div><ShieldCheck className="h-4 w-4 text-muted-foreground" /></div>
        {probeSummary.results.length ? <div className="divide-y divide-border">{probeSummary.results.map((result) => { const state = probeHealth(result); return <div key={result.model} className="flex items-center gap-3 px-4 py-3"><span className={cn('h-2 w-2 shrink-0 rounded-full', healthClasses[state])} /><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{result.model}</div><div className="mt-0.5 text-xs text-muted-foreground">{formatRelativeTime(result.checked_at)}{result.error_code ? ` · ${result.error_code}` : ''}</div></div><div className="text-right"><StateBadge state={state} /><div className="mt-1 text-xs tabular-nums text-muted-foreground">{result.chat_ok ? `${result.latency_ms} ms` : result.http_status || '--'}</div></div></div> })}</div> : <div className="flex h-72 flex-col items-center justify-center text-sm text-muted-foreground"><ShieldCheck className="mb-2 h-7 w-7 opacity-40" />尚无主动探测记录</div>}
      </section>
    </div>}
  </div>
}
