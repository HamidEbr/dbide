import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { linter, type Diagnostic } from '@codemirror/lint'
import { searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view'
import { useEffect, useMemo, useRef, useState } from 'react'
import { checkMongoStatement } from '@shared/mongo/check'
import { splitMongoStatements } from '@shared/mongo/lang'
import { statementAt } from '@shared/sql'
import { formatShortcut } from '@/commands/keybinding'
import { coreLink } from '@/ipc/link'
import { mongoCompletionSource, type CompletionEnv } from '@/features/mongo/completion'
import { notify } from '@/state/notices'
import { useScripts } from '@/state/scripts'
import { registerEditor } from './handles'
import { editorTheme } from './theme'

/** Field names by collection, read once per collection and remembered for the session. */
const fieldCache = new Map<string, Promise<string[]>>()

/** Collection names for autocomplete. Best effort: the editor works without them. */
const NO_NAMES: string[] = []

function useCollections(connectionId: string, database: string | null): string[] {
  const key = database ? `${connectionId}|${database}` : null
  const [loaded, setLoaded] = useState<{ key: string; names: string[] } | null>(null)
  useEffect(() => {
    if (!key || !database) return
    let cancelled = false
    coreLink
      .call('schema.completion', { connectionId, database })
      .then((result) => !cancelled && setLoaded({ key, names: Object.keys(result) }))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [key, connectionId, database])
  // Names that belong to another database are not offered.
  return loaded && loaded.key === key ? loaded.names : NO_NAMES
}

interface MongoEditorProps {
  scriptId: string
  connectionId: string
  database: string | null
  /** The editor takes focus when its tab becomes active. */
  active: boolean
}

/**
 * The editor of a MongoDB script: JavaScript highlighting, suggestions for collections, methods, operators
 * and fields, and a mark under whatever the shell would refuse, as it is typed.
 */
export function MongoEditor({ scriptId, connectionId, database, active }: MongoEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const collections = useCollections(connectionId, database)

  // The completion source reads these through refs, so the editor is built once.
  const live = useRef({ collections, database, connectionId })
  useEffect(() => {
    live.current = { collections, database, connectionId }
  })
  const env = useMemo<CompletionEnv>(
    () => ({
      collections: () => live.current.collections,
      fields: (db, collection) => {
        if (!db) return Promise.resolve([])
        const key = `${live.current.connectionId}|${db}|${collection}`
        let pending = fieldCache.get(key)
        if (!pending) {
          pending = coreLink
            .call('schema.fields', {
              connectionId: live.current.connectionId,
              database: db,
              collection,
            })
            .catch(() => [] as string[])
          fieldCache.set(key, pending)
        }
        return pending
      },
    }),
    [],
  )

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

    const mongoLinter = linter(
      (view): Diagnostic[] => {
        const text = view.state.doc.toString()
        const found: Diagnostic[] = []
        for (const statement of splitMongoStatements(text)) {
          const error = checkMongoStatement(statement.text)
          if (!error) continue
          const from = Math.min(statement.from + error.at, statement.to)
          found.push({
            from,
            to: Math.max(from + 1, Math.min(statement.to, from + 12)),
            severity: 'error',
            message: error.message,
          })
        }
        return found
      },
      { delay: 400 },
    )

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
          javascript(),
          autocompletion({
            override: [mongoCompletionSource(env, () => live.current.database)],
          }),
          mongoLinter,
          placeholder(
            `Write a MongoDB statement, such as db.orders.find({ status: "paid" }). ${run} runs the statement under the cursor, ${runAll} runs the script.`,
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
        if (mode === 'all') return splitMongoStatements(doc).map((s) => s.text)
        const selection = view.state.selection.main
        if (!selection.empty) {
          return splitMongoStatements(view.state.sliceDoc(selection.from, selection.to)).map(
            (s) => s.text,
          )
        }
        const statement = statementAt(splitMongoStatements(doc), selection.head)
        return statement ? [statement.text] : []
      },

      async format() {
        notify('There is no formatter for MongoDB scripts yet.')
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
  }, [scriptId, env])

  useEffect(() => {
    if (active) viewRef.current?.focus()
  }, [active])

  return <div className="sql-editor" ref={host} />
}
