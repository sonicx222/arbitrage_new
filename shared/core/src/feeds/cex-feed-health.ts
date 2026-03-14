/**
 * CEX Feed Health State Machine
 *
 * Tracks the health status of the CEX price feed connection.
 * Pure synchronous state machine — no timers, no I/O.
 *
 * State transitions:
 *   DISCONNECTED → CONNECTED (onConnected)
 *   DISCONNECTED → RECONNECTING (onDisconnected — initial connect failed, WS auto-reconnecting)
 *   CONNECTED → RECONNECTING (onDisconnected)
 *   RECONNECTING → CONNECTED (onConnected)
 *   RECONNECTING → DEGRADED (onMaxReconnectFailed)
 *   DEGRADED → CONNECTED (onConnected — last-resort reconnect succeeded)
 *   any → PASSIVE (setPassiveMode — simulation/skipExternalConnection)
 *
 * @see ADR-036: CEX Price Signals
 * @see ADR-043: Bulkhead Isolation & Health Watchdog
 * @module feeds
 */

export enum CexFeedHealthStatus {
  /** Not yet connected (initial state) */
  DISCONNECTED = 'disconnected',
  /** Actively connected to Binance WS */
  CONNECTED = 'connected',
  /** Disconnected, reconnection attempts in progress */
  RECONNECTING = 'reconnecting',
  /** All reconnect attempts exhausted; last-resort timer active */
  DEGRADED = 'degraded',
  /** Simulation/passive mode — no external connection expected */
  PASSIVE = 'passive',
}

export interface CexFeedHealthSnapshot {
  status: CexFeedHealthStatus;
  disconnectedSince: number | null;
  isDegraded: boolean;
}

export class CexFeedHealthTracker {
  private status: CexFeedHealthStatus = CexFeedHealthStatus.DISCONNECTED;
  private _disconnectedSince: number | null = null;

  onConnected(): void {
    this.status = CexFeedHealthStatus.CONNECTED;
    this._disconnectedSince = null;
  }

  onDisconnected(): void {
    // RESILIENCE FIX (C6): Also transition from DISCONNECTED → RECONNECTING.
    // When initial connect() fails, the WS client auto-reconnects in the background.
    // Without this transition, the health tracker stays DISCONNECTED and never
    // reaches DEGRADED even after maxReconnectFailed fires.
    if (this.status === CexFeedHealthStatus.CONNECTED || this.status === CexFeedHealthStatus.DISCONNECTED) {
      this.status = CexFeedHealthStatus.RECONNECTING;
      this._disconnectedSince = this._disconnectedSince ?? Date.now();
    }
    // If already RECONNECTING or DEGRADED, stay in current state
  }

  onMaxReconnectFailed(): void {
    this.status = CexFeedHealthStatus.DEGRADED;
    this._disconnectedSince = this._disconnectedSince ?? Date.now();
  }

  setPassiveMode(): void {
    this.status = CexFeedHealthStatus.PASSIVE;
    this._disconnectedSince = null;
  }

  getStatus(): CexFeedHealthStatus {
    return this.status;
  }

  getDisconnectedSince(): number | null {
    return this._disconnectedSince;
  }

  isDegraded(): boolean {
    return this.status === CexFeedHealthStatus.DEGRADED;
  }

  getSnapshot(): CexFeedHealthSnapshot {
    return {
      status: this.status,
      disconnectedSince: this._disconnectedSince,
      isDegraded: this.isDegraded(),
    };
  }
}
