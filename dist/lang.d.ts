import type { LangCode } from './types.js';
export interface DetectLangOptions {
    extraBrandTokens?: string[];
    extraMentionNames?: string[];
    defaultLang?: LangCode;
}
/**
 * Strips Matrix pills (`[@Name](@user:server)`), full `@user:server` IDs, explicit
 * `@<mentionName>` (including multi-word and CJK names), and standalone Unicode `@mentions`.
 */
export declare function stripAgentMentions(text: string, mentionNames?: readonly string[]): string;
/**
 * Strips `@mentions`, URLs, numbers, and noise before language classification.
 */
export declare function stripNoiseForLang(text: string, extraMentionNames?: readonly string[]): string;
/**
 * Detects `'zh-Hant' | 'zh-Hans' | 'en'`.
 * Strips `@mentions`, URLs, numbers, and pure ASCII shop/brand/short tokens (`ok`, `boots`)
 * before classifying so Chinese conversations never accidentally flip to English.
 */
export declare function detectLang(text: string, userHint?: LangCode, roomHint?: LangCode, options?: DetectLangOptions): LangCode;
/** Converts Simplified Chinese prose into pure Traditional Chinese with phrase disambiguation. */
export declare function toZhHant(text: string): string;
//# sourceMappingURL=lang.d.ts.map