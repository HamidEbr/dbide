import { Chip } from '@/components/panel'

/** A state such as `running` or `down`, coloured for what it means. */
export function StateChip({ state }: { state: string }) {
  const tone = state === 'running' || state === 'idle' ? 'ok' : state === 'flow' ? 'warn' : 'bad'
  return <Chip tone={tone}>{state}</Chip>
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/** Text that should be a JSON object, such as headers or queue arguments. Empty means none. */
export function parseJsonObject(text: string, what: string): Parsed<Record<string, unknown>> {
  if (text.trim() === '') return { ok: true, value: {} }
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {
        ok: false,
        message: `${what} must be a JSON object, such as { "x-max-length": 1000 }.`,
      }
    }
    return { ok: true, value: value as Record<string, unknown> }
  } catch (error) {
    return {
      ok: false,
      message: `${what} isn’t valid JSON. ${error instanceof Error ? error.message : ''}`.trim(),
    }
  }
}
