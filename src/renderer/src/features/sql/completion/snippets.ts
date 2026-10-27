import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { analyzeSql } from '@shared/sql-context'
import { allSnippets, type Snippet, type SnippetEngine } from '@shared/snippets'
import { useData } from '@/state/data'

const asOption = (snippet: Snippet): Completion =>
  snippetCompletion(snippet.body, {
    label: snippet.trigger,
    detail: snippet.name,
    type: 'text',
    // Above plain keywords: a trigger that is typed in full is meant.
    boost: 50,
  })

/**
 * Snippets in the editor's popup, offered where a statement begins or a keyword goes, never where a name is
 * being typed or inside a string.
 */
export function snippetSource(engine: SnippetEngine): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[A-Za-z_]\w*/)
    if (!word || (word.from === word.to && !context.explicit)) return null
    if (engine === 'sql') {
      const analysis = analyzeSql(context.state.doc.toString(), context.pos)
      if (analysis.kind !== 'keyword') return null
    } else {
      // A shell script: only at the start of a line, where a statement begins.
      const line = context.state.doc.lineAt(word.from)
      if (context.state.sliceDoc(line.from, word.from).trim() !== '') return null
    }
    return {
      from: word.from,
      options: allSnippets(engine, useData.getState().settings.snippets).map(asOption),
      validFor: /^\w*$/,
    }
  }
}
