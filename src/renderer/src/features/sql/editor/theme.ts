import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/** Every color is a CSS variable from tokens.css, so the editor follows light, dark, and density. */
const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--fg-0)',
    backgroundColor: 'var(--bg-0)',
    fontSize: 'var(--fs-mono)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--fg-0)', padding: '8px 0' },
  '.cm-line': { padding: '0 12px 0 8px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg-0)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-0)',
    color: 'var(--fg-2)',
    border: 'none',
    paddingLeft: '4px',
  },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '28px', padding: '0 8px 0 4px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-0)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    { backgroundColor: 'var(--accent-soft)' },
  '.cm-matchingBracket': {
    backgroundColor: 'var(--accent-soft)',
    outline: '1px solid var(--line-strong)',
  },
  '.cm-placeholder': { color: 'var(--fg-2)' },
  '.cm-tooltip': {
    border: '1px solid var(--line-strong)',
    backgroundColor: 'var(--bg-0)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-popover)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '260px' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 10px', color: 'var(--fg-0)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--fg-0)',
  },
  '.cm-completionDetail': { color: 'var(--fg-2)', marginLeft: '12px' },
  '.cm-panels': { backgroundColor: 'var(--bg-1)', color: 'var(--fg-0)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--warn-soft)', outline: '1px solid var(--warn)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)' },
})

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-keyword)', fontWeight: '500' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--syn-comment)',
    fontStyle: 'italic',
  },
  { tag: [t.typeName, t.standard(t.name)], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-function)' },
  { tag: [t.operator, t.punctuation, t.separator], color: 'var(--fg-1)' },
])

export const editorTheme = [theme, syntaxHighlighting(highlight)]
