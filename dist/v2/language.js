/**
 * Which language a v2 reply is written in: the asker's own. Traditional Chinese gets Traditional,
 * Simplified gets Simplified, English gets English; any other language is answered in English.
 * The brain is told explicitly, and Chinese replies are converted to the right script afterwards
 * in case the model drifts.
 */
import { detectForeignLanguage, detectLang, toZhHans, toZhHant } from '../lang.js';
export function replyLanguageFor(text, options = {}) {
    if (detectForeignLanguage(text ?? ''))
        return 'en';
    return detectLang(text ?? '', options.userHint, options.roomHint, {
        ...(options.mentionNames ? { extraMentionNames: [...options.mentionNames] } : {}),
    });
}
export function languageName(lang) {
    if (lang === 'zh-Hant')
        return 'Traditional Chinese (繁體中文)';
    if (lang === 'zh-Hans')
        return 'Simplified Chinese (简体中文)';
    return 'English';
}
/** Puts Chinese text into the reply's script. English replies are left as they are. */
export function matchScript(text, lang) {
    if (lang === 'zh-Hant')
        return toZhHant(text);
    if (lang === 'zh-Hans')
        return toZhHans(text);
    return text;
}
//# sourceMappingURL=language.js.map