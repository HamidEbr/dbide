import type { Density, ThemeSetting } from '@shared/settings'
import {
  activeScriptId,
  cancelFromEditor,
  runFromEditor,
  showQueryPlan,
} from '@/features/sql/actions'
import { hasResultView, showCurrentResultAs, useResultViews } from '@/features/sql/tools/viewState'
import { editHandleFor } from '@/features/sql/edit/handles'
import { editorFor } from '@/features/sql/editor/handles'
import { exporterFor } from '@/features/sql/export/handles'
import { activeGrid } from '@/features/sql/grid/active-grid'
import { duplicateScript, importScripts, revealScripts } from '@/features/sql/library'
import { createScript } from '@/features/sql/scripts'
import { defaultConnectionId } from '@/features/sql/target'
import { useData } from '@/state/data'
import { useDialogs } from '@/state/dialogs'
import { notify } from '@/state/notices'
import { useScripts } from '@/state/scripts'
import { useWorkbench, workbench, type SidebarView } from '@/state/workbench'
import { CommandRegistry } from './registry'

export const commands = new CommandRegistry()

const toggle = (key: 'navigatorOpen' | 'inspectorOpen') => (): void => {
  const settings = useData.getState().settings
  void useData.getState().updateSettings({ [key]: !settings[key] })
}

const setTheme = (theme: ThemeSetting) => (): void =>
  void useData.getState().updateSettings({ theme })

const setDensity = (density: Density) => (): void =>
  void useData.getState().updateSettings({ density })

/** Brings a view to the left side, opening the side first if it was hidden. */
const showSidebar = (view: SidebarView) => (): void => {
  const { settings, updateSettings } = useData.getState()
  if (!settings.navigatorOpen) void updateSettings({ navigatorOpen: true })
  useWorkbench.getState().setSidebar(view)
}

/** Registers every built-in command. Call once at startup. */
export function registerBuiltinCommands(): void {
  const hasActiveTab = (): boolean => useWorkbench.getState().activeId !== null
  const inSqlTab = (): boolean => activeScriptId() !== null
  const gridFocused = (): boolean => activeGrid() !== null

  const hasStagedChanges = (): boolean => {
    const id = activeScriptId()
    return id !== null && (editHandleFor(id)?.count() ?? 0) > 0
  }
  const hasExporter = (): boolean => {
    const id = activeScriptId()
    return id !== null && exporterFor(id) !== undefined
  }

  const all = [
    {
      id: 'palette.commands',
      title: 'Show all commands',
      category: 'Navigate',
      shortcut: 'Mod+Shift+P',
      run: () => useWorkbench.getState().setPalette('commands'),
    },
    {
      id: 'palette.goto',
      title: 'Go to anything…',
      category: 'Navigate',
      shortcut: 'Mod+P',
      run: () => useWorkbench.getState().setPalette('goto'),
    },
    {
      id: 'connection.new',
      title: 'New connection',
      category: 'Connection',
      shortcut: 'Mod+N',
      run: () => workbench.newConnection(),
    },
    {
      id: 'connection.importDbeaver',
      title: 'Import connections from another tool…',
      category: 'Connection',
      run: () => useDialogs.getState().openDbeaverImport(),
    },
    {
      id: 'schema.compare',
      title: 'Compare this schema with another…',
      category: 'Connection',
      run: () => {
        const id = activeScriptId()
        const script = id ? useScripts.getState().scripts[id] : undefined
        if (script?.connectionId && script.database) {
          useDialogs
            .getState()
            .openSchemaCompare({ connectionId: script.connectionId, database: script.database })
        } else {
          notify('Open a script on a database first, or use the compare button beside a database.')
        }
      },
    },
    {
      id: 'sql.builder',
      title: 'Build a query…',
      category: 'SQL',
      shortcut: 'Mod+Alt+Q',
      when: inSqlTab,
      run: () => {
        const id = activeScriptId()
        const script = id ? useScripts.getState().scripts[id] : undefined
        if (script?.connectionId && script.database) {
          useDialogs
            .getState()
            .openQueryBuilder({ connectionId: script.connectionId, database: script.database })
        } else {
          notify('Pick a database for the script first.')
        }
      },
    },
    {
      id: 'sql.explain',
      title: 'Show the query plan',
      category: 'SQL',
      shortcut: 'Mod+Alt+P',
      when: inSqlTab,
      run: () => showQueryPlan(activeScriptId()!),
    },
    {
      id: 'results.viewTable',
      title: 'Show the result as a table',
      category: 'Results',
      shortcut: 'Mod+Alt+1',
      when: hasResultView,
      run: () => showCurrentResultAs('grid'),
    },
    {
      id: 'results.viewPivot',
      title: 'Show the result as a pivot',
      category: 'Results',
      shortcut: 'Mod+Alt+2',
      when: hasResultView,
      run: () => showCurrentResultAs('pivot'),
    },
    {
      id: 'results.viewChart',
      title: 'Show the result as a chart',
      category: 'Results',
      shortcut: 'Mod+Alt+3',
      when: hasResultView,
      run: () => showCurrentResultAs('chart'),
    },
    {
      id: 'results.compare',
      title: 'Compare this result with another…',
      category: 'Results',
      shortcut: 'Mod+Alt+M',
      when: hasResultView,
      run: () => {
        const current = useResultViews.getState().current
        if (current) useDialogs.getState().openCompare(current)
      },
    },
    {
      id: 'diagram.open',
      title: 'Show a diagram of the database',
      category: 'Connection',
      shortcut: 'Mod+Alt+D',
      run: () => {
        const id = activeScriptId()
        const script = id ? useScripts.getState().scripts[id] : undefined
        if (script?.connectionId && script.database) {
          useDialogs
            .getState()
            .openDiagram({ connectionId: script.connectionId, database: script.database })
        } else {
          notify(
            'Open a script on a database first, or use the diagram button beside a database in the tree.',
          )
        }
      },
    },
    {
      id: 'script.new',
      title: 'New script',
      category: 'SQL',
      shortcut: 'Mod+T',
      run: () => {
        const connectionId = defaultConnectionId()
        if (connectionId) createScript({ connectionId })
        else if (useData.getState().connections.length === 0) workbench.newConnection()
        else {
          notify('Select a connection in the navigator first.')
        }
      },
    },
    {
      id: 'sql.run',
      title: 'Run statement',
      category: 'SQL',
      shortcut: 'Mod+Enter',
      when: inSqlTab,
      run: () => runFromEditor(activeScriptId()!, 'cursor'),
    },
    {
      id: 'sql.runAll',
      title: 'Run script',
      category: 'SQL',
      shortcut: 'Mod+Shift+Enter',
      when: inSqlTab,
      run: () => runFromEditor(activeScriptId()!, 'all'),
    },
    {
      id: 'sql.cancel',
      title: 'Cancel running statement',
      category: 'SQL',
      shortcut: 'Mod+.',
      when: inSqlTab,
      run: () => cancelFromEditor(activeScriptId()!),
    },
    {
      id: 'sql.format',
      title: 'Format SQL',
      category: 'SQL',
      shortcut: 'Mod+Alt+L',
      when: inSqlTab,
      run: () => void editorFor(activeScriptId()!)?.format(),
    },
    {
      id: 'script.history',
      title: 'Local history of this script',
      category: 'SQL',
      shortcut: 'Mod+Alt+H',
      when: inSqlTab,
      run: () => useDialogs.getState().openLocalHistory(activeScriptId()!),
    },
    {
      id: 'script.rename',
      title: 'Rename script',
      category: 'SQL',
      when: inSqlTab,
      run: () =>
        document.querySelector<HTMLElement>('.workbench-sql:not([hidden]) .script-name')?.click(),
    },
    {
      id: 'script.duplicate',
      title: 'Duplicate script',
      category: 'SQL',
      when: inSqlTab,
      run: () => void duplicateScript(activeScriptId()!),
    },
    {
      id: 'script.reveal',
      title: 'Show script in the file manager',
      category: 'SQL',
      when: inSqlTab,
      run: () => revealScripts(activeScriptId()),
    },
    {
      id: 'script.import',
      title: 'Import SQL files…',
      category: 'SQL',
      run: () => void importScripts(),
    },
    {
      id: 'script.revealFolder',
      title: 'Show the scripts folder',
      category: 'SQL',
      run: () => revealScripts(null),
    },
    {
      id: 'results.export',
      title: 'Export result…',
      category: 'Results',
      shortcut: 'Mod+Alt+E',
      when: hasExporter,
      run: () => exporterFor(activeScriptId()!)?.(),
    },
    {
      id: 'view.showConnections',
      title: 'Show connections',
      category: 'View',
      run: showSidebar('connections'),
    },
    {
      id: 'view.showScripts',
      title: 'Show scripts',
      category: 'View',
      shortcut: 'Mod+Shift+O',
      run: showSidebar('scripts'),
    },
    {
      id: 'view.showHistory',
      title: 'Show query history',
      category: 'View',
      shortcut: 'Mod+Shift+H',
      run: showSidebar('history'),
    },
    {
      id: 'edits.commit',
      title: 'Commit staged row changes',
      category: 'Results',
      shortcut: 'Mod+S',
      when: hasStagedChanges,
      run: () => editHandleFor(activeScriptId()!)?.commit(),
    },
    {
      id: 'edits.discard',
      title: 'Discard staged row changes',
      category: 'Results',
      when: hasStagedChanges,
      run: () => editHandleFor(activeScriptId()!)?.discard(),
    },
    {
      id: 'grid.copy',
      title: 'Copy selected cells',
      category: 'Results',
      shortcut: 'Mod+C',
      hidden: true,
      when: gridFocused,
      run: () => activeGrid()?.copy('tsv'),
    },
    {
      id: 'grid.copyWithHeaders',
      title: 'Copy selected cells with headers',
      category: 'Results',
      shortcut: 'Mod+Shift+C',
      when: gridFocused,
      run: () => activeGrid()?.copy('tsv', { headers: true }),
    },
    {
      id: 'grid.copyCsv',
      title: 'Copy selected cells as CSV',
      category: 'Results',
      when: gridFocused,
      run: () => activeGrid()?.copy('csv', { headers: true }),
    },
    {
      id: 'grid.copyJson',
      title: 'Copy selected cells as JSON',
      category: 'Results',
      when: gridFocused,
      run: () => activeGrid()?.copy('json'),
    },
    {
      id: 'grid.copyMarkdown',
      title: 'Copy selected cells as Markdown',
      category: 'Results',
      when: gridFocused,
      run: () => activeGrid()?.copy('markdown'),
    },
    {
      id: 'grid.copySqlInsert',
      title: 'Copy selected rows as SQL INSERT',
      category: 'Results',
      when: gridFocused,
      run: () => activeGrid()?.copy('sql-insert'),
    },
    {
      id: 'grid.copySqlUpdate',
      title: 'Copy selected rows as SQL UPDATE',
      category: 'Results',
      when: gridFocused,
      run: () => activeGrid()?.generate('update'),
    },
    {
      id: 'grid.copySqlDelete',
      title: 'Copy selected rows as SQL DELETE',
      category: 'Results',
      when: gridFocused,
      run: () => activeGrid()?.generate('delete'),
    },
    {
      id: 'grid.followForeignKey',
      title: 'Go to the row this foreign key points at',
      category: 'Results',
      shortcut: 'Mod+Alt+J',
      when: gridFocused,
      run: () => activeGrid()?.follow('references'),
    },
    {
      id: 'grid.findReferencingRows',
      title: 'Find the rows that point at this one',
      category: 'Results',
      when: gridFocused,
      run: () => activeGrid()?.follow('referencedBy'),
    },
    {
      id: 'tab.close',
      title: 'Close tab',
      category: 'Tabs',
      shortcut: 'Mod+W',
      when: hasActiveTab,
      run: () => {
        const { activeId, closeTab } = useWorkbench.getState()
        if (activeId) closeTab(activeId)
      },
    },
    {
      id: 'tab.next',
      title: 'Next tab',
      category: 'Tabs',
      shortcut: 'Mod+Alt+ArrowRight',
      run: () => useWorkbench.getState().cycle(1),
    },
    {
      id: 'tab.previous',
      title: 'Previous tab',
      category: 'Tabs',
      shortcut: 'Mod+Alt+ArrowLeft',
      run: () => useWorkbench.getState().cycle(-1),
    },
    {
      id: 'view.toggleNavigator',
      title: 'Toggle navigator',
      category: 'View',
      shortcut: 'Mod+B',
      run: toggle('navigatorOpen'),
    },
    {
      id: 'view.toggleInspector',
      title: 'Toggle inspector',
      category: 'View',
      shortcut: 'Mod+Alt+B',
      run: toggle('inspectorOpen'),
    },
    {
      id: 'settings.open',
      title: 'Open settings',
      category: 'App',
      shortcut: 'Mod+,',
      run: () => workbench.openSettings(),
    },
    {
      id: 'theme.system',
      title: 'Theme: follow system',
      category: 'View',
      run: setTheme('system'),
    },
    { id: 'theme.light', title: 'Theme: light', category: 'View', run: setTheme('light') },
    { id: 'theme.dark', title: 'Theme: dark', category: 'View', run: setTheme('dark') },
    {
      id: 'density.compact',
      title: 'Density: compact',
      category: 'View',
      run: setDensity('compact'),
    },
    {
      id: 'density.default',
      title: 'Density: default',
      category: 'View',
      run: setDensity('default'),
    },
    {
      id: 'density.comfortable',
      title: 'Density: comfortable',
      category: 'View',
      run: setDensity('comfortable'),
    },
  ]
  for (const command of all) commands.register(command)
}
