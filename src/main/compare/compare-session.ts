import type { CompareSide, CompareState } from '@shared/types';

/** A shortcut press whose clipboard read is still running; it holds the press's place in line. */
export interface PendingPress {
  readonly epoch: number;
  readonly ticket: number;
}

/**
 * The two-press compare flow as a tiny state machine:
 *
 *   (none) --press--> waiting-for-b --press--> ready --press--> waiting-for-b (new A) ...
 *
 * Reading the clipboard is async, so a press is split in two: `beginPress()` takes the press's
 * slot at once, `completePress()` delivers its snapshot later. Snapshots are applied in press
 * order whatever order the reads finish in, so A is always the first press. A reset, or a
 * comparison opened from the history, starts a new epoch: reads begun before it are dropped.
 *
 * Pure: no timers, no Electron. The controller decides what to show for each state.
 */
export class CompareSession {
  private state: CompareState | null = null;
  private epoch = 0;
  private issued = 0;
  private applied = 0;
  /** Snapshots that finished before an earlier press did; `null` marks a failed read. */
  private readonly arrived = new Map<number, CompareSide | null>();

  get current(): CompareState | null {
    return this.state;
  }

  /** Feeds the clipboard content captured by one shortcut press. */
  press(side: CompareSide): CompareState {
    this.state =
      this.state?.phase === 'waiting-for-b'
        ? { phase: 'ready', left: this.state.left, right: side }
        : { phase: 'waiting-for-b', left: side };
    return this.state;
  }

  /** Reserves the next A/B slot at the moment the shortcut is pressed. */
  beginPress(): PendingPress {
    return { epoch: this.epoch, ticket: this.issued++ };
  }

  /**
   * Delivers a press's snapshot (`null` if reading failed, so later presses are not blocked) and
   * applies every snapshot that is now next in line. Returns whether the state changed.
   */
  completePress(press: PendingPress, side: CompareSide | null): boolean {
    if (press.epoch !== this.epoch) return false;
    this.arrived.set(press.ticket, side);
    let changed = false;
    while (this.arrived.has(this.applied)) {
      const next = this.arrived.get(this.applied);
      this.arrived.delete(this.applied);
      this.applied++;
      if (next) {
        this.press(next);
        changed = true;
      }
    }
    return changed;
  }

  /** Compares two known texts directly (e.g. two clips picked in the history). */
  set(left: CompareSide, right: CompareSide): CompareState {
    this.startEpoch();
    this.state = { phase: 'ready', left, right };
    return this.state;
  }

  reset(): void {
    this.startEpoch();
    this.state = null;
  }

  /** Presses still being read belong to the old epoch and will be ignored. */
  private startEpoch(): void {
    this.epoch++;
    this.arrived.clear();
    this.applied = this.issued;
  }
}
