import { describe, expect, it } from 'vitest'
import { BSON, MongoServerSelectionError } from 'mongodb'
import { describeMongoError, MongoError, ShellError, syntaxError } from './errors'
import { MongoSyntaxError } from '@shared/mongo/lang'

const { Int32 } = BSON

describe('describeMongoError', () => {
  it('explains a refused login and keeps the server’s words', () => {
    expect(
      describeMongoError(
        Object.assign(new Error('Authentication failed.'), {
          codeName: 'AuthenticationFailed',
          code: 18,
        }),
      ),
    ).toEqual({
      code: 'AuthenticationFailed',
      message: expect.stringMatching(/^Authentication failed\. Check the username and password/),
    })
  })

  it('names a code that came as a number, even when the driver read it as a BSON Int32', () => {
    expect(describeMongoError({ code: 11000, message: 'E11000 duplicate key' })).toMatchObject({
      code: 'DuplicateKey',
      message: 'E11000 duplicate key',
    })
    expect(
      describeMongoError({ code: new Int32(11000), message: 'E11000 duplicate key' }).code,
    ).toBe('DuplicateKey')
    expect(describeMongoError({ code: new Int32(9999), message: 'odd' }).code).toBe('9999')
  })

  it('says what to do about the failures people meet', () => {
    expect(
      describeMongoError({ codeName: 'Unauthorized', message: 'not authorized on shop' }).message,
    ).toMatch(/does not have the role/)
    expect(describeMongoError({ codeName: 'MaxTimeMSExpired', message: 'x' }).message).toMatch(
      /ran out of time/,
    )
    expect(describeMongoError({ codeName: 'CursorNotFound', message: 'x' }).message).toMatch(
      /ten minutes/,
    )
    expect(describeMongoError({ codeName: 'Interrupted', message: 'x' }).message).toBe(
      'The operation was cancelled.',
    )
    expect(
      describeMongoError({
        codeName: 'DocumentValidationFailure',
        message: 'Document failed validation',
        errInfo: { details: 'rule' },
      }).message,
    ).toMatch(/validation rules refused the document/)
  })

  it('says which server version is too old', () => {
    expect(
      describeMongoError(
        new Error(
          'Server at x:27017 reports maximum wire version 6, but this version of the Node.js Driver requires at least 9 (MongoDB 4.4)',
        ),
      ),
    ).toEqual({
      code: 'SERVER_TOO_OLD',
      message: 'This MongoDB server is version 3.6. DBIDE needs MongoDB 4.4 or newer.',
    })
  })

  it('suggests a direct connection when a replica set cannot be reached', () => {
    const error = new MongoServerSelectionError('getaddrinfo ENOTFOUND db-1.internal', {
      type: 'ReplicaSetNoPrimary',
      servers: new Map(),
    } as never)
    const described = describeMongoError(error)
    expect(described.code).toBe('CONNECTION_CLOSED')
    expect(described.message).toMatch(/Couldn’t reach a MongoDB server/)
    expect(described.message).toMatch(/Connect to this host only|Direct connection/)
  })

  it('treats a lost connection as one that has to be reopened', () => {
    expect(
      describeMongoError(Object.assign(new Error('read ECONNRESET'), { name: 'MongoNetworkError' }))
        .code,
    ).toBe('CONNECTION_CLOSED')
  })

  it('wraps into an error that carries the code', () => {
    const error = new MongoError({ code: 11000, message: 'dup' })
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ code: 'DuplicateKey', message: 'dup', name: 'MongoError' })
  })
})

describe('syntaxError', () => {
  it('adds the line and column of the mistake', () => {
    const error = syntaxError(new MongoSyntaxError('Unexpected “}”.', 17), 'db.a.find({\n  x: }')
    expect(error).toBeInstanceOf(ShellError)
    expect(error).toMatchObject({
      code: 'SYNTAX_ERROR',
      message: 'Unexpected “}”. (line 2, column 6)',
    })
  })

  it('passes other errors through unchanged', () => {
    const other = new Error('boom')
    expect(syntaxError(other, '')).toBe(other)
  })
})
