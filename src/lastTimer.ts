// What the one-click ▶ bar says about the last managed timer (board #411):
// the action on one line, the work — "client – project · task" — on the next.
import type { ProjectOption } from './api';

export interface LastTimerWork {
    project: string | null;
    task: string | null;
    /** Absent on a timer remembered before #411; the bar then shows the project alone. */
    client?: string | null;
}

/** The project's client from the timesheet's projects, if the project is there and has one. */
export const clientOf = (projects: ProjectOption[] | undefined, projectId: string): string | null =>
    projects?.find((p) => p.id === projectId)?.client ?? null;

/** "Client – Project · Task", leaving out whichever parts are missing. */
export const lastTimerWork = (last: LastTimerWork): string => {
    const head = [last.client, last.project].filter(Boolean).join(' – ');
    return last.task ? (head ? `${head} · ${last.task}` : last.task) : head;
};

/**
 * The same day resumes the entry; an earlier one starts a new timer today, so
 * "Resume" would promise the wrong thing (the extension's board #361).
 */
export const resumeLabelKey = (date: string, today: string): 'timer.resume' | 'timer.startNew' =>
    date === today ? 'timer.resume' : 'timer.startNew';
