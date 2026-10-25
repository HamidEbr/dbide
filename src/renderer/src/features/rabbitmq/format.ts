export { formatBytes, formatCount, formatUptime, messageOf } from '@/lib/format'

/** Messages per second, kept short: `0`, `1.5`, `120`, `4.2K`. */
export function formatRate(rate: number): string {
  if (rate <= 0) return '0'
  if (rate < 10) return rate.toFixed(1).replace(/\.0$/, '')
  if (rate < 1000) return String(Math.round(rate))
  return `${(rate / 1000).toFixed(1)}K`
}

/** A name for a place a person can read: the default exchange has none. */
export const exchangeLabel = (name: string): string => (name === '' ? '(default)' : name)
