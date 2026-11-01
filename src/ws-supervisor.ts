/**
 * Watchdog for the Feishu long connection.
 *
 * The SDK's `WSClient` reconnects on its own, but a long-lived process can
 * still end up permanently silent:
 *
 * 1. a half-open socket (peer gone, no FIN/RST: NAT timeout, VPN drop, Wi-Fi
 *    roam) stays `readyState === OPEN` until the liveness watchdog fires — and
 *    that watchdog is disabled unless `wsConfig.pingTimeout` is set (the
 *    transport sets it, this supervisor is the second line of defence);
 * 2. the reconnect loop can keep failing for hours (DNS outage, blackholed
 *    route) while nothing reports it;
 * 3. the client object itself can stop scheduling attempts, leaving no timer
 *    and no error.
 *
 * The supervisor samples {@link SupervisedTransport.health} on an interval. If
 * the surface is not-ready for `staleMs`, it rebuilds the `WSClient` from
 * scratch instead of calling `reConnect()` (which would reuse the possibly
 * wedged instance). A `generation` comparison makes a reconnect that starts and
 * ends between two samples visible, so the catch-up still runs for it.
 *
 * @module @dsh-feishu/dsh-feishu/ws-supervisor
 */

/** Default time the surface may stay not-ready before the client is rebuilt. */
export const DEFAULT_STALE_MS = 90_000;
/** Default sampling interval. */
export const DEFAULT_CHECK_MS = 10_000;
/** Minimum spacing between two rebuilds (prevents rebuild storms). */
export const DEFAULT_COOLDOWN_MS = 60_000;
/** Heartbeat period while healthy. */
export const DEFAULT_HEARTBEAT_MS = 5 * 60_000;

/** Health snapshot the supervisor reads. */
export interface SupervisedHealth {
  readonly state: 'ready' | 'reconnecting' | 'error' | string;
  readonly readyAt: number | null;
  readonly generation: number;
  readonly lastError: string | null;
  readonly pingTimeoutSec?: number;
}

/** Transport surface the supervisor drives. */
export interface SupervisedTransport {
  health(): SupervisedHealth;
  restartLongConnection(reason: string): Promise<void>;
}

/** Minimal logger surface the supervisor needs. */
export interface SupervisorLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

/** Options for {@link WsSupervisor}. */
export interface WsSupervisorOptions {
  readonly transport: SupervisedTransport;
  readonly logger?: SupervisorLogger;
  /** Not-ready budget before a rebuild. Default {@link DEFAULT_STALE_MS}. */
  readonly staleMs?: number;
  /** Sampling interval. Default {@link DEFAULT_CHECK_MS}. */
  readonly checkMs?: number;
  /** Minimum spacing between rebuilds. Default {@link DEFAULT_COOLDOWN_MS}. */
  readonly cooldownMs?: number;
  /** Healthy-state heartbeat period. Default {@link DEFAULT_HEARTBEAT_MS}. */
  readonly heartbeatMs?: number;
  /** Called on every not-ready → ready transition (used for catch-up). */
  readonly onReady?: () => void | Promise<void>;
  /** Injectable clock (tests). */
  readonly now?: () => number;
}

/** Rebuilds a wedged `WSClient` and reports silence. */
export class WsSupervisor {
  private readonly transport: SupervisedTransport;
  private readonly logger: SupervisorLogger | undefined;
  private readonly staleMs: number;
  private readonly checkMs: number;
  private readonly cooldownMs: number;
  private readonly heartbeatMs: number;
  private readonly onReady: (() => void | Promise<void>) | undefined;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** When the surface was first observed not-ready in the current outage. */
  private downSince: number | undefined;
  /** Last rebuild timestamp; -Infinity so the first rebuild is never throttled. */
  private lastRebuildAt = Number.NEGATIVE_INFINITY;
  /** Rebuilds performed in this process lifetime (diagnostics). */
  private rebuildCount = 0;
  /** Last observed state, for edge-triggered logging. */
  private lastState: string | undefined;
  /** Last observed connection generation (monotonic). */
  private lastGeneration: number | undefined;
  private lastHeartbeatAt = 0;

  constructor(options: WsSupervisorOptions) {
    this.transport = options.transport;
    this.logger = options.logger;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.checkMs = options.checkMs ?? DEFAULT_CHECK_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.onReady = options.onReady;
    this.now = options.now ?? (() => Date.now());
  }

  /** Start sampling. Idempotent. */
  start(): void {
    if (this.timer !== undefined) return;
    // Adopt the current epoch as the baseline: the caller runs the initial
    // catch-up itself, so the first tick must not fire `onReady`.
    const health = this.transport.health();
    this.lastGeneration = health.generation;
    this.lastState = health.state;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.checkMs);
    // Never keep a shutting-down process alive just for the watchdog.
    this.timer.unref?.();
  }

  /** Stop sampling. Idempotent. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Rebuilds performed so far (diagnostics/tests). */
  get rebuilds(): number {
    return this.rebuildCount;
  }

  /**
   * One sampling pass (public for tests; {@link start} calls it on an interval).
   * @returns resolves after any rebuild completes.
   */
  async tick(): Promise<void> {
    const health = this.transport.health();
    const now = this.now();
    if (health.state === 'ready') {
      const first = this.lastGeneration === undefined;
      const recovered =
        !first && (this.lastState !== 'ready' || health.generation !== this.lastGeneration);
      this.lastGeneration = health.generation;
      this.lastState = 'ready';
      if (recovered) {
        this.logger?.info(
          this.downSince === undefined
            ? '[feishu] long connection established; running the initial catch-up'
            : `[feishu] long connection recovered after ${formatDuration(now - this.downSince)}` +
                ` (${this.rebuildCount} rebuild(s) so far)`,
        );
        this.downSince = undefined;
        // Bookkeeping is already committed: a slow catch-up must not make the
        // next tick fire the same recovery again.
        try {
          await this.onReady?.();
        } catch (error: unknown) {
          this.logger?.warn(`[feishu] reconnect catch-up failed: ${String(error)}`);
        }
      } else if (first) {
        this.logger?.info(
          `[feishu] long connection ready (pingTimeout=${health.pingTimeoutSec ?? 0}s)`,
        );
      }
      if (now - this.lastHeartbeatAt >= this.heartbeatMs) {
        this.lastHeartbeatAt = now;
        this.logger?.info(
          `[feishu] health: state=ready, rebuilds=${this.rebuildCount}, ` +
            `lastError=${health.lastError ?? 'none'}`,
        );
      }
      return;
    }

    if (this.lastState !== health.state) {
      this.logger?.warn(
        `[feishu] long connection ${health.state}` +
          (health.lastError === null ? '' : `: ${health.lastError}`),
      );
    }
    this.lastState = health.state;
    if (this.downSince === undefined) {
      this.downSince = now;
      this.logger?.warn(
        `[feishu] long connection down, watchdog armed ` +
          `(rebuild in ${formatDuration(this.staleMs)} unless it recovers)`,
      );
    }
    const downFor = now - this.downSince;
    if (downFor < this.staleMs) return;
    if (now - this.lastRebuildAt < this.cooldownMs) return;
    this.lastRebuildAt = now;
    this.rebuildCount += 1;
    this.logger?.error(
      `[feishu] long connection down for ${formatDuration(downFor)} — rebuilding WSClient ` +
        `(rebuild #${this.rebuildCount})`,
    );
    try {
      await this.transport.restartLongConnection(`watchdog: down ${formatDuration(downFor)}`);
    } catch (error: unknown) {
      this.logger?.error(`[feishu] WSClient rebuild failed: ${String(error)}`);
    }
    // Give the fresh client a clean budget.
    this.downSince = this.now();
  }
}

/**
 * Human-readable duration (`95s`, `4m12s`, `2h05m`).
 * @param ms - duration in milliseconds.
 * @returns compact duration.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}h${String(minutes).padStart(2, '0')}m`;
}
