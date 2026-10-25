import { describe, expect, it, vi } from 'vitest'
import { BatchQueue } from './batch-queue'

describe('BatchQueue', () => {
  it('delivers items in order, then reports completion', async () => {
    const queue = new BatchQueue<number>(() => undefined)
    queue.push(1)
    queue.push(2)
    queue.end()
    expect(await queue.next()).toEqual({ value: 1, done: false })
    expect(await queue.next()).toEqual({ value: 2, done: false })
    expect((await queue.next()).done).toBe(true)
  })

  it('wakes a waiting consumer when an item arrives', async () => {
    const queue = new BatchQueue<string>(() => undefined)
    const pending = queue.next()
    queue.push('hello')
    expect(await pending).toEqual({ value: 'hello', done: false })
  })

  it('delivers queued items before a failure, then throws it', async () => {
    const queue = new BatchQueue<number>(() => undefined)
    queue.push(1)
    queue.fail(new Error('lost connection'))
    expect(await queue.next()).toEqual({ value: 1, done: false })
    await expect(queue.next()).rejects.toThrow('lost connection')
  })

  it('ignores items pushed after the end', async () => {
    const queue = new BatchQueue<number>(() => undefined)
    queue.end()
    queue.push(1)
    expect((await queue.next()).done).toBe(true)
  })

  it('asks the producer to pause when too many items wait and to resume once drained', async () => {
    const onPressure = vi.fn()
    const queue = new BatchQueue<number>(onPressure, 3, 1)
    queue.push(1)
    queue.push(2)
    expect(onPressure).not.toHaveBeenCalled()
    queue.push(3)
    expect(onPressure).toHaveBeenLastCalledWith(true)

    await queue.next() // 2 left, above the low mark
    expect(onPressure).toHaveBeenCalledTimes(1)
    await queue.next() // 1 left, at the low mark
    expect(onPressure).toHaveBeenLastCalledWith(false)
    expect(onPressure).toHaveBeenCalledTimes(2)
  })

  it('only signals pressure once while it stays high', () => {
    const onPressure = vi.fn()
    const queue = new BatchQueue<number>(onPressure, 2, 0)
    for (let i = 0; i < 10; i++) queue.push(i)
    expect(onPressure).toHaveBeenCalledTimes(1)
    expect(queue.size).toBe(10)
  })
})
