/**
 * 评测记录表。逐行照搬 1.0 `services/photobench/frontend/src/App.vue:2989-3037`（只读权威）。
 *
 * 纯展示：运行列表与分页状态全部来自 `useRuns`（运行列表 hook，见 `hooks/useRuns.ts`），
 * 本组件不发请求、不持数据。
 *
 * `data-testid="runs-view"` 是 2.0 视图外壳的测试锚点（`App.test.tsx`）。挂在
 * `#runs-region` 上而不是另造一层包装节点——1.0 没有那层节点，多一个会偏离 DOM。
 *
 */
import type { RefObject } from "react";

import type { Run } from "../../api/types.ts";
import type { RunPageState } from "../../hooks/useRuns.ts";
import { albumName, duration, fmtDate, fmtPct, modelName, statusLabel } from "../../lib/format.ts";
import { modeBadgeClass, modeLabel } from "../../lib/qaBrowser.ts";

/** Compact list projection; never use Judge counts as a substitute for QA counts. */
function RunProgress({ run }: { run: Run }) {
  if (run.mode === "build") return <span className="muted" title="仅构建相册，不执行问答">—</span>;
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const phase = run.phases?.qa_eval;
  const progress = phase?.progress;
  const terminal = count(progress?.agent_completed) ?? count(phase?.agent_completed);
  const completed = terminal ?? count(run.summary?.completed);
  const total = count(progress?.agent_total) ?? count(phase?.agent_total) ??
    (run.qa_count === null ? null : count(run.qa_count) ?? count(run.summary?.total) ?? count(progress?.total));
  const label = completed === null && total === null ? "—" : `${completed ?? "—"}/${total ?? "—"}`;
  const basis = terminal === null ? "已保存题目记录" : "已结束题目（含明确失败）";
  const tooltip = [
    `${basis}：${completed ?? "未记录"} / ${total ?? "未记录"}`,
    "题目数量不表示答对或评分完整。",
  ];
  const scored = count(run.summary?.judge_valid_count);
  if (scored !== null) tooltip.push(`有效评分：${scored} / ${total ?? "未记录"}`);
  const valid = completed !== null && total !== null && total > 0 && completed <= total;
  if (completed !== null && total !== null && completed > total) tooltip.push("题目计数不一致，请查看详情。");
  return (
    <div className="run-progress" title={tooltip.join("\n")}>
      <span className="run-progress-count" aria-label={`${basis}：${label}`}>{label}</span>
      {valid ? <progress aria-label={`${basis}进度`} max={total} value={completed} /> : null}
    </div>
  );
}

export interface RunsTableProps {
  runs: Run[];
  runPage: RunPageState;
  activeRunId: string | null;
  onSelectRun: (run: Run) => void;
  onDeleteRun: (run: Run) => void;
  onChangeRunPage: (page: number) => void;
  /** 1.0 `#runs-region` 的滚动落点，由 `useRuns` 提供，不要自己 querySelector。 */
  regionRef: RefObject<HTMLElement | null>;
}

export function RunsTable({
  runs,
  runPage,
  activeRunId,
  onSelectRun,
  onDeleteRun,
  onChangeRunPage,
  regionRef,
}: RunsTableProps) {
  return (
    <section id="runs-region" className="section" ref={regionRef} data-testid="runs-view">
      <div className="section-head">
        <h2>评测记录</h2>
        {runPage.pages > 1 ? (
          <div className="pager">
            <button
              className="btn ghost compact"
              disabled={!runPage.has_previous}
              onClick={() => onChangeRunPage(runPage.page - 1)}
            >
              上一页
            </button>
            <span>
              {runPage.page} / {runPage.pages}
            </span>
            <button
              className="btn ghost compact"
              disabled={!runPage.has_next}
              onClick={() => onChangeRunPage(runPage.page + 1)}
            >
              下一页
            </button>
          </div>
        ) : null}
        <span className="muted">共 {runPage.total} 条</span>
      </div>
      {["pending", "running"].includes(String(runPage.scan?.state)) ? (
        <p className="muted">历史记录正在加载（已读取 {Number(runPage.scan?.scanned || 0)} 条），当前列表尚未完整。</p>
      ) : null}
      {runPage.scan?.state === "failed" ? <p className="error">历史记录加载失败：{String(runPage.scan.error || "未知原因")}</p> : null}
      <div className="runs-list">
        <table>
          <thead>
            <tr>
              <th>模型</th>
              <th>相册</th>
              <th>开始时间</th>
              <th>耗时</th>
              <th>状态</th>
              <th>题目</th>
              <th>媒体召回率</th>
              <th>质量均分</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.run_id}
                className={"run-row" + (activeRunId === run.run_id ? " selected" : "")}
                onClick={() => onSelectRun(run)}
              >
                <td>
                  <b>{modelName(run)}</b>
                  <span className={"mode-badge " + modeBadgeClass(run.mode)}>{modeLabel(run.mode)}</span>
                </td>
                <td className="muted small">{albumName(run)}</td>
                <td className="muted small">{fmtDate(run.started_at)}</td>
                <td className="muted small">{duration(run)}</td>
                <td>
                  <span className={"phase-status " + (run.status || "")}>{statusLabel(run.status)}</span>
                </td>
                <td><RunProgress run={run} /></td>
                <td>
                  {fmtPct(
                    run.summary?.media_retrieval_recall_macro ??
                      run.summary?.retrieval_recall_macro ??
                      run.summary?.retrieval_recall_mean,
                  )}
                </td>
                <td>{run.summary?.answer_quality_mean ?? "-"}</td>
                <td>
                  <button
                    className="btn danger compact"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteRun(run);
                    }}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
