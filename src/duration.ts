// Duration formatting and parsing. Pure functions with no i18n or Tauri
// dependencies so they run under Node's test runner; api.ts wraps
// formatDurationHuman with the locale's unit labels.

export interface DurationUnits {
    hour: string;
    minute: string;
}

export const DEFAULT_UNITS: DurationUnits = { hour: 'h', minute: 'm' };

export interface DurationOptions {
    /**
     * List mode: pad the hours to this many digits (with figure spaces, which
     * are digit-wide under tabular figures) and always show two-digit minutes,
     * so the hour/minute markers line up across rows.
     */
    hoursWidth?: number;
}

/** U+2007 FIGURE SPACE — the width of one digit when tabular figures are on. */
const FIGURE_SPACE = ' ';
const padFigures = (n: number, width: number) => String(n).padStart(width, FIGURE_SPACE);

/**
 * Tracked / uninvoiced totals in hours and minutes: "38h 12m", "4h", "45m".
 * Never converts to days or weeks — a 38-hour project is 38 hours of work,
 * not "4 days 6h", and 120 hours stays "120h".
 */
export function formatDurationHuman(minutes: number, units: DurationUnits = DEFAULT_UNITS, opts: DurationOptions = {}): string {
    const total = Math.max(0, Math.round(minutes));
    const h = Math.floor(total / 60);
    const m = total % 60;

    if (opts.hoursWidth) {
        return `${padFigures(h, opts.hoursWidth)}${units.hour} ${padFigures(m, 2)}${units.minute}`;
    }
    if (h > 0 && m > 0) return `${h}${units.hour} ${m}${units.minute}`;
    if (h > 0) return `${h}${units.hour}`;
    return `${m}${units.minute}`;
}

/** Digits needed for the largest whole-hour count in a list, for `hoursWidth`. */
export function hoursWidthFor(minuteTotals: number[]): number {
    const maxHours = minuteTotals.reduce((max, mins) => Math.max(max, Math.floor(Math.max(0, Math.round(mins)) / 60)), 0);
    return String(maxHours).length;
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
