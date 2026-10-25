import { describe, expect, it, vi } from 'vitest'
import type { KeyLike } from './keybinding'
import { CommandRegistry, type Command } from './registry'

const press = (code: string, mods: Partial<Omit<KeyLike, 'code'>> = {}): KeyLike => ({
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

const command = (overrides: Partial<Command> = {}): Command => ({
  id: 'test.command',
  title: 'Test command',
  category: 'Test',
  run: () => undefined,
  ...overrides,
})

describe('CommandRegistry', () => {
  it('runs a registered command by id', async () => {
    const registry = new CommandRegistry()
    const run = vi.fn()
    registry.register(command({ run }))
    await expect(registry.execute('test.command')).resolves.toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })

  it('refuses duplicate ids', () => {
    const registry = new CommandRegistry()
    registry.register(command())
    expect(() => registry.register(command())).toThrow(/already exists/)
  })

  it('does not run a command that is disabled right now', async () => {
    const registry = new CommandRegistry()
    const run = vi.fn()
    registry.register(command({ when: () => false, run }))
    await expect(registry.execute('test.command')).resolves.toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('returns false for unknown ids', async () => {
    await expect(new CommandRegistry().execute('nope')).resolves.toBe(false)
  })

  it('finds the command bound to a key press', () => {
    const registry = new CommandRegistry()
    registry.register(command({ shortcut: 'Mod+K' }))
    expect(registry.findByEvent(press('KeyK', { metaKey: true }), 'darwin')?.id).toBe(
      'test.command',
    )
    expect(registry.findByEvent(press('KeyK', { ctrlKey: true }), 'darwin')).toBeUndefined()
  })

  it('skips disabled commands when looking up a shortcut', () => {
    const registry = new CommandRegistry()
    registry.register(command({ shortcut: 'Mod+K', when: () => false }))
    expect(registry.findByEvent(press('KeyK', { metaKey: true }), 'darwin')).toBeUndefined()
  })

  it('lets a user override replace, remove, or restore the default shortcut', () => {
    const registry = new CommandRegistry()
    registry.register(command({ shortcut: 'Mod+K' }))

    registry.setOverride('test.command', 'Mod+J')
    expect(registry.shortcutOf('test.command')).toBe('Mod+J')
    expect(registry.findByEvent(press('KeyJ', { metaKey: true }), 'darwin')).toBeDefined()
    expect(registry.findByEvent(press('KeyK', { metaKey: true }), 'darwin')).toBeUndefined()

    registry.setOverride('test.command', null)
    expect(registry.shortcutOf('test.command')).toBeUndefined()

    registry.setOverride('test.command', undefined)
    expect(registry.shortcutOf('test.command')).toBe('Mod+K')
  })

  it('reports commands that share a shortcut', () => {
    const registry = new CommandRegistry()
    registry.register(command({ id: 'a', shortcut: 'Mod+K' }))
    registry.register(command({ id: 'b', shortcut: 'mod+k' }))
    registry.register(command({ id: 'c', shortcut: 'Mod+L' }))
    expect([...registry.conflicts().values()]).toEqual([['a', 'b']])
  })

  it('unregisters a command', () => {
    const registry = new CommandRegistry()
    const off = registry.register(command({ shortcut: 'Mod+K' }))
    off()
    expect(registry.get('test.command')).toBeUndefined()
    expect(registry.findByEvent(press('KeyK', { metaKey: true }), 'darwin')).toBeUndefined()
  })
})
