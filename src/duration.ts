// Duration formatting and parsing. Pure functions with no i18n or Tauri
// dependencies so they run under Node's test runner; api.ts wraps
// formatDurationHuman with the locale's unit labels.

export interface DurationUnits {
    hour: string;
    minute: string;
    day: string;
    week: string;
}

export const DEFAULT_UNITS: DurationUnits = { hour: 'h', minute: 'm', day: 'd', week: 'w' };

const HOUR = 60;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Tracked / uninvoiced totals at two units of precision, stepping up as they
 * grow so a long-running project never reads "500h 9m":
 *
 *   under a day     "38m", "4h", "4h 5m"
 *   under a week    "1d", "2d 3h"       — minutes dropped
 *   from a week on  "1w", "1w 2d"       — hours dropped too
 *
 * Days are calendar days (24h) and weeks seven of them, not working days:
 * the figure is how long the clock has been running, not a staffing estimate.
 *
 * Deliberately never padded: every use in the desktop app is inline prose
 * ("Total: 4h 5m · Uninvoiced: 1h 5m") or a single right-aligned value, where
 * the web app's figure-space padding would show up as stray gaps in the text.
 */
export function formatDurationHuman(minutes: number, units: DurationUnits = DEFAULT_UNITS): string {
    const total = wholeMinutes(minutes);

    if (total >= WEEK) return pair(Math.floor(total / WEEK), units.week, Math.floor((total % WEEK) / DAY), units.day);
    if (total >= DAY) return pair(Math.floor(total / DAY), units.day, Math.floor((total % DAY) / HOUR), units.hour);
    if (total >= HOUR) return pair(Math.floor(total / HOUR), units.hour, total % HOUR, units.minute);
    return `${total}${units.minute}`;
}

/** "2d 3h", or just "2d" when the smaller unit is zero. */
function pair(big: number, bigUnit: string, small: number, smallUnit: string): string {
    return small > 0 ? `${big}${bigUnit} ${small}${smallUnit}` : `${big}${bigUnit}`;
}

/**
 * An entry's minutes as of `now`: the stored total, plus what a running timer
 * has added since it started. Shared by the popover and the insights panel,
 * which both count up between refreshes.
 */
export function elapsedMinutes(entry: { minutes: number; timer_started_at: string | null }, now: number): number {
    if (!entry.timer_started_at) return entry.minutes;
    return entry.minutes + Math.max(0, (now - new Date(entry.timer_started_at).getTime()) / 60000);
}

/**
 * Minutes on a clock that is still running, as a whole number.
 *
 * Always down, never to the nearest — a timer forty seconds old reads 0:00,
 * not 0:01. That is the same answer the server gives (`currentMinutes()`
 * floors), and therefore the same one the web app and the terminal client
 * show; this app used to round, so the same live timer read a minute higher
 * here than in a browser beside it. The minute appears when it has actually
 * been worked.
 *
 * Stopping is a separate question and still rounds, with a one-minute
 * minimum, on the server: the figure that gets billed is decided once, there,
 * and no client has an opinion about it.
 */
function wholeMinutes(minutes: number): number {
    return Math.max(0, Math.floor(minutes));
}

/** Clock-style "h:mm" — the timer pill, entry rows, week strip. */
export function formatMinutes(minutes: number): string {
    const m = wholeMinutes(minutes);
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

// A number of hours: "1", "1.5", "1,5", ".5".
const HOURS = String.raw`(\d+(?:[.,]\d*)?|[.,]\d+)`;
const HOUR_UNIT = String.raw`h(?:ours?|rs?)?`;
const MINUTE_UNIT = String.raw`m(?:in(?:ute)?s?)?`;

const CLOCK = /^(\d*):(\d{0,2})$/;
const HOURS_AND_MINUTES = new RegExp(String.raw`^${HOURS}\s*${HOUR_UNIT}(?:\s*(\d+)\s*(?:${MINUTE_UNIT})?)?$`);
const MINUTES_ONLY = new RegExp(String.raw`^(\d+)\s*${MINUTE_UNIT}$`);
const BARE_HOURS = new RegExp(`^${HOURS}$`);

const hoursToMinutes = (h: string) => Math.round(parseFloat(h.replace(',', '.')) * 60);

/**
 * What a person types in a duration field -> minutes, or null if it is not
 * a duration. Accepts:
 *
 *   clock          "1:30", ":30" (30m), "2:" (2h)
 *   units          "1h", "1h30", "1h3" (1:03), "1h 30m", "1.5h", "2 hrs 5 mins"
 *   minutes        "30m", "30 min", "45 minutes"
 *   bare number    "2", "1.5", "1,5", ".5" — hours, as always
 *
 * Keep in step with the web app's copy (zebu-app resources/js/lib/format.ts).
 */
export function parseDuration(input: string): number | null {
    const s = input.trim().toLowerCase();
    if (!s) return null;

    let m = s.match(CLOCK);
    if (m) return m[1] || m[2] ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : null;

    m = s.match(HOURS_AND_MINUTES);
    if (m) return hoursToMinutes(m[1]) + Number(m[2] || 0);

    m = s.match(MINUTES_ONLY);
    if (m) return Number(m[1]);

    m = s.match(BARE_HOURS);
    if (m) return hoursToMinutes(m[1]);

    return null;
}
