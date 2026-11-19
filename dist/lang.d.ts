import type { LangCode } from './types.js';
export interface DetectLangOptions {
    extraBrandTokens?: string[];
    defaultLang?: LangCode;
}
/**
 * Strips `@mentions`, URLs, numbers, and noise before language classification.
 */
export declare function stripNoiseForLang(text: string): string;
/**
 * Detects `'zh-Hant' | 'zh-Hans' | 'en'`.
 * Strips `@mentions`, URLs, numbers, and pure ASCII shop/brand/short tokens (`ok`, `boots`)
 * before classifying so Chinese conversations never accidentally flip to English.
 */
export declare function detectLang(text: string, userHint?: LangCode, roomHint?: LangCode, options?: DetectLangOptions): LangCode;
//# sourceMappingURL=lang.d.ts.map