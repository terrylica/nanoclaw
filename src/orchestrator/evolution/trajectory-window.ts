/**
 * TrajectoryWindow: fixed-size circular buffer storing the last N action/outcome pairs.
 *
 * Provides O(1) push and O(N) snapshot access without unbounded memory growth.
 *
 * Usage:
 *   const window = new TrajectoryWindow(50);
 *   window.push({ action: 'prompt-refine', success: true, detail: 'score +0.2' });
 *   const recent = window.snapshot(); // newest-first
 */

// --- Types ---

export interface TrajectoryEntry {
  /** The action that was taken (e.g. 'prompt-refine', 'goal-fix') */
  action: string;
  /** Whether the action produced a successful outcome */
  success: boolean;
  /** Optional detail or diagnostic message */
  detail?: string;
  /** Unix timestamp (ms) when the entry was recorded */
  timestamp: number;
}

// --- TrajectoryWindow ---

export class TrajectoryWindow {
  private readonly buf: (TrajectoryEntry | undefined)[];
  private head = 0;
  private count = 0;

  /**
   * @param capacity Maximum number of entries to retain (default 50)
   */
  constructor(readonly capacity: number = 50) {
    this.buf = new Array(capacity);
  }

  /** Append an action/outcome entry, evicting the oldest when full. */
  push(entry: Omit<TrajectoryEntry, 'timestamp'>): void {
    this.buf[this.head] = { ...entry, timestamp: Date.now() };
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /**
   * Return all buffered entries ordered newest-first.
   * Returns at most `capacity` entries.
   */
  snapshot(): TrajectoryEntry[] {
    const result: TrajectoryEntry[] = [];
    for (let i = 1; i <= this.count; i++) {
      const idx = (this.head - i + this.capacity) % this.capacity;
      const entry = this.buf[idx];
      if (entry !== undefined) result.push(entry);
    }
    return result;
  }

  /** Number of entries currently in the buffer. */
  get size(): number {
    return this.count;
  }

  /** Remove all entries. */
  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
