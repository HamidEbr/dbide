import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { editorTheme } from '@/features/sql/editor/theme'

interface ShellEditorProps {
  initial: string
  onChange: (text: string) => void
  /** Cmd/Ctrl+Enter. */
  onSubmit: () => void
  /** Escape. */
  onCancel: () => void
  autoFocus?: boolean
  label: string
}

/** A small editor for one value or document in the shell's notation. */
export function ShellEditor({
  initial,
  onChange,
  onSubmit,
  onCancel,
  autoFocus,
  label,
}: ShellEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onChange, onSubmit, onCancel })
  useEffect(() => {
    callbacks.current = { onChange, onSubmit, onCancel }
  })

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          javascript(),
          placeholder('{ field: "value" }'),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                callbacks.current.onSubmit()
                return true
              },
            },
            {
              key: 'Escape',
              run: () => {
                callbacks.current.onCancel()
                return true
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          editorTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString())
          }),
        ],
      }),
    })
    if (autoFocus) view.focus()
    return () => view.destroy()
    // The editor is built once for the text it starts with; the parent keeps what is typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="shell-editor" ref={host} />
}
