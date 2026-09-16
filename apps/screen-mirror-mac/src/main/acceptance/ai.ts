/**
 * AI 仲裁客户端。
 *
 * PLAN 对 AI 的定位是**仲裁者**，不是主力：规则引擎负责全部匹配与门禁，
 * AI 只在「规则判歧义 / 需要复杂视觉判断」时进来看 Top-K 候选。
 * 因此这里有三条硬约束：
 *
 * 1. **只能引用输入里存在的节点 ID**。AI 幻觉出来的 id 一律导致整个响应被拒，
 *    而不是「过滤掉这一条继续用」—— 半信半疑地采信比不采信更危险。
 * 2. **不允许创建节点**。AI 无法凭空产生 design/app 节点，所以校验层只认
 *    请求里出现过的 id 集合。
 * 3. **未配置即优雅降级**。没有 endpoint/key 时返回 null，验收照常按规则跑完，
 *    只是结论停留在 review（因为必检项里出现了 unknown），不会假装通过。
 *
 * 配置来源（后者覆盖前者）：
 *   - `<workspace>/reports/../acceptance-ai.json`（0600，不进普通需求索引）
 *   - 环境变量 `SM_ACCEPTANCE_AI_ENDPOINT` / `SM_ACCEPTANCE_AI_KEY` / `SM_ACCEPTANCE_AI_MODEL`
 *
 * 兼容 OpenAI Chat Completions 协议，因此任何同协议的网关都能直接用。
 */

import { readJsonSafe } from '../store/atomic';
import { acceptanceAiConfigPath } from '../store/paths';
import type { AiAcceptanceRequest, AiAcceptanceResponse, AiMatchCandidate } from '../../types/aiAcceptance';

export interface AiConfig {
  /** 基础地址，如 `https://api.openai.com/v1`（末尾斜杠会被去掉） */
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** 允许的匹配关系（与 NodeMatch.relation 对齐，另加 group 表示集合对集合） */
const ALLOWED_RELATIONS = new Set([
  'one_to_one',
  'one_to_many',
  'many_to_one',
  'group',
  'missing',
  'extra',
  'ambiguous',
  'ignored',
]);

const ALLOWED_OBSERVATION_TYPES = new Set([
  'missing',
  'extra',
  'layout-difference',
  'visual-difference',
  'unknown',
]);

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * 合并「文件配置 / 环境变量」成一份可用配置。
 * 抽成纯函数是为了能直接测「env 覆盖文件」「缺 key 视为未配置」这些分支。
 */
export function resolveAiConfig(
  env: Record<string, string | undefined>,
  fileConfig: Partial<AiConfig> | null | undefined,
): AiConfig | null {
  const endpoint = nonEmpty(env.SM_ACCEPTANCE_AI_ENDPOINT) ?? nonEmpty(fileConfig?.endpoint);
  const apiKey = nonEmpty(env.SM_ACCEPTANCE_AI_KEY) ?? nonEmpty(fileConfig?.apiKey);
  const model = nonEmpty(env.SM_ACCEPTANCE_AI_MODEL) ?? nonEmpty(fileConfig?.model);
  // endpoint 与 key 缺一不可：只有 endpoint 会在每次运行时换回一个 401，
  // 不如直接判定「未配置」，让结论老实停在 review。
  if (!endpoint || !apiKey) return null;

  const timeout = Number(env.SM_ACCEPTANCE_AI_TIMEOUT_MS ?? fileConfig?.timeoutMs);
  return {
    endpoint: trimTrailingSlash(endpoint),
    apiKey,
    model: model ?? 'gpt-4o-mini',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

/** 读盘 + 合并。读不到文件不报错，直接按「无文件配置」处理。 */
export async function loadAiConfig(env: Record<string, string | undefined> = process.env): Promise<AiConfig | null> {
  const fileConfig = await readJsonSafe<Partial<AiConfig>>(acceptanceAiConfigPath());
  return resolveAiConfig(env, fileConfig);
}

/**
 * 校验并归一化 AI 响应。**纯函数**，测试直接喂构造数据。
 *
 * `allowedDesignIds` / `allowedAppIds` 是请求中实际出现过的 id 全集；
 * 任何越界引用都抛错 —— 这是 PLAN「AI 返回不存在的节点 ID 时拒绝结果」的落点。
 */
export function validateAiResponse(
  value: unknown,
  allowedDesignIds: ReadonlySet<string>,
  allowedAppIds: ReadonlySet<string>,
): AiAcceptanceResponse {
  if (!value || typeof value !== 'object') throw new Error('AI 响应不是对象');
  const raw = value as { candidates?: unknown; observations?: unknown };

  if (raw.candidates !== undefined && !Array.isArray(raw.candidates)) throw new Error('AI 响应的 candidates 不是数组');
  if (raw.observations !== undefined && !Array.isArray(raw.observations)) throw new Error('AI 响应的 observations 不是数组');

  const candidates: AiMatchCandidate[] = [];
  for (const entry of (raw.candidates ?? []) as unknown[]) {
    if (!entry || typeof entry !== 'object') throw new Error('AI candidate 不是对象');
    const item = entry as Record<string, unknown>;
    const designNodeId = nonEmpty(item.designNodeId);
    if (!designNodeId) throw new Error('AI candidate 缺少 designNodeId');
    if (!allowedDesignIds.has(designNodeId)) {
      throw new Error(`AI 引用了不存在的设计稿节点：${designNodeId}`);
    }
    if (!Array.isArray(item.appNodeIds)) throw new Error('AI candidate 的 appNodeIds 不是数组');
    const appNodeIds: string[] = [];
    for (const id of item.appNodeIds as unknown[]) {
      const appId = nonEmpty(id);
      if (!appId) throw new Error('AI candidate 的 appNodeIds 含空值');
      if (!allowedAppIds.has(appId)) throw new Error(`AI 引用了不存在的 App 节点：${appId}`);
      appNodeIds.push(appId);
    }
    const relation = nonEmpty(item.relation) ?? 'one_to_one';
    if (!ALLOWED_RELATIONS.has(relation)) throw new Error(`AI candidate 的 relation 非法：${relation}`);
    const probability = Number(item.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error('AI candidate 的 probability 必须在 0..1');
    }
    const reasonCodes = Array.isArray(item.reasonCodes)
      ? (item.reasonCodes as unknown[]).map((code) => String(code)).slice(0, 12)
      : [];
    candidates.push({ designNodeId, appNodeIds, relation, probability, reasonCodes });
  }

  const observations: AiAcceptanceResponse['observations'] = [];
  for (const entry of (raw.observations ?? []) as unknown[]) {
    if (!entry || typeof entry !== 'object') throw new Error('AI observation 不是对象');
    const item = entry as Record<string, unknown>;
    const type = nonEmpty(item.type);
    if (!type || !ALLOWED_OBSERVATION_TYPES.has(type)) {
      throw new Error(`AI observation 的 type 非法：${String(item.type)}`);
    }
    const designNodeIds = Array.isArray(item.designNodeIds) ? (item.designNodeIds as unknown[]) : [];
    const appNodeIds = Array.isArray(item.appNodeIds) ? (item.appNodeIds as unknown[]) : [];
    for (const id of designNodeIds) {
      if (!allowedDesignIds.has(String(id))) throw new Error(`AI observation 引用了不存在的设计稿节点：${String(id)}`);
    }
    for (const id of appNodeIds) {
      if (!allowedAppIds.has(String(id))) throw new Error(`AI observation 引用了不存在的 App 节点：${String(id)}`);
    }
    const evidence = Array.isArray(item.evidence) ? (item.evidence as unknown[]).map((text) => String(text)).slice(0, 12) : [];
    observations.push({
      type: type as AiAcceptanceResponse['observations'][number]['type'],
      designNodeIds: designNodeIds.map(String),
      appNodeIds: appNodeIds.map(String),
      evidence,
    });
  }

  return { candidates, observations };
}

const SYSTEM_PROMPT = [
  'You arbitrate UI-verification node matches between a Figma design tree and an Android native view tree.',
  'You are given the candidate matches produced by a deterministic rule engine. Each candidate carries a design node id and a ranked list of app node ids.',
  'Rules you must follow:',
  '1. Only reference ids that appear in the input. Never invent an id.',
  '2. Never create nodes. If nothing matches, omit the candidate.',
  '3. Prefer keeping the rule engine ordering unless the evidence clearly contradicts it.',
  '4. Report uncertainty honestly: use a low probability rather than a confident guess.',
  'Respond with JSON only, matching this shape:',
  '{"candidates":[{"designNodeId":"string","appNodeIds":["string"],"relation":"one_to_one|one_to_many|many_to_one|group|missing|extra|ambiguous|ignored","probability":0.0,"reasonCodes":["string"]}],"observations":[{"type":"missing|extra|layout-difference|visual-difference|unknown","designNodeIds":["string"],"appNodeIds":["string"],"evidence":["string"]}]}',
].join('\n');

/** 从 Chat Completions 的响应里抠出正文。抽出来是为了让解析逻辑也能被断言。 */
export function extractMessageContent(payload: unknown): string {
  const choices = (payload as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('AI 响应缺少 choices');
  const message = (choices[0] as { message?: { content?: unknown } })?.message;
  const content = message?.content;
  if (typeof content === 'string' && content.trim().length > 0) return content;
  // 部分网关会返回分段的 content 数组
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : String(part)))
      .join('');
    if (joined.trim().length > 0) return joined;
  }
  throw new Error('AI 响应没有可用的正文');
}

/**
 * 调一次 AI 并返回**已校验**的结果。
 * 任何失败（网络、超时、JSON 非法、id 越界）都向上抛，由调用方记进 `result.ai.error`，
 * 绝不悄悄降级成「AI 说通过」。
 */
export async function arbitrate(
  config: AiConfig,
  request: AiAcceptanceRequest,
  allowedDesignIds: ReadonlySet<string>,
  allowedAppIds: ReadonlySet<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<AiAcceptanceResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(`${config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ candidates: request.candidates }) },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`AI 服务返回 ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`);
    }

    const payload: unknown = await response.json();
    const content = extractMessageContent(payload);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('AI 正文不是合法 JSON');
    }
    return validateAiResponse(parsed, allowedDesignIds, allowedAppIds);
  } finally {
    clearTimeout(timer);
  }
}
