/**
 * CEX Feed Health State Machine
 *
 * Tracks the health status of the CEX price feed connection.
 * Pure synchronous state machine — no timers, no I/O.
 *
 * State transitions:
 *   DISCONNECTED → CONNECTED (onConnected)
 *   CONNECTED → RECONNECTING (onDisconnected)
 *   RECONNECTING → CONNECTED (onConnected)
 *   RECONNECTING → DEGRADED (onMaxReconnectFailed)
 *   DEGRADED → CONNECTED (onConnected — last-resort reconnect succeeded)
 *   any → PASSIVE (setPassiveMode — simulation/skipExternalConnection)
 *
 * @see ADR-036: CEX Price Signals
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
    if (this.status === CexFeedHealthStatus.CONNECTED) {
      this.status = CexFeedHealthStatus.RECONNECTING;
    }
    // If already DISCONNECTED or DEGRADED, stay in current state
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
