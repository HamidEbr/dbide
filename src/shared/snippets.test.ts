import { describe, expect, it } from 'vitest'
import { allSnippets, BUILT_IN_SNIPPETS, snippetProblem } from './snippets'

describe('snippets', () => {
  it('lets a person’s own snippet replace a built-in one with the same trigger', () => {
    const all = allSnippets('sql', [{ trigger: 'SEL', name: 'Mine', body: 'SELECT 1' }])
    expect(all.filter((s) => s.trigger.toLowerCase() === 'sel')).toEqual([
      { trigger: 'SEL', name: 'Mine', body: 'SELECT 1' },
    ])
    expect(all.length).toBe(BUILT_IN_SNIPPETS.sql.length)
  })

  it('keeps each engine’s built-ins apart', () => {
    expect(allSnippets('mongo', []).map((s) => s.trigger)).toContain('aggr')
    expect(allSnippets('sql', []).map((s) => s.trigger)).not.toContain('aggr')
  })

  it('has unique triggers and valid built-ins', () => {
    for (const list of Object.values(BUILT_IN_SNIPPETS)) {
      expect(new Set(list.map((s) => s.trigger)).size).toBe(list.length)
      for (const s of list) expect(snippetProblem(s)).toBeNull()
    }
  })

  it('says what is wrong with a snippet', () => {
    expect(snippetProblem({ trigger: '1a', name: '', body: 'x' })).toMatch(/trigger/)
    expect(snippetProblem({ trigger: 'a', name: '', body: ' ' })).toMatch(/body/)
    expect(snippetProblem({ trigger: 'a', name: '', body: 'x' })).toBeNull()
  })
})
