/**
 * A bounded work queue with a concurrency limit.
 *
 * Why this exists: the newPool handler in src/index.ts is an async
 * EventEmitter callback. EventEmitter does not await its listeners, so every
 * detected token used to fire its full ~110-call metrics pipeline immediately,
 * in parallel with every other token, with no ceiling. On a busy Pump.fun
 * minute that is several hundred concurrent RPC calls from one process - which
 * is exactly how a 3-hour run produced 41% HTTP 429s and a median metrics
 * collection of 20 seconds against a 4-second budget.
 *
 * Pure and dependency-free (the drop callback is injected), so it is fully
 * testable offline with no network, no config and no clock games.
 */
export interface WorkQueueOptions<T> {
  /** How many jobs may run at once. */
  maxConcurrent: number;
  /** Cap on the number of jobs WAITING. Past this the oldest waiting job is dropped. */
  maxQueued: number;
  /** The work itself. Rejections are reported via onError, never left unhandled. */
  worker: (item: T) => Promise<void>;
  /**
   * Called when a job is evicted because the backlog is full. The OLDEST
   * waiting job is dropped, not the newest: a token detected 40 seconds ago has
   * already lost whatever edge it had, while the one just detected still has a
   * chance. Dropping silently would hide exactly the overload this class exists
   * to make visible.
   */
  onDrop?: (item: T, queueLength: number) => void;
  onError?: (item: T, err: unknown) => void;
}

export class WorkQueue<T> {
  private readonly opts: WorkQueueOptions<T>;
  private waiting: T[] = [];
  private running = 0;
  private totalAccepted = 0;
  private totalDropped = 0;
  private totalCompleted = 0;

  constructor(opts: WorkQueueOptions<T>) {
    if (opts.maxConcurrent <= 0) throw new Error("WorkQueue: maxConcurrent must be > 0");
    if (opts.maxQueued <= 0) throw new Error("WorkQueue: maxQueued must be > 0");
    this.opts = opts;
  }

  /**
   * Offer an item. Returns false if it displaced an older item (i.e. the queue
   * was already full) - the caller may want to log that. Never blocks and never
   * throws: an overloaded bot must keep watching, not fall over.
   */
  push(item: T): boolean {
    this.totalAccepted++;
    let dropped = false;

    if (this.waiting.length >= this.opts.maxQueued) {
      const evicted = this.waiting.shift();
      this.totalDropped++;
      dropped = true;
      if (evicted !== undefined) this.opts.onDrop?.(evicted, this.waiting.length);
    }

    this.waiting.push(item);
    this.pump();
    return !dropped;
  }

  /** Start as many jobs as the concurrency limit allows. */
  private pump(): void {
    while (this.running < this.opts.maxConcurrent && this.waiting.length > 0) {
      const item = this.waiting.shift() as T;
      this.running++;
      // Deliberately not awaited - pump() returns immediately so the caller
      // (an event handler) is never blocked.
      void this.run(item);
    }
  }

  private async run(item: T): Promise<void> {
    try {
      await this.opts.worker(item);
    } catch (err) {
      this.opts.onError?.(item, err);
    } finally {
      this.running--;
      this.totalCompleted++;
      this.pump();
    }
  }

  /** Snapshot for logging/tests. */
  stats() {
    return {
      running: this.running,
      queued: this.waiting.length,
      totalAccepted: this.totalAccepted,
      totalDropped: this.totalDropped,
      totalCompleted: this.totalCompleted,
    };
  }

  /** Resolves once everything in flight and waiting has finished. Used by tests and shutdown. */
  async drain(): Promise<void> {
    while (this.running > 0 || this.waiting.length > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
