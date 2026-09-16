import React, { useMemo } from 'react';

import { buildNodeTree, type RenderNode, type RenderTree, type VerifySource } from '@shared/verify';

import type { PickPoint } from '../lib/selection';

interface NodeCanvasProps {
  source: VerifySource;
  /** 设计稿 / 截图的原始宽高（逻辑像素，1:1 渲染，缩放交给 CanvasViewport） */
  width: number;
  height: number;
  /**
   * R4 对齐系数：作用在本帧内容上的等比缩放（设计稿帧恒为 1，截图帧取
   * `widthAlignScale(设计宽, 截图宽)`）。见 `@shared/verify.widthAlignScale`。
   */
  alignScale?: number;
  /**
   * 该帧是否已有真实底图。
   *
   * ⚠️ 有图时本组件**不渲染任何图片元素** —— 底图与像素格已搬到屏幕空间
   * （`FrameRaster`），挂在这里会跟着祖先 `transform: scale()` 一起被合成器
   * 拉伸，放大后必然发糊。这里只用它决定要不要画占位块。
   */
  hasImage: boolean;
  imageLabel: string;
  nodes: RenderNode[];
  /** 当前选中的节点 id。选中的描边在屏幕空间（`FrameRaster`），这里只用来标出选中态 */
  selectedId: string | null;
  /**
   * 当前 hover 的节点 id。**由调用方（CanvasBoard）按 `planCanvasHover` 算好后传进来**，
   * 不是浏览器的原始命中 —— 环画在「下一击会选中的那个」上（见 lib/selection）。
   * 本层只拿它给类型角标用（`.hovered`），不自己解析层级。
   */
  hoveredId: string | null;
  /**
   * 点击一个节点。第二 / 第三个参数是**屏幕坐标的落点**与**是否按住 ⌘/Ctrl**：
   * 调用方要靠它们判断「原地再点 = 上移一层」与「跳到整帧」（见 lib/selection）。
   */
  onSelect: (node: RenderNode, point: PickPoint, outermost: boolean) => void;
  /**
   * 光标下的**最深命中节点**（原始命中，未经任何解析）；移出帧范围时给 null。
   *
   * 这一层**只报告命中，不决定该高亮谁**：高亮的层级要按「下一击会选中的那个」推出来
   * （`planCanvasHover`），而那需要选中态与点过的痕迹，两者都不住在这一层。
   * 所以落点与 ⌘/Ctrl 也要一起交出去 —— 判「原地再点」与「跳到整帧」缺一不可。
   * `node` 为 null 时后两个参数无意义（调用方直接清空 hover）。
   */
  onHover: (node: RenderNode | null, point?: PickPoint, outermost?: boolean) => void;
  /**
   * 点到帧内空白处（没落在任何节点上）。全局只有一份选中，所以在哪一侧点空白
   * 都是同一件事：清空。
   */
  onClearSelection: () => void;
}

interface NodeLayerProps {
  node: RenderNode;
  tree: RenderTree;
  /** 父节点在 frame 内的绝对坐标；子节点用「自身 rect − 父 rect」定位 */
  parentX: number;
  parentY: number;
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (node: RenderNode, point: PickPoint, outermost: boolean) => void;
}

/**
 * 单个节点（含其子树）。
 *
 * 三个对齐「所见即所得」的细节，缺一个就会出现「看着像、点起来不对」：
 *  1. **命中闸门看 `hittable`**（见 `RenderNode.hittable`）：画得出像素的节点自不必说，
 *     **画不出像素的「容器」也参与命中** —— 布局 Frame / Group 的盒本身就是结构，
 *     指针落进去就该选中它。真正被挡在外面的只有两类：`visible: false` 的隐藏图层，
 *     以及**填充被显式隐藏**的图层（它在画面上一片空白，放进来只会变成看不见的靶子
 *     抢走真元素的 hover）。⚠️ 别再改回 `hasFill` —— 那会把无填充 Frame 一起挡掉。
 *  2. `clipped === true` → 虚线淡化。该节点在最近的 clipsContent 祖先外，已被裁掉。
 *  3. `clipsContent` → `overflow: hidden`。父容器开了裁剪，溢出部分既看不见也点不中
 *     （浏览器对 `overflow: hidden` 的命中测试同样是裁掉的，不必另写逻辑）。
 *
 * ⚠️ 2、3 合起来还决定了**一个节点能不能被直接点到**：嵌套 DOM 里父盒画在子盒下面，
 * 于是父级只剩「子级没盖住的空隙」可点 —— 这正是「无填充的 Frame 现在能点到、但指在
 * 它的子节点上仍然点到子节点」的原因（后者是「点哪选哪」的应有之义，不是缺陷）。
 * 想选到被盖住的父级走 `lib/selection` 的规则（单击选命中本身、原地再点上移一层、
 * ⌘/Ctrl 跳到整帧）；**hover 与单击走的是同一个判定**（`planCanvasHover`），
 * 所以「环所在的层级」恒等于「下一击会选中的层级」。
 * 这里只负责如实报告「点到了谁、点在屏幕的哪里、按没按 ⌘」。
 *
 * ⚠️ hover **不在这里画描边**：本层活在 `transform: scale()` 内部，线宽要写成 1/zoom，
 * zoom 大时几乎画不出来（zoom = 16 时是 0.0625px）。hover 环与选中框同住屏幕空间的
 * `FrameRaster`。这里只留 `data-node-id`，供调用方把原始命中反查成节点。
 *
 * 另外：children 在导出里就是 **back-to-front**（0 最底层），
 * 因此**按数组顺序渲染即可**，不要排序；绝对定位元素按 DOM 顺序叠放。
 */
const NodeLayer: React.FC<NodeLayerProps> = ({
  node,
  tree,
  parentX,
  parentY,
  selectedId,
  hoveredId,
  onSelect,
}) => {
  const children = tree.childrenOf.get(node.id) ?? [];
  const left = node.rect.x - parentX;
  const top = node.rect.y - parentY;
  const selected = node.id === selectedId;

  const className = [
    'node-overlay',
    node.kind,
    selected ? 'selected' : '',
    node.id === hoveredId ? 'hovered' : '',
    node.clipped ? 'clipped' : '',
    node.visible ? '' : 'invisible',
    node.hasFill ? '' : 'no-fill',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      data-source={node.source}
      data-node-id={node.id}
      style={{
        left,
        top,
        width: node.rect.width,
        height: node.rect.height,
        overflow: node.clipsContent ? 'hidden' : undefined,
        // 命中闸门。判据是 `hittable`（画不出像素的容器照样参与），**不是** `hasFill` ——
        // 两者在「零像素容器」上结论相反，而那正是要点到的那些图层。见 RenderNode.hittable。
        pointerEvents: node.hittable ? undefined : 'none',
      }}
      title={node.label}
      onClick={(event) => {
        event.stopPropagation();
        // 只把「点到了谁」和「点在屏幕什么位置」交出去。
        // 层级链**不靠 DOM 冒泡**收集：这里 stopPropagation 掐断了冒泡，而且
        // 嵌套顺序只说明「谁画在上面」，与「谁是父级」是两回事 ——
        // 调用方按 parentId 走链，语义才唯一（见 lib/selection.ancestorChain）。
        onSelect(
          node,
          { x: event.clientX, y: event.clientY },
          event.metaKey || event.ctrlKey,
        );
      }}
    >
      {children.map((child) => (
        <NodeLayer
          key={child.id}
          node={child}
          tree={tree}
          parentX={node.rect.x}
          parentY={node.rect.y}
          selectedId={selectedId}
          hoveredId={hoveredId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
};

/**
 * 单个画布帧：底层截图，上层用 DOM 绝对定位绘制节点。
 *
 * 缩放与平移统一由外层 CanvasViewport 的整层 `transform: translate + scale` 负责
 * （GPU 复合，与节点数无关）；节点边框通过祖先 `--iz`(=1/zoom) 反向补偿，缩放后仍是 1px 实线。
 *
 * 对外还有一个**帧内对齐缩放** `alignScale`（R4）：设计稿与截图逻辑尺寸不一致时，
 * 截图帧整体等比缩放去对齐设计稿宽度。它作用在 `.frame-content` 上而不是 `.frame-stage` 上：
 *  - `.frame-stage` 用**显示后**的尺寸做布局盒 → 两帧并排时视觉宽度与布局宽度一致，
 *    不会出现「看着一样宽、实际留了 15px 缝」；
 *  - `.frame-content` 保持帧自身的逻辑坐标空间 → 节点 rect 一个都不用改。
 * 边框补偿要多算一层：屏幕上最终放大倍数是 `zoom × alignScale`，故给内容层补
 * `--izs`(=1/alignScale)，配合 `--iz` 一起在 CSS 里相乘。
 *
 * 底图、像素格、**选中框与 hover 环**都不在本组件里：它们由 `FrameRaster` 在屏幕空间
 * 按最终尺寸绘制。原因见那个文件顶部的注释 —— 挂在 transform 层内的内容一律会被合成器
 * 拉伸：`image-rendering: pixelated` 救不回放大的像素边界，`1/zoom` 的细线也画不出来
 * （zoom = 16 时本地线宽只有 0.0625px）。本层只保留节点自身：**命中测试**与
 * `data-node-id`，并给 `.frame-content` 打上 `data-frame`，供 `FrameRaster` 测量本帧的世界坐标。
 */
const NodeCanvas: React.FC<NodeCanvasProps> = ({
  source,
  width,
  height,
  alignScale = 1,
  hasImage,
  imageLabel,
  nodes,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
  onClearSelection,
}) => {
  // 扁平节点表 → 父子树：只有嵌套 DOM 才能让 clipsContent 的 overflow 真正生效
  const tree = useMemo(() => buildNodeTree(nodes), [nodes]);
  /** 原始命中（DOM 上的 data-node-id）反查成节点，交给调用方 */
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const scale = Number.isFinite(alignScale) && alignScale > 0 ? alignScale : 1;
  const displayWidth = width * scale;
  const displayHeight = height * scale;

  const contentStyle: React.CSSProperties = {
    width,
    height,
    transform: scale === 1 ? undefined : `scale(${scale})`,
    transformOrigin: '0 0',
    ['--izs' as string]: String(1 / scale),
  };

  /**
   * 光标落在哪个节点上。
   *
   * 挂在 `.frame-stage` 而不是 `.nodes-layer`：后者是 `pointer-events: none`，
   * 光标落在节点之间的空隙时事件根本不到它那儿，hover 环会留在上一个节点上不动。
   * 这里用 `closest('[data-node-id]')` 而不是 `event.target.dataset` ——
   * 节点是嵌套 DOM，target 已是最深的**可命中**元素，但显式向上找更稳
   * （将来若在节点内部塞装饰元素，不必再改这里）。
   */
  const handleHoverMove = (event: React.MouseEvent<HTMLDivElement>): void => {
    const host = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-node-id]');
    const id = host?.dataset.nodeId;
    const node = id ? (byId.get(id) ?? null) : null;
    if (!node) {
      onHover(null);
      return;
    }
    // 与 onSelect 交出去的东西**完全一致**（命中 + 落点 + ⌘/Ctrl）：hover 与单击要喂给
    // 同一个判定，缺一个就会各自算出不同的答案 —— 那正是「环画在 A、点下去选中 B」。
    onHover(node, { x: event.clientX, y: event.clientY }, event.metaKey || event.ctrlKey);
  };

  return (
    <div className="frame" data-role={source}>
      <div className="frame-label">
        <span className={`dot ${source === 'design' ? 'design-dot' : 'app-dot'}`} />
        <span>{source === 'design' ? '设计稿' : '截图'}</span>
        <span className="dim">
          {width}×{height}
        </span>
        {scale !== 1 && <span className="dim">按宽缩放 {scale.toFixed(3)}×</span>}
        <span className="dim">{nodes.length} 节点</span>
      </div>

      <div
        className="frame-stage"
        style={{ width: displayWidth, height: displayHeight }}
        onMouseMove={handleHoverMove}
        onMouseLeave={() => onHover(null)}
        onClick={(event) => {
          // 点击空白（非节点）取消选中；节点自身 stopPropagation
          if (event.target === event.currentTarget) onClearSelection();
        }}
      >
        <div className="frame-content" style={contentStyle} data-frame={source}>
          {!hasImage && <div className="mock-image" data-placeholder={imageLabel} />}

          <div className="nodes-layer">
            {tree.roots.map((node) => (
              <NodeLayer
                key={node.id}
                node={node}
                tree={tree}
                parentX={0}
                parentY={0}
                selectedId={selectedId}
                hoveredId={hoveredId}
                onSelect={onSelect}
              />
            ))}
            {/* 选中框与 hover 环**都不在这里** —— 它们在屏幕空间的 FrameRaster 里。
                本层活在 transform 层内部，画不出稳定的 1px 线。 */}
          </div>
        </div>
      </div>
    </div>
  );
};

export default NodeCanvas;
