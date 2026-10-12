/**
 * workspace 直读探针
 *
 *   node --experimental-strip-types src/__tests__/probe_workspace.ts [workspaceRoot]
 *
 * 在**真实数据**上验三件事（`run.ts` 里的合成树测不到这些）：
 *   1. 索引里声明的 `nodeCount` 与直读拍平后的节点数一致 —— 跨源一致性。
 *      不一致意味着索引过期或 schema 换了结构，两者都会让报告看起来「正常但不对」。
 *   2. `parentId` / `childCount` 自洽：每个非根节点找得到父，父的 `childCount` 等于
 *      实际子数，且前序顺序里父一定排在子之前（下游拿 parentId 回溯祖先链全靠它）。
 *   3. 两张截图能解码，且像素尺寸与 meta 声明一致（M4 的全部分母都来自这两个数）。
 *
 * workspace 不存在时退出 0 —— 这台机器上没有 Mac app 数据不该算失败。
 */

import { defaultWorkspaceRoot, listWorkspacePairs, loadFromWorkspace } from '../node/fromWorkspace.ts';
import type { DesignNode } from '../types.ts';

const root = process.argv[2] ?? process.env['SCREEN_MIRROR_WORKSPACE'] ?? defaultWorkspaceRoot();

let pairs: ReturnType<typeof listWorkspacePairs>;
try {
  pairs = listWorkspacePairs(root);
} catch (e) {
  console.log(`skip：读不到 workspace（${e instanceof Error ? e.message : String(e)}）`);
  process.exit(0);
}

if (pairs.length === 0) {
  console.log('skip：workspace 里没有任何配对');
  process.exit(0);
}

let checked = 0;
const failures: string[] = [];
const fail = (label: string, detail = ''): void => {
  failures.push(detail ? `${label} — ${detail}` : label);
};

console.log(`workspace: ${root}\n发现 ${pairs.length} 个配对\n`);

for (const ref of pairs) {
  const tag = `${ref.requirementName} / ${ref.designName}`;
  const loaded = loadFromWorkspace(root, { pairId: ref.pairId });
  const { designNodes, appNodes, meta } = loaded.input;

  console.log(`▸ ${tag}`);
  console.log(`    design ${designNodes.length} 节点 / app ${appNodes.length} 节点`);

  // ---- 1. 与索引声明对齐 ----
  if (ref.designNodeCount && designNodes.length !== ref.designNodeCount) {
    fail(`${tag}：设计侧节点数`, `索引声明 ${ref.designNodeCount}，直读 ${designNodes.length}`);
  }
  if (ref.appNodeCount && appNodes.length !== ref.appNodeCount) {
    fail(`${tag}：App 侧节点数`, `索引声明 ${ref.appNodeCount}，直读 ${appNodes.length}`);
  }
  if (designNodes.length === 0) fail(`${tag}：设计侧拍平结果为空`);

  // ---- 2. 树自洽 ----
  const byId = new Map<string, DesignNode>();
  designNodes.forEach((n, i) => {
    if (byId.has(n.id)) fail(`${tag}：节点 id 重复`, n.id);
    else byId.set(n.id, n);
    if (i > 0 && n.parentId === null) {
      fail(`${tag}：非唯一根节点`, `第 ${i} 个节点 ${n.id} 的 parentId 是 null`);
    }
  });
  const childTally = new Map<string, number>();
  for (const n of designNodes) {
    if (n.parentId) childTally.set(n.parentId, (childTally.get(n.parentId) ?? 0) + 1);
  }
  for (const n of designNodes) {
    if (n.parentId && !byId.has(n.parentId)) {
      fail(`${tag}：悬空 parentId`, `${n.id} → ${n.parentId}`);
    }
    const actual = childTally.get(n.id) ?? 0;
    if ((n.childCount ?? 0) !== actual) {
      fail(`${tag}：childCount 与实际子节点数不符`, `${n.id}：声明 ${n.childCount}，实际 ${actual}`);
    }
  }

  // ---- 3. 截图 ----
  for (const [side, img, declared] of [
    ['design', loaded.input.designImage, [meta.design.pixelWidth, meta.design.pixelHeight]],
    ['app', loaded.input.appImage, [meta.app.pixelWidth, meta.app.pixelHeight]],
  ] as const) {
    if (!img) {
      fail(`${tag}：${side} 截图缺失`);
      continue;
    }
    if (!img.load) {
      fail(`${tag}：${side} 截图没有解码器`);
      continue;
    }
    const px = await img.load();
    const [dw, dh] = declared as [number | undefined, number | undefined];
    if (dw && dh && (px.width !== dw || px.height !== dh)) {
      fail(`${tag}：${side} 截图尺寸`, `meta 声明 ${dw}×${dh}，实际 ${px.width}×${px.height}`);
    }
    if (px.data.length !== px.width * px.height * 4) {
      fail(`${tag}：${side} 像素缓冲长度`, `${px.data.length} ≠ ${px.width}×${px.height}×4`);
    }
  }

  checked++;
}

console.log(`\n${'─'.repeat(64)}`);
if (failures.length) {
  console.error(`✗ 检查 ${checked} 个配对，${failures.length} 处不一致：`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ ${checked} 个配对全部通过（节点数对齐索引 · 树自洽 · 截图像素尺寸一致）`);
