// The header's date (board #422): "Thu Sep 24" — short weekday, short month,
// day — in the app's locale. Intl separates the weekday with a comma in some
// locales ("Thu, Sep 24"); after "Today, " that reads as a list, so a bare
// ", " between the parts becomes a space. Other punctuation (German's "Do.,"
// keeps its full stop) is left as the locale writes it.

export const dayLabel = (date: string, locale: string): string => {
    const d = new Date(date + 'T00:00:00');
    return new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' })
        .formatToParts(d)
        .map((p) => (p.type === 'literal' && p.value === ', ' ? ' ' : p.value))
        .join('');
};
