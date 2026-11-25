import type { LangCode } from '../types.js';
export declare function replyLanguageFor(text: string, options?: {
    mentionNames?: readonly string[];
    userHint?: LangCode;
    roomHint?: LangCode;
}): LangCode;
export declare function languageName(lang: LangCode): string;
/** Puts Chinese text into the reply's script. English replies are left as they are. */
export declare function matchScript(text: string, lang: LangCode): string;
//# sourceMappingURL=language.d.ts.map