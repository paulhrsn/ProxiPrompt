/** Owns one reconnect chain and one processing timer, including failed initial startup. */
export class ConnectionLoop<T> {
  private current: T | null = null;
  private attempt?: AbortController;
  private retry?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private failures = 0;
  private stopped = true;
  private busy = false;
  private queued = false;

  constructor(private readonly options: {
    connect: (signal: AbortSignal, disconnected: () => void) => Promise<T>;
    prepare: (connection: T, signal: AbortSignal) => Promise<void>;
    dispose: (connection: T) => void;
    process: (connection: T) => Promise<void>;
    onReady?: (connection: T) => void;
    onError?: (error: unknown) => void;
    intervalMs?: number;
    retryMs?: number;
  }) {}

  get ready(): T | null { return this.current; }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.processOnce(), this.options.intervalMs ?? 2000);
    void this.connect();
  }

  stop() {
    this.stopped = true;
    ++this.generation;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = undefined; this.retry = undefined;
    this.attempt?.abort(); this.attempt = undefined;
    if (this.current) this.options.dispose(this.current);
    this.current = null;
  }

  async processOnce() {
    if (!this.current || this.stopped) return;
    if (this.busy) { this.queued = true; return; }
    this.busy = true;
    try {
      do {
        this.queued = false;
        const connection = this.current;
        if (!connection || this.stopped) break;
        await this.options.process(connection);
      } while (this.queued && this.current && !this.stopped);
    } catch (error) { this.options.onError?.(error); }
    finally {
      this.busy = false;
      if (this.queued && this.current && !this.stopped) void this.processOnce();
    }
  }

  private async connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.attempt = controller;
    let candidate: T | undefined;
    let disposed = false;
    const disposeCandidate = () => {
      if (candidate && !disposed) { disposed = true; this.options.dispose(candidate); }
    };
    const recover = (error?: unknown) => {
      if (this.stopped || generation !== this.generation) return;
      ++this.generation;
      this.current = null;
      controller.abort();
      disposeCandidate();
      if (error) this.options.onError?.(error);
      const delay = Math.min((this.options.retryMs ?? 500) * 2 ** Math.min(this.failures++, 5), 10000);
      this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, delay);
    };
    try {
      candidate = await this.options.connect(controller.signal, () => recover());
      if (this.stopped || generation !== this.generation) { disposeCandidate(); return; }
      await this.options.prepare(candidate, controller.signal);
      if (this.stopped || generation !== this.generation) { disposeCandidate(); return; }
      this.current = candidate;
      this.failures = 0;
      this.options.onReady?.(candidate);
      void this.processOnce();
    } catch (error) { recover(error); }
  }
}
