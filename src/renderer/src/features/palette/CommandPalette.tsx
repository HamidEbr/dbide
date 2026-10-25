import { Command } from 'cmdk'
import { useState } from 'react'
import { commands } from '@/commands/commands'
import { EngineIcon, EnvDot, Kbd } from '@/components/ui'
import { useData } from '@/state/data'
import { useWorkbench, workbench } from '@/state/workbench'

/**
 * One dialog, two modes. "Commands" lists everything runnable; "Go to anything" jumps to
 * connections. Later milestones add tables, collections, keys, and queues to the same list.
 */
export function CommandPalette() {
  const mode = useWorkbench((state) => state.palette)
  const setPalette = useWorkbench((state) => state.setPalette)
  const connections = useData((state) => state.connections)
  const [search, setSearch] = useState('')

  // The query is cleared on the way out, so the next open starts empty without an effect.
  const close = (): void => {
    setSearch('')
    setPalette(null)
  }
  const run = (action: () => void): void => {
    close()
    // Let the dialog unmount first so focus returns to the page before the action runs.
    queueMicrotask(action)
  }

  const visibleCommands = commands
    .list()
    .filter((command) => !command.hidden && commands.isEnabled(command.id))
  const categories = [...new Set(visibleCommands.map((command) => command.category))]

  return (
    <Command.Dialog
      open={mode !== null}
      onOpenChange={(open) => !open && close()}
      label={mode === 'goto' ? 'Go to anything' : 'Command palette'}
      className="palette"
      overlayClassName="palette-overlay"
      contentClassName="palette-content"
    >
      <Command.Input
        value={search}
        onValueChange={setSearch}
        placeholder={mode === 'goto' ? 'Go to a connection…' : 'Type a command…'}
      />
      <Command.List>
        <Command.Empty>Nothing matches “{search}”.</Command.Empty>

        {mode === 'goto' ? (
          <Command.Group heading="Connections">
            {connections.map((connection) => (
              <Command.Item
                key={connection.id}
                value={`${connection.name} ${connection.host} ${connection.engine}`}
                onSelect={() => run(() => workbench.openConnection(connection.id))}
              >
                <EnvDot environment={connection.environment} />
                <EngineIcon engine={connection.engine} />
                <span>{connection.name}</span>
                <span className="palette-detail mono">
                  {connection.host}:{connection.port}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : (
          categories.map((category) => (
            <Command.Group key={category} heading={category}>
              {visibleCommands
                .filter((command) => command.category === category)
                .map((command) => {
                  const shortcut = commands.shortcutOf(command.id)
                  return (
                    <Command.Item
                      key={command.id}
                      value={`${command.category} ${command.title}`}
                      onSelect={() => run(() => void commands.execute(command.id))}
                    >
                      <span>{command.title}</span>
                      {shortcut ? <Kbd shortcut={shortcut} /> : null}
                    </Command.Item>
                  )
                })}
            </Command.Group>
          ))
        )}
      </Command.List>
    </Command.Dialog>
  )
}
