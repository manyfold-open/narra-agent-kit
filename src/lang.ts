import type { LangCode } from './types.js';

const CJK_CHAR = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const ZHUYIN_CHAR = /[\u3100-\u312F\u31A0-\u31BF]/;

// Distinct Traditional-only characters (zero overlap with HANS_CHARS or shared CJK chars).
const HANT_CHARS = new Set(
  '這們說帳賬還麼為錢誰嗎過個對沒開關請問謝購買賣優惠碼號網頁鏈記錄裡裏點電話車飯館倫國幫給讓覺得應該會樣時間現剛後邊塊張條筆實際薦評價雞麵湯鍋燒餃餅魚蝦豬鴨鵝鹹熱凍廳樓區訂預約單掃發總結轉聯繫試錯誤漏補刪變換選擇歡認識聽寫讀學習業產務題詳細簡複雜難週兩萬億歲體驗視頻聲語銀幣鎊歐減費郵滿贈禮獎勵積員級專屬貴劃維護與雖經較處種從離來進無動飲'.split(
    '',
  ),
);

// Distinct Simplified-only characters (zero overlap with HANT_CHARS or shared CJK chars).
const HANS_CHARS = new Set(
  '这们说帐账还么为钱谁吗过个对没开关请问谢购买卖优惠码号网页链记录里点电话车饭馆伦国帮给让觉得应该会样时间现刚后边块张条笔实际荐评价鸡汤锅烧饺饼鱼虾猪鸭鹅咸热冻厅楼区订预约单扫发总结转联系试错误漏补删变换选择欢认识听写读学习业产物题详细简复杂难周两万亿岁体验视频声语银币镑欧减费邮满赠礼奖励积员级专属贵划维护与虽经较处种从离来进无动饮'.replace(
    '物',
    '',
  ).split(''),
);

// Wait: ensure '变' vs '變' and '换' vs '換' are exact; clean any accidental overlap defensively.
for (const ch of HANT_CHARS) {
  if (HANS_CHARS.has(ch)) {
    HANS_CHARS.delete(ch);
  }
}

const MATRIX_PILL_MENTION = /\[@[^\]\n]{1,80}\]\(@[A-Za-z0-9._=\-/+]+:[A-Za-z0-9.-]+(?::\d{1,5})?\)/g;
const MATRIX_USER_MENTION = /@[A-Za-z0-9._=\-/+]+:[A-Za-z0-9.-]+(?::\d{1,5})?/g;
const SIMPLE_MENTION = /(?:^|\s)@[A-Za-z0-9._-]+/g;
const URL_REGEX = /https?:\/\/\S+/gi;
const HASH_REF_REGEX = /#\d+\b/g;
const NUMBER_REGEX = /(?:[£$€¥]?\d+(?:[.,]\d+)?%?)/g;

/**
 * Pure ASCII short/acknowledgement/shop/brand tokens that frequently appear inside
 * Chinese messages and should never flip a Chinese conversation to English.
 */
const IGNORABLE_ASCII_TOKENS = new Set([
  'ok',
  'okay',
  'yes',
  'no',
  'ya',
  'yep',
  'nope',
  'thx',
  'ty',
  'tysm',
  'lol',
  'haha',
  'hahaha',
  'aa',
  'id',
  'uk',
  'us',
  'eu',
  'ai',
  'llm',
  'gpt',
  'api',
  'pdf',
  'csv',
  'json',
  'url',
  'app',
  'vip',
  'nhs',
  'nhsuk',
  'boots',
  'nike',
  'adidas',
  'asos',
  'tesco',
  'waitrose',
  'sainsburys',
  'sainsbury',
  'ikea',
  'apple',
  'samsung',
  'uniqlo',
  'sephora',
  'amazon',
  'ms',
  'mns',
  'zara',
  'hm',
  'argos',
  'currys',
  'johnlewis',
  'selfridges',
  'harrods',
  'deliveroo',
  'ubereats',
  'justeat',
  'pret',
  'dishoom',
  'openai',
  'anthropic',
  'claude',
  'gemini',
  'deepmind',
  'meta',
  'llama',
  'london',
  'soho',
  'chinatown',
  'camden',
  'shoreditch',
  'mayfair',
  'kensington',
  'paddington',
  'stratford',
  'canary',
  'wharf',
  'link',
  'code',
  'dm',
  'pm',
  'brb',
  'gtg',
]);

/** Common English grammatical/question/conversational words indicating intentional English prose. */
const ENGLISH_CUE_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'am',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'don',
  "don't",
  "didn't",
  "doesn't",
  'can',
  'could',
  'would',
  'should',
  'will',
  'shall',
  'may',
  'might',
  'have',
  'has',
  'had',
  'what',
  'where',
  'when',
  'why',
  'how',
  'which',
  'who',
  'whom',
  'whose',
  'this',
  'that',
  'these',
  'those',
  'there',
  'here',
  'for',
  'with',
  'from',
  'about',
  'into',
  'onto',
  'between',
  'please',
  'thanks',
  'thank',
  'sorry',
  'hello',
  'hi',
  'hey',
  'help',
  'need',
  'want',
  'looking',
  'find',
  'show',
  'give',
  'tell',
  'check',
  'recommend',
  'best',
  'good',
  'cheap',
  'deals',
  'codes',
  'offers',
  'vouchers',
  'discounts',
  'ramen',
  'food',
  'restaurant',
  'restaurants',
  'split',
  'owe',
  'owes',
  'paid',
  'spent',
  'news',
  'latest',
  'today',
  'tomorrow',
  'yesterday',
  'english',
  'chinese',
  'speak',
  'more',
  'any',
  'some',
  'expired',
  'working',
  'work',
  'worked',
]);

export interface DetectLangOptions {
  extraBrandTokens?: string[];
  defaultLang?: LangCode;
}

/**
 * Strips `@mentions`, URLs, numbers, and noise before language classification.
 */
export function stripNoiseForLang(text: string): string {
  return (text || '')
    .replace(MATRIX_PILL_MENTION, ' ')
    .replace(MATRIX_USER_MENTION, ' ')
    .replace(SIMPLE_MENTION, ' ')
    .replace(URL_REGEX, ' ')
    .replace(HASH_REF_REGEX, ' ')
    .replace(NUMBER_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyCjkScript(text: string, userHint?: LangCode, roomHint?: LangCode): 'zh-Hant' | 'zh-Hans' {
  if (ZHUYIN_CHAR.test(text)) return 'zh-Hant';
  let hant = 0;
  let hans = 0;
  for (const ch of text) {
    if (HANT_CHARS.has(ch)) hant++;
    else if (HANS_CHARS.has(ch)) hans++;
  }
  if (hans > hant) return 'zh-Hans';
  if (hant > hans) return 'zh-Hant';
  if (userHint === 'zh-Hant' || userHint === 'zh-Hans') return userHint;
  if (roomHint === 'zh-Hant' || roomHint === 'zh-Hans') return roomHint;
  return 'zh-Hant';
}

/**
 * Detects `'zh-Hant' | 'zh-Hans' | 'en'`.
 * Strips `@mentions`, URLs, numbers, and pure ASCII shop/brand/short tokens (`ok`, `boots`)
 * before classifying so Chinese conversations never accidentally flip to English.
 */
export function detectLang(
  text: string,
  userHint?: LangCode,
  roomHint?: LangCode,
  options?: DetectLangOptions,
): LangCode {
  const cleaned = stripNoiseForLang(text);
  const fallback = userHint ?? roomHint ?? options?.defaultLang ?? 'en';
  if (!cleaned) return fallback;

  if (CJK_CHAR.test(cleaned) || ZHUYIN_CHAR.test(cleaned)) {
    return classifyCjkScript(cleaned, userHint, roomHint);
  }

  const extraIgnore = new Set((options?.extraBrandTokens ?? []).map((t) => t.toLowerCase()));
  const rawTokens = cleaned.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];
  if (rawTokens.length === 0) return fallback;

  const lowerTokens = rawTokens.map((t) => t.toLowerCase());
  const nonBrandTokens = lowerTokens.filter(
    (tok) => !IGNORABLE_ASCII_TOKENS.has(tok) && !extraIgnore.has(tok),
  );

  // If everything left was pure ASCII shop/brand/short tokens (e.g. "ok", "boots", "nike ok"),
  // preserve the user's or room's Chinese context if one exists.
  if (nonBrandTokens.length === 0) {
    return fallback;
  }

  const hasEnglishCue = lowerTokens.some((tok) => ENGLISH_CUE_WORDS.has(tok));
  const hasZhHint = userHint === 'zh-Hant' || userHint === 'zh-Hans' || roomHint === 'zh-Hant' || roomHint === 'zh-Hans';

  // In a Chinese conversation, 1-2 short non-sentence ASCII tokens (like an unfamiliar shop/model name)
  // without English grammar/question cues inherit the Chinese hint instead of flipping to English.
  if (hasZhHint && nonBrandTokens.length <= 2 && !hasEnglishCue && lowerTokens.length <= 2) {
    return userHint === 'zh-Hant' || userHint === 'zh-Hans' ? userHint : (roomHint as 'zh-Hant' | 'zh-Hans');
  }

  return 'en';
}
