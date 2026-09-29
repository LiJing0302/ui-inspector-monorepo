/**
 * AI 验收客户端。
 *
 * 页面分区使用纯视觉截图：模型只返回截图中的模块边界，节点树只在本地
 * 用于坐标反查和诊断。区域对齐、区域内节点匹配和复杂视觉复核仍分别使用
 * 各自的结构化协议，并由本地校验层限制可引用的区域/节点。
 * 因此这里有三条硬约束：
 *
 * 1. **只能引用输入里存在的节点 ID**。全局仲裁出现幻觉 id 时拒绝整份响应；
 *    区域节点匹配会逐条剔除非法项，并追加 unknown 诊断阻止页面自动通过。
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

import { chmod } from 'node:fs/promises';

import { readJsonSafe, writeJsonAtomic } from '../store/atomic';
import { acceptanceAiConfigPath } from '../store/paths';
import type {
  AiConnectionTestResult,
  AiConfigStatus,
  AiRegionNodeMatchRequest,
  AiRegionNodeMatchResponse,
  AiRegionProposal,
  AiRegionDecision,
  AiRegionRequest,
  AiRegionSegmentationRequest,
  AiRegionSegmentationResponse,
  AiAppSegmentationRequest,
  AiAppSegmentationResponse,
  AiDesignSegmentationRequest,
  AiDesignSegmentationResponse,
  AiDesignRegionSearchRequest,
  AiDesignRegionSearchResponse,
  AiDesignRegionSearchMatch,
  AiVisualRegionProposal,
  AiVisualSegmentationRequest,
  AiVisualSegmentationResponse,
  AiVisualRegionRetryRequest,
  SaveAiConfigInput,
  TestAiConfigInput,
} from '../../types/aiAcceptance';

export interface AiConfig {
  /** 基础地址，如 `https://api.openai.com/v1`（末尾斜杠会被去掉） */
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
export const PAGE_AI_MIN_TIMEOUT_MS = 180_000;
export const REGION_NODE_AI_MIN_TIMEOUT_MS = 60_000;
const STRUCTURED_OUTPUT_MAX_TOKENS = 4096;
const SEGMENTATION_MAX_OUTPUT_TOKENS = 12288;
const DESIGN_SEARCH_MAX_OUTPUT_TOKENS = 12288;
const VISUAL_SEGMENTATION_MAX_OUTPUT_TOKENS = 12288;

/** Provider-specific options that remain outside prompts and persisted config. */
export function aiCompletionOptions(
  config: Pick<AiConfig, 'endpoint'>,
  maxTokens = STRUCTURED_OUTPUT_MAX_TOKENS,
): Record<string, unknown> {
  let isBigModel = false;
  try {
    isBigModel = new URL(config.endpoint).hostname.toLowerCase() === 'open.bigmodel.cn';
  } catch {
    // Config validation reports malformed endpoints before any request is made.
  }
  return {
    max_tokens: maxTokens,
    // GLM-5.3 is an always-thinking model. Thinking is enabled separately;
    // reasoning_effort controls its low/high/max depth.
    ...(isBigModel ? { thinking: { type: 'enabled' }, reasoning_effort: 'low' } : {}),
  };
}

function completionFinishReason(payload: unknown): string | undefined {
  const root = payload && typeof payload === 'object' ? payload as { choices?: unknown } : {};
  const first = Array.isArray(root.choices) ? root.choices[0] : null;
  return first && typeof first === 'object' && typeof (first as { finish_reason?: unknown }).finish_reason === 'string'
    ? (first as { finish_reason: string }).finish_reason
    : undefined;
}

function attachCompletionDiagnostics(error: unknown, payload: unknown, rawOutput?: string): never {
  const target = error instanceof Error
    ? error as Error & { rawOutput?: string; finishReason?: string }
    : new Error(String(error)) as Error & { rawOutput?: string; finishReason?: string };
  if (rawOutput) target.rawOutput = rawOutput;
  const finishReason = completionFinishReason(payload);
  if (finishReason) target.finishReason = finishReason;
  throw target;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * 配置界面接受基础地址或完整 Chat Completions 地址。
 *
 * 内部请求统一追加 `/chat/completions`，因此用户粘贴 curl 里的完整 URL 时，
 * 必须先去掉末尾路径，避免实际请求变成 `.../chat/completions/chat/completions`。
 */
export function normalizeAiEndpoint(value: string): string {
  return trimTrailingSlash(value.trim()).replace(/\/chat\/completions$/i, '');
}

function completionUrl(endpoint: string): string {
  return `${normalizeAiEndpoint(endpoint)}/chat/completions`;
}

async function throwCompletionError(response: Response, label: string): Promise<never> {
  const detail = await response.text().catch(() => '');
  throw new Error(`${label} ${response.status}${detail ? `：${detail.slice(0, 500)}` : ''}`);
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
    endpoint: normalizeAiEndpoint(endpoint),
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

export async function getAiConfigStatus(env: Record<string, string | undefined> = process.env): Promise<AiConfigStatus> {
  const fileConfig = await readJsonSafe<Partial<AiConfig>>(acceptanceAiConfigPath());
  const resolved = resolveAiConfig(env, fileConfig);
  const fromEnvironment = !!nonEmpty(env.SM_ACCEPTANCE_AI_ENDPOINT) || !!nonEmpty(env.SM_ACCEPTANCE_AI_KEY);
  return {
    configured: resolved !== null,
    endpoint: resolved?.endpoint ?? nonEmpty(fileConfig?.endpoint) ?? '',
    model: resolved?.model ?? nonEmpty(fileConfig?.model) ?? 'gpt-4o-mini',
    timeoutMs: resolved?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    source: resolved ? (fromEnvironment ? 'environment' : 'file') : 'none',
  };
}

export async function saveAiConfig(input: SaveAiConfigInput): Promise<AiConfigStatus> {
  const endpoint = normalizeAiEndpoint(input.endpoint);
  const model = input.model.trim();
  const existing = await readJsonSafe<Partial<AiConfig>>(acceptanceAiConfigPath());
  const apiKey = input.apiKey.trim() || nonEmpty(existing?.apiKey) || '';
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('AI endpoint 不是合法 URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('AI endpoint 只支持 http/https');
  if (!model) throw new Error('AI model 不能为空');
  if (!apiKey) throw new Error('AI API key 不能为空');
  const timeoutMs = Number(input.timeoutMs);
  await writeJsonAtomic(acceptanceAiConfigPath(), {
    endpoint,
    model,
    apiKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  } satisfies AiConfig);
  await chmod(acceptanceAiConfigPath(), 0o600);
  return getAiConfigStatus({});
}

// Keep both dimensions above the strictest common multimodal API minimum.
// Qwen rejects the traditional 1x1 connectivity-test pixel before inference.
const CONNECTION_TEST_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGP4TyFgGDVg1IBRA4aLAQBdePwur/3haQAAAABJRU5ErkJggg==';

export async function testAiConnection(input: TestAiConfigInput, fetchImpl: typeof fetch = fetch): Promise<AiConnectionTestResult> {
  const started = Date.now();
  const existing = await loadAiConfig();
  const config = resolveAiConfig({}, {
    endpoint: input.endpoint || existing?.endpoint,
    model: input.model || existing?.model,
    apiKey: input.apiKey?.trim() || existing?.apiKey,
    timeoutMs: input.timeoutMs || existing?.timeoutMs,
  });
  const model = input.model.trim() || existing?.model || '';
  if (!config) return { ok: false, model, latencyMs: Date.now() - started, error: 'Endpoint 或 API key 未配置' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(completionUrl(config.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        ...aiCompletionOptions(config),
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Return only JSON: {"ok":true}. Confirm that the attached image is visible.' },
            { type: 'image_url', image_url: { url: CONNECTION_TEST_IMAGE, detail: 'low' } },
          ],
        }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false, model: config.model, latencyMs: Date.now() - started,
        error: `HTTP ${response.status}${detail ? `：${detail.slice(0, 180)}` : ''}`,
      };
    }
    const content = extractMessageContent(await response.json());
    const parsed = parseAiJson(content) as { ok?: unknown };
    if (parsed.ok !== true) throw new Error('模型返回成功，但未按 JSON 协议确认图片能力');
    return { ok: true, model: config.model, latencyMs: Date.now() - started };
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError' || /abort|timeout/i.test((error as Error).message);
    return {
      ok: false,
      model: config.model,
      latencyMs: Date.now() - started,
      error: aborted ? `连接测试超时（${Math.round(config.timeoutMs / 1000)} 秒）` : (error as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

const REGION_SYSTEM_PROMPT = [
  'You align semantic UI regions between a Figma design screenshot and an Android app screenshot.',
  'The deterministic engine supplies the only allowed region ids and candidate pairs.',
  'Use screenshot crops, text, local geometry, role, order and child summaries together.',
  'Never invent ids or pixel bounds. Prefer uncertainty over a forced match.',
  'Respond with JSON only:',
  '{"regionMatches":[{"designRegionIds":["string"],"appRegionIds":["string"],"relation":"one_to_one|one_to_many|many_to_one|missing|extra|ambiguous","probability":0.0,"reasonCodes":["string"]}],"observations":[{"type":"missing|extra|layout-difference|visual-difference|content-difference|unknown","designRegionIds":["string"],"appRegionIds":["string"],"evidence":["string"]}]}',
].join('\n');

const SEGMENTATION_SYSTEM_PROMPT = [
  'Segment the design screenshot and the Android app screenshot independently into semantic visual modules before considering any correspondence.',
  'Do not use one screenshot to force the other screenshot to have the same region count, order, or boundaries.',
  'The screenshots supplied for this call are unmarked. Do not expect node ids, colored borders, or annotation overlays.',
  'A module is a meaningful visual/content block such as a header, banner, card, product group, store block, list, grid, or navigation bar.',
  'Do not return leaf text, a single icon, a button, a transparent wrapper, or the entire page as a module.',
  'The design may be only an example while app content is dynamically configured, so do not require equal text, colors, item counts, or region counts.',
  'For every module return the exact visible outer rectangle through normalizedRect x/y/width/height. Follow the actual visual top, bottom, left, and right edges in that screenshot.',
  'Coordinates must be normalized fractions in [0,1] relative to each source page. Do not output page-sized wrapper regions.',
  'Prefer 4-16 useful top-level modules, but return fewer or more when the screenshot clearly requires it. Modules must not overlap without a visual reason.',
  'For a long design screenshot, segment all visible modules across the complete screenshot. Do not restrict design regions to the top or to the App viewport range.',
  'The response must be strict RFC JSON: double-quoted property names and string values, no comments, no trailing commas, no markdown fences, and no explanatory text before or after the object.',
  'Respond with JSON only:',
  '{"designRegions":[{"proposalId":"d1","source":"design","role":"header|banner|card|grid|list|product|store|navigation|overlay|unknown","normalizedRect":{"x":0,"y":0,"width":0.8,"height":0.1},"layout":"horizontal|vertical|grid|freeform|unknown","fixed":false,"scrollable":false,"confidence":0.0,"reasonCodes":["visual_boundary","text_group"]}],"appRegions":[],"observations":["string"]}',
].join('\n');

const APP_SEGMENTATION_SYSTEM_PROMPT = [
  'Segment only the current Android app screenshot into meaningful semantic visual modules.',
  'This screenshot is the complete current viewport. Do not reason about a design screenshot and do not invent an unseen scroll position.',
  'Return modules such as header, banner, card, product group, store block, list, grid, or navigation.',
  'Do not return leaf text, a single icon, a transparent wrapper, or the entire page.',
  'Use normalized coordinates relative to the App screenshot. Modules should be useful top-level blocks and may be non-uniform.',
  'The deterministic candidates and node summaries are supporting evidence only; the visible screenshot defines the module boundary.',
  'Respond with strict JSON only, with double-quoted keys, no markdown fences, comments, or trailing commas:',
  '{"appRegions":[{"proposalId":"a1","source":"app","role":"header|banner|card|grid|list|product|store|navigation|overlay|unknown","normalizedRect":{"x":0,"y":0,"width":0.8,"height":0.1},"layout":"horizontal|vertical|grid|freeform|unknown","fixed":false,"scrollable":false,"confidence":0.0,"reasonCodes":["visual_boundary"]}],"observations":["string"]}',
].join('\n');

const DESIGN_SEGMENTATION_SYSTEM_PROMPT = [
  'Segment only the supplied design screenshot into meaningful semantic visual modules.',
  'Do not reason about an Android app screenshot and do not try to match another page.',
  'The screenshot may be a long design page. Segment all visible modules across the complete image, including modules below the first viewport.',
  'Return modules such as header, banner, card, product group, store block, list, grid, or navigation.',
  'Do not return leaf text, a single icon, a transparent wrapper, or the entire page.',
  'Use normalized coordinates relative to the complete design screenshot. The rectangle must follow the actual visible outer boundary of the module.',
  'The design is an example and may contain configured content. Use visual composition and layout as evidence; do not require any future App text or item count to be present.',
  'The deterministic candidates and node summaries are supporting evidence only; the visible screenshot defines the module boundary.',
  'Return strict JSON only, with double-quoted keys, no markdown fences, comments, or trailing commas:',
  '{"designRegions":[{"proposalId":"d1","source":"design","role":"header|banner|card|grid|list|product|store|navigation|overlay|unknown","normalizedRect":{"x":0,"y":0,"width":0.8,"height":0.1},"layout":"horizontal|vertical|grid|freeform|unknown","fixed":false,"scrollable":false,"confidence":0.0,"reasonCodes":["visual_boundary"]}],"observations":["string"]}',
].join('\n');

const DESIGN_SEARCH_SYSTEM_PROMPT = [
  'Locate each already-segmented App module inside a long design screenshot.',
  'The App screenshot is the current viewport and is the authoritative query. The design screenshot is a complete long page whose scroll position is unknown.',
  'Design tile images overlap and each tile label includes its global logical y range. Inspect every relevant tile; do not assume the matching design content starts at y=0.',
  'For every appRegionId return at most one best global design rectangle. The returned normalizedRect is relative to the complete design page, not the tile.',
  'Return the exact visible outer boundary of each matched module in the design image: normalizedRect must follow its actual top, bottom, left, and right visual edges. Do not expand to neighboring content or substitute a generic page/container boundary.',
  'The design is an example and configured content can differ. Match module semantics, layout, relative visual composition, and distinctive assets rather than exact text.',
  'Return status not-found or ambiguous when evidence is insufficient. Never force a match and never return a design region that is not backed by an App module.',
  'Only use the App region IDs supplied in the request. Do not invent IDs.',
  'Respond with strict JSON only, with double-quoted keys, no markdown fences, comments, or trailing commas:',
  '{"matches":[{"appRegionId":"app-region-001","status":"matched|ambiguous|not-found","designNormalizedRect":{"x":0,"y":0,"width":0.8,"height":0.1},"tileId":"design-tile-001","probability":0.0,"reasonCodes":["semantic_layout"]}],"observations":["string"]}',
].join('\n');

const REGION_NODE_SYSTEM_PROMPT = [
  'You match UI nodes inside one already-aligned design/app region.',
  'Each screenshot is annotated with short ids such as D001 and A001. Return only ids present in the supplied node tables.',
  'The design is an example and app content may be dynamic. Match semantic/visual roles and relative position; do not require equal text or image content.',
  'Support one-to-one, one-to-many and many-to-one relationships. Transparent wrappers and layout containers are weak evidence.',
  'Use the supplied deterministic Top-K candidates as the allowed search space for automatic matches.',
  'Report uncertainty rather than forcing a match. Observations describe visual or structural differences but never decide the page verdict.',
  'Respond with JSON only:',
  '{"matches":[{"designShortIds":["D001"],"appShortIds":["A001"],"relation":"one_to_one|one_to_many|many_to_one|missing|extra|ambiguous","probability":0.0,"reasonCodes":["string"]}],"observations":[{"type":"missing|extra|layout-difference|visual-difference|content-difference|unknown","severity":"warning|fail|unknown","evidence":["string"],"probability":0.0}]}',
].join('\n');

function multimodalContent(
  payload: unknown,
  images: ReadonlyArray<{ label: string; dataUrl: string }>,
): string | Array<Record<string, unknown>> {
  if (images.length === 0) return JSON.stringify(payload);
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: JSON.stringify(payload) }];
  for (const item of images.slice(0, 32)) {
    content.push({ type: 'text', text: item.label });
    content.push({ type: 'image_url', image_url: { url: item.dataUrl, detail: 'low' } });
  }
  return content;
}

/** 从 Chat Completions 的响应里抠出正文。抽出来是为了让解析逻辑也能被断言。 */
export function extractMessageContent(payload: unknown): string {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : {};
  const message = first.message && typeof first.message === 'object' ? first.message as Record<string, unknown> : {};
  const readContent = (value: unknown): string => {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const item = value as Record<string, unknown>;
      return String(item.text ?? item.content ?? '').trim();
    }
    if (!Array.isArray(value)) return '';
    return value.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const item = part as Record<string, unknown>;
        return String(item.text ?? item.content ?? '');
      }
      return '';
    }).join('').trim();
  };
  // Different OpenAI-compatible gateways place the answer in different fields.
  const candidates = [
    message.content,
    message.output_text,
    first.text,
    first.content,
    root.output_text,
    message.reasoning_content,
  ];
  for (const candidate of candidates) {
    const content = readContent(candidate);
    if (content) return content;
  }
  const choiceKeys = Object.keys(first).join(',') || 'none';
  const messageKeys = Object.keys(message).join(',') || 'none';
  const finishReason = first.finish_reason ? `；finish_reason=${String(first.finish_reason)}` : '';
  const error = new Error(`AI 响应没有可用的正文；response 字段=${Object.keys(root).join(',') || 'none'}；choice 字段=${choiceKeys}；message 字段=${messageKeys}${finishReason}`) as Error & { rawOutput?: string };
  // Preserve a bounded response shape for diagnostics when the gateway returned
  // no textual content at all. This is not sent back to the model.
  error.rawOutput = JSON.stringify(root).slice(0, 24000);
  throw error;
}

function removeTrailingCommas(value: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ',') {
      let next = index + 1;
      while (/\s/.test(value[next] ?? '')) next += 1;
      if (value[next] === '}' || value[next] === ']') continue;
    }
    output += character;
  }
  return output;
}

function removeJsonComments(value: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1] ?? '';
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === '/' && next === '/') {
      while (index < value.length && value[index] !== '\n') index += 1;
      output += '\n';
    } else if (character === '/' && next === '*') {
      index += 2;
      while (index < value.length && !(value[index] === '*' && value[index + 1] === '/')) index += 1;
      index += 1;
      output += ' ';
    } else {
      output += character;
    }
  }
  return output;
}

function quoteUnquotedKeys(value: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === '{' || character === ',') {
      output += character;
      let cursor = index + 1;
      while (/\s/.test(value[cursor] ?? '')) {
        output += value[cursor]!;
        cursor += 1;
      }
      const key = value.slice(cursor).match(/^([A-Za-z_$][\w$-]*)\s*:/);
      if (key) {
        output += `"${key[1]}"`;
        index = cursor + key[0].length - 1;
        output += ':';
      } else {
        index = cursor - 1;
      }
      continue;
    }
    output += character;
  }
  return output;
}

function jsonErrorDetail(content: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const position = message.match(/position (\d+)/)?.[1];
  if (!position) return message;
  const offset = Number(position);
  if (!Number.isFinite(offset)) return message;
  const start = Math.max(0, offset - 80);
  const end = Math.min(content.length, offset + 80);
  return `${message}；附近内容：${JSON.stringify(content.slice(start, end))}`;
}

function balancedJsonFragment(value: string): string | null {
  const objectStart = value.indexOf('{');
  const arrayStart = value.indexOf('[');
  const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
  if (start < 0) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') stack.push(character);
    else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack[stack.length - 1] !== expected) return null;
      stack.pop();
      if (stack.length === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

/** Parse common model JSON wrappers without weakening the schema validators. */
export function parseAiJson(content: string): unknown {
  const trimmed = content.replace(/^\uFEFF/, '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const fragment = balancedJsonFragment(fenced ?? trimmed);
  const candidates = [...new Set([trimmed, fenced, fragment].filter((item): item is string => !!item))];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    const commentFree = removeJsonComments(candidate);
    const normalizedCandidates = [
      candidate,
      commentFree,
      removeTrailingCommas(commentFree),
      removeTrailingCommas(quoteUnquotedKeys(commentFree)),
    ];
    for (const normalized of [...new Set(normalizedCandidates)]) {
      try {
        return JSON.parse(normalized) as unknown;
      } catch (error) {
        lastError = error;
      }
    }
  }
  const message = jsonErrorDetail(candidates[candidates.length - 1] ?? trimmed, lastError);
  const error = new Error(`AI JSON 解析失败：${message}`) as Error & { rawOutput?: string };
  error.rawOutput = content;
  throw error;
}

export function validateAiRegionDecision(
  value: unknown,
  allowedDesignRegionIds: ReadonlySet<string>,
  allowedAppRegionIds: ReadonlySet<string>,
): AiRegionDecision {
  if (!value || typeof value !== 'object') throw new Error('AI 区域响应不是对象');
  const raw = value as { regionMatches?: unknown; observations?: unknown };
  if (raw.regionMatches !== undefined && !Array.isArray(raw.regionMatches)) throw new Error('AI regionMatches 不是数组');
  if (raw.observations !== undefined && !Array.isArray(raw.observations)) throw new Error('AI 区域 observations 不是数组');
  const validateIds = (valueToCheck: unknown, allowed: ReadonlySet<string>, label: string): string[] => {
    if (!Array.isArray(valueToCheck)) throw new Error(`${label} 不是数组`);
    return valueToCheck.map((id) => {
      const normalized = nonEmpty(id);
      if (!normalized || !allowed.has(normalized)) throw new Error(`AI 引用了不存在的${label}：${String(id)}`);
      return normalized;
    });
  };
  const regionMatches: AiRegionDecision['regionMatches'] = [];
  const consumedDesign = new Set<string>();
  const consumedApp = new Set<string>();
  for (const entry of (raw.regionMatches ?? []) as unknown[]) {
    if (!entry || typeof entry !== 'object') throw new Error('AI region match 不是对象');
    const item = entry as Record<string, unknown>;
    const designRegionIds = validateIds(item.designRegionIds, allowedDesignRegionIds, '设计区域');
    const appRegionIds = validateIds(item.appRegionIds, allowedAppRegionIds, 'App 区域');
    const relation = nonEmpty(item.relation) ?? 'ambiguous';
    if (!['one_to_one', 'one_to_many', 'many_to_one', 'missing', 'extra', 'ambiguous'].includes(relation)) {
      throw new Error(`AI 区域 relation 非法：${relation}`);
    }
    const probability = Number(item.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('AI 区域 probability 必须在 0..1');
    if (new Set(designRegionIds).size !== designRegionIds.length || new Set(appRegionIds).size !== appRegionIds.length) {
      throw new Error('AI 区域匹配包含重复 ID');
    }
    if (designRegionIds.some((id) => consumedDesign.has(id)) || appRegionIds.some((id) => consumedApp.has(id))) {
      throw new Error('AI 区域响应重复消费区域 ID');
    }
    const validCardinality = relation === 'one_to_one'
      ? designRegionIds.length === 1 && appRegionIds.length === 1
      : relation === 'one_to_many'
        ? designRegionIds.length === 1 && appRegionIds.length > 1
        : relation === 'many_to_one'
          ? designRegionIds.length > 1 && appRegionIds.length === 1
          : relation === 'missing'
            ? designRegionIds.length > 0 && appRegionIds.length === 0
            : relation === 'extra'
              ? designRegionIds.length === 0 && appRegionIds.length > 0
              : designRegionIds.length + appRegionIds.length > 0;
    if (!validCardinality) throw new Error(`AI 区域 relation 与 ID 数量不一致：${relation}`);
    regionMatches.push({
      designRegionIds,
      appRegionIds,
      relation: relation as AiRegionDecision['regionMatches'][number]['relation'],
      probability,
      reasonCodes: Array.isArray(item.reasonCodes) ? item.reasonCodes.map(String).slice(0, 12) : [],
    });
    designRegionIds.forEach((id) => consumedDesign.add(id));
    appRegionIds.forEach((id) => consumedApp.add(id));
  }
  const observations: AiRegionDecision['observations'] = [];
  for (const entry of (raw.observations ?? []) as unknown[]) {
    if (!entry || typeof entry !== 'object') throw new Error('AI region observation 不是对象');
    const item = entry as Record<string, unknown>;
    const type = nonEmpty(item.type) ?? 'unknown';
    if (!['missing', 'extra', 'layout-difference', 'visual-difference', 'content-difference', 'unknown'].includes(type)) {
      throw new Error(`AI 区域 observation type 非法：${type}`);
    }
    observations.push({
      type: type as AiRegionDecision['observations'][number]['type'],
      designRegionIds: validateIds(item.designRegionIds ?? [], allowedDesignRegionIds, '设计区域'),
      appRegionIds: validateIds(item.appRegionIds ?? [], allowedAppRegionIds, 'App 区域'),
      evidence: Array.isArray(item.evidence) ? item.evidence.map(String).slice(0, 12) : [],
    });
  }
  return { regionMatches, observations };
}

export async function arbitrateRegions(
  config: AiConfig,
  request: AiRegionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AiRegionDecision> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(config.timeoutMs, PAGE_AI_MIN_TIMEOUT_MS));
  try {
    const images = [
      ...(request.pageImages ?? []).map((item) => ({
        label: `${item.source} ${item.kind ?? 'full page'}${item.page ? ` ${item.page}` : ''}`,
        dataUrl: item.dataUrl,
      })),
      ...(request.crops ?? []).map((item) => ({ label: `${item.source} region ${item.regionId}`, dataUrl: item.dataUrl })),
    ];
    const response = await fetchImpl(completionUrl(config.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        ...aiCompletionOptions(config),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: REGION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: multimodalContent(
              { baseline: 'app', design: request.design, app: request.app, candidates: request.candidates },
              images,
            ),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) await throwCompletionError(response, 'AI 区域服务返回');
    const payload = await response.json();
    const content = extractMessageContent(payload);
    try {
      const parsed: unknown = parseAiJson(content);
      return {
        ...validateAiRegionDecision(
        parsed,
        new Set(request.design.regions.map((region) => region.id)),
        new Set(request.app.regions.map((region) => region.id)),
        ),
        rawOutput: content,
        finishReason: completionFinishReason(payload),
      };
    } catch (error) {
      attachCompletionDiagnostics(error, payload, (error as { rawOutput?: string }).rawOutput ?? content);
    }
  } finally {
    clearTimeout(timer);
  }
}

const REGION_ROLES = new Set(['page', 'system', 'header', 'banner', 'card', 'grid', 'list', 'product', 'store', 'navigation', 'overlay', 'unknown']);
const REGION_LAYOUTS = new Set(['horizontal', 'vertical', 'grid', 'freeform', 'unknown']);

function validateNormalizedRect(value: unknown): { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== 'object') throw new Error('AI 分区 normalizedRect 不是对象');
  const raw = value as Record<string, unknown>;
  const rect = {
    x: Number(raw.x),
    y: Number(raw.y),
    width: Number(raw.width),
    height: Number(raw.height),
  };
  if (Object.values(rect).some((item) => !Number.isFinite(item))) throw new Error('AI 分区坐标不是有限数值');
  if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
    || rect.x + rect.width > 1.0001 || rect.y + rect.height > 1.0001) {
    throw new Error('AI 分区坐标超出归一化页面范围');
  }
  return rect;
}

export function validateAiRegionSegmentation(value: unknown): AiRegionSegmentationResponse {
  if (!value || typeof value !== 'object') throw new Error('AI 分区响应不是对象');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.designRegions) || !Array.isArray(raw.appRegions)) throw new Error('AI 分区响应缺少两侧区域数组');
  const seen = new Set<string>();
  const parse = (entry: unknown, source: 'design' | 'app'): AiRegionProposal => {
    if (!entry || typeof entry !== 'object') throw new Error('AI 分区条目不是对象');
    const item = entry as Record<string, unknown>;
    const proposalId = nonEmpty(item.proposalId);
    if (!proposalId || seen.has(`${source}:${proposalId}`)) throw new Error('AI 分区 proposalId 缺失或重复');
    seen.add(`${source}:${proposalId}`);
    if (item.source !== source) throw new Error(`AI 分区来源错误：期望 ${source}`);
    const role = nonEmpty(item.role) ?? 'unknown';
    const layout = nonEmpty(item.layout) ?? 'unknown';
    if (!REGION_ROLES.has(role) || role === 'page' || role === 'system') throw new Error(`AI 分区角色非法：${role}`);
    if (!REGION_LAYOUTS.has(layout)) throw new Error(`AI 分区布局非法：${layout}`);
    const confidence = Number(item.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('AI 分区 confidence 必须在 0..1');
    return {
      proposalId,
      source,
      role: role as AiRegionProposal['role'],
      normalizedRect: validateNormalizedRect(item.normalizedRect),
      layout: layout as AiRegionProposal['layout'],
      fixed: item.fixed === true,
      scrollable: item.scrollable === true,
      confidence,
      reasonCodes: Array.isArray(item.reasonCodes) ? item.reasonCodes.map(String).slice(0, 12) : [],
    };
  };
  return {
    designRegions: raw.designRegions.map((item) => parse(item, 'design')).slice(0, 32),
    appRegions: raw.appRegions.map((item) => parse(item, 'app')).slice(0, 32),
    observations: Array.isArray(raw.observations) ? raw.observations.map(String).slice(0, 24) : [],
  };
}

export async function segmentRegions(
  config: AiConfig,
  request: AiRegionSegmentationRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AiRegionSegmentationResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(config.timeoutMs, PAGE_AI_MIN_TIMEOUT_MS));
  try {
    const response = await fetchImpl(completionUrl(config.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        ...aiCompletionOptions(config, SEGMENTATION_MAX_OUTPUT_TOKENS),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SEGMENTATION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: multimodalContent(
              { baseline: request.baseline ?? 'app', design: request.design, app: request.app },
              request.pageImages.map((item) => ({
                label: `${item.source} ${item.kind ?? 'page'}${item.page ? ` ${item.page}` : ''}`,
                dataUrl: item.dataUrl,
              })),
            ),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) await throwCompletionError(response, 'AI 分区服务返回');
    const payload = await response.json();
    const content = extractMessageContent(payload);
    try {
      const parsed: unknown = parseAiJson(content);
      return { ...validateAiRegionSegmentation(parsed), rawOutput: content, finishReason: completionFinishReason(payload) };
    } catch (error) {
      attachCompletionDiagnostics(error, payload, (error as { rawOutput?: string }).rawOutput ?? content);
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseAppRegionProposal(entry: unknown, seen: Set<string>): AiRegionProposal {
  if (!entry || typeof entry !== 'object') throw new Error('AI App 分区条目不是对象');
  const item = entry as Record<string, unknown>;
  const proposalId = nonEmpty(item.proposalId);
  if (!proposalId || seen.has(proposalId)) throw new Error('AI App 分区 proposalId 缺失或重复');
  seen.add(proposalId);
  if (item.source !== 'app') throw new Error('AI App 分区来源错误');
  const role = nonEmpty(item.role) ?? 'unknown';
  const layout = nonEmpty(item.layout) ?? 'unknown';
  if (!REGION_ROLES.has(role) || role === 'page' || role === 'system') throw new Error(`AI App 分区角色非法：${role}`);
  if (!REGION_LAYOUTS.has(layout)) throw new Error(`AI App 分区布局非法：${layout}`);
  const confidence = Number(item.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('AI App 分区 confidence 必须在 0..1');
  return {
    proposalId,
    source: 'app',
    role: role as AiRegionProposal['role'],
    normalizedRect: validateNormalizedRect(item.normalizedRect),
    layout: layout as AiRegionProposal['layout'],
    fixed: item.fixed === true,
    scrollable: item.scrollable === true,
    confidence,
    reasonCodes: Array.isArray(item.reasonCodes) ? item.reasonCodes.map(String).slice(0, 12) : [],
  };
}

export function validateAiAppSegmentation(value: unknown): AiAppSegmentationResponse {
  if (!value || typeof value !== 'object') throw new Error('AI App 分区响应不是对象');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.appRegions)) throw new Error('AI App 分区响应缺少 appRegions');
  const seen = new Set<string>();
  return {
    appRegions: raw.appRegions.map((entry) => parseAppRegionProposal(entry, seen)).slice(0, 64),
    observations: Array.isArray(raw.observations) ? raw.observations.map(String).slice(0, 24) : [],
  };
}

export async function segmentAppRegions(
  config: AiConfig,
  request: AiAppSegmentationRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AiAppSegmentationResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(config.timeoutMs, PAGE_AI_MIN_TIMEOUT_MS));
  try {
    const response = await fetchImpl(completionUrl(config.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        ...aiCompletionOptions(config, SEGMENTATION_MAX_OUTPUT_TOKENS),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: APP_SEGMENTATION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: multimodalContent(
              { app: request.app },
              request.pageImages.map((item) => ({
                label: `app ${item.kind ?? 'page'}${item.page ? ` ${item.page}` : ''}`,
                dataUrl: item.dataUrl,
              })),
            ),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) await throwCompletionError(response, 'AI App 分区服务返回');
    const payload = await response.json();
    const content = extractMessageContent(payload);
    try {
      const parsed: unknown = parseAiJson(content);
      return { ...validateAiAppSegmentation(parsed), rawOutput: content, finishReason: completionFinishReason(payload) };
    } catch (error) {
      attachCompletionDiagnostics(error, payload, (error as { rawOutput?: string }).rawOutput ?? content);
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseDesignRegionProposal(entry: unknown, seen: Set<string>): AiRegionProposal {
  if (!entry || typeof entry !== 'object') throw new Error('AI 设计稿分区条目不是对象');
  const item = entry as Record<string, unknown>;
  const proposalId = nonEmpty(item.proposalId);
  if (!proposalId || seen.has(proposalId)) throw new Error('AI 设计稿分区 proposalId 缺失或重复');
  seen.add(proposalId);
  if (item.source !== 'design') throw new Error('AI 设计稿分区来源错误');
  const role = nonEmpty(item.role) ?? 'unknown';
  const layout = nonEmpty(item.layout) ?? 'unknown';
  if (!REGION_ROLES.has(role) || role === 'page' || role === 'system') throw new Error(`AI 设计稿分区角色非法：${role}`);
  if (!REGION_LAYOUTS.has(layout)) throw new Error(`AI 设计稿分区布局非法：${layout}`);
  const confidence = Number(item.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('AI 设计稿分区 confidence 必须在 0..1');
  return {
    proposalId,
    source: 'design',
    role: role as AiRegionProposal['role'],
    normalizedRect: validateNormalizedRect(item.normalizedRect),
    layout: layout as AiRegionProposal['layout'],
    fixed: item.fixed === true,
    scrollable: item.scrollable === true,
    confidence,
    reasonCodes: Array.isArray(item.reasonCodes) ? item.reasonCodes.map(String).slice(0, 12) : [],
  };
}

export function validateAiDesignSegmentation(value: unknown): AiDesignSegmentationResponse {
  if (!value || typeof value !== 'object') throw new Error('AI 设计稿分区响应不是对象');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.designRegions)) throw new Error('AI 设计稿分区响应缺少 designRegions');
  const seen = new Set<string>();
  return {
    designRegions: raw.designRegions.map((entry) => parseDesignRegionProposal(entry, seen)).slice(0, 64),
    observations: Array.isArray(raw.observations) ? raw.observations.map(String).slice(0, 24) : [],
  };
}

export async function segmentDesignRegions(
  config: AiConfig,
  request: AiDesignSegmentationRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AiDesignSegmentationResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(config.timeoutMs, PAGE_AI_MIN_TIMEOUT_MS));
  try {
    const response = await fetchImpl(completionUrl(config.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        ...aiCompletionOptions(config, SEGMENTATION_MAX_OUTPUT_TOKENS),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: DESIGN_SEGMENTATION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: multimodalContent(
              { design: request.design },
              request.pageImages.map((item) => ({
                label: `design ${item.kind ?? 'page'}${item.page ? ` ${item.page}` : ''}`,
                dataUrl: item.dataUrl,
              })),
            ),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) await throwCompletionError(response, 'AI 设计稿分区服务返回');
    const payload = await response.json();
    const content = extractMessageContent(payload);
    try {
      const parsed: unknown = parseAiJson(content);
      return { ...validateAiDesignSegmentation(parsed), rawOutput: content, finishReason: completionFinishReason(payload) };
    } catch (error) {
      attachCompletionDiagnostics(error, payload, (error as { rawOutput?: string }).rawOutput ?? content);
    }
  } finally {
    clearTimeout(timer);
  }
}

const VISUAL_SEGMENTATION_SYSTEM_PROMPT = [
  'Segment the supplied UI screenshot into meaningful top-level visual modules.',
  'Use the screenshot only. Do not expect or use node ids, node summaries, local candidate regions, DOM data, or another screenshot.',
  'A module is a visually coherent content block such as a header, banner, card, product group, store block, list, grid, or navigation area.',
  'Do not return a leaf text label, isolated icon, tiny button, transparent wrapper, or the entire page as a module.',
  'For every module return the exact visible outer rectangle. The rectangle must follow the actual visual left, top, right, and bottom boundary.',
  'Coordinates are normalized to the supplied image: leftTop and rightBottom values must be between 0 and 1.',
  'A long design screenshot must be segmented across the complete supplied image, not only the first viewport.',
  'Return strict JSON only: double-quoted keys, no markdown fences, comments, trailing commas, or explanatory text.',
  '{"regions":[{"proposalId":"r1","leftTop":{"x":0,"y":0},"rightBottom":{"x":1,"y":0.1},"confidence":0.0,"reasonCodes":["visual_boundary"]}],"observations":["string"]}',
].join('\n');

const VISUAL_REGION_RETRY_SYSTEM_PROMPT = [
  'Re-evaluate the boundary of one UI visual module in the supplied crop.',
  'The previous region could not be associated with any native node by the local coordinate resolver.',
  'Use the crop image and previous bounds only. Do not ask for or invent node ids, node summaries, or local candidate regions.',
  'Adjust the boundary by expanding or shrinking it until it follows the complete visible module, while keeping the module identity unchanged.',
  'Return exactly one region in normalized coordinates relative to the supplied retry image.',
  'Return strict JSON only: double-quoted keys, no markdown fences, comments, trailing commas, or explanatory text.',
  '{"regions":[{"proposalId":"retry-1","leftTop":{"x":0,"y":0},"rightBottom":{"x":1,"y":1},"confidence":0.0,"reasonCodes":["boundary_adjustment"]}],"observations":["string"]}',
].join('\n');

function validateVisualPoint(value: unknown, label: string): { x: number; y: number } {
  if (!value || typeof value !== 'object') throw new Error(`AI ${label} 不是对象`);
  const raw = value as Record<string, unknown>;
  const point = { x: Number(raw.x), y: Number(raw.y) };
  if (Object.values(point).some((item) => !Number.isFinite(item) || item < 0 || item > 1)) {
    throw new Error(`AI ${label} 坐标必须在 0..1`);
  }
  return point;
}

function parseVisualRegionProposal(entry: unknown, index: number): AiVisualRegionProposal {
  if (!entry || typeof entry !== 'object') throw new Error('AI 视觉分区条目不是对象');
  const item = entry as Record<string, unknown>;
  const proposalId = nonEmpty(item.proposalId) ?? `region-${index + 1}`;
  const leftTop = validateVisualPoint(item.leftTop, '视觉分区左上角');
  const rightBottom = validateVisualPoint(item.rightBottom, '视觉分区右下角');
  if (leftTop.x >= rightBottom.x || leftTop.y >= rightBottom.y) {
    throw new Error(`AI 视觉分区 ${proposalId} 的左上角和右下角无效`);
  }
  const confidence = item.confidence === undefined ? undefined : Number(item.confidence);
  if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new Error(`AI 视觉分区 ${proposalId} confidence 必须在 0..1`);
  }
  return {
    proposalId,
    leftTop,
    rightBottom,
    ...(confidence === undefined ? {} : { confidence }),
    reasonCodes: Array.isArray(item.reasonCodes) ? item.reasonCodes.map(String).slice(0, 12) : [],
  };
}

export function validateAiVisualSegmentation(value: unknown): AiVisualSegmentationResponse {
  if (!value || typeof value !== 'object') throw new Error('AI 视觉分区响应不是对象');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.regions)) throw new Error('AI 视觉分区响应缺少 regions');
  const seen = new Set<string>();
  const regions = raw.regions.map(parseVisualRegionProposal).filter((region) => {
    if (seen.has(region.proposalId)) throw new Error(`AI 视觉分区 proposalId 重复：${region.proposalId}`);
    seen.add(region.proposalId);
    return true;
  });
  return {
    regions,
    observations: Array.isArray(raw.observations) ? raw.observations.map(String).slice(0, 24) : [],
  };
}

async function requestVisualSegmentation(
  config: AiConfig,
  request: AiVisualSegmentationRequest | AiVisualRegionRetryRequest,
  prompt: string,
  label: string,
  fetchImpl: typeof fetch,
): Promise<AiVisualSegmentationResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(config.timeoutMs, PAGE_AI_MIN_TIMEOUT_MS));
  const isRetry = request.protocol === 'ui-acceptance-visual-region-retry-v1';
  const metadata = isRetry
    ? {
      protocol: request.protocol,
      runId: request.runId,
      model: request.model,
      source: request.source,
      image: { width: request.image.width, height: request.image.height },
      imageRect: request.imageRect,
      previousRegion: request.previousRegion,
      failureReason: request.failureReason,
    }
    : {
      protocol: request.protocol,
      runId: request.runId,
      model: request.model,
      source: request.source,
      image: { width: request.image.width, height: request.image.height },
    };
  try {
    const response = await fetchImpl(completionUrl(config.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        ...aiCompletionOptions(config, VISUAL_SEGMENTATION_MAX_OUTPUT_TOKENS),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: multimodalContent(metadata, [{ label, dataUrl: request.image.dataUrl }]),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) await throwCompletionError(response, 'AI 视觉分区服务返回');
    const payload = await response.json();
    const content = extractMessageContent(payload);
    try {
      const parsed = validateAiVisualSegmentation(parseAiJson(content));
      if (parsed.regions.length === 0) throw new Error('AI 视觉分区未返回模块');
      return { ...parsed, rawOutput: content, finishReason: completionFinishReason(payload) };
    } catch (error) {
      attachCompletionDiagnostics(error, payload, (error as { rawOutput?: string }).rawOutput ?? content);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function segmentVisualRegions(
  config: AiConfig,
  request: AiVisualSegmentationRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AiVisualSegmentationResponse> {
  return requestVisualSegmentation(config, request, VISUAL_SEGMENTATION_SYSTEM_PROMPT, `${request.source} 原始截图`, fetchImpl);
}

export async function retryVisualRegion(
  config: AiConfig,
  request: AiVisualRegionRetryRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AiVisualSegmentationResponse> {
  return requestVisualSegmentation(config, request, VISUAL_REGION_RETRY_SYSTEM_PROMPT, `${request.source} 区域重划分截图`, fetchImpl);
}

function validateDesignSearchRect(value: unknown): { x: number; y: number; width: number; height: number } {
  return validateNormalizedRect(value);
}

export function validateAiDesignRegionSearch(
  value: unknown,
  allowedAppRegionIds: ReadonlySet<string>,
): AiDesignRegionSearchResponse {
  if (!value || typeof value !== 'object') throw new Error('AI 长设计稿定位响应不是对象');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.matches)) throw new Error('AI 长设计稿定位响应缺少 matches');
  const consumed = new Set<string>();
  const matches: AiDesignRegionSearchMatch[] = raw.matches.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('AI 长设计稿定位条目不是对象');
    const item = entry as Record<string, unknown>;
    const appRegionId = nonEmpty(item.appRegionId);
    if (!appRegionId || !allowedAppRegionIds.has(appRegionId)) throw new Error(`AI 引用了不存在的 App 区域：${String(item.appRegionId)}`);
    if (consumed.has(appRegionId)) throw new Error(`AI 长设计稿定位重复消费 App 区域：${appRegionId}`);
    consumed.add(appRegionId);
    const status = nonEmpty(item.status) ?? 'ambiguous';
    if (!['matched', 'ambiguous', 'not-found'].includes(status)) throw new Error(`AI 长设计稿定位 status 非法：${status}`);
    const probability = Number(item.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('AI 长设计稿定位 probability 必须在 0..1');
    const rectValue = item.designNormalizedRect ?? item.normalizedRect;
    const designNormalizedRect = rectValue === undefined ? undefined : validateDesignSearchRect(rectValue);
    if (status === 'matched' && !designNormalizedRect) throw new Error(`AI 长设计稿定位 matched 缺少设计稿坐标：${appRegionId}`);
    return {
      appRegionId,
      status: status as AiDesignRegionSearchMatch['status'],
      ...(designNormalizedRect ? { designNormalizedRect } : {}),
      ...(nonEmpty(item.tileId) ? { tileId: nonEmpty(item.tileId)! } : {}),
      probability,
      reasonCodes: Array.isArray(item.reasonCodes) ? item.reasonCodes.map(String).slice(0, 12) : [],
    };
  });
  return {
    matches,
    observations: Array.isArray(raw.observations) ? raw.observations.map(String).slice(0, 24) : [],
  };
}

export async function locateDesignRegions(
  config: AiConfig,
  request: AiDesignRegionSearchRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AiDesignRegionSearchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(config.timeoutMs, PAGE_AI_MIN_TIMEOUT_MS));
  try {
    const response = await fetchImpl(completionUrl(config.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        ...aiCompletionOptions(config, DESIGN_SEARCH_MAX_OUTPUT_TOKENS),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: DESIGN_SEARCH_SYSTEM_PROMPT },
          {
            role: 'user',
            content: multimodalContent(
              {
                baseline: request.baseline,
                app: request.app,
                design: { ...request.design, tiles: request.design.tiles },
              },
              request.pageImages.map((item) => ({
                label: item.source === 'design'
                  ? `design tile ${item.tileId ?? item.page ?? ''}`
                  : `app ${item.kind ?? 'page'}${item.regionId ? ` ${item.regionId}` : ''}`,
                dataUrl: item.dataUrl,
              })),
            ),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) await throwCompletionError(response, 'AI 长设计稿定位服务返回');
    const payload = await response.json();
    const content = extractMessageContent(payload);
    try {
      const parsed: unknown = parseAiJson(content);
      return { ...validateAiDesignRegionSearch(parsed, new Set(request.app.regions.map((region) => region.id))), rawOutput: content, finishReason: completionFinishReason(payload) };
    } catch (error) {
      attachCompletionDiagnostics(error, payload, (error as { rawOutput?: string }).rawOutput ?? content);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function validateAiRegionNodeMatches(
  value: unknown,
  allowedDesignShortIds: ReadonlySet<string>,
  allowedAppShortIds: ReadonlySet<string>,
  candidateAppIds: ReadonlyMap<string, ReadonlySet<string>>,
): AiRegionNodeMatchResponse {
  if (!value || typeof value !== 'object') throw new Error('AI 区域节点响应不是对象');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.matches) || !Array.isArray(raw.observations)) throw new Error('AI 区域节点响应缺少数组');
  type ParsedMatch = AiRegionNodeMatchResponse['matches'][number] & { originalIndex: number };
  const parsedMatches: ParsedMatch[] = [];
  const rejectedMatchReasons: string[] = [];
  const reject = (index: number, reason: string): void => {
    rejectedMatchReasons.push(`AI_MATCH_REJECTED: match[${index}] ${reason}`);
  };

  raw.matches.forEach((entry, originalIndex) => {
    if (!entry || typeof entry !== 'object') {
      reject(originalIndex, '不是对象');
      return;
    }
    const item = entry as Record<string, unknown>;
    if (!Array.isArray(item.designShortIds) || !Array.isArray(item.appShortIds)) {
      reject(originalIndex, 'designShortIds/appShortIds 不是数组');
      return;
    }
    const designShortIds = item.designShortIds.map(String);
    const appShortIds = item.appShortIds.map(String);
    if (new Set(designShortIds).size !== designShortIds.length || new Set(appShortIds).size !== appShortIds.length) {
      reject(originalIndex, '单条匹配包含重复短 ID');
      return;
    }
    const unknownDesignId = designShortIds.find((id) => !allowedDesignShortIds.has(id));
    if (unknownDesignId) {
      reject(originalIndex, `引用不存在的设计短 ID：${unknownDesignId}`);
      return;
    }
    const unknownAppId = appShortIds.find((id) => !allowedAppShortIds.has(id));
    if (unknownAppId) {
      reject(originalIndex, `引用不存在的 App 短 ID：${unknownAppId}`);
      return;
    }
    const relation = nonEmpty(item.relation) ?? 'ambiguous';
    if (!['one_to_one', 'one_to_many', 'many_to_one', 'missing', 'extra', 'ambiguous'].includes(relation)) {
      reject(originalIndex, `relation 非法：${relation}`);
      return;
    }
    const validCardinality = relation === 'one_to_one' ? designShortIds.length === 1 && appShortIds.length === 1
      : relation === 'one_to_many' ? designShortIds.length === 1 && appShortIds.length > 1
        : relation === 'many_to_one' ? designShortIds.length > 1 && appShortIds.length === 1
          : relation === 'missing' ? designShortIds.length > 0 && appShortIds.length === 0
            : relation === 'extra' ? designShortIds.length === 0 && appShortIds.length > 0
              : designShortIds.length + appShortIds.length > 0;
    if (!validCardinality) {
      reject(originalIndex, `relation 与 ID 数量不一致：${relation}`);
      return;
    }
    if (designShortIds.length > 0 && appShortIds.length > 0) {
      const candidateUnion = new Set(designShortIds.flatMap((id) => [...(candidateAppIds.get(id) ?? [])]));
      if (appShortIds.some((id) => !candidateUnion.has(id))) {
        reject(originalIndex, '匹配超出确定性候选集');
        return;
      }
    }
    const probability = Number(item.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      reject(originalIndex, 'probability 必须在 0..1');
      return;
    }
    parsedMatches.push({
      designShortIds,
      appShortIds,
      relation: relation as AiRegionNodeMatchResponse['matches'][number]['relation'],
      probability,
      reasonCodes: Array.isArray(item.reasonCodes) ? item.reasonCodes.map(String).slice(0, 12) : [],
      originalIndex,
    });
  });

  // Resolve conflicts globally so model output order cannot make a low-confidence
  // match consume a node before a stronger match is considered.
  const usedDesign = new Set<string>();
  const usedApp = new Set<string>();
  const acceptedMatches: ParsedMatch[] = [];
  for (const item of [...parsedMatches].sort((a, b) => b.probability - a.probability || a.originalIndex - b.originalIndex)) {
    const duplicateDesignId = item.designShortIds.find((id) => usedDesign.has(id));
    const duplicateAppId = item.appShortIds.find((id) => usedApp.has(id));
    if (duplicateDesignId || duplicateAppId) {
      reject(item.originalIndex, duplicateDesignId
        ? `重复消费设计节点：${duplicateDesignId}`
        : `重复消费 App 节点：${duplicateAppId}`);
      continue;
    }
    item.designShortIds.forEach((id) => usedDesign.add(id));
    item.appShortIds.forEach((id) => usedApp.add(id));
    acceptedMatches.push(item);
  }
  const matches = acceptedMatches
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map(({ originalIndex: _originalIndex, ...item }) => item);
  const observations = raw.observations.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('AI 区域节点 observation 不是对象');
    const item = entry as Record<string, unknown>;
    const type = nonEmpty(item.type) ?? 'unknown';
    const severity = nonEmpty(item.severity) ?? 'unknown';
    if (!['missing', 'extra', 'layout-difference', 'visual-difference', 'content-difference', 'unknown'].includes(type)) throw new Error(`AI observation type 非法：${type}`);
    if (!['warning', 'fail', 'unknown'].includes(severity)) throw new Error(`AI observation severity 非法：${severity}`);
    const probability = Number(item.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('AI observation probability 必须在 0..1');
    return {
      type: type as AiRegionNodeMatchResponse['observations'][number]['type'],
      severity: severity as AiRegionNodeMatchResponse['observations'][number]['severity'],
      evidence: Array.isArray(item.evidence) ? item.evidence.map(String).slice(0, 12) : [],
      probability,
    };
  });
  observations.push(...rejectedMatchReasons.map((reason) => ({
    type: 'unknown' as const,
    severity: 'unknown' as const,
    evidence: [reason],
    probability: 1,
  })));
  return { matches, observations };
}

export async function matchRegionNodesWithAi(
  config: AiConfig,
  request: AiRegionNodeMatchRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AiRegionNodeMatchResponse> {
  const candidateMap = new Map(request.candidates.map((candidate) => [candidate.designShortId, new Set(candidate.appShortIds)]));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(config.timeoutMs, REGION_NODE_AI_MIN_TIMEOUT_MS));
  try {
    const response = await fetchImpl(completionUrl(config.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        ...aiCompletionOptions(config),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: REGION_NODE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: multimodalContent(
              {
                designRegionId: request.designRegionId,
                appRegionId: request.appRegionId,
                designNodes: request.designNodes,
                appNodes: request.appNodes,
                candidates: request.candidates,
              },
              request.images.map((item) => ({
                label: `${item.source} ${item.kind}${item.page ? ` page ${item.page}` : ''}`,
                dataUrl: item.dataUrl,
              })),
            ),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) await throwCompletionError(response, 'AI 区域节点服务返回');
    const payload = await response.json();
    const content = extractMessageContent(payload);
    try {
      const parsed: unknown = parseAiJson(content);
      return {
        ...validateAiRegionNodeMatches(
        parsed,
        new Set(request.designNodes.map((node) => node.shortId)),
        new Set(request.appNodes.map((node) => node.shortId)),
        candidateMap,
        ),
        rawOutput: content,
        finishReason: completionFinishReason(payload),
      };
    } catch (error) {
      attachCompletionDiagnostics(error, payload, (error as { rawOutput?: string }).rawOutput ?? content);
    }
  } finally {
    clearTimeout(timer);
  }
}
