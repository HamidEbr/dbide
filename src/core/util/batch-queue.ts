/**
 * Hands items from a fast producer (a database socket) to a slower consumer (the UI) with
 * backpressure: when too many items wait, `onPressure(true)` tells the producer to stop reading,
 * and `onPressure(false)` lets it continue once the consumer catches up. Memory stays flat no
 * matter how large the result is.
 */
export class BatchQueue<T> {
  private readonly items: T[] = []
  private waiter: (() => void) | null = null
  private finished = false
  private failure: { error: unknown } | null = null
  private pressured = false

  constructor(
    private readonly onPressure: (pressured: boolean) => void,
    private readonly high = 8,
    private readonly low = 2,
  ) {}

  push(item: T): void {
    if (this.finished) return
    this.items.push(item)
    this.wake()
    if (!this.pressured && this.items.length >= this.high) {
      this.pressured = true
      this.onPressure(true)
    }
  }

  /** No more items will come. Items already queued are still delivered. */
  end(): void {
    this.finished = true
    this.wake()
  }

  /** The producer failed. Queued items are delivered first, then the consumer sees the error. */
  fail(error: unknown): void {
    if (this.finished) return
    this.failure = { error }
    this.finished = true
    this.wake()
  }

  /** Pending items, for tests and diagnostics. */
  get size(): number {
    return this.items.length
  }

  async next(): Promise<IteratorResult<T>> {
    for (;;) {
      const item = this.items.shift()
      if (item !== undefined) {
        if (this.pressured && this.items.length <= this.low) {
          this.pressured = false
          this.onPressure(false)
        }
        return { value: item, done: false }
      }
      if (this.failure) throw this.failure.error
      if (this.finished) return { value: undefined, done: true }
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
  }
}
