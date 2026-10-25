export function formatCount(count: number): string {
  return count.toLocaleString()
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '–'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** `3 days 4 h`, `2 h 10 min`, `45 s`. */
export function formatUptime(ms: number | null): string {
  if (ms === null) return '–'
  const seconds = Math.floor(ms / 1000)
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days} d ${hours} h`
  if (hours > 0) return `${hours} h ${minutes} min`
  if (minutes > 0) return `${minutes} min`
  return `${seconds} s`
}

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
