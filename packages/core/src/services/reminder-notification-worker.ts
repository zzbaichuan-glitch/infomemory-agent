import type { Reminder } from '../domain.js';
import type { ReminderDeliveryRepository } from '../repositories/reminder-repository.js';

export interface ReminderNotifier {
  notify(reminder: Reminder): Promise<void>;
}

export interface ReminderNotificationWorkerOptions {
  intervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export class ReminderNotificationWorker {
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #leaseMs: number;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #inFlight: Promise<number> | undefined;

  constructor(
    private readonly repository: ReminderDeliveryRepository,
    private readonly notifier: ReminderNotifier,
    options: ReminderNotificationWorkerOptions = {},
  ) {
    this.#intervalMs = Math.max(1_000, options.intervalMs ?? 15_000);
    this.#batchSize = Math.max(1, Math.min(options.batchSize ?? 50, 200));
    this.#leaseMs = Math.max(5_000, options.leaseMs ?? 300_000);
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((error: unknown) => this.#onError(error));
    }, this.#intervalMs);
    this.#timer.unref?.();
    void this.tick().catch((error: unknown) => this.#onError(error));
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Stop scheduling new notifications and wait for the active tick to settle. */
  async stopAndDrain(): Promise<void> {
    this.stop();
    const inFlight = this.#inFlight;
    if (!inFlight) return;
    try {
      await inFlight;
    } catch (error) {
      this.#onError(error);
    }
  }

  async tick(at = this.#now()): Promise<number> {
    if (this.#running) return 0;
    const inFlight = this.#runTick(at);
    this.#inFlight = inFlight;
    try {
      return await inFlight;
    } finally {
      if (this.#inFlight === inFlight) this.#inFlight = undefined;
    }
  }

  async #runTick(at: Date): Promise<number> {
    this.#running = true;
    const claimedAt = at.toISOString();
    try {
      const reminders = await this.repository.claimDueReminders(
        claimedAt,
        this.#batchSize,
        this.#leaseMs,
      );
      let notified = 0;
      for (const reminder of reminders) {
        try {
          await this.notifier.notify(reminder);
          await this.repository.markReminderNotificationSent(
            reminder.id,
            claimedAt,
            this.#now().toISOString(),
          );
          notified += 1;
        } catch (error) {
          await this.repository.releaseReminderNotificationClaim(reminder.id, claimedAt);
          this.#onError(error);
        }
      }
      return notified;
    } finally {
      this.#running = false;
    }
  }
}
