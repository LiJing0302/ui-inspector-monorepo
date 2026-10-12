/**
 * Node 侧：从 Mac app 的 workspace 直读素材，组装成 `AcceptanceInput`。
 *
 * 为什么要有这条路：debug bundle 的 `.zip` 得先在 Mac app 里点「导出调试包」再手工搬运，
 * 而 workspace 里本来就躺着同一份素材 ——
 *
 *   workspace/
 *     index.json                                   ← 需求 / 设计稿 / App 快照 / 配对表
 *     requirements/<requirementId>/
 *       design/<designAssetId>/{schema.json, screenshot.png, meta.json}
 *       app/<appSnapshotId>/{nodes.json, screenshot.png, meta.json}
 *
 * 直读省掉「导出 + 搬运」两步，也让「改一行 → 重跑」退化成一条命令。
 *
 * 实测等价性（2026-10-03，样本「测试验收 / 10年管家开通前」）：
 *   - `flatten(schema.json.tree)` 与本仓库导出包里的 `design/nodes.json`
 *     **逐字段完全一致**（609/609，且前序顺序一致）；
 *   - `app/<id>/nodes.json` 与导出包 keys 完全相同（495/495）。
 *   两者唯一的差别是导出包多写了 `parentId` / `childCount` —— 由本模块补齐。
 *   所以「直读」与「吃导出包」在引擎看来是同一份输入，结论不会漂。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppNode, BundleMeta, DesignNode } from '../types.ts';
import type { LoadedBundle } from './loadBundle.ts';
import { imageRef } from './loadBundle.ts';

/* ------------------------------------------------------------------ *
 * 路径
 * ------------------------------------------------------------------ */

/**
 * 「你说的东西不存在 / 不够唯一」这类**预期内**的输入问题。
 *
 * 单独一个类只为了 CLI 能只打 message、不打堆栈 —— 选错需求名是日常动作，
 * 抛一屏 `at loadFromWorkspace (...)` 会让人以为程序坏了。
 */
export class WorkspaceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceInputError';
  }
}

/** workspace 根。默认 macOS 的固定位置，可用 SCREEN_MIRROR_WORKSPACE 覆盖（便于跑夹具）。 */
export function defaultWorkspaceRoot(): string {
  return (
    process.env['SCREEN_MIRROR_WORKSPACE'] ??
    join(homedir(), 'Library', 'Application Support', 'screen-mirror-mac', 'workspace')
  );
}

/* ------------------------------------------------------------------ *
 * Figma schema → 扁平节点
 * ------------------------------------------------------------------ */

/** `schema.json` 里的 tree 节点（除 `children` 外字段与扁平节点同构） */
export interface FigmaSchemaNode {
  id: string;
  children?: FigmaSchemaNode[];
  [k: string]: unknown;
}

export interface FigmaSchemaFile {
  width?: number;
  height?: number;
  exportScale?: number;
  screenshot?: string;
  nodeCount?: number;
  tree: FigmaSchemaNode;
  [k: string]: unknown;
}

/**
 * 前序遍历拍平。
 *
 * 只补两个字段：`parentId`（根为 null）与 `childCount`。
 * 其余字段**原样带过** —— 多写一个字段就等于在输入侧引入一处未经验证的推断。
 */
export function flattenFigmaTree(tree: FigmaSchemaNode): DesignNode[] {
  const out: DesignNode[] = [];
  const walk = (node: FigmaSchemaNode, parentId: string | null): void => {
    const { children, ...rest } = node;
    const kids = children ?? [];
    out.push({ ...(rest as unknown as DesignNode), parentId, childCount: kids.length });
    for (const child of kids) walk(child, node.id);
  };
  walk(tree, null);
  return out;
}

/* ------------------------------------------------------------------ *
 * 索引（需求 / 设计稿 / App 快照 / 配对）
 * ------------------------------------------------------------------ */

export interface WorkspaceDesignAsset {
  id: string;
  name?: string;
  width?: number;
  height?: number;
  pixelWidth?: number;
  pixelHeight?: number;
  exportScale?: number;
  nodeCount?: number;
  schemaFile?: string;
  screenshotFile?: string;
  [k: string]: unknown;
}

export interface WorkspaceAppSnapshot {
  id: string;
  label?: string;
  platform?: string;
  device?: string;
  width?: number;
  height?: number;
  pixelWidth?: number;
  pixelHeight?: number;
  densityDpi?: number;
  nodeCount?: number;
  nodesFile?: string;
  screenshotFile?: string;
  capturedAt?: string;
  [k: string]: unknown;
}

export interface WorkspacePair {
  id: string;
  designAssetId: string;
  appSnapshotId: string;
  status?: string;
  createdAt?: string;
}

export interface WorkspaceRequirement {
  id: string;
  name: string;
  updatedAt?: string;
  designAssets: WorkspaceDesignAsset[];
  appSnapshots: WorkspaceAppSnapshot[];
  pairs: WorkspacePair[];
}

export interface WorkspaceIndex {
  version?: number;
  requirements: WorkspaceRequirement[];
}

/** 供 `--list` 展示的一行 */
export interface WorkspacePairRef {
  requirementId: string;
  requirementName: string;
  pairId: string;
  designAssetId: string;
  designName: string;
  appSnapshotId: string;
  appLabel: string;
  designNodeCount: number;
  appNodeCount: number;
  updatedAt: string;
}

export function readWorkspaceIndex(root: string): WorkspaceIndex {
  const file = join(root, 'index.json');
  if (!existsSync(file)) {
    throw new WorkspaceInputError(`workspace 索引不存在：${file}（用 SCREEN_MIRROR_WORKSPACE 指定其它位置）`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as WorkspaceIndex;
}

export function listWorkspacePairs(root: string): WorkspacePairRef[] {
  const index = readWorkspaceIndex(root);
  const out: WorkspacePairRef[] = [];
  for (const req of index.requirements ?? []) {
    for (const pair of req.pairs ?? []) {
      const design = (req.designAssets ?? []).find((a) => a.id === pair.designAssetId);
      const app = (req.appSnapshots ?? []).find((s) => s.id === pair.appSnapshotId);
      out.push({
        requirementId: req.id,
        requirementName: req.name,
        pairId: pair.id,
        designAssetId: pair.designAssetId,
        designName: design?.name ?? '(设计稿缺失)',
        appSnapshotId: pair.appSnapshotId,
        appLabel: app?.label ?? app?.device ?? '(App 快照缺失)',
        designNodeCount: design?.nodeCount ?? 0,
        appNodeCount: app?.nodeCount ?? 0,
        updatedAt: req.updatedAt ?? '',
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 选择与加载
 * ------------------------------------------------------------------ */

export interface WorkspaceSelector {
  /** 配对 id（精确）；给了它就忽略其它条件 */
  pairId?: string;
  /** 需求名或 id（子串匹配，忽略大小写与首尾空白） */
  requirement?: string;
  /** 设计稿名（子串匹配）；一个需求下有多页配对时用它定位 */
  design?: string;
}

const norm = (s: string): string => s.trim().toLowerCase();

function matchOne<T>(items: T[], needle: string | undefined, key: (t: T) => string, what: string): T | null {
  if (!needle) return null;
  const n = norm(needle);
  const exact = items.filter((it) => key(it) === needle.trim());
  const hits = exact.length ? exact : items.filter((it) => norm(key(it)).includes(n));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) throw new WorkspaceInputError(`没有匹配的${what}：${needle}`);
  throw new WorkspaceInputError(
    `「${needle}」匹配到 ${hits.length} 个${what}，请用更完整的名字或 id：\n` +
      hits.map((h) => `  · ${key(h)}`).join('\n'),
  );
}

/**
 * 把 workspace 素材装配成与 `loadBundle()` 同构的返回值。
 *
 * 有多个候选而选择条件不唯一时**抛错并列出候选**，不猜 —— 猜错的代价是拿错页的数据
 * 出一份看起来很正常的报告，比直接失败难查得多。
 */
export function loadFromWorkspace(root: string, selector: WorkspaceSelector): LoadedBundle {
  const index = readWorkspaceIndex(root);

  if (selector.pairId) {
    for (const req of index.requirements ?? []) {
      const pair = (req.pairs ?? []).find((p) => p.id === selector.pairId);
      if (pair) return assemble(root, req, pair);
    }
    throw new WorkspaceInputError(`workspace 里没有这个配对 id：${selector.pairId}`);
  }

  const req = matchOne(index.requirements ?? [], selector.requirement, (r) => r.name, '需求');
  if (!req) {
    const pairs = listWorkspacePairs(root);
    throw new WorkspaceInputError(
      `请用 --req <需求名> 指定要验收的需求（或 --pair <配对id>）。当前 workspace 有：\n` +
        pairs.map((p) => `  · ${p.requirementName} / ${p.designName}  [${p.pairId}]`).join('\n'),
    );
  }

  const pairsOfReq = (req.pairs ?? []).map((p) => {
    const design = (req.designAssets ?? []).find((a) => a.id === p.designAssetId);
    return { pair: p, designName: design?.name ?? '' };
  });
  if (pairsOfReq.length === 0) throw new WorkspaceInputError(`需求「${req.name}」下没有任何配对`);

  if (selector.design) {
    const hit = matchOne(pairsOfReq, selector.design, (x) => x.designName, '设计稿配对');
    return assemble(root, req, hit!.pair);
  }

  if (pairsOfReq.length > 1) {
    // 该需求下多页：直接列出来，别默认挑第一个
    throw new WorkspaceInputError(
      `需求「${req.name}」下有 ${pairsOfReq.length} 个配对，请用 --design <设计稿名> 指定：\n` +
        pairsOfReq.map((x) => `  · ${x.designName}  [${x.pair.id}]`).join('\n'),
    );
  }
  return assemble(root, req, pairsOfReq[0]!.pair);
}

/** 物理像素 ÷ 逻辑像素；任一侧缺失就返回 undefined，让引擎走它自己的默认。 */
function scaleOf(side: { width?: number; pixelWidth?: number }): number | undefined {
  const logical = side.width ?? 0;
  const physical = side.pixelWidth ?? 0;
  if (logical <= 0 || physical <= 0) return undefined;
  return Math.round((physical / logical) * 1000) / 1000;
}

function assemble(root: string, req: WorkspaceRequirement, pair: WorkspacePair): LoadedBundle {
  const design = (req.designAssets ?? []).find((a) => a.id === pair.designAssetId);
  const app = (req.appSnapshots ?? []).find((s) => s.id === pair.appSnapshotId);
  if (!design) throw new WorkspaceInputError(`配对引用的设计稿不存在：${pair.designAssetId}`);
  if (!app) throw new WorkspaceInputError(`配对引用的 App 快照不存在：${pair.appSnapshotId}`);

  const designDir = join(root, 'requirements', req.id, 'design', design.id);
  const appDir = join(root, 'requirements', req.id, 'app', app.id);

  const schemaFile = join(designDir, design.schemaFile ?? 'schema.json');
  if (!existsSync(schemaFile)) throw new WorkspaceInputError(`设计稿 schema 不存在：${schemaFile}`);
  const schema = JSON.parse(readFileSync(schemaFile, 'utf8')) as FigmaSchemaFile;
  const designNodes = flattenFigmaTree(schema.tree);

  const nodesFile = join(appDir, app.nodesFile ?? 'nodes.json');
  if (!existsSync(nodesFile)) throw new WorkspaceInputError(`App 节点不存在：${nodesFile}`);
  const appNodes = JSON.parse(readFileSync(nodesFile, 'utf8')) as AppNode[];

  const designImage = imageRef(
    join(designDir, design.screenshotFile ?? 'screenshot.png'),
    design.pixelWidth,
    design.pixelHeight,
  );
  const appImage = imageRef(
    join(appDir, app.screenshotFile ?? 'screenshot.png'),
    app.pixelWidth,
    app.pixelHeight,
  );
  const missing: string[] = [];
  if (!designImage) missing.push('design/screenshot.png');
  if (!appImage) missing.push('app/screenshot.png');

  const meta: BundleMeta = {
    kind: 'ui-acceptance-workspace',
    version: 1,
    exportedAt: new Date().toISOString(),
    requirement: { id: req.id, name: req.name },
    pair: { id: pair.id },
    design: {
      assetId: design.id,
      name: design.name ?? '',
      width: design.width ?? schema.width ?? 0,
      height: design.height ?? schema.height ?? 0,
      pixelWidth: design.pixelWidth,
      pixelHeight: design.pixelHeight,
      exportScale: design.exportScale ?? schema.exportScale,
      nodeCount: designNodes.length,
    },
    app: {
      snapshotId: app.id,
      name: app.label ?? '',
      platform: app.platform,
      device: app.device,
      width: app.width ?? 0,
      height: app.height ?? 0,
      pixelWidth: app.pixelWidth,
      pixelHeight: app.pixelHeight,
      // ⚠️ workspace 的 app meta.json **不存** scaleX/scaleY，而 M4 像素通道按
      // `scaleX ?? scale ?? exportScale ?? 1` 取值 —— 不补就会退化成 1，
      // 采样点整体缩到 1/3，像素项从 3 项失败膨胀到 13 项（实测踩过）。
      // 这里用两个**都由 SDK 上报**的量求比值，不属于「用逻辑值反算物理值」；
      // 导出包里的 scaleX=3 恰好等于 1080/360，口径一致。
      scaleX: scaleOf(app),
      scaleY: scaleOf(app),
      densityDpi: app.densityDpi,
      nodeCount: appNodes.length,
    },
    files: [schemaFile, nodesFile],
    missing,
  };

  return {
    dir: designDir,
    temp: null,
    input: { meta, designNodes, appNodes, designImage: designImage ?? undefined, appImage: appImage ?? undefined },
  };
}
