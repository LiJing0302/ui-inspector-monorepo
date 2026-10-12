/**
 * 验收前提声明（Profile）
 *
 * 报告 D4 的落地：**显式声明 + 模型确认**。XBIDetective 的教训是"未处理的弹窗与动态内容
 * 会产生大量假阳性"，所以登录态、数据态、运营可配项必须在**判定之前**声明出来，
 * 而不是指望模型自己判断。
 */

import type { AcceptanceProfile, DynamicPattern, RegionDef } from './types.ts';
import { BUILTIN_DYNAMIC_PATTERNS } from './text.ts';

/** 工具自身浮层的默认名单（实测来自 App 树：`上传中` / `验收` / 系统 toast / 下拉刷新） */
export const DEFAULT_NOISE_TEXTS = [
  '上传中',
  '验收',
  '网络不可用，请检查网络连接',
  '下拉刷新',
  '加载中',
  'Loading',
];

export const DEFAULT_CHROME_PATTERNS = ['status\\s*bar', '状态栏', 'navigation\\s*bar'];

/**
 * 本 bundle 的分区定义（报告 §3.3）。
 * 边界取自设计稿浅层结构；`hints` 用于给 VLM 提供"这一片高发什么类型差异"的线索。
 */
export const BUNDLE_2026_09_30_REGIONS: RegionDef[] = [
  { regionId: 'R1', label: '顶部栏', designY0: 0, designY1: 120, hints: ['登录态', '头像/昵称', '消息/客服/设置'] },
  { regionId: 'R2', label: '会员卡', designY0: 120, designY1: 265, hints: ['运营可配文案', '价格', '权益三条'] },
  { regionId: 'R3', label: '权益横幅', designY0: 265, designY1: 339, hints: ['拼接粒度差异'] },
  { regionId: 'R4', label: '数据四宫格', designY0: 339, designY1: 470, hints: ['数量动态位', '登录态'] },
  { regionId: 'R5', label: '待办九宫格', designY0: 470, designY1: 594, hints: ['数量角标'] },
  { regionId: 'R6', label: '服务网格', designY0: 594, designY1: 900, hints: ['文案差异', '圆角卡片'] },
  { regionId: 'R7', label: '线下店', designY0: 900, designY1: 1080, hints: ['店铺名/地址/距离 → 数据态'] },
  { regionId: 'R8', label: '精选好物列表', designY0: 1080, designY1: 2205, hints: ['测试数据', '截图外'] },
  { regionId: 'R9', label: '底部导航（固定层）', designY0: 1140, designY1: 1261, hints: ['固定层，不与流式层比 Δy'] },
];

export function defaultDynamicPatterns(): DynamicPattern[] {
  return [...BUILTIN_DYNAMIC_PATTERNS];
}

export function createDefaultProfile(overrides: Partial<AcceptanceProfile> = {}): AcceptanceProfile {
  return {
    name: overrides.name ?? 'default',
    noiseClassNames: overrides.noiseClassNames ?? [],
    noiseTexts: overrides.noiseTexts ?? DEFAULT_NOISE_TEXTS,
    chromeClassNames: overrides.chromeClassNames ?? [],
    chromeNamePatterns: overrides.chromeNamePatterns ?? DEFAULT_CHROME_PATTERNS,
    dynamicPatterns: overrides.dynamicPatterns ?? defaultDynamicPatterns(),
    declaredEnvironmental: overrides.declaredEnvironmental ?? [],
    regions: overrides.regions,
    thresholds: {
      geometryTolerance: 4,
      deltaE: 2.5,
      cornerTolerancePx: 4,
      gapJump: 40,
      ...(overrides.thresholds ?? {}),
    },
    preconditions: overrides.preconditions ?? [],
  };
}

/** 本 bundle 的专用 profile —— 把实测出来的前提写死成可复现的声明 */
export function createBundleProfile2026_09_30(): AcceptanceProfile {
  return createDefaultProfile({
    name: 'bundle-2026-09-30-10年管家开通前',
    regions: BUNDLE_2026_09_30_REGIONS,
    declaredEnvironmental: [
      // 全局：登录/注册占位、脱敏手机号
      { pattern: '^登录/注册$|^-$|^/-/-$', reason: '登录态 / 数据态差异（App 未登录）' },
      { pattern: '\\*{2,}', reason: '脱敏手机号等账号信息' },
      { pattern: '^¥?9001$|^测试用1$|^卖酷家乐账号$', reason: '联调测试数据' },
      { pattern: '^\\d+(\\.\\d+)?\\s?(km|m|公里|米)$', reason: '距离等经营数据' },
      // 区域级：整区不做逐条文案比对（区域级豁免，需 regions 且无 pattern）
      { regions: ['R1'], reason: '顶部栏含登录态（设计已登录 / App 未登录），昵称/等级/社区入口不做逐条比对' },
      { regions: ['R8'], reason: 'R8 精选好物为联调测试商品数据，仅比结构不比文案' },
      { regions: ['R7'], reason: 'R7 线下店店名/地址/距离为真实经营数据（数据态）' },
      // 区域级 + 文本：只豁免登录态相关文案，保留「三条权益」这类真实差异
      {
        regions: ['R2'],
        pattern: '^会员$|^Smartlife$|^会员专享券包$|^入会领取$|^L3黄金会员$',
        reason: '登录态相关文案（App 未登录）',
      },
    ],
    preconditions: [
      'App 截图仅覆盖设计高度的 62.8%（792 / 1261），下半屏无像素证据 → 相关区域判定降级为 review，禁止 pass',
      '右侧 App 处于未登录态，登录态相关节点不参与存在性判定',
      '商品列表（R8）为联调测试数据，不做文案比对',
      '平台态：设计含 iOS 状态栏、App 为 Android 系统栏 → 已按平台 chrome 剔除',
      '线下店店名/地址为真实经营数据，由 profile 声明为数据态',
    ],
  });
}
