/**
 * 画布键位提示 —— **文案的唯一来源**。
 *
 * 为什么要把这些字句收进一个模块：它们原先散在两个地方（`NodeInfoPanel` 的
 * `GESTURE_HINT` 与它空状态里的第二行）。2026-09-22 把「选整帧」从 ⌘ 换成 ⌥、
 * 把 ⌘ 让给「固定间距」之后，**空状态那一行没跟着改** ——
 * 面板上同时挂着两种说法，而用户按下去得到的是第三种。
 * 现在底部提示条（`CanvasHintBar`）与面板都从这里取，改键位只改这一份。
 *
 * ⚠️ 这里只是**文案**。行为实现在 `CanvasBoard#handleCanvasPick` 与那个 window
 *    keydown 里，两者必须一起动 —— 冒烟有守卫：提示里承诺的每个修饰键，
 *    都要能在实现里找到对应分支。
 *
 * ⚠️ 2026-09-28 按用户要求砍掉三套交互：**⌥ 选整帧**、**Enter 进子节点**、
 *    **右键图层菜单**。浏览态因此从 6 条缩到 4 条。删的时候**实现要一起删**
 *    （`lib/selection` 的 `alt` / `descendInto` / `layersAtPoint`）——
 *    只删文案会留下一堆按下去没反应的键，那比不写提示更糟。
 */

/**
 * 修饰键显示名。Mac 是 ⌘、Windows / Linux 是 Ctrl。
 *
 * 判据只有一处：`lib/selection.ts#modsOf`（`metaKey || ctrlKey` → meta）。
 * 提示里写成 `⌘/Ctrl` 而不是按平台二选一，是因为提示条要能同时被两种平台的
 * 使用者看懂，而多打三个字符的代价远小于「以为 Mac 专属、Windows 上不敢按」。
 */
export const META_LABEL = '⌘/Ctrl';

export interface CanvasHint {
  /** 键位 / 鼠标动作，按顺序渲染成芯片 */
  keys: string[];
  /** 这一步做什么（提示条上的正文，尽量短） */
  label: string;
  /** 悬停时的完整说明 —— 提示条要能一眼扫完，细节放 title */
  detail?: string;
}

/** 画布有两种含义完全不同的状态，键位也不同（见 CanvasBoard 的标注分支） */
export type CanvasHintMode = 'browse' | 'annotate' | 'overlay';

/**
 * 浏览态：默认的那一套。**四条**（2026-09-28 砍掉 ⌥ 整帧与右键菜单之后）。
 *
 * 顺序 = 上手顺序：先选（单击 / 原地再点），再是 ⌘ 的两个用法（本侧固定间距、
 * 对侧补选对比），最后 Esc 退层。**不列滚轮缩放 / 拖拽平移** —— 那两条是画布的
 * 通用预期，占位只会把真正需要被发现的 ⌘ 挤出去。
 *
 * ⚠️ 曾经还有两条（⌥ 选整帧、右键图层菜单）与 Enter 下钻，均已按用户要求移除。
 *    别再「顺手加回来」—— 用户砍的是整套交互的复杂度，不是嫌这三个键不好用。
 *    「一步到最外层」现在只能靠**原地再点**逐层退，或走**图层面板**。
 */
export const BROWSE_HINTS: CanvasHint[] = [
  {
    keys: ['单击'],
    label: '选中 · 再点上移',
    detail: '单击选指针底下那一层；在同一处再点一次，往父级上移一层（hover 环 = 下一击会选中谁）',
  },
  {
    keys: [META_LABEL, '单击'],
    label: '固定间距',
    detail:
      '在本侧已选中一个元素时，⌘ 单击另一个元素把间距读数钉住（光标划过别的元素不会顶掉）；' +
      '再 ⌘ 点一次取消。设计稿与截图两侧可以各钉一个，读数同时显示。',
  },
  {
    keys: [META_LABEL, '点另一侧'],
    label: '两侧对比',
    detail:
      '本侧还没选中、对侧已经选中时，⌘ 点另一侧的节点 = 把这一侧也选上，' +
      '右栏立刻切成「设计稿 ↔ App」字段对照表。这就是跨两侧比元素的入口。',
  },
  {
    keys: ['Esc'],
    label: '上移 / 清空',
    detail:
      '往父级退一层（不用瞄准的「原地再点」）；已经是这一帧最外层时再按一次，' +
      '清掉**这一侧**的选中（另一侧不动）。',
  },
];

/**
 * 标注态：这一击的含义整个换了（不是选中，而是把节点加进待配对组），
 * 所以提示条必须跟着换 —— 挂着浏览态的键位等于教用户按错。
 *
 * ⚠️ 这里的 Enter（提交为配对）**不在** 2026-09-28 那次删除范围内：
 *    用户砍的是「Enter 进入子节点」，而标注态的 Enter 是提交标注，两回事。
 */
export const ANNOTATE_HINTS: CanvasHint[] = [
  { keys: ['单击'], label: '加入待配对组', detail: '设计稿与截图两边各点，凑成一组' },
  { keys: ['Enter'], label: '提交为配对', detail: '把待配对组提交成一条人工标注' },
  { keys: ['Esc'], label: '清空待配对组', detail: '撤掉当前这一组，重新点' },
];

export function hintsFor(mode: CanvasHintMode): CanvasHint[] {
  return mode === 'overlay' ? OVERLAY_HINTS : mode === 'annotate' ? ANNOTATE_HINTS : BROWSE_HINTS;
}

export const OVERLAY_HINTS: CanvasHint[] = [
  { keys: ['截图内拖拽'], label: '移动截图', detail: '从截图内开始拖拽只移动截图，设计稿固定；画布单击不选择元素。' },
  { keys: ['截图外拖拽'], label: '平移画布', detail: '从截图外开始拖拽，同时移动设计稿与截图，保持叠图对齐位置。' },
  { keys: ['↑', '↓', '←', '→'], label: '微调截图', detail: '方向键移动 1 个画布单位，按住 Shift 移动 10 个。' },
];

/**
 * 信息面板首屏那一行（`NodeInfoPanel`）。
 *
 * 它与底部提示条是**同一件事的两种篇幅**：提示条常驻在画布底下、承担「有哪些键」，
 * 面板这一行只回答「面板里换不了节点，那要怎么换」。两处各写一份正是 09-22 那次
 * 漂移的成因，所以它们必须在同一个文件里。
 */
export const GESTURE_HINT =
  '单击选指针底下那个 · 原地再点上移一层 · ⌘/Ctrl 点另一个元素固定间距（再点一次取消）· Esc 上移一层 —— 完整键位见画布底部';
