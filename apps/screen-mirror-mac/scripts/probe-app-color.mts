/**
 * 离线探针：`appColorToCss`（App侧 ARGB → CSS RGBA）的行为核验。
 *
 * 零构建（node --experimental-strip-types），直接 import 源文件。
 * 真实数据取自盲盒抽奖需求的 app 快照（`9fe18d9b`）。
 */
import { appColorToCss } from '../src/types/verify.ts';

let failed = 0;
const eq = (label: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        期望 ${String(expected)}\n        实际 ${String(actual)}`}`);
};

// —— 用户报的那个值：真实含义是「黑色 54% 透明」，不是深红 ——
eq('#8a000000 → #0000008a（ARGB 换字节序，不是重排颜色）', appColorToCss('#8a000000'), '#0000008a');
eq('#14000000 → #00000014', appColorToCss('#14000000'), '#00000014');
eq('#40000000 → #00000040', appColorToCss('#40000000'), '#00000040');

// —— 6 位两侧同口径，必须原样透传（动了就是回归）——
eq('6 位黑透传', appColorToCss('#000000'), '#000000');
eq('6 位白透传', appColorToCss('#ffffff'), '#ffffff');
// —— 8 位一律转换，无例外：这条是探针第一次跑时把断言写错才发现的 ——
eq('真实数据里的 #ffffffb2 → #ffffb2ff', appColorToCss('#ffffffb2'), '#ffffb2ff');
eq('#ff328566 → #328566ff', appColorToCss('#ff328566'), '#328566ff');

// —— 非 hex / 空值：自带语序或不存在的值，一律透传 ——
eq('rgba() 透传', appColorToCss('rgba(0, 0, 0, 0.54)'), 'rgba(0, 0, 0, 0.54)');
eq('渐变串透传', appColorToCss('#fff → #000'), '#fff → #000');
eq('null 透传', appColorToCss(null), null);
eq('undefined 透传', appColorToCss(undefined), undefined);
eq('空串透传', appColorToCss(''), '');

// —— 四边拼接串：判据不匹配 ⇒ 必须原样透传（由 comparison.ts 逐边拆开处理）——
eq('四边拼接串不整体转换', appColorToCss('#8a000000 / #40000000'), '#8a000000 / #40000000');

// —— 大写hex ——
eq('大写 #8A000000', appColorToCss('#8A000000'), '#0000008A');

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);