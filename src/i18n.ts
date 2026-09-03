// App localization: vue-i18n with one JSON catalog per locale in src/locales/.
// English is the source of truth; `npm run i18n:check` keeps the others in sync.

import { ref } from 'vue';
import { createI18n } from 'vue-i18n';

// Every src/locales/<locale>.json becomes an available locale automatically.
const modules = import.meta.glob('./locales/*.json', { eager: true }) as Record<string, { default: Record<string, unknown> }>;
const messages: Record<string, Record<string, unknown>> = {};
for (const [path, mod] of Object.entries(modules)) {
    const locale = path.match(/([\w-]+)\.json$/)![1];
    messages[locale] = mod.default;
}

export const SUPPORTED_LOCALES = Object.keys(messages).sort();

// Native names for the settings picker — endonyms, deliberately untranslated.
export const LOCALE_NAMES: Record<string, string> = {
    de: 'Deutsch',
    en: 'English',
    es: 'Español',
    fr: 'Français',
    it: 'Italiano',
    ja: '日本語',
    ko: '한국어',
    nl: 'Nederlands',
    pl: 'Polski',
    pt: 'Português',
    'zh-CN': '中文（简体）',
};

/** Best supported locale for a BCP-47 tag: exact match, then language-only (de-AT → de, zh → zh-CN). */
function matchLocale(tag: string): string | null {
    const lower = tag.toLowerCase();
    const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === lower);
    if (exact) return exact;
    const lang = lower.split('-')[0];
    return SUPPORTED_LOCALES.find((l) => l.toLowerCase().split('-')[0] === lang) ?? null;
}

// Polish has three plural forms: 1 / few (2–4, except 12–14) / many.
function polishPlural(choice: number, choicesLength: number): number {
    if (choicesLength < 3) return choice === 1 ? 0 : 1;
    if (choice === 1) return 0;
    const mod10 = choice % 10;
    const mod100 = choice % 100;
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return 1;
    return 2;
}

export const i18n = createI18n({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages: messages as any,
    pluralRules: { pl: polishPlural },
});

/**
 * Locale used for Intl date/number formatting. Follows the chosen UI locale,
 * except on "System" where the full system tag is kept (en-GB keeps its
 * regional date order even though the catalog is just "en").
 */
export const intlLocale = ref<string>('en');

/** Apply a language preference: a supported locale code, or 'system' to follow the OS. */
export function setLocalePreference(pref: string): void {
    if (pref !== 'system' && SUPPORTED_LOCALES.includes(pref)) {
        i18n.global.locale.value = pref;
        intlLocale.value = pref;
        return;
    }
    const tags = navigator.languages?.length ? navigator.languages : [navigator.language || 'en'];
    let matched = 'en';
    for (const tag of tags) {
        const m = matchLocale(tag);
        if (m) {
            matched = m;
            break;
        }
    }
    i18n.global.locale.value = matched;
    intlLocale.value = navigator.language || matched;
}

setLocalePreference('system');
