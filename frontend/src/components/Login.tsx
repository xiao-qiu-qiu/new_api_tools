import { type FormEvent, useState } from 'react'
import { AlertCircle, ArrowRight, Loader2, LockKeyhole } from 'lucide-react'

interface LoginProps { onLogin: (password: string) => Promise<boolean> }

export function Login(props: LoginProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (!password.trim()) {
      setError('请输入访问密码')
      return
    }
    setLoading(true)
    try {
      if (!await props.onLogin(password)) setError('密码不正确，请重试')
    } catch {
      setError('服务暂时不可用，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  return <main className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-10">
    <section className="w-full max-w-sm rounded-lg border border-border bg-card shadow-sm" aria-labelledby="login-title">
      <div className="border-b border-border px-6 py-5">
        <div className="mb-5 flex items-center gap-3">
          <img src="/tool.svg" alt="" className="h-9 w-9" />
          <div><div className="text-sm font-semibold">NewAPI Tools</div><div className="text-xs text-muted-foreground">运营与可靠性控制台</div></div>
        </div>
        <h1 id="login-title" className="text-xl font-semibold">登录控制台</h1>
        <p className="mt-1 text-sm text-muted-foreground">使用部署时设置的管理密码继续。</p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
        <div>
          <label htmlFor="password" className="field-label">访问密码</label>
          <div className="relative">
            <LockKeyhole className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入访问密码" className="field pl-9" disabled={loading} autoFocus autoComplete="current-password" />
          </div>
        </div>
        {error && <div role="alert" className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}
        <button type="submit" disabled={loading} className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
          {loading ? <><Loader2 className="h-4 w-4 animate-spin" />正在登录</> : <>进入控制台<ArrowRight className="h-4 w-4" /></>}
        </button>
      </form>
    </section>
  </main>
}
