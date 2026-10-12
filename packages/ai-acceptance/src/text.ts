/**
 * 文本归一化与动态位识别（纯函数，无副作用、无平台依赖）
 *
 * 实测依据（报告 §1.2 约束 7 / 9）：
 *   - App 文本含零宽字符分隔：`海尔<ZWSP>单门50L冰箱`
 *   - App 树混入系统 toast / 工具浮层文本
 *   - 设计 TEXT 的 `name` 不是内容，只认 text.characters
 */

import type { DynamicPattern } from './types.ts';

/** 零宽 / 不可见字符（U+200B/200C/200D/2060/FEFF）+ BOM */
const INVISIBLE = /[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g;

/** 去掉不可见字符 */
export function stripInvisible(input: string): string {
  return input.replace(INVISIBLE, '');
}

/** 全角 → 半角（含全角空格 U+3000） */
export function toHalfWidth(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code === 0x3000) out += ' ';
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else out += ch;
  }
  return out;
}

/**
 * 归一化文本：去不可见字符 → 全角转半角 → 折叠空白 → 去首尾空白。
 * 不做大小写折叠（中文为主，且大小写在 UI 文案里有意义）。
 */
export function normalizeText(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = toHalfWidth(stripInvisible(input)).replace(/\s+/g, '').trim();
  return s.length === 0 ? null : s;
}

/** 用于锚点比对的 key（当前等于 normalizeText，单独抽出便于将来收紧） */
export function textKey(input: string | null | undefined): string | null {
  return normalizeText(input);
}

/**
 * 数字掩码：所有连续数字替换为 `#`，用于"格式一致、值不同"的动态位比对。
 *
 * 会先剥掉数字里的**千分位分隔符**（实测：`¥560` ↔ `¥1,280` 是同一个价格位的
 * 不同取值，若不剥逗号掩码会变成 `¥#` vs `¥#,###`，动态位会被误判成文案不一致）。
 */
export function digitMask(input: string): string {
  return input.replace(/,(?=\d{3}(?!\d))/g, '').replace(/\d+(\.\d+)?/g, '#');
}

/** 判断两段文本是否"格式一致但取值不同"（动态位的典型形态） */
export function sameShapeDifferentValue(a: string, b: string): boolean {
  if (a === b) return false;
  const ma = digitMask(a);
  const mb = digitMask(b);
  if (ma !== mb) return false;
  // 掩码里必须至少有一个数字位，否则只是纯文本差异
  return ma.includes('#');
}

/** 是否为纯数值型文本（可被认定为动态数据） */
export function isNumericLike(input: string): boolean {
  return /^[¥$€]?-?\d+(\.\d+)?[%+kmg万亿张元分秒天日]?$/i.test(input);
}

export interface DynamicHit {
  name: string;
  matched: boolean;
}

/** 内置动态位模式（profile 未声明时的兜底） */
export const BUILTIN_DYNAMIC_PATTERNS: Array<{ name: string; test: (t: string) => boolean }> = [
  { name: 'DATETIME', test: (t) => /\d{1,4}[-/年]\d{1,2}([-/月]\d{1,2}日?)?|\d{1,2}:\d{2}/.test(t) },
  { name: 'RELATIVE_TIME', test: (t) => /刚刚|分钟前|小时前|\d+天前|昨天|前天|上周/.test(t) },
  { name: 'PRICE', test: (t) => /^[¥$€]\s?\d/.test(t) || /^[¥$€]?\d+(\.\d+)?元?$/.test(t) },
  { name: 'COUNT', test: (t) => /^\d+(\.\d+)?(张|个|件|次|条|人|分|点|元|km|米|m)?$/i.test(t) },
  { name: 'DISTANCE', test: (t) => /^\d+(\.\d+)?\s?(km|m|公里|米)$/i.test(t) },
  { name: 'PERCENT_OFF', test: (t) => /^\d(\.\d+)?折$|^\d{1,3}%$/.test(t) },
];

/** 对一段文本跑动态位识别，返回命中的模式名 */
export function detectDynamic(text: string, patterns?: DynamicPattern[]): string[] {
  const list = patterns ?? BUILTIN_DYNAMIC_PATTERNS;
  const hits: string[] = [];
  for (const p of list) {
    try {
      if (p.test(text)) hits.push(p.name);
    } catch {
      /* profile 里的自定义 pattern 抛错不影响主流程 */
    }
  }
  return hits;
}

/**
 * 文本拼接等价判定：解决"设计多节点 / App 单节点"的粒度差异（报告约束 4）。
 * 例：设计 [`10年包修`, `&`, `10年免费上门检测`] ↔ App [`10年包修&10年免费上门检测`]
 */
export function concatEquivalent(designParts: string[], appText: string): boolean {
  const joined = designParts.join('');
  return joined === appText;
}

/**
 * 在 target 列表里找一组"拼接后等于 appText"的设计文本子序列。
 * 返回命中下标（连续优先）；找不到返回 null。
 */
export function findConcatRun(designTexts: string[], appText: string): number[] | null {
  const n = designTexts.length;
  if (n === 0 || appText.length === 0) return null;
  // 连续窗口优先（粒度差异通常出现在相邻兄弟节点）
  for (let len = 2; len <= Math.min(n, 6); len++) {
    for (let i = 0; i + len <= n; i++) {
      if (designTexts.slice(i, i + len).join('') === appText) {
        return Array.from({ length: len }, (_, k) => i + k);
      }
    }
  }
  return null;
}
