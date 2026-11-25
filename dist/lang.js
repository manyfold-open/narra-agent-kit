const CJK_CHAR = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const ZHUYIN_CHAR = /[\u3100-\u312F\u31A0-\u31BF]/;
// Distinct Traditional-only characters (zero overlap with HANS_CHARS or shared CJK chars).
const HANT_CHARS = new Set('這們說帳賬還麼為錢誰嗎過個對沒開關請問謝購買賣優惠碼號網頁鏈記錄裡裏點電話車飯館倫國幫給讓覺得應該會樣時間現剛後邊塊張條筆實際薦評價雞麵湯鍋燒餃餅魚蝦豬鴨鵝鹹熱凍廳樓區訂預約單掃發總結轉聯繫試錯誤漏補刪變換選擇歡認識聽寫讀學習業產務題詳細簡複雜難週兩萬億歲體驗視頻聲語銀幣鎊歐減費郵滿贈禮獎勵積員級專屬貴劃維護與雖經較處種從離來進無動飲籤羅數據資運勢閃覽籠師氣書圖東機樂戰創廣場節絡輪靜復訊組證監訟襲礎艦報參賽網畫藝術攝臘燙粵陝蘭灣亞韓辦當頭響環醫藥療腫徵討論導啟備飛鐵線體'.split(''));
// Distinct Simplified-only characters (zero overlap with HANT_CHARS or shared CJK chars).
const HANS_CHARS = new Set('这们说帐账还么为钱谁吗过个对没开关请问谢购买卖优惠码号网页链记录里点电话车饭馆伦国帮给让觉得应该会样时间现刚后边块张条笔实际荐评价鸡汤锅烧饺饼鱼虾猪鸭鹅咸热冻厅楼区订预约单扫发总结转联系试错误漏补删变换选择欢认识听写读学习业产物题详细简复杂难周两万亿岁体验视频声语银币镑欧减费邮满赠礼奖励积员级专属贵划维护与虽经较处种从离来进无动饮签罗数据资运势闪览笼师气书图东机乐战创广场节络轮静复讯组证监讼袭础舰报参赛网画艺术摄腊烫粤陕兰湾亚韩办当头响环医药疗肿征讨论导启备飞铁线体'.replace('物', '').split(''));
// Wait: ensure '变' vs '變' and '换' vs '換' are exact; clean any accidental overlap defensively.
for (const ch of HANT_CHARS) {
    if (HANS_CHARS.has(ch)) {
        HANS_CHARS.delete(ch);
    }
}
const MATRIX_PILL_MENTION = /\[@[^\]\n]{1,80}\]\(@[A-Za-z0-9._=\-/+]+:[A-Za-z0-9.-]+(?::\d{1,5})?\)/g;
const MATRIX_USER_MENTION = /@[A-Za-z0-9._=\-/+]+:[A-Za-z0-9.-]+(?::\d{1,5})?/g;
const SIMPLE_MENTION = /(?:^|(?<=[\s,，.。!！?？:：;；"'「」『』()（）]))@[\p{L}\p{N}._=\-/+]+/gu;
const URL_REGEX = /https?:\/\/\S+/gi;
const HASH_REF_REGEX = /#\d+\b/g;
const NUMBER_REGEX = /(?:[£$€¥]?\d+(?:[.,]\d+)?%?)/g;
const escapeLangRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    'expand',
    'item',
    'story',
    'details',
    'summary',
    'recap',
    'draw',
    'stick',
    'card',
    'cards',
    'spread',
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
    'daily',
    'card',
    'cards',
    'draw',
    'tarot',
    'stick',
    'sticks',
    'fortune',
    'datasets',
    'dataset',
    'hackathons',
    'hackathon',
    'popups',
    'popup',
    'events',
    'event',
    'exhibitions',
    'markets',
    'spots',
    'places',
    'summary',
    'briefing',
    'headlines',
    'stories',
    'list',
    'weekly',
    'spread',
    'reading',
    'shake',
    'morning',
    'afternoon',
    'evening',
    'bye',
    'awesome',
    'great',
]);
/**
 * Strips Matrix pills (`[@Name](@user:server)`), full `@user:server` IDs, explicit
 * `@<mentionName>` (including multi-word and CJK names), and standalone Unicode `@mentions`.
 */
export function stripAgentMentions(text, mentionNames = []) {
    let out = (text ?? '')
        .replace(MATRIX_PILL_MENTION, ' ')
        .replace(MATRIX_USER_MENTION, ' ');
    const sortedNames = [...new Set(mentionNames.map((n) => (n ?? '').trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
    for (const name of sortedNames) {
        const escaped = escapeLangRegex(name);
        const pattern = CJK_CHAR.test(name)
            ? new RegExp(`(?<![A-Za-z0-9._+-])@${escaped}`, 'giu')
            : new RegExp(`(?<![A-Za-z0-9._+-])@${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
        out = out.replace(pattern, ' ');
    }
    return out.replace(SIMPLE_MENTION, ' ').replace(/\s+/g, ' ').trim();
}
/**
 * Strips `@mentions`, URLs, numbers, and noise before language classification.
 */
export function stripNoiseForLang(text, extraMentionNames) {
    return stripAgentMentions(text, extraMentionNames)
        .replace(URL_REGEX, ' ')
        .replace(HASH_REF_REGEX, ' ')
        .replace(NUMBER_REGEX, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function classifyCjkScript(text, userHint, roomHint) {
    if (ZHUYIN_CHAR.test(text))
        return 'zh-Hant';
    let hant = 0;
    let hans = 0;
    for (const ch of text) {
        if (HANT_CHARS.has(ch))
            hant++;
        else if (HANS_CHARS.has(ch))
            hans++;
    }
    if (hans > hant)
        return 'zh-Hans';
    if (hant > hans)
        return 'zh-Hant';
    if (userHint === 'zh-Hant' || userHint === 'zh-Hans')
        return userHint;
    if (roomHint === 'zh-Hant' || roomHint === 'zh-Hans')
        return roomHint;
    return 'zh-Hant';
}
/**
 * Detects `'zh-Hant' | 'zh-Hans' | 'en'`.
 * Strips `@mentions`, URLs, numbers, and pure ASCII shop/brand/short tokens (`ok`, `boots`)
 * before classifying so Chinese conversations never accidentally flip to English.
 */
export function detectLang(text, userHint, roomHint, options) {
    const cleaned = stripNoiseForLang(text, options?.extraMentionNames);
    const fallback = userHint ?? roomHint ?? options?.defaultLang ?? 'en';
    if (!cleaned)
        return fallback;
    if (CJK_CHAR.test(cleaned) || ZHUYIN_CHAR.test(cleaned)) {
        return classifyCjkScript(cleaned, userHint, roomHint);
    }
    const extraIgnore = new Set((options?.extraBrandTokens ?? []).map((t) => t.toLowerCase()));
    const rawTokens = cleaned.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];
    if (rawTokens.length === 0)
        return fallback;
    const lowerTokens = rawTokens.map((t) => t.toLowerCase());
    const nonBrandTokens = lowerTokens.filter((tok) => !IGNORABLE_ASCII_TOKENS.has(tok) && !extraIgnore.has(tok));
    // If everything left was pure ASCII shop/brand/short tokens (e.g. "ok", "boots", "nike ok"),
    // preserve the user's or room's Chinese context if one exists.
    if (nonBrandTokens.length === 0) {
        return fallback;
    }
    const hasEnglishCue = lowerTokens.some((tok) => ENGLISH_CUE_WORDS.has(tok));
    const effectiveHint = userHint ?? roomHint;
    const hasZhHint = effectiveHint === 'zh-Hant' || effectiveHint === 'zh-Hans';
    // In a Chinese conversation, 1-2 short non-sentence ASCII tokens (like an unfamiliar shop/model name)
    // without English grammar/question cues inherit the Chinese hint instead of flipping to English.
    // Never override an explicit `userHint === 'en'` with a stale Chinese `roomHint`.
    if (hasZhHint && nonBrandTokens.length <= 2 && !hasEnglishCue && lowerTokens.length <= 2) {
        return effectiveHint;
    }
    return 'en';
}
const ZH_HANT_PHRASES = [
    ['三里桥', '三里橋'],
    ['占上风', '佔上風'],
    ['倒吊人', '倒吊人'],
    ['一片云', '一片雲'],
    ['了解', '了解'],
    ['云开', '雲開'],
    ['云朵', '雲朵'],
    ['千里', '千里'],
    ['反复', '反覆'],
    ['发生', '發生'],
    ['发现', '發現'],
    ['发觉', '發覺'],
    ['周围', '周圍'],
    ['一周', '一週'],
    ['下周', '下週'],
    ['本周', '本週'],
    ['每周', '每週'],
    ['这周', '這週'],
    ['复盘', '復盤'],
    ['复杂', '複雜'],
    ['修复', '修復'],
    ['恢复', '恢復'],
    ['干净', '乾淨'],
    ['干脆', '乾脆'],
    ['干扰', '干擾'],
    ['路未干', '路未乾'],
    ['卷入', '捲入'],
    ['卷进', '捲進'],
    ['十斗', '十斗'],
    ['御守', '御守'],
    ['收获', '收穫'],
    ['晓发', '曉發'],
    ['欲望', '慾望'],
    ['独占', '獨佔'],
    ['疗愈', '療癒'],
    ['皇后', '皇后'],
    ['联系', '聯繫'],
    ['计划', '計劃'],
    ['规划', '規劃'],
    ['划掉', '劃掉'],
    ['划算', '划算'],
    ['迂回', '迂迴'],
    ['重复', '重複'],
    ['锦里', '錦里'],
    ['网络', '網絡'],
    ['融资', '融資'],
    ['开源', '開源'],
    ['签证', '簽證'],
    ['签署', '簽署'],
    ['签约', '簽約'],
    ['签订', '簽訂'],
    ['标签', '標籤'],
    ['拉面', '拉麵'],
    ['牛肉面', '牛肉麵'],
    ['担担面', '擔擔麵'],
    ['面馆', '麵館'],
    ['烧腊', '燒臘'],
    ['智能体', '智能體'],
    ['芯片', '晶片'],
    ['软件', '軟體'],
    ['硬件', '硬體'],
    ['面条', '麵條'],
    ['里脊', '里脊'],
    ['基础', '基礎'],
    ['监控', '監控'],
    ['诉讼', '訴訟'],
    ['遭袭', '遭襲'],
    ['账单', '帳單'],
    ['旗舰', '旗艦'],
    ['旗舰店', '旗艦店'],
    ['黑客松', '黑客松'],
    ['骇客松', '駭客松'],
];
const PHRASES_BY_LEN = [...ZH_HANT_PHRASES].sort((a, b) => b[0].length - a[0].length);
const ZH_HANT_CHARS = {
    万: '萬', 与: '與', 专: '專', 业: '業', 东: '東', 丝: '絲', 丢: '丟',
    两: '兩', 严: '嚴', 丧: '喪', 个: '個', 临: '臨', 为: '為', 举: '舉',
    么: '麼', 义: '義', 乌: '烏', 乐: '樂', 习: '習', 乡: '鄉', 书: '書',
    买: '買', 乱: '亂', 争: '爭', 于: '於', 亏: '虧', 云: '雲', 亚: '亞',
    产: '產', 亲: '親', 亵: '褻', 亿: '億', 仅: '僅', 仆: '僕', 从: '從',
    仑: '崙', 仓: '倉', 仪: '儀', 们: '們', 价: '價', 众: '眾', 优: '優',
    会: '會', 伟: '偉', 传: '傳', 伤: '傷', 伦: '倫', 伪: '偽', 体: '體',
    余: '餘', 佣: '傭', 侠: '俠', 侣: '侶', 侦: '偵', 侧: '側', 侨: '僑',
    俩: '倆', 债: '債', 倾: '傾', 偿: '償', 储: '儲', 儿: '兒', 兑: '兌',
    党: '黨', 兰: '蘭', 关: '關', 兴: '興', 养: '養', 兽: '獸', 内: '內',
    冈: '岡', 册: '冊', 写: '寫', 军: '軍', 农: '農', 冯: '馮', 冲: '衝',
    决: '決', 况: '況', 净: '淨', 准: '準', 凉: '涼', 减: '減', 几: '幾',
    凤: '鳳', 凭: '憑', 凯: '凱', 击: '擊', 凿: '鑿', 划: '劃', 刘: '劉',
    则: '則', 刚: '剛', 创: '創', 删: '刪', 别: '別', 剑: '劍', 剥: '剝',
    剧: '劇', 劝: '勸', 办: '辦', 务: '務', 动: '動', 劲: '勁', 劳: '勞',
    势: '勢', 勋: '勳', 医: '醫', 华: '華', 协: '協', 单: '單', 卖: '賣',
    卢: '盧', 卫: '衛', 却: '卻', 卷: '捲', 厂: '廠', 厅: '廳', 历: '歷',
    压: '壓', 厌: '厭', 厕: '廁', 县: '縣', 参: '參', 双: '雙', 发: '發',
    变: '變', 叙: '敘', 叠: '疊', 叶: '葉', 号: '號', 叹: '嘆', 后: '後',
    吓: '嚇', 吗: '嗎', 启: '啟', 吴: '吳', 员: '員', 呜: '嗚', 周: '週',
    响: '響', 哑: '啞', 唤: '喚', 喷: '噴', 团: '團', 园: '園', 围: '圍',
    国: '國', 图: '圖', 圆: '圓', 圣: '聖', 场: '場', 坏: '壞', 坚: '堅',
    坛: '壇', 坝: '壩', 坞: '塢', 坟: '墳', 坠: '墜', 块: '塊', 垒: '壘',
    垦: '墾', 垫: '墊', 执: '執', 堕: '墮', 声: '聲', 壳: '殼', 壶: '壺',
    处: '處', 备: '備', 复: '復', 够: '夠', 头: '頭', 夸: '誇', 夹: '夾',
    夺: '奪', 奋: '奮', 奖: '獎', 奥: '奧', 妇: '婦', 妈: '媽', 娱: '娛',
    孙: '孫', 学: '學', 宁: '寧', 宫: '宮', 宝: '寶', 实: '實', 宠: '寵',
    审: '審', 宪: '憲', 宽: '寬', 宾: '賓', 对: '對', 寻: '尋', 导: '導',
    寿: '壽', 将: '將', 尔: '爾', 尘: '塵', 尝: '嘗', 尽: '盡', 层: '層',
    属: '屬', 屡: '屢', 岁: '歲', 岂: '豈', 岗: '崗', 岛: '島', 岭: '嶺',
    岳: '嶽', 峡: '峽', 币: '幣', 帅: '帥', 师: '師', 帐: '帳', 带: '帶',
    帧: '幀', 帮: '幫', 干: '乾', 并: '並', 广: '廣', 庄: '莊', 庆: '慶',
    库: '庫', 应: '應', 庙: '廟', 废: '廢', 开: '開', 异: '異', 弃: '棄',
    张: '張', 弥: '彌', 弯: '彎', 弹: '彈', 强: '強', 归: '歸', 当: '當',
    录: '錄', 彻: '徹', 径: '徑', 忆: '憶', 忧: '憂', 态: '態', 怀: '懷',
    总: '總', 恋: '戀', 恒: '恆', 恶: '惡', 恼: '惱', 悬: '懸', 惊: '驚',
    惧: '懼', 惨: '慘', 惫: '憊', 惯: '慣', 愿: '願', 懒: '懶', 戏: '戲',
    战: '戰', 户: '戶', 扑: '撲', 扩: '擴', 扫: '掃', 扬: '揚', 扰: '擾',
    护: '護', 报: '報', 担: '擔', 拟: '擬', 拥: '擁', 择: '擇', 挂: '掛',
    挡: '擋', 挣: '掙', 挤: '擠', 挥: '揮', 损: '損', 换: '換', 据: '據',
    搁: '擱', 摆: '擺', 摇: '搖', 摊: '攤', 撑: '撐', 敌: '敵', 敛: '斂',
    数: '數', 断: '斷', 无: '無', 旧: '舊', 时: '時', 显: '顯', 晒: '曬',
    晓: '曉', 暂: '暫', 术: '術', 机: '機', 杀: '殺', 杂: '雜', 权: '權',
    杆: '桿', 条: '條', 来: '來', 杨: '楊', 松: '鬆', 极: '極', 构: '構',
    标: '標', 栋: '棟', 栏: '欄', 树: '樹', 样: '樣', 桥: '橋', 桩: '樁',
    梦: '夢', 检: '檢', 楼: '樓', 横: '橫', 樱: '櫻', 欢: '歡', 欧: '歐',
    残: '殘', 气: '氣', 汇: '匯', 汉: '漢', 汤: '湯', 沟: '溝', 没: '沒',
    泽: '澤', 洁: '潔', 浅: '淺', 浇: '澆', 测: '測', 济: '濟', 浓: '濃',
    涌: '湧', 涛: '濤', 渊: '淵', 渐: '漸', 渔: '漁', 渗: '滲',
    温: '溫', 湾: '灣', 湿: '濕', 滤: '濾', 滥: '濫', 滨: '濱', 潜: '潛',
    灯: '燈', 灵: '靈', 灾: '災', 炉: '爐', 炖: '燉', 点: '點', 炼: '煉',
    烟: '煙', 烦: '煩', 烧: '燒', 热: '熱', 烛: '燭', 爱: '愛', 爷: '爺',
    牵: '牽', 牺: '犧', 状: '狀', 犹: '猶', 独: '獨', 狭: '狹', 献: '獻',
    玛: '瑪', 环: '環', 现: '現', 珑: '瓏', 琐: '瑣', 电: '電', 画: '畫',
    畅: '暢', 畴: '疇', 疗: '療', 盘: '盤', 着: '著', 瞒: '瞞', 矿: '礦',
    码: '碼', 确: '確', 碍: '礙', 礼: '禮', 离: '離', 种: '種', 积: '積',
    称: '稱', 稳: '穩', 穷: '窮', 竞: '競', 笔: '筆', 简: '簡', 篮: '籃',
    筛: '篩', 签: '籤', 类: '類', 紧: '緊', 纠: '糾', 红: '紅', 约: '約',
    级: '級', 纪: '紀', 纯: '純', 纸: '紙', 纷: '紛', 细: '細', 织: '織',
    终: '終', 组: '組', 经: '經', 结: '結', 绕: '繞', 绘: '繪', 给: '給',
    绝: '絕', 统: '統', 继: '繼', 绩: '績', 绪: '緒', 续: '續', 维: '維',
    综: '綜', 绿: '綠', 缓: '緩', 编: '編', 缘: '緣', 缚: '縛', 缝: '縫',
    缩: '縮', 纵: '縱', 线: '線', 练: '練', 绑: '綁', 网: '網', 罗: '羅',
    罚: '罰', 羡: '羨', 联: '聯', 聪: '聰', 胜: '勝', 脱: '脫', 脸: '臉',
    舍: '捨', 节: '節', 苍: '蒼', 苏: '蘇', 荣: '榮', 药: '藥', 获: '獲',
    营: '營', 萧: '蕭', 萨: '薩', 蓝: '藍', 茧: '繭', 荫: '蔭', 虑: '慮',
    虫: '蟲', 虽: '雖', 蜡: '蠟', 补: '補', 装: '裝', 里: '裡', 观: '觀',
    规: '規', 觅: '覓', 视: '視', 觉: '覺', 计: '計', 订: '訂', 认: '認',
    讨: '討', 让: '讓', 训: '訓', 议: '議', 讯: '訊', 记: '記', 讲: '講',
    许: '許', 论: '論', 设: '設', 访: '訪', 证: '證', 评: '評', 识: '識',
    诉: '訴', 词: '詞', 译: '譯', 试: '試', 诗: '詩', 诚: '誠', 话: '話',
    该: '該', 详: '詳', 语: '語', 误: '誤', 诱: '誘', 说: '說', 请: '請',
    诸: '諸', 读: '讀', 课: '課', 谁: '誰', 调: '調', 谈: '談', 谋: '謀',
    谓: '謂', 谜: '謎', 谢: '謝', 谨: '謹', 贝: '貝', 负: '負', 贡: '貢',
    财: '財', 责: '責', 贤: '賢', 败: '敗', 货: '貨', 质: '質', 贪: '貪',
    贫: '貧', 购: '購', 贯: '貫', 贴: '貼', 贵: '貴', 贷: '貸', 费: '費',
    贺: '賀', 贼: '賊', 资: '資', 赏: '賞', 赔: '賠', 赖: '賴', 赚: '賺',
    赛: '賽', 赞: '讚', 赠: '贈', 赢: '贏', 赶: '趕', 跃: '躍', 车: '車',
    轨: '軌', 转: '轉', 轮: '輪', 软: '軟', 轴: '軸', 轰: '轟', 轻: '輕',
    载: '載', 较: '較', 辅: '輔', 辆: '輛', 辈: '輩', 辉: '輝', 输: '輸',
    辙: '轍', 辞: '辭', 辩: '辯', 边: '邊', 达: '達', 迁: '遷', 过: '過',
    迈: '邁', 迎: '迎', 运: '運', 还: '還', 这: '這', 进: '進', 远: '遠',
    违: '違', 连: '連', 迟: '遲', 迹: '跡', 适: '適', 选: '選', 逊: '遜',
    递: '遞', 遗: '遺', 遥: '遙', 邻: '鄰', 郁: '鬱', 采: '採', 释: '釋',
    鉴: '鑒', 针: '針', 钉: '釘', 钓: '釣', 钟: '鐘', 钢: '鋼', 钱: '錢',
    铁: '鐵', 钻: '鑽', 银: '銀', 铺: '鋪', 链: '鏈', 销: '銷', 锁: '鎖',
    锅: '鍋', 锋: '鋒', 错: '錯', 锥: '錐', 锦: '錦', 键: '鍵', 镇: '鎮',
    镜: '鏡', 长: '長', 门: '門', 闪: '閃', 闭: '閉', 问: '問', 闲: '閒',
    间: '間', 闷: '悶', 闹: '鬧', 闻: '聞', 阅: '閱', 阔: '闊', 队: '隊',
    阳: '陽', 阴: '陰', 阵: '陣', 阶: '階', 际: '際', 陆: '陸', 陈: '陳',
    险: '險', 随: '隨', 隐: '隱', 难: '難', 雾: '霧', 静: '靜', 韧: '韌',
    顶: '頂', 项: '項', 顺: '順', 须: '須', 顽: '頑', 顾: '顧', 顿: '頓',
    预: '預', 领: '領', 颇: '頗', 频: '頻', 颗: '顆', 题: '題', 额: '額',
    颜: '顏', 风: '風', 飘: '飄', 飞: '飛', 饭: '飯', 饮: '飲', 饰: '飾',
    饱: '飽', 饼: '餅', 馆: '館', 馈: '饋', 马: '馬', 驱: '驅', 驶: '駛',
    驻: '駐', 驾: '駕', 验: '驗', 骑: '騎', 骗: '騙', 骤: '驟', 鱼: '魚',
    鲁: '魯', 鲜: '鮮', 鸟: '鳥', 鸡: '雞', 鸣: '鳴', 鸭: '鴨', 黄: '黃',
    齐: '齊', 龙: '龍', 龟: '龜', 听: '聽', 范: '範', 系: '係', 丰: '豐',
    见: '見', 满: '滿', 滞: '滯',
    络: '絡', 鹅: '鵝', 腊: '臘', 虾: '蝦', 猪: '豬', 饺: '餃', 轩: '軒',
    阁: '閣', 厨: '廚', 咸: '鹹', 冻: '凍',
    监: '監', 讼: '訟', 袭: '襲', 础: '礎', 账: '賬', 舰: '艦', 档: '檔',
    筹: '籌', 赋: '賦', 触: '觸', 颖: '穎', 腾: '騰', 罢: '罷', 惩: '懲',
    讽: '諷',
};
const LANG_SWITCH_CONTENT_GUARD_RE = /\b(?:menu|breakfast|tea|class|lesson|teacher|song|movie|book|subtitle|subtitles|name|version|title|paper|article|exam)\b|菜單|菜单|早餐|茶|課|课|老師|老师|歌|電影|电影|書|书|字幕|名字|標題|标题/i;
const LANG_SWITCH_ZH_PREFIX = '(?:(?:從|从)?現在開始|(?:從|从)现在开始|接下來|接下来|以後|以后|之後|之后|後面|后面|麻煩(?:你|您)?|麻烦(?:你|您)?|請|请|可以|能否|幫我|帮我|都)';
const LANG_SWITCH_ZH_SUFFIX = '(?:來|来)?(?:回覆|回复|回|聊天|溝通|沟通|對話|对话|說|说|講|讲|聊)?(?:我|一下|吧|好嗎|好吗|可以嗎|可以吗|喔|哦|呀|謝謝|谢谢)?';
const LANG_SWITCH_HANT_RE = new RegExp(`^(?:${LANG_SWITCH_ZH_PREFIX}[\\s,，]*){0,4}(?:改用|改回|切回|切換成|切换成|切換回|切换回|換成|换成|換回|换回|轉回|转回|變回|变回|用|說|说|講|讲|回覆|回复|回)?(?:繁體|繁体|正體|正体)(?:中文)?(?:[\\s,，]*${LANG_SWITCH_ZH_SUFFIX}){0,3}$`, 'i');
const LANG_SWITCH_HANS_RE = new RegExp(`^(?:${LANG_SWITCH_ZH_PREFIX}[\\s,，]*){0,4}(?:改用|改回|切回|切換成|切换成|切換回|切换回|換成|换成|換回|换回|轉回|转回|變回|变回|用|說|说|講|讲|回覆|回复|回)?(?:簡體|简体)(?:中文)?(?:[\\s,，]*${LANG_SWITCH_ZH_SUFFIX}){0,3}$`, 'i');
const LANG_SWITCH_ZH_EN_RE = new RegExp(`^(?:${LANG_SWITCH_ZH_PREFIX}[\\s,，]*){0,4}(?:改用|改回|切回|切換成|切换成|切換回|切换回|換成|换成|換回|换回|轉回|转回|變回|变回|用|說|说|講|讲|回覆|回复|回)英[文語语](?:[\\s,，]*${LANG_SWITCH_ZH_SUFFIX}){0,3}$`, 'i');
const LANG_SWITCH_EN_RE = /^(?:(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?)?(?:(?:switch\s+to|use|speak|talk(?:\s+to\s+me)?\s+in|reply(?:\s+to\s+me)?\s+in|respond(?:\s+to\s+me)?\s+in|answer(?:\s+me)?\s+in|write(?:\s+to\s+me)?\s+in|in)\s+english|english(?:\s+only)?)(?:\s+(?:from\s+now\s+on|from\s+here(?:\s+on)?|going\s+forward|after\s+this|for\s+me|to\s+me|please|thank\s+you|thanks))*$/i;
/**
 * Detects an explicit user request to switch reply script/language (works regardless of whether
 * the request itself is written in Traditional or Simplified characters, e.g. `請用簡體` / `请用繁体`).
 */
export function detectExplicitLangSwitch(text) {
    const clean = (text ?? '')
        .trim()
        .replace(/^[\s,，.。!！?？:：;；"'「」『』()（）]+|[\s,，.。!！?？:：;；"'「」『』()（）]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!clean || clean.length > 60 || LANG_SWITCH_CONTENT_GUARD_RE.test(clean))
        return null;
    if (LANG_SWITCH_HANT_RE.test(clean)) {
        return 'zh-Hant';
    }
    if (LANG_SWITCH_HANS_RE.test(clean)) {
        return 'zh-Hans';
    }
    if (LANG_SWITCH_EN_RE.test(clean) || LANG_SWITCH_ZH_EN_RE.test(clean)) {
        return 'en';
    }
    return null;
}
/** Converts Simplified Chinese prose into pure Traditional Chinese with phrase disambiguation. */
export function toZhHant(text) {
    const input = text ?? '';
    let out = '';
    let i = 0;
    const n = input.length;
    while (i < n) {
        let matched = false;
        for (const [src, dst] of PHRASES_BY_LEN) {
            if (input.startsWith(src, i)) {
                out += dst;
                i += src.length;
                matched = true;
                break;
            }
        }
        if (!matched) {
            const ch = input[i];
            out += ZH_HANT_CHARS[ch] ?? ch;
            i += 1;
        }
    }
    return out;
}
let hansTables = null;
function zhHansTables() {
    if (hansTables)
        return hansTables;
    const chars = {};
    for (const [hans, hant] of Object.entries(ZH_HANT_CHARS)) {
        if (hans !== hant && !(hant in chars))
            chars[hant] = hans;
    }
    const phrases = ZH_HANT_PHRASES.filter(([hans, hant]) => hans !== hant)
        .map(([hans, hant]) => [hant, hans])
        .sort((a, b) => b[0].length - a[0].length);
    hansTables = { phrases, chars };
    return hansTables;
}
/** Converts Traditional Chinese prose into Simplified Chinese (the reverse of `toZhHant`). */
export function toZhHans(text) {
    const { phrases, chars } = zhHansTables();
    const input = text ?? '';
    let out = '';
    let i = 0;
    while (i < input.length) {
        let matched = false;
        for (const [src, dst] of phrases) {
            if (input.startsWith(src, i)) {
                out += dst;
                i += src.length;
                matched = true;
                break;
            }
        }
        if (!matched) {
            const ch = input[i];
            out += chars[ch] ?? ch;
            i += 1;
        }
    }
    return out;
}
const FOREIGN_SCRIPTS = [
    [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'ja'],
    [/\p{Script=Hangul}/u, 'ko'],
    [/\p{Script=Cyrillic}/u, 'ru'],
    [/\p{Script=Arabic}/u, 'ar'],
    [/\p{Script=Hebrew}/u, 'he'],
    [/\p{Script=Thai}/u, 'th'],
    [/\p{Script=Devanagari}/u, 'hi'],
    [/\p{Script=Greek}/u, 'el'],
];
const LATIN_MARKERS = {
    en: /\b(?:the|is|are|what|where|can|any|today|tonight|do|does|i|you|we|to|in|of|and|for|with|there|some|how|eat)\b/gi,
    es: /[¿¡ñ]|\b(?:el|los|las|que|qué|hay|hoy|alguna?|noticias?|dónde|donde|puedo|podemos|esta|noche|comer|para|una?|con|por|mañana)\b/gi,
    fr: /[çœ]|\b(?:le|les|des|est|je|vous|nous|quoi|ce|soir|où|aujourd'hui|manger|faire|une?|avec|pour|demain)\b/gi,
    de: /[äöüß]|\b(?:der|die|das|und|ist|ich|kann|heute|abend|was|wo|gibt|es|essen|machen|wir|ein|eine|mit|morgen)\b/gi,
    it: /\b(?:il|che|di|oggi|cosa|sono|dove|posso|stasera|mangiare|fare|una?|con|per|domani|ci)\b/gi,
    pt: /[ãõ]|\b(?:os|que|não|hoje|você|onde|posso|podemos|noite|comer|fazer|uma?|com|para|amanhã|tem)\b/gi,
    nl: /\b(?:het|een|wat|kunnen|vanavond|waar|eten|doen|ik|wij|we|vandaag|morgen|met|voor|zijn|er)\b/gi,
};
/**
 * BCP-47 code of `text` when it is clearly neither Chinese nor English, else null. Script-based for
 * non-Latin writing (kana wins over Han, so Japanese with kanji is `ja`); for Latin script, common
 * function words of es/fr/de/it/pt/nl must clearly outnumber English ones. Mentions are not stripped.
 */
export function detectForeignLanguage(text) {
    const t = (text ?? '').trim();
    if (!t)
        return null;
    for (const [re, code] of FOREIGN_SCRIPTS)
        if (re.test(t))
            return code;
    if (/[\u3400-\u9FFF]/.test(t))
        return null;
    const counts = Object.fromEntries(Object.entries(LATIN_MARKERS).map(([code, re]) => [code, (t.match(re) ?? []).length]));
    let best = null;
    for (const [code, n] of Object.entries(counts)) {
        if (code === 'en')
            continue;
        if (n >= 2 && n > counts.en && (!best || n > counts[best]))
            best = code;
    }
    return best;
}
/** True for codes the zh/en templates already answer in. */
export function isZhOrEn(code) {
    return !code || /^(?:zh|en)(?:-|$)/i.test(code);
}
//# sourceMappingURL=lang.js.map