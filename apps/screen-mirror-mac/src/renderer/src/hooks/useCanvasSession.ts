import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * 画布**配对会话**：把画布上的人工操作（选中 / 聚焦 / 标注 / 取景 / 工具）按配对存起来，
 * 而不是跟着某个组件实例的生死。
 *
 * ## 要解决的问题
 *
 * 「画布验收」这一屏是个**条件渲染**的子页面：切到「页面匹配」时 `CanvasBoard` 整体卸载，
 * 切回左侧另一个配对时又用 `key` 重建（那是刻意的，见 CanvasBoard 顶部）。两条路径都会
 * 把 `useState` 抹掉，于是「在设计稿上选中一个节点、在截图侧选中对应节点、标了几处差异、
 * 把视口摆到位」这一串动作，只要离开一次这一屏就全没了 —— 而它们恰恰是**核对一页**
 * 这件事的全部上下文，重进一次就得从头再点一遍。
 *
 * 所以这些状态的主语是**配对**，不是组件实例：配对还在、两侧素材没换，操作就该原样回来。
 *
 * ## 什么时候该丢
 *
 * 两侧素材的**内容指纹**（`signature`）一变就**整体作废**：换了设计稿、换了截图，
 * 或者同一帧被「覆盖」重新导入过 —— 画布上的节点表已经是另一份数据了，指着旧节点的
 * 框、旧坐标的取景不但没用，还会误导（用户的原话是「当当前匹配项中的设计稿或者
 * app 截图替换匹配的时候，再重置最初状态」）。
 *
 * 组件侧靠**把签名并进 React key** 来配合（`canvasSessionKey`）：素材一换就重建，
 * 重建时第一次读会话发现签名对不上，条目被就地重置，于是所有字段回到初始值。
 *
 * ## 为什么是模块级 Map 而不是提到父组件的 state
 *
 * 提 state 要把十几个字段全部改成受控 props、调用点几十处；而这里的用法很窄 ——
 * **读只发生在挂载时的惰性初始化里，写只发生在字段变化时**，都贴着字段的声明。
 * 代价是这份状态不在 React 树里，所以**不拿它做渲染期的派生计算**（`value` 始终来自
 * `useState`）：外面这份只是「复活用」的存档，不会出现两份状态互相矛盾。
 */
export interface CanvasScope {
  pairId: string;
  /** 两侧素材的内容指纹（`canvasMaterialSignature`）。变了 = 素材被换过 = 上一条会话作废 */
  signature: string;
}

/**
 * 「这一对的两侧素材」的内容指纹。
 *
 * 除了两侧 id，还带上**素材各自的写入时间**。只认 id 是不够的：插件直传选「覆盖」时
 * `figmaImport` **会复用原 id、只换内容**（`const assetId = existing?.id ?? createId()`），
 * 于是「重新导出的同一帧」在 id 上看起来一模一样 —— 而它的 schema 可能整棵都变了，
 * 画布上指着旧节点的选中态、旧坐标的取景留下来只会误导。
 *
 * 缺时间戳（素材不在表里 / 老数据）按空串算：签名退化成「只看 id」，与加这一维之前一致。
 */
export function canvasMaterialSignature(input: {
  designAssetId: string;
  designImportedAt?: string | undefined;
  appSnapshotId: string;
  appCapturedAt?: string | undefined;
}): string {
  return [
    input.designAssetId,
    input.designImportedAt ?? '',
    input.appSnapshotId,
    input.appCapturedAt ?? '',
  ].join('|');
}

/** 组装会话键。收成一个函数只为「键只有一种造法」，别在调用点各拼各的 */
export function canvasScopeOf(pairId: string, signature: string): CanvasScope {
  return { pairId, signature };
}

/**
 * 传给 `CanvasBoard` 的 React `key`。
 *
 * **素材指纹进 key** 是「替换素材 = 重置」这条规则的落地点：key 一变组件就重建，
 * 重建时第一条读会话发现签名对不上，条目被就地作废，所有字段回到初始值。
 * 用同一个函数生成，免得 key 里少了一维而会话签名有 —— 那种偏差会让「换了素材
 * 却保留了旧状态」，而且只看代码很难发现。
 */
export function canvasSessionKey(pairId: string, signature: string): string {
  return `${pairId}::${signature}`;
}

/** 视口取景（`view` 字段）的类型由 CanvasViewport 定义并在变化时上报，这里只是存下来 */

interface CanvasSession {
  signature: string;
  fields: Map<string, unknown>;
}

/** pairId → 会话。键只认 pairId（配对 id 是 uuid，跨需求不会撞），签名另存在条目里 */
const sessions = new Map<string, CanvasSession>();

/**
 * 取出该配对当前的会话条目；签名对不上（素材被换过）就**整条重建**。
 *
 * 重建而不是「逐字段清」：素材一换，画布上的节点 id 空间全变了，任何残留字段都是脏的，
 * 没有哪一个值得留下来。
 */
function entryFor(scope: CanvasScope): CanvasSession {
  const existing = sessions.get(scope.pairId);
  if (existing && existing.signature === scope.signature) return existing;

  const fresh: CanvasSession = { signature: scope.signature, fields: new Map() };
  sessions.set(scope.pairId, fresh);
  return fresh;
}

/**
 * 读一个字段（挂载时读一次）。没有存过就用 `fallback`。
 *
 * ⚠️ 第一次读会**顺带开条目**（可能触发上面那次重建），所以必须在同一轮里先读后写 ——
 *    组件的写法天然满足：`useCanvasField` 的惰性初始化先跑，setter 之后才可能被调用。
 */
export function readCanvasField<T>(scope: CanvasScope, field: string, fallback: T): T {
  const entry = entryFor(scope);
  return entry.fields.has(field) ? (entry.fields.get(field) as T) : fallback;
}

/**
 * 写一个字段。
 *
 * ⚠️ **签名对不上就丢掉这一笔**（而不是顺手开一条新会话）：
 *  - 条目不存在 → 说明还没人读过（`useCanvasField` 的惰性初始化一定先读），
 *    凭空开一条只会让后来读到一份半截的会话；
 *  - 条目存在但签名不同 → 它已经属于另一轮（两侧素材被换过），旧组件迟到的写入
 *    绝不能落到新一轮里 —— 那会表现成「素材换了、画布却停在旧位置」。
 *
 * 活着的组件写不丢：它的第一条 `readCanvasField` 已经把条目开好了。
 */
export function writeCanvasField<T>(scope: CanvasScope, field: string, value: T): void {
  const entry = sessions.get(scope.pairId);
  if (!entry || entry.signature !== scope.signature) return;
  entry.fields.set(field, value);
}

/** 配对被删除时清掉它的会话，别留着内存垃圾 */
export function dropCanvasSession(pairId: string): void {
  sessions.delete(pairId);
}

/**
 * 一个跟着配对走的 `useState`。
 *
 * 用法就是把画布里那些「人工操作」的 state 声明换掉，**调用点一行都不用改** ——
 * setter 的签名与 `useState` 完全一致（含函数式更新），所以几十个调用点原地不动。
 */
export function useCanvasField<T>(
  scope: CanvasScope,
  field: string,
  fallback: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readCanvasField(scope, field, fallback));

  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      setValue((current) => {
        const resolved =
          typeof next === 'function' ? (next as (previous: T) => T)(current) : next;
        // ⚠️ 写入放在 updater 里而不是外面：函数式更新（`prev => …`）也要拿「最新值」
        //    才能算出该存什么，而最新值只有 updater 拿得到。
        //    StrictMode 下 updater 会被调用两次 —— 同一个值写两遍是幂等的，不会写坏。
        writeCanvasField(scope, field, resolved);
        return resolved;
      });
    },
    [field, scope],
  );

  return [value, set];
}
