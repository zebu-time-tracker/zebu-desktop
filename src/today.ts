// Midnight while the app is open. The popover stays loaded for days, so the
// date it opened on goes stale: a view that was showing today moves to the new
// today; a day picked by hand stays where it is.

/** What the selected day becomes when the calendar moves from `wasToday` to `today`. */
export const followToday = (selected: string, wasToday: string, today: string): string =>
    selected === wasToday ? today : selected;
