import type { Platform } from '@shared/bridge'
import { matchesShortcut, parseShortcut, type KeyLike, type ParsedShortcut } from './keybinding'

export interface Command {
  id: string
  title: string
  category: string
  /** Default shortcut, written with `Mod` so it adapts to the OS (⌘ or Ctrl). */
  shortcut?: string
  /** Hide from the palette; still runnable by shortcut or menu. */
  hidden?: boolean
  /** Return false to disable the command right now. */
  when?: () => boolean
  run: () => void | Promise<void>
}

/**
 * Single source of truth for everything the user can do. The palette, the keyboard handler,
 * native menus and (later) toolbars and context menus all read from here, so a command can
 * never exist in one place and be missing from another.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, Command>()
  private readonly overrides = new Map<string, string | null>()
  private parsed = new Map<string, ParsedShortcut>()

  register(command: Command): () => void {
    if (this.commands.has(command.id)) throw new Error(`Command "${command.id}" already exists`)
    this.commands.set(command.id, command)
    this.reparse()
    return () => {
      this.commands.delete(command.id)
      this.reparse()
    }
  }

  get(id: string): Command | undefined {
    return this.commands.get(id)
  }

  list(): Command[] {
    return [...this.commands.values()]
  }

  /** The shortcut in effect: a user override wins, `null` means the user removed it. */
  shortcutOf(id: string): string | undefined {
    if (this.overrides.has(id)) return this.overrides.get(id) ?? undefined
    return this.commands.get(id)?.shortcut
  }

  /** Rebinds a command. Pass `null` to unbind it, `undefined` to restore the default. */
  setOverride(id: string, shortcut: string | null | undefined): void {
    if (shortcut === undefined) this.overrides.delete(id)
    else this.overrides.set(id, shortcut)
    this.reparse()
  }

  isEnabled(id: string): boolean {
    const command = this.commands.get(id)
    return command !== undefined && (command.when?.() ?? true)
  }

  async execute(id: string): Promise<boolean> {
    const command = this.commands.get(id)
    if (!command || !this.isEnabled(id)) return false
    await command.run()
    return true
  }

  /** The enabled command bound to this key press, if any. */
  findByEvent(event: KeyLike, platform: Platform): Command | undefined {
    for (const [id, shortcut] of this.parsed) {
      if (matchesShortcut(event, shortcut, platform) && this.isEnabled(id)) {
        return this.commands.get(id)
      }
    }
    return undefined
  }

  /** Commands that share a shortcut. Shown in a future keybindings editor. */
  conflicts(): Map<string, string[]> {
    const byShortcut = new Map<string, string[]>()
    for (const command of this.commands.values()) {
      const shortcut = this.shortcutOf(command.id)
      if (!shortcut) continue
      const key = shortcut.toLowerCase()
      byShortcut.set(key, [...(byShortcut.get(key) ?? []), command.id])
    }
    return new Map([...byShortcut].filter(([, ids]) => ids.length > 1))
  }

  private reparse(): void {
    const parsed = new Map<string, ParsedShortcut>()
    for (const command of this.commands.values()) {
      const shortcut = this.shortcutOf(command.id)
      if (shortcut) parsed.set(command.id, parseShortcut(shortcut))
    }
    this.parsed = parsed
  }
}
