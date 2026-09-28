// What the one-click ▶ bar says about the last managed timer (board #411):
// the work reads like an entry row — client small above, "project · task"
// below — with the action beside it.
import type { ProjectOption } from './api';

interface LastTimerWork {
    project: string | null;
    task: string | null;
    /** Absent on a timer remembered before #411; the bar then shows the project alone. */
    client?: string | null;
}

/** The project's client from the timesheet's projects, if the project is there and has one. */
export const clientOf = (projects: ProjectOption[] | undefined, projectId: string): string | null =>
    projects?.find((p) => p.id === projectId)?.client ?? null;

/**
 * Whether the day on show lists nothing but the last timer's own entry: the
 * ▶ bar would then repeat the one row right under it (board #450). A day with
 * other entries keeps the bar, since the last timer is not the obvious one.
 */
export const lastTimerIsOnlyEntry = (last: { entry_id: string; date: string }, dayEntries: { id: string }[], shownDate: string): boolean =>
    last.date === shownDate && dayEntries.length === 1 && dayEntries[0].id === last.entry_id;

/** The line under the client: "Project · Task", leaving out whichever part is missing. */
export const lastTimerProject = (last: Pick<LastTimerWork, 'project' | 'task'>): string => [last.project, last.task].filter(Boolean).join(' · ');

/**
 * The same day resumes the entry; an earlier one starts a new timer today, so
 * "Resume" would promise the wrong thing (the extension's board #361).
 */
export const resumeLabelKey = (date: string, today: string): 'timer.resume' | 'timer.startNew' =>
    date === today ? 'timer.resume' : 'timer.startNew';

const dayNumber = (date: string): number => {
    const [y, m, d] = date.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86_400_000;
};

/**
 * How long ago `date` was, as the app's locale says it: "yesterday",
 * "3 days ago", "2 weeks ago", "last month". Both dates are YYYY-MM-DD, so
 * this counts calendar days, not 24-hour spans.
 */
export const relativeDay = (date: string, today: string, locale: string): string => {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const days = Math.max(0, Math.round(dayNumber(today) - dayNumber(date)));
    if (days < 7) return rtf.format(-days, 'day');
    if (days < 30) return rtf.format(-Math.floor(days / 7), 'week');
    const [ty, tm, td] = today.split('-').map(Number);
    const [y, m, d] = date.split('-').map(Number);
    const months = Math.max(1, (ty - y) * 12 + (tm - m) - (td < d ? 1 : 0));
    if (months < 12) return rtf.format(-months, 'month');
    return rtf.format(-Math.floor(months / 12), 'year');
};

/**
 * A translated sentence split around one placeholder's value, so the value can
 * be styled on its own without rendering the translation as HTML. `mark` is a
 * value that cannot occur in the translation itself.
 */
export const splitAround = (text: string, mark: string): [string, string] => {
    const at = text.indexOf(mark);
    return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + mark.length)];
};
