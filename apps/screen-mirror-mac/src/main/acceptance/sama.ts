/**
 * SAMA 引擎接入 —— 把 `packages/ai-acceptance` 挂到 Mac app 的验收流程上。
 *
 * ## 为什么是「另一条通道」而不是替换现有引擎
 *
 * 现有「运行验收」走 `service.ts` 的规则引擎，产出 `AcceptanceResult`
 * （phase / verdict / regionAnalysis / matches），面板的人工确认·忽略、运行历史、
 * ground truth、区域改配**全都长在那个结果模型上**。SAMA 的产物是 `AcceptanceReport`
 * （regions / issues / counts / pixel），结构完全不同 —— 直接替换会把上面那些配套一起打断。
 *
 * 所以这里做成**并列通道**：同一个配对、同一份素材，用另一套方法论再算一遍，
 * 结论单独呈现。两条结论可以互相印证，坏了也不牵连。
 *
 * ## 为什么依赖挂在 devDependencies
 *
 * `electron.vite.config.ts` 的 main/preload 都挂了 `externalizeDepsPlugin()` ——
 * 它会把 `dependencies` 里的包**整包外置**（不打包、运行时 require）。
 * 而本包的 `main` 指向 `src/index.ts`（TS 源码），一旦放进 `dependencies`，
 * 构建产物里就会留下一条 `require('@ui-inspector/ai-acceptance')` → **运行必崩**。
 * 放 `devDependencies` 则不会被外置，vite 会把 TS 源码直接编译进 bundle。
 *
 * （对照：`@ui-inspector/protocol` 也在 `dependencies` 且同样指向 `src/index.ts`，却能跑 ——
 *  因为主进程对它是 `import type`，编译后语句消失。**类型导入无事，值导入必炸**。）
 *
 * ## ⚠️ 绝不能把中间产物传回渲染层
 *
 * `runAcceptance()` 返回的 `debug` 里含 `Map`、`Sampler`、函数与整个节点树，
 * 跨 IPC 传会撞「不可结构化克隆」。这里**只回传 `report`**（纯数据）与 markdown 文本。
 */

import {
  MockRegionReviewer,
  buildMergedView,
  createBundleProfile2026_09_30,
  createDefaultProfile,
  renderMarkdownReport,
  runAcceptance,
  shapeBoth,
  type ImageRef,
  type MergeInput,
  type PixelImage,
  type RegionReviewer,
  type Sampler,
} from '@ui-inspector/ai-acceptance';
import {
  OpenAiCompatibleReviewer,
  PngSampler,
  WorkspaceInputError,
  loadFromWorkspace,
} from '@ui-inspector/ai-acceptance/node';

import type {
  CleanDroppedNode,
  CleanKeptNode,
  MergedViewNode,
  SamaCleanResult,
  SamaEngine,
  SamaRunInput,
  SamaRunResult,
} from '@shared/sama';

/**
 * 契约类型定义在 `src/types/sama.ts`，由主进程与渲染层**共用同一份** ——
 * 这里只做转发。各自维护一份的后果是渲染层改了字段名、主进程照旧返回旧形状，
 * 而 TS 两边都自洽、谁都不报错。
 */
export type {
  SamaEngine,
  SamaRunFailure,
  SamaRunInput,
  SamaRunResult,
  SamaRunSuccess,
  SamaTemplate,
} from '@shared/sama';

/**
 * 截图 → 采样器 + 原图。
 *
 * 解码失败**不能**让整次验收失败：截图可能是空的、被截断的、或格式不是 PNG。
 * 这时像素通道会自己标 `available:false` 并给出原因，其余通道照常出结论。
 */
async function loadSide(ref: ImageRef | undefined): Promise<{ sampler: Sampler | null; image: PixelImage | null }> {
  if (!ref?.load) return { sampler: null, image: null };
  try {
    const image = await ref.load();
    return { sampler: new PngSampler(image), image };
  } catch {
    return { sampler: null, image: null };
  }
}

/**
 * 宿主能力注入。
 *
 * 这个模块**刻意不 import electron**（也不 import `../store/paths`、`./ai`）：
 * 那两处都直接依赖 `app`，一旦 import 进来，整个文件就只能在 Electron 进程里加载，
 * 「引擎编排」这段最该被验证的逻辑也就跟着只能靠启动 GUI 来跑。
 * 把「取 workspace 根」和「读 AI 配置」变成注入项之后，宿主怎么提供是宿主的事，
 * 编排本身可以在纯 Node 里直接验证（见 `scripts/probe-sama.ts`）。
 */
export interface SamaHost {
  /** workspace 根 —— Electron 侧传 `workspaceRoot()`（`app.getPath('userData')/workspace`） */
  workspaceRoot: string;
  /**
   * 读宿主已配置的 AI（endpoint / model / key）。
   * 不传 = 无法使用 `ai` 引擎，请求 `ai` 时会降级到 `rules` 并给出说明。
   */
  loadAiConfig?: () => Promise<{ endpoint: string; apiKey: string; model: string; timeoutMs: number } | null>;
}

export async function runSamaAcceptance(input: SamaRunInput, host: SamaHost): Promise<SamaRunResult> {
  const startedAt = Date.now();
  const engine = input.engine ?? 'rules';
  const enablePixel = input.pixel !== false;

  try {
    // 素材不接受二次导出/搬运：直接读宿主那一份。
    const loaded = loadFromWorkspace(host.workspaceRoot, { pairId: input.pairId });
    const profile = input.template === 'bundle' ? createBundleProfile2026_09_30() : createDefaultProfile();

    let reviewer: RegionReviewer | null = null;
    let engineUsed: SamaEngine = 'rules';
    let engineNote: string | null = null;

    if (engine === 'mock') {
      reviewer = new MockRegionReviewer({ addWeakCategoryIssues: true });
      engineUsed = 'mock';
    } else if (engine === 'ai') {
      // 复用 App 里已经配好的那一份 AI（同一 endpoint / model / key），不另起一套设置。
      const config = (await host.loadAiConfig?.()) ?? null;
      if (config) {
        reviewer = new OpenAiCompatibleReviewer({
          baseUrl: config.endpoint,
          apiKey: config.apiKey,
          model: config.model,
          timeoutMs: config.timeoutMs,
        });
        engineUsed = 'ai';
      } else {
        engineNote = 'App 里尚未配置 AI（缺 endpoint 或 API key），本次只跑了确定性规则通道。';
      }
    }

    const [design, app] = await Promise.all([
      enablePixel ? loadSide(loaded.input.designImage) : Promise.resolve({ sampler: null, image: null }),
      enablePixel ? loadSide(loaded.input.appImage) : Promise.resolve({ sampler: null, image: null }),
    ]);

    const { report } = await runAcceptance(loaded.input, {
      profile,
      reviewer,
      enablePixel,
      samplers: { design: design.sampler, app: app.sampler },
      images: { design: design.image, app: app.image },
    });

    return {
      ok: true,
      engineUsed,
      engineNote,
      durationMs: Date.now() - startedAt,
      report,
      markdown: renderMarkdownReport(report),
    };
  } catch (error) {
    if (error instanceof WorkspaceInputError) {
      return { ok: false, kind: 'input', error: error.message };
    }
    return {
      ok: false,
      kind: 'internal',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ============================================================================
   清洗明细（人工核验卡点①的取数口）
   ============================================================================*/

/**
 * 取清洗明细 + 归并视图，**只跑 L0 不跑验收**。
 *
 * ## 为什么不复用 `runSamaAcceptance` 的结果
 *
 * 那条链路会跑 L1→L4 全程（对 App 侧意味着几十次图片解码 + 像素采样），
 * 而人工核验清洗只关心「节点表被清洗成了什么样」—— 跑完整条链路既慢又没必要。
 *
 * ## ⚠️ 为什么走独立 IPC 而不是塞进 `AcceptanceReport`
 *
 * 实测盲盒那份：保留 191 + 剔除 525 + 归并视图 ≈ **110 KB**。
 * `AcceptanceReport` 是验收结论契约（会被写进 JSON 报告文件、被断言比对数字），
 * 把调试级明细塞进去会：① 每次验收都传一遍；② 报告文件体积翻几倍；
 * ③ 破坏「结论与调试产物分离」这条已经很难守住的纪律。
 *
 * ## ⚠️ 坐标口径
 *
 * 所有 rect 都是**帧内逻辑坐标**（未乘 alignScale），与 `FrameRaster.projectionOf`
 * 的期望一致 —— 画布侧拿到后直接用，**不乘任何系数**。
 * 剔掉的节点不在 `node.rect` 索引里，所以它的 rect 必须由这里带过去。
 */
export async function loadSamaClean(
  input: { pairId: string },
  host: Pick<SamaHost, 'workspaceRoot'>,
): Promise<SamaCleanResult> {
  const startedAt = Date.now();
  try {
    const loaded = loadFromWorkspace(host.workspaceRoot, { pairId: input.pairId });
    const profile = createDefaultProfile();
    const shaped = shapeBoth({
      meta: loaded.input.meta,
      designNodes: loaded.input.designNodes,
      appNodes: loaded.input.appNodes,
      profile,
    });

    const kept: CleanKeptNode[] = [];
    const dropped: CleanDroppedNode[] = [];
    /** 归并要用的输入（className 从 tags 的 `cn:` 项回传，见 l0 的写入） */
    const mergeInputs: Record<'design' | 'app', MergeInput[]> = { design: [], app: [] };

    for (const [sideName, side] of [
      ['design', shaped.design],
      ['app', shaped.app],
    ] as const) {
      const rawNodes = sideName === 'app' ? loaded.input.appNodes : loaded.input.designNodes;
      const rawById = new Map(
        rawNodes.map((n) => [
          sideName === 'app' ? (n as { nodeId: string }).nodeId : (n as { id: string }).id,
          n,
        ]),
      );
      const rectOf = (id: string): [number, number, number, number] | null => {
        // 优先用归一化后的 rect（它已经剔了脏值）；拿不到才回落原始节点
        const n = side.nodes.find((x) => x.id === id);
        if (n) return [n.rect.x, n.rect.y, n.rect.width, n.rect.height];
        const raw = rawById.get(id) as
          | { x?: number; y: number; width: number; height: number; rect?: { x: number; y: number; width: number; height: number } }
          | undefined;
        if (!raw) return null;
        const r = raw.rect ?? { x: raw.x ?? 0, y: raw.y, width: raw.width, height: raw.height };
        return [r.x, r.y, r.width, r.height];
      };

      /**
       * ⭐ 每个节点属于哪个 SVG 图标（`SvgView` 根的 id）。
       *
       * ## 为什么要从**原始节点表**算，而不是让归并沿 `parentId` 走
       *
       * 实测（10年管家 App 侧）：`SvgView` 的**直接子是 `GroupView 0×0`** ——
       * SVG 的绘制树有一层零尺寸中间层。清洗的 `zero-size` 判据会把它剔掉，
       * 于是归并看到的树在**第一层就断了**：
       *
       * ```
       * 30 个 SvgView 根 → 后代共 162 个
       *   kept 54 / zero-size 38（GroupView 0×0 25 + DefsView/GradientView 高 0 13）/ …
       * 归并结果：19 个 svg-root，**成员数全为 1**（收拢了 0 个内部元素）
       * ```
       *
       * ⇒ 光看清洗后的节点集，图标内部元素成了各自独立的框（实测画布上
       * 还飘着 45 个 `PathView`/`CircleView`/`RectView`）。
       * 原始表里有被剔的中间层，才能把 `SvgView → GroupView(0×0) → CircleView`
       * 这条链串起来。
       *
       * ⚠️ 只给**horcrux 族**的节点算（实测 30 个根的 162 个后代**全是** horcrux，
       * 零污染 ⇒ 不会误把真实内容圈进图标）。
       */
      const svgRootOf = new Map<string, string>();
      if (sideName === 'app') {
        /**
         * 沿**原始** parentId 一路往上找最近的 `SvgView` 根；带深度上限防环。
         *
         * ⚠️ 必须走 `rawById`（原始表）而不是清洗后的节点集 ——
         * 中间那层 `GroupView 0×0` 已被清洗剔掉，走清洗后的树会断链。
         */
        const findSvgRoot = (startId: string): string | null => {
          let cur = rawById.get(startId) as
            | { parentId?: string | null; className?: string }
            | undefined;
          // ⚠️ 先判自己：`SvgView` 的 parent 不是 `SvgView`，从 parent 往上走会**找不到自己**
          // ⇒ 根的 `svgGroup` 会是 undefined，引擎侧「根必须在场」守卫会把**合法组也跳过**
          // （实测：加守卫后 svg-root 从 19 个掉到 0 个）。
          if (cur?.className && /SvgView/.test(cur.className)) return startId;
          for (let hops = 0; cur && hops < 32; hops += 1) {
            const pid = cur.parentId;
            if (!pid) return null;
            const parent = rawById.get(pid) as
              | { className?: string; parentId?: string | null }
              | undefined;
            if (parent?.className && /SvgView/.test(parent.className)) return pid;
            cur = parent;
          }
          return null;
        };
        for (const n of rawNodes as Array<{ nodeId: string; className: string }>) {
          if (!/horcrux/.test(n.className ?? '')) continue;
          const root = findSvgRoot(n.nodeId);
          if (root) svgRootOf.set(n.nodeId, root);
        }
      }

      for (const n of side.nodes) {
        kept.push({
          id: n.id,
          side: sideName,
          rect: [n.rect.x, n.rect.y, n.rect.width, n.rect.height],
          kind: n.kind,
          text: n.text,
        });
        mergeInputs[sideName].push({
          id: n.id,
          parentId: n.parentId,
          index: n.index,
          rect: n.rect,
          visible: true,
          clipped: n.clippedOut,
          className: n.tags.find((t) => t.startsWith('cn:'))?.slice(3) ?? '',
          nodeKind: n.kind,
          text: n.text,
          boxStyle: n.boxStyle,
          // ⭐ 让引擎把整个图标收成一个视图节点（见上方 `svgRootOf` 的注释）
          svgGroup: svgRootOf.get(n.id),
        });
      }

      for (const d of side.dropped) {
        const rect = rectOf(d.id);
        // 拿不到几何就不画 —— 宁可少画一个框，也不要画一个位置错的框
        if (!rect) continue;
        dropped.push({
          id: d.id,
          side: sideName,
          tier: d.tier,
          reason: d.reason,
          evidence: d.evidence,
          rect,
        });
      }
    }

    const appMerge = buildMergedView(mergeInputs.app, 'app');
    const designMerge = buildMergedView(mergeInputs.design, 'design');
    const merged: MergedViewNode[] = [...appMerge.view, ...designMerge.view].map((v) => ({
      id: v.id,
      side: v.side,
      kind: v.kind,
      rect: [v.rect.x, v.rect.y, v.rect.width, v.rect.height],
      memberIds: v.memberIds,
      text: v.text,
      memberCount: v.memberIds.length,
      // ⭐ 三个字段**必须由引擎带过来**，画布侧算不出来：
      // 归并后成员已被收拢，看不出「这个框原本是什么类型」「原来有没有孩子」
      // 「有没有画背景」。缺了它们画布只能全画或全不画。
      nodeKind: v.nodeKind,
      hasChildren: v.hasChildren,
      hasBoxPaint: v.hasBoxPaint,
    }));

    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      stats: {
        design: {
          total: shaped.design.stats.total,
          kept: shaped.design.stats.kept,
          dropped: shaped.design.stats.dropped,
          byTier: shaped.design.stats.byTier,
        },
        app: {
          total: shaped.app.stats.total,
          kept: shaped.app.stats.kept,
          dropped: shaped.app.stats.dropped,
          byTier: shaped.app.stats.byTier,
        },
      },
      kept,
      dropped,
      merged,
      mergeStats: {
        app: { total: appMerge.stats.total, merged: appMerge.stats.merged },
        design: { total: designMerge.stats.total, merged: designMerge.stats.merged },
      },
    };
  } catch (error) {
    if (error instanceof WorkspaceInputError) {
      return { ok: false, kind: 'input', error: error.message };
    }
    return { ok: false, kind: 'internal', error: error instanceof Error ? error.message : String(error) };
  }
}
