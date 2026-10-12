/**
 * Node 侧：OpenAI 兼容协议的 VLM reviewer
 *
 * 关键设计：**不让模型做 grounding**。编号来自我们自己的清单，模型只需在给定编号上做语义判断。
 * 这直接规避了"GPT-4o 在 GUI-360 上 grounding 仅 9.4%"这类精度天花板的来源。
 *
 * 无 API key 时不要用它 —— 用 MockRegionReviewer，确定性流程照样跑通。
 */

import type { PixelImage, RegionReviewRequest, RegionReviewResponse, RegionReviewer } from '../types.ts';
import { buildRegionPrompt } from '../reviewer.ts';
import pkg from 'pngjs';

const { PNG } = pkg as unknown as {
  PNG: { sync: { write(p: { width: number; height: number; data: Uint8Array }): Uint8Array } };
};

export interface OpenAiReviewerOptions {
  baseUrl?: string;
  apiKey: string;
  model: string;
  /** 是否把裁切图一并发送（无图则退化为纯清单评审） */
  sendImages?: boolean;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** 自定义 fetch（便于测试注入） */
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleReviewer implements RegionReviewer {
  readonly name: string;
  private readonly opts: Required<Omit<OpenAiReviewerOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch };

  constructor(opts: OpenAiReviewerOptions) {
    this.name = `openai:${opts.model}`;
    this.opts = {
      baseUrl: opts.baseUrl ?? 'https://api.openai.com/v1',
      apiKey: opts.apiKey,
      model: opts.model,
      sendImages: opts.sendImages ?? true,
      temperature: opts.temperature ?? 0,
      // ⚠️ 下限保护（2026-10-04）：这个值由 App 的 AI 设置透传，而那条链路允许用户
      // 填任意数字。填 0 / 负数 / 几百毫秒都会让**每一次**请求必然超时，而报错在
      // 当时读起来只是「引擎异常」。这里抬到 30s —— 低于它，带图请求没有跑完的可能。
      timeoutMs: Math.max(30_000, opts.timeoutMs ?? 90_000),
      maxRetries: opts.maxRetries ?? 2,
      fetchImpl: opts.fetchImpl ?? fetch,
    };
  }

  async review(req: RegionReviewRequest): Promise<RegionReviewResponse> {
    const { system, user } = buildRegionPrompt(req);
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: user }];

    if (this.opts.sendImages) {
      // 顺序固定：先设计、后 App；并在文本里已声明（模型据此对齐）
      if (req.designCrop) content.push({ type: 'text', text: '[图1] 设计稿裁切（左）' });
      if (req.designCrop) content.push(imagePart(req.designCrop));
      if (req.appCrop) content.push({ type: 'text', text: '[图2] App 截图裁切（右）' });
      if (req.appCrop) content.push(imagePart(req.appCrop));
    }

    const body = {
      model: this.opts.model,
      temperature: this.opts.temperature,
      response_format: { type: 'json_object' as const },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
    };

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
      try {
        const res = await this.opts.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${res.statusText} ${text.slice(0, 400)}`);
        }
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const raw = json.choices?.[0]?.message?.content ?? '';
        const parsed = parseJsonLoose(raw);
        return {
          regionId: (parsed?.['regionId'] as string) ?? req.region.regionId,
          environmental: (parsed?.['environmental'] as RegionReviewResponse['environmental']) ?? [],
          dynamic: (parsed?.['dynamic'] as RegionReviewResponse['dynamic']) ?? [],
          defects: (parsed?.['defects'] as RegionReviewResponse['defects']) ?? [],
          confidence: typeof parsed?.['confidence'] === 'number' ? (parsed['confidence'] as number) : undefined,
          raw: parsed ?? raw,
        };
      } catch (e) {
        lastErr = e;
        if (attempt < this.opts.maxRetries) await sleep(400 * (attempt + 1));
      } finally {
        // ⚠️⚠️ `clearTimeout` 必须在 finally 里，不能只在成功路径上调。
        // 原先它写在 `await fetch` 之后：HTTP 错误 / JSON 解析失败 / 超时这三条
        // 都会跳过它，计时器就一直挂到超时才触发 —— 而 Node 的定时器**持有
        // AbortController 的引用**，于是每次失败都泄漏一个未释放的定时器。
        // 9 个分区 × 3 次重试 = 最多 27 个悬挂定时器。
        // 症状是「进程明明返回了却过几秒才退出」/ 内存莫名上涨，
        // 而报错信息里一个字都不会提。
        clearTimeout(timer);
      }
    }
    throw new Error(`[${this.name}] ${req.region.regionId} 评审失败：${describeError(lastErr, this.opts.timeoutMs)}`);
  }
}

function imagePart(img: PixelImage): Record<string, unknown> {
  const png = PNG.sync.write({ width: img.width, height: img.height, data: img.data });
  const b64 = Buffer.from(png).toString('base64');
  return { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } };
}

/** 容错 JSON 解析：模型偶尔会包 ```json 代码块或加前后缀说明 */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    /* continue */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as Record<string, unknown>;
    } catch {
      /* continue */
    }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * 把底层错误翻译成**能据此行动**的一句话。
 *
 * ⚠️ 为什么要专门写这个（2026-10-04 实测踩到）：`AbortError` 原本直接 `String(e)`，
 * 出来是「评审失败：AbortError: This operation was aborted」——
 * 这句话把「我们自己超时主动 abort」和「对方中途断连」和「Node 版本行为」混成同一个样子，
 * 读的人无从判断该调超时、该换模型、还是该查网络。落到 UI 上就是「引擎异常：…」一句带过。
 *
 * 分支是按「能观察到的现象」分的，不去猜内部原因：
 *  - `AbortError` + 我们自己 abort 过 ⇒ 只能是超时（fetch 抛 AbortError 的另一条路径是
 *    调用方 abort，而这里唯一的 abort 来源就是那个 setTimeout）
 *  - 带 `code`（ENOENT/ECONNREFUSED…）⇒ 压根没连上
 *  - 其余按类型归类
 */
function describeError(e: unknown, timeoutMs: number): string {
  const name = e instanceof Error ? e.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return `请求超时（${Math.round(timeoutMs / 1000)}s）。VLM 读图比纯文本慢得多；`
      + `可在 AI 设置里调大超时，或减少一次送审的条目数。原始错误：${String(e)}`;
  }
  const code = (e as { code?: string } | null)?.code;
  if (code) return `网络失败（${code}）：连不上 AI 端点。检查 endpoint 是否可达、key 是否有效。原始错误：${String(e)}`;
  if (e instanceof SyntaxError) {
    return `响应不是合法 JSON（endpoint 可能不是 OpenAI 兼容格式，或返回了 HTML 错误页）。原始错误：${String(e)}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
