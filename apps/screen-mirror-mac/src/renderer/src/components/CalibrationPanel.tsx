import React from 'react';

import type { ExportGroundTruthResult, GroundTruthPair, GroundTruthVerdict } from '@shared/groundTruth';

import { pairDirection, pendingCounts, verdictLabel, type GroundTruthDigest } from '../lib/calibration';

interface CalibrationPanelProps {
  annotating: boolean;
  pairs: GroundTruthPair[];
  digest: GroundTruthDigest;
  /** 待配对组（canonicalId）。与画布上那圈品红框同源 */
  pending: string[];
  busy: boolean;
  /** 读写 / 导出的失败原因。⚠️ 不复用 `runError`：那是验收链路的错，混在一起会让人以为验收挂了 */
  error: string | null;
  /** 最近一次导出的结果（含落盘路径）。用户要把这个路径交出去，必须能选中复制 */
  exported: ExportGroundTruthResult | null;
  /** 有没有可预填的引擎结论 —— 没有时置灰预填按钮并说明原因 */
  hasEngineResult: boolean;
  nodeLabel: (canonicalId: string) => string;
  onAnnotatingChange: (value: boolean) => void;
  onTogglePending: (canonicalId: string) => void;
  onClearPending: () => void;
  onCommit: (verdict: GroundTruthVerdict) => void;
  onDeletePair: (id: string) => void;
  /** 点一行 = 在画布上框出这一组（复用匹配高亮通道） */
  onFocusPair: (pair: GroundTruthPair) => void;
  onSetNote: (id: string, note: string) => void;
  onPrefill: () => void;
  onExport: () => void;
}

const VERDICT_CLASS: Record<GroundTruthVerdict, string> = {
  matched: 'matched',
  'no-counterpart': 'absent',
  ignore: 'ignored',
};

/**
 * 标注面板（右栏第三个 tab）。
 *
 * ## 它回答的问题与另两个 tab 不同
 *
 * 「节点信息」回答「这个节点是什么」，「验收结果」回答「引擎认为哪里不对」，
 * 而这里回答的是**「正确答案是什么」** —— 引擎的对错要靠它才知道。所以它不复用
 * 任何验收结论，也不显示 verdict：面板里一旦混进引擎的判断，人就会不自觉地
 * 顺着它标（确认偏差），而这份数据的全部价值恰恰在于它是**独立**的。
 *
 * ## 为什么「预填」按钮要标注来源
 *
 * 「先铺一份引擎的答案、只改错的」是最省力的标注方式，但那些**没被改过的预填项
 * 不是独立证据**。按钮旁边就写明这一点，导出时也会按来源分开统计 ——
 * 否则这份数据看起来完美，实际只是把引擎的话抄了一遍（见 `prefillFromMatches`）。
 *
 * ⚠️ 面板里**不显示引擎在这条标注上对不对**：那个判断有一套「先看配错、再看漏配」
 * 的顺序规则，唯一的实现放在导出侧（`acceptance/groundTruthExport`）。
 * 在这里再写一份，面板与导出迟早给出两个答案，而它们看起来都像权威。
 */
const CalibrationPanel: React.FC<CalibrationPanelProps> = ({
  annotating,
  pairs,
  digest,
  pending,
  busy,
  error,
  exported,
  hasEngineResult,
  nodeLabel,
  onAnnotatingChange,
  onTogglePending,
  onClearPending,
  onCommit,
  onDeletePair,
  onFocusPair,
  onSetNote,
  onPrefill,
  onExport,
}) => {
  // 用 lib 里的同一个判定，不在这里自己 `startsWith('design:')` —— 前缀只有一处定义，
  // 两处各写一遍时，哪天前缀规则变了（例如加了第三方来源），面板就会静默数错
  const pendingStat = pendingCounts(pending);

  return (
    <div className="calib-panel">
      {/* 开关放在面板顶部而不是只在工具栏：从「验收结果」看到一条可疑的结论后，
          用户的下一步就是来这儿把正确答案标下来 —— 入口应该在他正看着的地方。 */}
      <div className="calib-head">
        <button
          type="button"
          className={`calib-toggle${annotating ? ' on' : ''}`}
          aria-pressed={annotating}
          onClick={() => onAnnotatingChange(!annotating)}
        >
          {annotating ? '● 标注模式已开' : '○ 开启标注模式'}
        </button>
        <span className="calib-head-hint">
          {annotating
            ? '在画布上点选节点加入待配对组；Esc 清空，Enter 提交为「配对」'
            : '开启后在画布上点选两侧节点，手工把同一个元素配起来'}
        </span>
      </div>

      <div className="calib-digest">
        <span className="calib-stat">
          <b>{digest.total}</b> 条标注
        </span>
        <span className="calib-stat matched">
          配对 <b>{digest.matched}</b>
        </span>
        <span className="calib-stat absent">
          另一侧不存在 <b>{digest.noCounterpart}</b>
        </span>
        <span className="calib-stat ignored">
          忽略 <b>{digest.ignore}</b>
        </span>
        <span className="calib-stat muted">
          节点 {digest.designNodes} 设计 / {digest.appNodes} App
        </span>
        {digest.prefilled > 0 && (
          <span
            className="calib-stat warn"
            title="这部分的结论来自引擎、你还没有改过。它们不算独立证据，导出时会计入 prefilledPairs"
          >
            引擎预填 <b>{digest.prefilled}</b>
          </span>
        )}
      </div>

      <div className="calib-actions">
        <button
          type="button"
          className="calib-btn"
          disabled={busy || !hasEngineResult}
          title={
            hasEngineResult
              ? '把引擎已匹配的结论铺成草稿（标为「引擎预填」，导出时单独统计）'
              : '还没有引擎结论 —— 先去「验收结果」跑一次'
          }
          onClick={onPrefill}
        >
          从引擎结论预填
        </button>
        <button
          type="button"
          className="calib-btn primary"
          disabled={busy || pairs.length === 0}
          title={pairs.length === 0 ? '还没有任何标注' : '导出成一份自足 JSON（答案 + 引擎基线 + 全量可匹配节点）'}
          onClick={onExport}
        >
          导出标注
        </button>
      </div>

      {error && <div className="calib-message error">{error}</div>}

      {exported && !error && (
        <div className="calib-message ok">
          <div>
            已导出 <b>{exported.pairCount}</b> 条标注（{(exported.bytes / 1024).toFixed(1)} KB）
          </div>
          {/* 路径要能整段选中复制：这个文件是交给别人分析的，靠肉眼抄路径最容易错一个字符 */}
          <code className="calib-path" title="点击全选">
            {exported.file}
          </code>
        </div>
      )}

      {/* 待配对组。开标注模式时**常驻**（哪怕空着）—— 它是「现在做哪一步」的唯一提示，
          空着的时候正好用来显示「先在画布上点节点」这句引导。 */}
      {annotating && (
        <div className="calib-pending">
          <div className="calib-pending-head">
            <span className="calib-pending-title">待配对组</span>
            <span className="calib-pending-count">
              设计 {pendingStat.design} · App {pendingStat.app}
            </span>
            <button
              type="button"
              className="calib-mini"
              disabled={pending.length === 0}
              onClick={onClearPending}
            >
              清空
            </button>
          </div>
          {pending.length === 0 ? (
            <p className="calib-pending-empty">在画布上点选节点（可以两侧都点，也可以只点一侧）</p>
          ) : (
            <div className="calib-pending-list">
              {pending.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`calib-chip removable ${id.startsWith('design:') ? 'design' : 'app'}`}
                  title="移出待配对组"
                  onClick={() => onTogglePending(id)}
                >
                  {nodeLabel(id)} ×
                </button>
              ))}
            </div>
          )}
          <div className="calib-pending-actions">
            <button
              type="button"
              className="calib-btn primary"
              disabled={pending.length === 0 || busy}
              onClick={() => onCommit('matched')}
            >
              配对
            </button>
            <button
              type="button"
              className="calib-btn"
              disabled={pending.length === 0 || busy}
              onClick={() => onCommit('no-counterpart')}
            >
              另一侧不存在
            </button>
            <button
              type="button"
              className="calib-btn"
              disabled={pending.length === 0 || busy}
              onClick={() => onCommit('ignore')}
            >
              忽略
            </button>
          </div>
        </div>
      )}

      <div className="calib-list">
        {pairs.length === 0 ? (
          <p className="calib-empty">
            还没有标注。
            <br />
            标注是「引擎算得对不对」的答案，与「人工锚点」是两回事 ——
            它只被导出，不会被匹配引擎读取。
          </p>
        ) : (
          pairs.map((pair) => (
            <div key={pair.id} className={`calib-row ${VERDICT_CLASS[pair.verdict]}`}>
              <div className="calib-row-head">
                <button
                  type="button"
                  className="calib-row-verdict"
                  title="在画布上框出这一组"
                  onClick={() => onFocusPair(pair)}
                >
                  {verdictLabel(pair.verdict)}
                </button>
                {pair.origin === 'engine-prefill' && (
                  <span className="calib-tag prefill" title="由引擎结论预填，还没被人工改动">
                    预填
                  </span>
                )}
                <span className="calib-row-direction">{pairDirection(pair)}</span>
                <button
                  type="button"
                  className="calib-mini danger"
                  title="删除这条标注"
                  onClick={() => onDeletePair(pair.id)}
                >
                  ×
                </button>
              </div>

              <div className="calib-row-nodes">
                {pair.designNodeIds.map((id) => (
                  <span key={id} className="calib-chip design readonly" title={id}>
                    {nodeLabel(id)}
                  </span>
                ))}
                {pair.designNodeIds.length > 0 && pair.appNodeIds.length > 0 && (
                  <span className="calib-row-arrow">↔</span>
                )}
                {pair.appNodeIds.map((id) => (
                  <span key={id} className="calib-chip app readonly" title={id}>
                    {nodeLabel(id)}
                  </span>
                ))}
              </div>

              {/* 备注：默认折叠成一行输入。它是我读导出时唯一能拿到的「为什么这么标」，
                  而很多判定（运营配的文案、只在登录后出现的浮层）从数据里看不出来。 */}
              <input
                className="calib-note"
                type="text"
                defaultValue={pair.note ?? ''}
                placeholder="备注（为什么这么标？导出后这是唯一的解释来源）"
                onBlur={(event) => {
                  if (event.target.value.trim() !== (pair.note ?? '')) {
                    onSetNote(pair.id, event.target.value);
                  }
                }}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default CalibrationPanel;
