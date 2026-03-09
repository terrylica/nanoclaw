/**
 * Rolling 60-second RPM tracker for MiniMax API calls.
 *
 * Reserves 5 RPM for triage (core mission) — evolution gets the rest.
 */

const MAX_RPM = 20;
const EVOLUTION_RESERVE = 5; // RPM reserved for triage
const WINDOW_MS = 60_000;

const timestamps: number[] = [];

/** Record a MiniMax API call */
export function recordCall(): void {
  timestamps.push(Date.now());
}

/** Get current RPM (calls in last 60s) */
export function getCurrentRPM(): number {
  const cutoff = Date.now() - WINDOW_MS;
  // Prune old timestamps
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }
  return timestamps.length;
}

/** Check if evolution can make a MiniMax call (respects triage reserve) */
export function canCallMiniMax(): boolean {
  return getCurrentRPM() < MAX_RPM - EVOLUTION_RESERVE;
}

/** Check if triage can make a MiniMax call (uses full budget) */
export function canCallForTriage(): boolean {
  return getCurrentRPM() < MAX_RPM;
}
