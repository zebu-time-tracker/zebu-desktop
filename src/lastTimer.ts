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

/** The line under the client: "Project · Task", leaving out whichever part is missing. */
export const lastTimerProject = (last: Pick<LastTimerWork, 'project' | 'task'>): string => [last.project, last.task].filter(Boolean).join(' · ');

/**
 * The same day resumes the entry; an earlier one starts a new timer today, so
 * "Resume" would promise the wrong thing (the extension's board #361).
 */
export const resumeLabelKey = (date: string, today: string): 'timer.resume' | 'timer.startNew' =>
    date === today ? 'timer.resume' : 'timer.startNew';
