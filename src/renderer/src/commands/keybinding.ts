import type { Platform } from '@shared/bridge'

/** The parts of a KeyboardEvent matching needs, so it can be tested without a DOM. */
export interface KeyLike {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export interface ParsedShortcut {
  /** ⌘ on macOS, Ctrl on Windows and Linux. */
  mod: boolean
  shift: boolean
  alt: boolean
  /** `KeyboardEvent.code`, i.e. the physical key. */
  code: string
}

const NAMED_KEYS: Record<string, string> = {
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote',
  "'": 'Quote',
  ';': 'Semicolon',
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
}

function keyToCode(key: string): string {
  const named = NAMED_KEYS[key.toLowerCase()]
  if (named) return named
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase()
  throw new Error(`Unknown key "${key}" in shortcut`)
}

/** Parses `Mod+Shift+P`. Keys are matched by physical position so they survive any layout. */
export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split('+').filter((part) => part.length > 0)
  // A lone "+" key would parse to nothing; it is not used by any built-in shortcut.
  const key = parts.pop()
  if (!key) throw new Error(`Empty shortcut "${shortcut}"`)

  const parsed: ParsedShortcut = { mod: false, shift: false, alt: false, code: keyToCode(key) }
  for (const modifier of parts) {
    switch (modifier.toLowerCase()) {
      case 'mod':
        parsed.mod = true
        break
      case 'shift':
        parsed.shift = true
        break
      case 'alt':
      case 'option':
        parsed.alt = true
        break
      default:
        throw new Error(`Unknown modifier "${modifier}" in shortcut "${shortcut}"`)
    }
  }
  return parsed
}

export function matchesShortcut(
  event: KeyLike,
  shortcut: ParsedShortcut,
  platform: Platform,
): boolean {
  const mac = platform === 'darwin'
  const modDown = mac ? event.metaKey : event.ctrlKey
  const otherDown = mac ? event.ctrlKey : event.metaKey
  return (
    event.code === shortcut.code &&
    modDown === shortcut.mod &&
    !otherDown &&
    event.shiftKey === shortcut.shift &&
    event.altKey === shortcut.alt
  )
}

const MAC_GLYPHS: Record<string, string> = {
  Mod: '⌘',
  Shift: '⇧',
  Alt: '⌥',
  Enter: '↵',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: '⌦',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
}

function displayKey(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  const punctuation = Object.entries(NAMED_KEYS).find(
    ([symbol, name]) => name === code && symbol.length === 1,
  )
  return punctuation ? punctuation[0] : code
}

/** Key caps to render: `⌘ ⇧ P` on macOS, `Ctrl Shift P` elsewhere. */
export function formatShortcut(shortcut: string, platform: Platform): string[] {
  const parsed = parseShortcut(shortcut)
  const mac = platform === 'darwin'
  const caps: string[] = []
  if (mac) {
    if (parsed.alt) caps.push(MAC_GLYPHS.Alt!)
    if (parsed.shift) caps.push(MAC_GLYPHS.Shift!)
    if (parsed.mod) caps.push(MAC_GLYPHS.Mod!)
  } else {
    if (parsed.mod) caps.push('Ctrl')
    if (parsed.alt) caps.push('Alt')
    if (parsed.shift) caps.push('Shift')
  }
  const key = displayKey(parsed.code)
  caps.push(mac ? (MAC_GLYPHS[parsed.code] ?? key) : key)
  return caps
}
