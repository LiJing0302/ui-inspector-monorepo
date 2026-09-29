/**
 * 导出文件名共用的两个小工具。
 *
 * 单独成文件只有一个理由：**两处导出（配对调试包 / 标注包）必须产出同一种命名**。
 * 它们落的是同一个 workspace 根下的两个兄弟目录，人（和后续的自动分析）会并排看它们 ——
 * 一个带秒一个不带、一个本地时间一个 UTC，会让人误以为其中一个更旧。
 */

/**
 * 文件名里不能出现的字符 / 空白统一换成 `-`；空结果回退到 fallback。
 *
 * 截到 40 字符是因为这些片段来自**用户可改的名字**（需求名 / 设计稿名）：
 * 不截的话，两个长名字拼起来会撞上文件系统的单段 255 字节上限，
 * 而写入失败的表现是「导出没反应」，看不出跟名字长度有关。
 */
export function safeSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * 形如 `2026-09-16_16-39-55` 的**本地**时间戳。
 *
 * ⚠️ 用本地时间而不是 `toISOString()`（UTC）。这是刻意偏离旧行为的一处：
 * 文件名是给人看的，而这个用户在东八区 —— UTC 的时间戳会让「下午 4 点导的文件」
 * 在 Finder 里显示成 `08-39`，与文件的「修改时间」列对不上八小时，
 * 排查时第一反应会是「这文件是别处来的 / 时间不对」。
 *
 * 文件内部的 `exportedAt` 仍然写 ISO 8601（UTC），那里需要的是无歧义，
 * 不是好读。两个地方各取所需。
 */
export function exportStamp(date: Date = new Date()): string {
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
  ].join('_');
}
