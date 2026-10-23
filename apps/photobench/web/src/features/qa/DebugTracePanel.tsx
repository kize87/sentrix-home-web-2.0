/** Saved runtime facts, rendered only when each level is opened. */
import { useState } from "react";
import type { ReactNode } from "react";
import type { RunItemDetail } from "../../api/types.ts";
import { esc, fmtMs } from "../../lib/format.ts";
import { runtimeDebugTurns } from "../../lib/trace.ts";

type Dict = Record<string, unknown>;
function dict(value: unknown): Dict {
  return typeof value === "object" && value !== null ? value as Dict : {};
}
function Fold({ className, summary, children }: { className: string; summary: ReactNode; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className={className} onToggle={(event) => {
    if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
  }}><summary>{summary}</summary>{open ? children() : null}</details>;
}
const labels: Record<string, string> = {
  model: "模型调用", model_action: "模型动作", tool: "工具调用", tool_result: "工具结果",
  judge: "内部评审", planner: "任务规划", plan: "任务规划", status: "状态变化", guard: "保护与收尾", terminal: "回合收尾",
};
function Step({ step, index }: { step: Dict; index: number }) {
  const kind = String(step.type || step.stage || "event");
  const debug = dict(step.debug);
  const label = labels[kind] || kind;
  const statusLabels: Record<string, string> = { complete: "完成", completed: "完成", running: "进行中", pending: "等待中", partial: "部分完成", failed: "失败", cancelled: "已取消", ok: "正常" };
  const rawStatus = esc(step.status) || esc(step.termination_reason);
  const status = statusLabels[rawStatus] || rawStatus || "已记录";
  const text = esc(step.text) || esc(step.message) || esc(step.raw_full) || esc(step.raw);
  const fields = kind === "model" ? [
    ["提示词", step.prompt], ["模型回答", step.raw_full ?? step.raw],
  ] : kind === "tool" ? [
    ["工具输入", step.arguments], ["工具输出", step.observation],
  ] : kind === "judge" ? [
    ["评判结论", { faithful: step.faithful, problems: step.problems }],
    ["评判提示词", debug.prompt], ["评判回答", debug.raw],
  ] : [["事件事实", step.payload ?? step]];
  return <Fold className={"debug-step debug-kind-" + kind} summary={<>
    <span className="debug-step-index">{index + 1}</span>
    <strong>{label}{step.tool ? " · " + esc(step.tool) : ""}</strong>
    {step.duration_ms != null ? <span className="debug-turn-meta">{fmtMs(step.duration_ms)}</span> : null}
    <span className="debug-step-status">{status}</span>
  </>}>{() => <div className="debug-step-content">
    {text && kind !== "model" ? <p className="debug-event-text">{text}</p> : null}
    {fields.map(([title, value], fieldIndex) => value == null ? null : <section key={fieldIndex} className="debug-field">
      <h5>{String(title)}</h5><pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
    </section>)}
    {kind === "model" && step.prompt == null ? <p className="muted small">此记录未采集完整提示词。</p> : null}
  </div>}</Fold>;
}
export interface DebugTracePanelProps { detail: RunItemDetail }
export function DebugTracePanel({ detail }: DebugTracePanelProps) {
  const turns = runtimeDebugTurns(detail);
  if (!turns.length) return null;
  return <Fold className="call-node debug-trace-node" summary={<>
    <strong>调试详情：完整运行时轨迹</strong>
    <span>{turns.length} 轮用户问答 · 按需展开已保存的事件与原始数据</span>
  </>}>{() => <div className="debug-trace-body">{turns.map((turn, turnIndex) => {
    const steps = (Array.isArray(turn.debug_trace) ? turn.debug_trace : []) as Dict[];
    return <Fold key={turnIndex} className="debug-turn" summary={<>
      <span className="debug-turn-index">第 {Number(turn.index ?? turnIndex) + 1} 轮</span>
      <strong>{esc(turn.message) || "问答"}</strong>
      <span className="debug-turn-meta">{steps.length} 个步骤</span>
    </>}>{() => <div className="debug-steps">{steps.map((step, index) => <Step key={index} step={step} index={index} />)}</div>}</Fold>;
  })}</div>}</Fold>;
}
