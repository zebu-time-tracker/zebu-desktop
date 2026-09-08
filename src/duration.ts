// Duration formatting and parsing. Pure functions with no i18n or Tauri
// dependencies so they run under Node's test runner; api.ts wraps
// formatDurationHuman with the locale's unit labels.

export interface DurationUnits {
    hour: string;
    minute: string;
}

export const DEFAULT_UNITS: DurationUnits = { hour: 'h', minute: 'm' };

/**
 * Tracked / uninvoiced totals in hours and minutes: "38h 12m", "4h", "45m".
 * Never converts to days or weeks — a 38-hour project is 38 hours of work,
 * not "4 days 6h", and 120 hours stays "120h".
 *
 * Deliberately never padded: every use in the desktop app is inline prose
 * ("Total: 4h 5m · Uninvoiced: 1h 5m") or a single right-aligned value, where
 * the web app's figure-space padding would show up as stray gaps in the text.
 */
export function formatDurationHuman(minutes: number, units: DurationUnits = DEFAULT_UNITS): string {
    const total = Math.max(0, Math.round(minutes));
    const h = Math.floor(total / 60);
    const m = total % 60;

    if (h > 0 && m > 0) return `${h}${units.hour} ${m}${units.minute}`;
    if (h > 0) return `${h}${units.hour}`;
    return `${m}${units.minute}`;
}

/** Clock-style "h:mm" — the timer pill, entry rows, week strip. */
export function formatMinutes(minutes: number): string {
    const m = Math.max(0, Math.round(minutes));
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** "1:30", "1.5", "90m" -> minutes */
export function parseDuration(input: string): number | null {
    const s = input.trim().toLowerCase();
    if (!s) return null;
    let m = s.match(/^(\d+):(\d{1,2})$/);
    if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
    m = s.match(/^(\d+)m$/);
    if (m) return parseInt(m[1]);
    m = s.match(/^(\d+(?:[.,]\d+)?)$/);
    if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * 60);
    return null;
}
