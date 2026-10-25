import { evaluate } from './eval'
import { MongoSyntaxError, parseMongoStatement } from './lang'

/**
 * Reads a statement the way the core will, down to its values, and reports the first thing wrong with it:
 * a syntax error, or an argument such as `ObjectId("nope")` that can't be built. Returns null when
 * the statement is fine, which is not a promise the server will accept it.
 */
export function checkMongoStatement(text: string): MongoSyntaxError | null {
  try {
    const command = parseMongoStatement(text)
    if (command.kind === 'collection' || command.kind === 'database') {
      for (const expr of command.args) evaluate(expr)
      for (const modifier of command.modifiers) for (const expr of modifier.args) evaluate(expr)
    }
    return null
  } catch (error) {
    if (error instanceof MongoSyntaxError) return error
    throw error
  }
}
