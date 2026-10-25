import { describe, expect, it } from 'vitest'
import { formatShortcut, matchesShortcut, parseShortcut, type KeyLike } from './keybinding'

const key = (code: string, mods: Partial<Omit<KeyLike, 'code'>> = {}): KeyLike => ({
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('parseShortcut', () => {
  it('parses modifiers and letters', () => {
    expect(parseShortcut('Mod+Shift+P')).toEqual({
      mod: true,
      shift: true,
      alt: false,
      code: 'KeyP',
    })
  })

  it('parses punctuation, digits, and named keys', () => {
    expect(parseShortcut('Mod+,').code).toBe('Comma')
    expect(parseShortcut('Mod+1').code).toBe('Digit1')
    expect(parseShortcut('Mod+Enter').code).toBe('Enter')
    expect(parseShortcut('Mod+Alt+ArrowRight')).toMatchObject({ alt: true, code: 'ArrowRight' })
    expect(parseShortcut('F5').code).toBe('F5')
  })

  it('rejects unknown modifiers and keys', () => {
    expect(() => parseShortcut('Hyper+P')).toThrow(/modifier/)
    expect(() => parseShortcut('Mod+Banana')).toThrow(/key/)
    expect(() => parseShortcut('')).toThrow()
  })
})

describe('matchesShortcut', () => {
  const palette = parseShortcut('Mod+Shift+P')

  it('uses Cmd on macOS', () => {
    expect(matchesShortcut(key('KeyP', { metaKey: true, shiftKey: true }), palette, 'darwin')).toBe(
      true,
    )
    expect(matchesShortcut(key('KeyP', { ctrlKey: true, shiftKey: true }), palette, 'darwin')).toBe(
      false,
    )
  })

  it('uses Ctrl on Windows and Linux', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(
        matchesShortcut(key('KeyP', { ctrlKey: true, shiftKey: true }), palette, platform),
      ).toBe(true)
      expect(
        matchesShortcut(key('KeyP', { metaKey: true, shiftKey: true }), palette, platform),
      ).toBe(false)
    }
  })

  it('requires modifiers to match exactly', () => {
    expect(matchesShortcut(key('KeyP', { metaKey: true }), palette, 'darwin')).toBe(false)
    expect(
      matchesShortcut(
        key('KeyP', { metaKey: true, shiftKey: true, altKey: true }),
        palette,
        'darwin',
      ),
    ).toBe(false)
  })

  it('matches the physical key, so non-Latin layouts still work', () => {
    // On a Persian layout the typed character differs but `code` stays KeyP.
    expect(matchesShortcut(key('KeyP', { ctrlKey: true, shiftKey: true }), palette, 'linux')).toBe(
      true,
    )
    expect(matchesShortcut(key('KeyQ', { ctrlKey: true, shiftKey: true }), palette, 'linux')).toBe(
      false,
    )
  })
})

describe('formatShortcut', () => {
  it('uses glyphs on macOS, in Apple order', () => {
    expect(formatShortcut('Mod+Shift+P', 'darwin')).toEqual(['⇧', '⌘', 'P'])
    expect(formatShortcut('Mod+Alt+ArrowRight', 'darwin')).toEqual(['⌥', '⌘', '→'])
    expect(formatShortcut('Mod+,', 'darwin')).toEqual(['⌘', ','])
  })

  it('uses words on Windows and Linux', () => {
    expect(formatShortcut('Mod+Shift+P', 'win32')).toEqual(['Ctrl', 'Shift', 'P'])
    expect(formatShortcut('Mod+,', 'linux')).toEqual(['Ctrl', ','])
  })
})
