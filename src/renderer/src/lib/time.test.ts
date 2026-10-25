import { describe, expect, it } from 'vitest'
import { dayLabel, timeAgo } from './time'

const at = (iso: string): number => new Date(iso).getTime()

describe('timeAgo', () => {
  const now = at('2026-03-10T12:00:00')

  it('speaks in minutes, then hours, then days', () => {
    expect(timeAgo(now - 20_000, now)).toBe('just now')
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(timeAgo(now - 30 * 3_600_000, now)).toBe('yesterday')
  })

  it('falls back to a short date', () => {
    expect(timeAgo(at('2026-02-01T09:00:00'), now)).toMatch(/Feb/)
  })
})

describe('dayLabel', () => {
  const now = new Date('2026-03-10T12:00:00')

  it('names today and yesterday, dates the rest', () => {
    expect(dayLabel(at('2026-03-10T00:30:00'), now)).toBe('Today')
    expect(dayLabel(at('2026-03-09T23:30:00'), now)).toBe('Yesterday')
    expect(dayLabel(at('2026-03-01T10:00:00'), now)).toMatch(/Mar/)
  })

  it('adds the year only for another year', () => {
    expect(dayLabel(at('2025-12-24T10:00:00'), now)).toMatch(/2025/)
    expect(dayLabel(at('2026-01-05T10:00:00'), now)).not.toMatch(/2026/)
  })
})
