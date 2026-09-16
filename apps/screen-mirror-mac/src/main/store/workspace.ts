/**
 * workspace 存储层。
 *
 * 设计要点（刻意选择了「单索引 + reconcile」而不是「索引 + 每需求一份 json」）：
 *
 * 1. **`index.json` 是唯一权威目录**。真实文件（schema/截图/缩略图）按需求目录落盘。
 *    双层索引（index + requirement.json）解决不了**跨文件原子性**：
 *    删需求时删了文件但索引还引用、导入中断留下孤儿目录、崩溃卡在两次写之间。
 *
 * 2. **写顺序**：先写真实文件 → 再原子重写 `index.json`。
 *    保证「索引里有的，文件一定在」。
 *    **删顺序**：先从 `index.json` 移除并原子写 → 再删目录。
 *    即使删目录那步崩了，启动时 reconcile 也能用索引兜底（至多留个孤儿目录）。
 *
 * 3. **启动时 reconcile**：丢弃「索引里有、目录已消失」的条目，并报告孤儿目录（不自动删）。
 *
 * 4. 所有改动经 `enqueue()` 串行化，杜绝并发读-改-写覆盖。
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises';

import type { RequirementMeta } from '../../types/verify';
import { readJsonSafe, writeJsonAtomic } from './atomic';
import { indexPath, requirementDir, requirementsRoot } from './paths';

const INDEX_VERSION = 1;

interface WorkspaceIndex {
  version: number;
  requirements: RequirementMeta[];
}

/** 内存缓存；首次访问时惰性加载 */
let cached: WorkspaceIndex | null = null;
/** 串行队列：所有写操作排队，避免并发读-改-写互相覆盖 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(action: () => Promise<T> | T): Promise<T> {
  const result = queue.then(action);
  queue = result.catch(() => {});
  return result as Promise<T>;
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

async function readIndex(): Promise<WorkspaceIndex> {
  if (cached) return cached;

  const raw = await readJsonSafe<WorkspaceIndex>(indexPath());
  if (raw && Array.isArray(raw.requirements)) {
    cached = { version: raw.version ?? INDEX_VERSION, requirements: raw.requirements };
  } else {
    // 首次运行，或 index.json 损坏：都退化成空库，不让应用起不来
    cached = { version: INDEX_VERSION, requirements: [] };
  }
  return cached;
}

async function persist(): Promise<void> {
  if (!cached) return;
  await writeJsonAtomic(indexPath(), cached);
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 初始化：建目录 → 加载索引 → reconcile。
 * 在 `app.whenReady()` 之后调用。
 */
export function initWorkspace(): Promise<void> {
  return enqueue(async () => {
    await mkdir(requirementsRoot(), { recursive: true });
    const index = await readIndex();

    // 索引有、目录没了 → 丢弃该条目（可能是上次删除只删了一半）
    const alive: RequirementMeta[] = [];
    let dropped = 0;
    for (const requirement of index.requirements) {
      if (await dirExists(requirementDir(requirement.id))) alive.push(requirement);
      else dropped += 1;
    }
    if (dropped > 0) {
      index.requirements = alive;
      await persist();
      console.warn(`[workspace] reconcile：丢弃 ${dropped} 个目录已消失的需求条目`);
    }

    // 目录有、索引没有 → 只报告，不自动删（可能是用户手动放进去的，删了不可逆）
    const keep = new Set(index.requirements.map((r) => r.id));
    const entries = await readdir(requirementsRoot(), { withFileTypes: true }).catch(() => []);
    const orphans = entries.filter((e) => e.isDirectory() && !keep.has(e.name)).map((e) => e.name);
    if (orphans.length > 0) {
      console.warn(`[workspace] 发现 ${orphans.length} 个孤儿目录（未索引，已保留）：${orphans.join(', ')}`);
    }
  });
}

/** 需求列表，按最近更新倒序 */
export function listRequirements(): Promise<RequirementMeta[]> {
  return enqueue(async () => {
    const index = await readIndex();
    return [...index.requirements].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
}

export function getRequirement(id: string): Promise<RequirementMeta | null> {
  return enqueue(async () => {
    const index = await readIndex();
    return index.requirements.find((r) => r.id === id) ?? null;
  });
}

export function createRequirement(input: { name: string; description?: string }): Promise<RequirementMeta> {
  return enqueue(async () => {
    const index = await readIndex();
    const timestamp = nowIso();
    const requirement: RequirementMeta = {
      id: newId(),
      name: input.name.trim() || '未命名需求',
      description: input.description?.trim() || undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
      designAssets: [],
      appSnapshots: [],
      pairs: [],
      issues: [],
    };

    await mkdir(requirementDir(requirement.id), { recursive: true });
    index.requirements.push(requirement);
    await persist();
    return requirement;
  });
}

/**
 * 删除需求：**先改索引并落盘，再删目录**。
 * 反过来的话，若删完目录还没改索引就崩溃，会留下指向不存在目录的索引条目
 * （虽然 reconcile 能兜住，但会多一次无谓的修复）。
 */
export function deleteRequirement(id: string): Promise<void> {
  return enqueue(async () => {
    const index = await readIndex();
    const before = index.requirements.length;
    index.requirements = index.requirements.filter((r) => r.id !== id);
    if (index.requirements.length === before) return;

    await persist();
    await rm(requirementDir(id), { recursive: true, force: true });
  });
}

/**
 * 在串行队列内对某个需求做「读-改-写」。
 * 所有涉及需求内容的改动（导入资产、建配对、存问题）都必须走这里，
 * 否则并发导入会互相覆盖。
 *
 * 返回 `mutator` 的返回值；需求不存在时抛错。
 */
export function mutateRequirement<T>(
  id: string,
  mutator: (requirement: RequirementMeta) => T | Promise<T>,
): Promise<T> {
  return enqueue(async () => {
    const index = await readIndex();
    const requirement = index.requirements.find((r) => r.id === id);
    if (!requirement) throw new Error(`需求不存在：${id}`);

    const result = await mutator(requirement);
    requirement.updatedAt = nowIso();
    await persist();
    return result;
  });
}

/** 生成新 id（供各业务模块统一使用） */
export function createId(): string {
  return newId();
}

/** 当前 ISO 时间戳 */
export function timestamp(): string {
  return nowIso();
}
