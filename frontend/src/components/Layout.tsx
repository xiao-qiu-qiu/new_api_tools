import { type ReactNode, useCallback, useEffect, useState } from 'react'
import {
  Activity, BarChart3, Bell, ChevronLeft, CircleDollarSign, Globe2,
  KeyRound, LayoutDashboard, LogOut, Menu, Moon, RadioTower, Sun,
  Tag, Ticket, UserCog, Users, X,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch, createAuthHeaders } from '../lib/api'
import { cn } from '../lib/utils'

export type TabType = 'dashboard' | 'risk' | 'abuse-broadcast' | 'ip-analysis' | 'redemptions' | 'topups' | 'analytics' | 'model-status' | 'users' | 'auto-group' | 'tokens'

interface LayoutProps {
  children: ReactNode
  activeTab: TabType
  onTabChange: (tab: TabType) => void
  onLogout: () => void
}

interface DbStatus { connected: boolean; engine: string }
interface NavigationItem { id: TabType; label: string; icon: typeof LayoutDashboard }

const navigationGroups: { label: string; items: NavigationItem[] }[] = [
  { label: '运营', items: [
    { id: 'dashboard', label: '总览', icon: LayoutDashboard },
    { id: 'topups', label: '充值记录', icon: CircleDollarSign },
    { id: 'redemptions', label: '兑换码', icon: Ticket },
    { id: 'analytics', label: '日志分析', icon: BarChart3 },
  ] },
  { label: '可靠性', items: [
    { id: 'model-status', label: '模型状态', icon: Activity },
    { id: 'risk', label: '风控中心', icon: Tag },
    { id: 'abuse-broadcast', label: '联合广播', icon: RadioTower },
    { id: 'ip-analysis', label: 'IP 分析', icon: Globe2 },
  ] },
  { label: '管理', items: [
    { id: 'users', label: '用户管理', icon: Users },
    { id: 'tokens', label: '令牌管理', icon: KeyRound },
    { id: 'auto-group', label: '自动分组', icon: UserCog },
  ] },
]

const allItems = navigationGroups.flatMap((group) => group.items)

export function Layout(props: LayoutProps) {
  const { token } = useAuth()
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null)
  const [unreadBroadcasts, setUnreadBroadcasts] = useState(0)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('shell_collapsed') === 'true')
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('theme')
    return saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  const activeItem = allItems.find((item) => item.id === props.activeTab)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => { localStorage.setItem('shell_collapsed', String(collapsed)) }, [collapsed])
  useEffect(() => { setMobileOpen(false) }, [props.activeTab])

  const fetchUnreadBroadcasts = useCallback(async () => {
    if (!token) return
    try {
      const apiUrl = import.meta.env.VITE_API_URL || ''
      const response = await apiFetch(`${apiUrl}/api/abuse-broadcast/unread-count`, { headers: createAuthHeaders(token) })
      const data = await response.json()
      setUnreadBroadcasts(data.success ? Number(data.data?.unread || 0) : 0)
    } catch { setUnreadBroadcasts(0) }
  }, [token])

  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL || ''
    fetch(`${apiUrl}/api/health/db`)
      .then((response) => response.json())
      .then((data) => setDbStatus({ connected: Boolean(data.success), engine: data.engine || '' }))
      .catch(() => setDbStatus({ connected: false, engine: '' }))
  }, [])

  useEffect(() => {
    void fetchUnreadBroadcasts()
    const timer = window.setInterval(() => void fetchUnreadBroadcasts(), 60000)
    const listener = () => void fetchUnreadBroadcasts()
    window.addEventListener('abuse-broadcast-unread-changed', listener)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('abuse-broadcast-unread-changed', listener)
    }
  }, [fetchUnreadBroadcasts])

  const openBroadcasts = () => {
    window.history.pushState(null, '', '/abuse-broadcast?view=inbox')
    window.dispatchEvent(new CustomEvent('abuse-broadcast-open-inbox'))
    props.onTabChange('abuse-broadcast')
  }

  const sidebar = (mobile: boolean) => (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className={cn('flex h-14 items-center border-b border-sidebar-border px-3', collapsed && !mobile ? 'justify-center' : 'gap-2')}>
        <img src="/tool.svg" alt="" className="h-7 w-7 shrink-0" />
        {(!collapsed || mobile) && <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">NewAPI Tools</div><div className="truncate text-[11px] text-muted-foreground">运营与可靠性</div></div>}
        {mobile && <button type="button" className="icon-button" onClick={() => setMobileOpen(false)} aria-label="关闭导航"><X className="h-4 w-4" /></button>}
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="主导航">
        {navigationGroups.map((group) => <div key={group.label} className="mb-4">
          {(!collapsed || mobile) && <div className="px-2 pb-1.5 text-[11px] font-medium text-muted-foreground">{group.label}</div>}
          <div className="space-y-0.5">{group.items.map((item) => {
            const Icon = item.icon
            const active = props.activeTab === item.id
            return <button key={item.id} type="button" title={collapsed && !mobile ? item.label : undefined} onClick={() => props.onTabChange(item.id)} className={cn('flex h-9 w-full items-center rounded-md px-2 text-sm transition-colors', collapsed && !mobile ? 'justify-center' : 'gap-2.5', active ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
              <Icon className="h-4 w-4 shrink-0" />
              {(!collapsed || mobile) && <span className="truncate">{item.label}</span>}
              {item.id === 'abuse-broadcast' && unreadBroadcasts > 0 && (!collapsed || mobile) && <span className="ml-auto rounded-full bg-rose-500 px-1.5 text-[10px] leading-4 text-white">{unreadBroadcasts > 99 ? '99+' : unreadBroadcasts}</span>}
            </button>
          })}</div>
        </div>)}
      </nav>
      <div className="border-t border-sidebar-border p-2">
        <div className={cn('mb-1 flex h-9 items-center rounded-md px-2 text-xs text-muted-foreground', collapsed && !mobile ? 'justify-center' : 'gap-2')}>
          <span className={cn('h-2 w-2 rounded-full', dbStatus?.connected ? 'bg-emerald-500' : 'bg-rose-500')} />
          {(!collapsed || mobile) && <span className="truncate">{dbStatus?.connected ? `${dbStatus.engine.toUpperCase()} 已连接` : '数据库离线'}</span>}
        </div>
        {!mobile && <button type="button" className="flex h-8 w-full items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}><ChevronLeft className={cn('h-4 w-4 transition-transform', collapsed && 'rotate-180')} /></button>}
      </div>
    </div>
  )

  return <div className="min-h-screen bg-background text-foreground">
    <aside className={cn('fixed inset-y-0 left-0 z-40 hidden border-r border-sidebar-border md:block', collapsed ? 'w-16' : 'w-60')}>{sidebar(false)}</aside>
    {mobileOpen && <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true"><button type="button" className="absolute inset-0 bg-black/45" onClick={() => setMobileOpen(false)} aria-label="关闭导航" /><aside className="absolute inset-y-0 left-0 w-72 border-r border-sidebar-border">{sidebar(true)}</aside></div>}
    <div className={cn('transition-[padding] duration-200', collapsed ? 'md:pl-16' : 'md:pl-60')}>
      <header className="sticky top-0 z-30 flex h-14 items-center border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6">
        <button type="button" className="icon-button mr-2 md:hidden" onClick={() => setMobileOpen(true)} aria-label="打开导航"><Menu className="h-4 w-4" /></button>
        <div className="min-w-0 flex-1"><h1 className="truncate text-sm font-semibold">{activeItem?.label || '总览'}</h1><p className="hidden text-xs text-muted-foreground sm:block">NewAPI 中转站运营控制台</p></div>
        <div className="flex items-center gap-1">
          <button type="button" className="icon-button" onClick={() => setDark((value) => !value)} aria-label={dark ? '切换浅色模式' : '切换深色模式'}>{dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
          <button type="button" className="icon-button relative" onClick={openBroadcasts} aria-label="联合广播收件箱"><Bell className="h-4 w-4" />{unreadBroadcasts > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-rose-500" />}</button>
          <button type="button" className="icon-button" onClick={props.onLogout} aria-label="退出登录"><LogOut className="h-4 w-4" /></button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 sm:py-6">{props.children}</main>
    </div>
  </div>
}
