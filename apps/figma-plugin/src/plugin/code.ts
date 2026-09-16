import JSZip from 'jszip';
import type {
  ExportManifest,
  ExportOptions,
  FrameBrief,
  FrameMeta,
  PageBrief,
  PluginToUIMessage,
  SelectionGranularity,
  UIToPluginMessage,
} from '../shared/types';
import { SCHEMA_VERSION, nodePath, serializeFrame } from './serialize';
import { PREVIEW_FILE_NAME, renderPreviewHtml } from './preview';

const SCREENSHOT_DIR = 'screenshots';
const SCHEMA_DIR = 'schema';

const CONTAINER_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);

/** 画布点选的导出粒度，由 UI 侧切换 */
let granularity: SelectionGranularity = 'element';

function post(msg: PluginToUIMessage): void {
  figma.ui.postMessage(msg);
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'LOG', level, message });
}

function safeName(input: string): string {
  return (
    input
      .replace(/[/\\:*?"<>|\n\r\t]+/g, '_')
      .replace(/\s+/g, '-')
      .replace(/_+/g, '_')
      .replace(/^[.\-]+|[.\-]+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

function isContainer(node: SceneNode): boolean {
  return CONTAINER_TYPES.has(node.type);
}

/** 收集可作为「设计稿」的候选节点 */
function collectRoots(page: PageNode, includeNested: boolean): SceneNode[] {
  const roots: SceneNode[] = [];
  const walk = (parent: BaseNode & ChildrenMixin, depth: number): void => {
    for (const child of parent.children) {
      if (!isContainer(child as SceneNode)) continue;
      roots.push(child as SceneNode);
      if (includeNested && depth < 2 && 'children' in child) {
        walk(child as unknown as BaseNode & ChildrenMixin, depth + 1);
      }
    }
  };
  walk(page as unknown as BaseNode & ChildrenMixin, 0);
  return roots;
}

/**
 * 把画布选区解析成「要导出的目标」，严格遵循「选中什么导出什么」：
 *  - element 粒度（默认）：导出被点中的节点本身，哪怕它只是一个 TEXT / RECTANGLE
 *  - frame 粒度：向上找最近的容器祖先（Frame / Component / Section / Instance）
 * 注意：不依赖扫描候选列表，否则嵌在 Section 里的 Frame 会被误归到外层 Section。
 */
function resolveSelectionFrames(): FrameBrief[] {
  const seen = new Set<string>();
  const out: FrameBrief[] = [];
  for (const node of figma.currentPage.selection) {
    let target: BaseNode | null = node;
    if (granularity === 'frame') {
      while (target && !isContainer(target as SceneNode)) {
        target = target.parent;
      }
    }
    if (target && !seen.has(target.id)) {
      seen.add(target.id);
      out.push(brief(target as SceneNode));
    }
  }
  return out;
}

function brief(node: SceneNode): FrameBrief {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    path: nodePath(node),
    width: Math.round((node as any).width ?? 0),
    height: Math.round((node as any).height ?? 0),
  };
}

/**
 * 导出文件名：元素粒度下同名的叶子节点很多（一堆「标题」「背景」），
 * 用路径末两级拼成 "Header-标题" 这类名字，既可读又能大幅减少重名后缀。
 */
function exportBaseName(frame: SceneNode): { base: string; full: string } {
  const full = nodePath(frame);
  const parts = full.split('/').filter(Boolean);
  return {
    base: safeName(parts.length > 1 ? parts.slice(-2).join('-') : parts[0] || frame.name),
    full,
  };
}

async function scan(includeNestedFrames: boolean): Promise<void> {
  const isDev = figma.editorType === 'dev';
  try {
    try {
      await figma.loadAllPagesAsync();
    } catch (err) {
      // 加载失败不致命：至少还能扫当前页
      log('warn', `加载全部页面失败，将只扫描当前页：${err instanceof Error ? err.message : String(err)}`);
    }

    const pages: PageBrief[] = [];
    for (const page of figma.root.children) {
      if (page.type !== 'PAGE') continue;
      try {
        pages.push({
          id: page.id,
          name: page.name,
          frames: collectRoots(page, includeNestedFrames).map(brief),
        });
      } catch (err) {
        // 页面未加载 / 权限受限时跳过，不影响其余页面
        log('warn', `页面「${page.name}」读取失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (isDev) {
      // Dev seat 只能在 Dev Mode 跑插件，这里不需要劝用户切模式；
      // 只说明已显式加载全部页面，避免"只看到当前页"的误解
      log('info', `Dev Mode 运行（只读）：已显式加载 ${pages.length} 个页面，导出功能不受影响`);
    }
    if (!pages.some((p) => p.frames.length)) {
      log('warn', '没有扫到任何设计稿，可勾选「把嵌套 Frame 也列为设计稿」后点刷新');
    }

    post({
      type: 'SCAN_RESULT',
      pages,
      selection: resolveSelectionFrames(),
      fileName: figma.root.name || 'untitled',
    });
  } catch (err) {
    post({
      type: 'SCAN_RESULT',
      pages: [],
      selection: [],
      fileName: figma.root.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function typeSummary(manifest: ExportManifest): string {
  const counter = new Map<string, number>();
  manifest.frames.forEach((f) => counter.set(f.type, (counter.get(f.type) ?? 0) + 1));
  return Array.from(counter.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type} ×${n}`)
    .join('、');
}

function buildReadme(manifest: ExportManifest): string {
  return [
    '# Figma 设计稿节点导出产物',
    '',
    `- 文件：${manifest.fileName}`,
    `- 导出时间：${manifest.exportedAt}`,
    `- 截图倍率：${manifest.exportScale}x`,
    `- 图片格式：${manifest.imageFormat}`,
    `- 导出单元数量：${manifest.frames.length}（Frame / Component，或精确到单个元素）`,
    '',
    '## 目录结构',
    '',
    '```',
    'manifest.json           # 所有导出单元的索引',
    `screenshots/*.png        # 截图（像素尺寸 = 导出单元尺寸 × ${manifest.exportScale}）`,
    'schema/*.json           # 对应导出单元的节点树',
    `${PREVIEW_FILE_NAME}             # 可视化预览（解压后双击打开）`,
    '```',
    '',
    `本次共导出 ${manifest.frames.length} 个单元，类型分布：${typeSummary(manifest)}。`,
    '非容器单元（TEXT / RECTANGLE / INSTANCE 等）是「精确到元素」导出的：',
    '它的 rect 恒为 (0,0,w,h)，absRect 仍保留页面绝对坐标，可用于回到整屏里定位。',
    '',
    '## 坐标约定',
    '',
    '每个节点的 `rect` 是**相对于该导出单元根节点左上角**的坐标，单位为设计稿 px（未乘倍率）。',
    '渲染到截图上时：`截图像素坐标 = rect × manifest.exportScale`。',
    '`absRect` 是 Figma 页面绝对坐标，用于跨导出单元定位。',
    '',
    '## 节点字段',
    '',
    '| 字段 | 说明 |',
    '| --- | --- |',
    '| id / name / type | Figma 节点标识、名称、类型 |',
    '| path | 层级路径，如 `首页/Header/标题` |',
    '| rootType / rootPath | manifest.frames[] 中导出单元自身的类型与路径，用来消歧同名元素 |',
    '| rect | 相对设计稿的坐标与尺寸 |',
    '| fills / strokes / effects | 填充、描边、阴影（颜色为 #RRGGBBAA） |',
    '| text | TEXT 节点的文案与字体信息 |',
    '| layout | Auto Layout 方向与间距、内边距 |',
    '| component | 组件 / 实例信息，含主组件 id 与名称 |',
    '',
    '## 与 App 节点对比的建议',
    '',
    '1. 用 `path` + `type` 做粗匹配，用 `rect` 做位置与尺寸校验；',
    '2. 用 `text.characters / fontSize / color` 校验文案；',
    '3. 用 `fills[0].color` 校验背景与色块；',
    '4. 容差建议：位置 ±1px，尺寸 ±1px，颜色按通道 ±2。',
  ].join('\n');
}

async function exportFrames(options: ExportOptions): Promise<void> {
  const zip = new JSZip();
  const manifest: ExportManifest = {
    schemaVersion: SCHEMA_VERSION,
    generator: 'figma-node-schema-exporter',
    exportedAt: new Date().toISOString(),
    fileKey: figma.fileKey ?? null,
    fileName: figma.root.name || 'untitled',
    exportScale: options.scale,
    imageFormat: options.format,
    frames: [],
  };

  const usedNames = new Set<string>();
  const previewFrames: Array<{ meta: FrameMeta; schema: unknown }> = [];
  const total = options.frameIds.length;

  for (let i = 0; i < options.frameIds.length; i++) {
    const id = options.frameIds[i];
    const frame = (await figma.getNodeByIdAsync(id)) as SceneNode | null;
    if (!frame) {
      log('warn', `跳过：找不到节点 ${id}`);
      continue;
    }

    post({
      type: 'EXPORT_PROGRESS',
      current: i,
      total,
      label: `正在处理 ${frame.name}`,
    });

    // 重名保护：元素粒度下大量叶子同名（"标题""背景"），文件名已带父级前缀，仍可能撞车
    const { base: rawBase, full } = exportBaseName(frame);
    let base = rawBase;
    if (usedNames.has(base)) {
      let n = 2;
      while (usedNames.has(`${base}-${n}`)) n += 1;
      base = `${base}-${n}`;
    }
    usedNames.add(base);

    const screenshotPath = options.withScreenshot ? `${SCREENSHOT_DIR}/${base}.${options.format.toLowerCase()}` : '';

    if (options.withScreenshot) {
      try {
        const bytes = await frame.exportAsync({
          format: options.format,
          constraint: { type: 'SCALE', value: options.scale },
        });
        zip.file(screenshotPath, bytes, { compression: 'STORE' });
      } catch (err) {
        log('error', `截图失败 ${frame.name}：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 元素级导出时 frame.parent 可能是 Frame / Section，要一路找到真正的 PAGE
    let page: BaseNode | null = frame.parent;
    while (page && page.type !== 'PAGE') page = page.parent;
    const pageId = page && page.type === 'PAGE' ? page.id : '';
    const pageName = page && page.type === 'PAGE' ? page.name : '';
    const { schema, nodeCount, skipped } = serializeFrame(
      frame,
      pageId,
      pageName,
      options.scale,
      screenshotPath,
      {
        includeHidden: options.includeHidden,
        includeImageFills: options.includeImageFills,
        maxDepth: options.maxDepth,
      },
    );

    const schemaPath = `${SCHEMA_DIR}/${base}.json`;
    zip.file(schemaPath, JSON.stringify(schema, null, 2), { compression: 'DEFLATE' });

    const meta: FrameMeta = {
      id: schema.frameId,
      name: schema.frameName,
      type: schema.rootType,
      path: full,
      pageId: schema.pageId,
      pageName: schema.pageName,
      width: schema.width,
      height: schema.height,
      screenshot: screenshotPath,
      schemaFile: schemaPath,
      nodeCount,
    };
    manifest.frames.push(meta);
    previewFrames.push({ meta, schema });

    log(
      'info',
      `✓ [${schema.rootType}] ${schema.rootPath} — ${nodeCount} 个节点${skipped ? `（跳过 ${skipped} 个隐藏节点）` : ''}`,
    );
  }

  post({ type: 'EXPORT_PROGRESS', current: total, total, label: '正在打包…' });

  zip.file('manifest.json', JSON.stringify(manifest, null, 2), { compression: 'DEFLATE' });
  zip.file('README.md', buildReadme(manifest), { compression: 'DEFLATE' });

  if (options.includePreview) {
    zip.file(
      PREVIEW_FILE_NAME,
      renderPreviewHtml(JSON.stringify({ manifest, frames: previewFrames })),
      { compression: 'DEFLATE' },
    );
  }

  const data = await zip.generateAsync(
    { type: 'uint8array', compression: 'DEFLATE' },
    (meta) => {
      post({
        type: 'EXPORT_PROGRESS',
        current: total,
        total,
        label: `压缩中 ${meta.percent.toFixed(0)}%`,
      });
    },
  );

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  post({
    type: 'EXPORT_DONE',
    data,
    fileName: `${safeName(manifest.fileName)}-nodes-${stamp}.zip`,
    frameCount: manifest.frames.length,
    bytes: data.byteLength,
  });
  figma.notify(`导出完成：${manifest.frames.length} 个设计稿`);
}

/** 启动：任何一步失败都要留下痕迹，避免「点了没反应」无从排查 */
function boot(): void {
  const options: ShowUIOptions = { width: 460, height: 680, themeColors: true };
  try {
    figma.showUI(__html__, { ...options, title: '设计稿节点导出' });
  } catch (err) {
    // 旧版本 Figma 不认识 title 字段时降级
    console.log('[设计稿节点导出] showUI 降级：', err);
    figma.showUI(__html__, options);
  }
}

try {
  console.log('[设计稿节点导出] 插件已加载，editorType =', figma.editorType);
  boot();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log('[设计稿节点导出] 启动失败：', err);
  figma.notify(`插件启动失败：${message}`, { error: true });
}

figma.ui.onmessage = async (msg: UIToPluginMessage): Promise<void> => {
  try {
    switch (msg.type) {
      case 'SCAN':
        granularity = msg.granularity ?? granularity;
        await scan(msg.includeNestedFrames);
        break;
      case 'SET_GRANULARITY':
        granularity = msg.value;
        // 粒度变了，立刻按新规则重算一次选区，UI 无需等待下一次 selectionchange
        post({
          type: 'SELECTION_CHANGED',
          frames: resolveSelectionFrames(),
          rawCount: figma.currentPage.selection.length,
        });
        break;
      case 'EXPORT':
        await exportFrames(msg.options);
        break;
      case 'NOTIFY':
        figma.notify(msg.message);
        break;
      default:
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    log('error', message);
    post({ type: 'EXPORT_ERROR', message });
  }
};

/** 画布选区变化 → 通知 UI 同步勾选（默认精确导出被点中的节点本身） */
figma.on('selectionchange', () => {
  const raw = figma.currentPage.selection.length;
  post({ type: 'SELECTION_CHANGED', frames: resolveSelectionFrames(), rawCount: raw });
});

// 插件启动即扫描一次
void scan(false);
