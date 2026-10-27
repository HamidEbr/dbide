import {
  autocompletion,
  type CompletionSource,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { keywordCompletionSource, MSSQL, MySQL, PostgreSQL, sql } from '@codemirror/lang-sql'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view'
import { useEffect, useMemo, useRef } from 'react'
import { splitStatements, statementAt } from '@shared/sql'
import { dialectOf, type SqlDialect } from '@shared/dialect'
import { analyzeSql } from '@shared/sql-context'
import { formatShortcut } from '@/commands/keybinding'
import { notify } from '@/state/notices'
import { useData } from '@/state/data'
import { useScripts } from '@/state/scripts'
import { registerEditor } from './handles'
import { schemaCache } from '../completion/schema-cache'
import { snippetSource } from '../completion/snippets'
import { sqlCompletionSource } from '../completion/source'
import { editorTheme } from './theme'

const CM_DIALECTS = { mysql: MySQL, postgresql: PostgreSQL, mssql: MSSQL } as const
const sqlLanguage = (dialect: SqlDialect) =>
  sql({ dialect: CM_DIALECTS[dialect], upperCaseKeywords: false })

const keywordSources = Object.fromEntries(
  (Object.keys(CM_DIALECTS) as SqlDialect[]).map((d) => [
    d,
    {
      upper: keywordCompletionSource(CM_DIALECTS[d], true),
      lower: keywordCompletionSource(CM_DIALECTS[d], false),
    },
  ]),
) as Record<SqlDialect, { upper: CompletionSource; lower: CompletionSource }>

/** The formatter's name for each server's SQL. */
const FORMATTER_LANGUAGE: Record<SqlDialect, 'mysql' | 'postgresql' | 'transactsql'> = {
  mysql: 'mysql',
  postgresql: 'postgresql',
  mssql: 'transactsql',
}

/** Keywords and functions where they belong: not where a table or a database is being named. */
const keywordSourceFor =
  (dialect: () => SqlDialect): CompletionSource =>
  (context) => {
    const d = dialect()
    const analysis = analyzeSql(context.state.doc.toString(), context.pos, d)
    if (analysis.kind === 'none' || analysis.kind === 'table' || analysis.kind === 'database') {
      return null
    }
    if (analysis.kind === 'column' && analysis.qualifier !== null) return null
    const sources = keywordSources[d]
    return (useData.getState().settings.sqlUppercaseKeywords ? sources.upper : sources.lower)(
      context,
    )
  }

interface SqlEditorProps {
  scriptId: string
  connectionId: string
  database: string | null
  /** The editor takes focus when its tab becomes active. */
  active: boolean
}

export function SqlEditor({ scriptId, connectionId, database, active }: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const language = useMemo(() => new Compartment(), [])
  // The editor is built once per script; the database it asks about can change underneath it.
  const engine = useData((state) => state.connections.find((c) => c.id === connectionId)?.engine)
  const dialect: SqlDialect = (engine && dialectOf(engine)) || 'mysql'
  const live = useRef({ database, dialect })
  useEffect(() => {
    live.current = { database, dialect }
    viewRef.current?.dispatch({ effects: language.reconfigure(sqlLanguage(dialect)) })
    // Read the names now, so the first suggestion doesn't wait for the server.
    if (database) void schemaCache.detail(connectionId, database)
    void schemaCache.databases(connectionId)
  }, [connectionId, database, dialect, language])
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const platform = window.dbide.platform
    const run = formatShortcut('Mod+Enter', platform).join('')
    const runAll = formatShortcut('Mod+Shift+Enter', platform).join('')

    let timer: ReturnType<typeof setTimeout> | undefined
    const save = (view: EditorView): void => {
      timer = undefined
      useScripts.getState().patch(scriptId, { text: view.state.doc.toString() })
    }

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: useScripts.getState().scripts[scriptId]?.text ?? '',
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({
            override: [
              sqlCompletionSource({
                connectionId,
                database: () => live.current.database,
                cache: schemaCache,
                fullPaths: () => useData.getState().settings.sqlFullPaths,
                dialect: () => live.current.dialect,
              }),
              snippetSource('sql', () => live.current.dialect),
              keywordSourceFor(() => live.current.dialect),
            ],
          }),
          language.of(sqlLanguage(live.current.dialect)),
          placeholder(
            `Write SQL. ${run} runs the statement under the cursor, ${runAll} runs the script.`,
          ),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
          ]),
          editorTheme,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            clearTimeout(timer)
            timer = setTimeout(() => save(update.view), 200)
          }),
        ],
      }),
    })
    viewRef.current = view

    const unregister = registerEditor(scriptId, {
      statements(mode) {
        const doc = view.state.doc.toString()
        const d = live.current.dialect
        if (mode === 'all') return splitStatements(doc, d).map((s) => s.text)
        const selection = view.state.selection.main
        if (!selection.empty) {
          return splitStatements(view.state.sliceDoc(selection.from, selection.to), d).map(
            (s) => s.text,
          )
        }
        const statement = statementAt(splitStatements(doc, d), selection.head)
        return statement ? [statement.text] : []
      },

      async format() {
        const { format } = await import('sql-formatter')
        const selection = view.state.selection.main
        const from = selection.empty ? 0 : selection.from
        const to = selection.empty ? view.state.doc.length : selection.to
        try {
          const formatted = format(view.state.sliceDoc(from, to), {
            language: FORMATTER_LANGUAGE[live.current.dialect],
            keywordCase: 'upper',
            tabWidth: 2,
            linesBetweenQueries: 1,
          })
          view.dispatch({ changes: { from, to, insert: formatted } })
        } catch (error) {
          notify(
            `Couldn’t format this SQL. ${error instanceof Error ? error.message.split('\n')[0] : ''}`,
            'error',
          )
        }
      },

      focus: () => view.focus(),

      getText: () => view.state.doc.toString(),

      setText(text) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      },

      insertAtCursor(text) {
        view.dispatch(view.state.replaceSelection(text))
        view.focus()
      },
    })

    return () => {
      unregister()
      if (timer !== undefined) {
        clearTimeout(timer)
        save(view)
      }
      view.destroy()
      viewRef.current = null
    }
  }, [scriptId, language, connectionId])

  useEffect(() => {
    if (active) viewRef.current?.focus()
  }, [active])

  return <div className="sql-editor" ref={host} />
}
