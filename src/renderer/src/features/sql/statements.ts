import { splitMongoStatements } from '@shared/mongo/lang'
import type { ScriptLanguage } from '@shared/scripts'
import { splitStatements } from '@shared/sql'

/** Where a statement sits in a script's text. The same shape for every language. */
export interface Statement {
  text: string
  from: number
  to: number
  end: number
}

/** Cuts a script into the statements that run one after another. */
export function statementsOf(language: ScriptLanguage, text: string): Statement[] {
  return language === 'mongodb' ? splitMongoStatements(text) : splitStatements(text)
}

/** The extension of a script's file, for showing next to its name. */
export const extensionOf = (language: ScriptLanguage): string =>
  language === 'mongodb' ? '.mongodb' : '.sql'
