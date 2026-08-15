import type React from 'react'
import { cn } from '../lib/utils'

interface StatCardProps {
  title: string
  value: number | string
  subValue?: string
  icon: React.ElementType
  color: string
  variant?: 'default' | 'compact'
  customLabel?: string
  className?: string
  onClick?: () => void
}

const iconColors: Record<string, string> = {
  blue: 'text-sky-600 bg-sky-50 dark:bg-sky-950/40 dark:text-sky-300',
  green: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300',
  emerald: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300',
  purple: 'text-violet-600 bg-violet-50 dark:bg-violet-950/40 dark:text-violet-300',
  orange: 'text-orange-600 bg-orange-50 dark:bg-orange-950/40 dark:text-orange-300',
  amber: 'text-amber-600 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300',
  red: 'text-rose-600 bg-rose-50 dark:bg-rose-950/40 dark:text-rose-300',
  rose: 'text-rose-600 bg-rose-50 dark:bg-rose-950/40 dark:text-rose-300',
  cyan: 'text-cyan-600 bg-cyan-50 dark:bg-cyan-950/40 dark:text-cyan-300',
  teal: 'text-teal-600 bg-teal-50 dark:bg-teal-950/40 dark:text-teal-300',
  gray: 'text-zinc-600 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-300',
}

export function StatCard(props: StatCardProps) {
  const Icon = props.icon
  const compact = props.variant === 'compact'
  const content = <>
    <div className="min-w-0 flex-1">
      <p className="truncate text-xs text-muted-foreground">{props.customLabel || props.title}</p>
      <p className={cn('mt-1 font-semibold tabular-nums', compact ? 'text-xl' : 'text-2xl')}>{props.value}</p>
      {props.subValue && <p className="mt-1 truncate text-xs text-muted-foreground">{props.subValue}</p>}
    </div>
    <span className={cn('flex shrink-0 items-center justify-center rounded-md', compact ? 'h-8 w-8' : 'h-9 w-9', iconColors[props.color] || iconColors.blue)}><Icon className={compact ? 'h-4 w-4' : 'h-5 w-5'} /></span>
  </>

  const classes = cn('surface flex items-center gap-3 p-4 text-left', props.onClick && 'w-full cursor-pointer hover:bg-muted/40', props.className)
  if (props.onClick) return <button type="button" className={classes} onClick={props.onClick}>{content}</button>
  return <div className={classes}>{content}</div>
}
