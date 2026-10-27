import {
  autocompletion,
  type CompletionSource,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { keywordCompletionSource, MySQL, sql } from '@codemirror/lang-sql'
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
import { analyzeSql } from '@shared/sql-context'
import { formatShortcut } from '@/commands/keybinding'
import { notify } from '@/state/notices'
import { useScripts } from '@/state/scripts'
import { registerEditor } from './handles'
import { schemaCache } from '../completion/schema-cache'
import { sqlCompletionSource } from '../completion/source'
import { editorTheme } from './theme'

const mysql = () => sql({ dialect: MySQL, upperCaseKeywords: false })

const keywords = keywordCompletionSource(MySQL, false)

/** Keywords and functions where they belong: not where a table or a database is being named. */
const keywordSource: CompletionSource = (context) => {
  const analysis = analyzeSql(context.state.doc.toString(), context.pos)
  if (analysis.kind === 'none' || analysis.kind === 'table' || analysis.kind === 'database') {
    return null
  }
  if (analysis.kind === 'column' && analysis.qualifier !== null) return null
  return keywords(context)
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
  const live = useRef({ database })
  useEffect(() => {
    live.current = { database }
    // Read the names now, so the first suggestion doesn't wait for the server.
    if (database) void schemaCache.detail(connectionId, database)
    void schemaCache.databases(connectionId)
  }, [connectionId, database])
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
              }),
              keywordSource,
            ],
          }),
          language.of(mysql()),
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
        if (mode === 'all') return splitStatements(doc).map((s) => s.text)
        const selection = view.state.selection.main
        if (!selection.empty) {
          return splitStatements(view.state.sliceDoc(selection.from, selection.to)).map(
            (s) => s.text,
          )
        }
        const statement = statementAt(splitStatements(doc), selection.head)
        return statement ? [statement.text] : []
      },

      async format() {
        const { format } = await import('sql-formatter')
        const selection = view.state.selection.main
        const from = selection.empty ? 0 : selection.from
        const to = selection.empty ? view.state.doc.length : selection.to
        try {
          const formatted = format(view.state.sliceDoc(from, to), {
            language: 'mysql',
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
