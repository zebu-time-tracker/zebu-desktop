// The meta line under a timer row (board #420): "View project · Uninvoiced:
// 32h · Budget: 65%". Kept out of App.vue so the rules are testable.

/** Budget burn from 60% is a warning, from 80% an alarm. */
export type BudgetLevel = 'ok' | 'warn' | 'alarm';

export const BUDGET_WARN_PCT = 60;
export const BUDGET_ALARM_PCT = 80;

export const budgetLevel = (pct: number): BudgetLevel => (pct >= BUDGET_ALARM_PCT ? 'alarm' : pct >= BUDGET_WARN_PCT ? 'warn' : 'ok');

/**
 * Minutes as a plain hour count: one decimal under ten hours ("3.5h"), whole
 * hours from ten ("32h"), "0h" for none and "0.1h" for a few minutes. Never days or minutes, so the number
 * reads the same way whatever its size. `unit` is the locale's hour suffix.
 */
export const formatHours = (minutes: number, locale: string, unit = 'h'): string => {
    // a few minutes are still something: never round them away to "0h"
    const hours = minutes > 0 ? Math.max(minutes / 60, 0.1) : 0;
    const digits = hours < 10 ? 1 : 0;
    const n = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(hours);
    return `${n}${unit}`;
};
