/**
 * 每道题下面的全流程完整轨迹。
 *
 * 两条视图叠在一起，来源不同、用途也不同：
 *
 * 1. **Agent 全流程**（`turnTimeline`）：planner → 每次模型调用 → 它发起的工具 →
 *    语义评审 → 最终回答。每条模型调用展开就是**实际发送的 messages / tools** 与
 *    **原始回复**（正文、思考通道、原始工具调用参数）。
 * 2. **运行时事件**（`turn.trace`）：2.0 的原始进度流。每个已有步骤（规划 / 模型动作 /
 *    工具结果 / 评审 / 结束）都按 `step_id` / `parent_step_id` / `call_id` 挂回对应的
 *    那次模型调用，展开即可看到「模型这一步看到什么、回答什么」。
 *
 * 老 run 没有 `debug_calls` 时两个视图都回退到 1.0 的 `debug_trace`；缺数据的地方
 * 明确写「未记录」，不做推断。
 */
import { useState } from "react";
import type { ReactNode } from "react";
import type { RunItemDetail } from "../../api/types.ts";
import {
  callLabel,
  debugCallForStep,
  turnDebugCalls,
  turnProgressEvents,
  turnTimeline,
  runtimeTurns,
} from "../../lib/agentTrace.ts";
import type { Dict, TraceTimelineEntry } from "../../lib/agentTrace.ts";
import { conversationTurns } from "../../lib/evidence.ts";
import { esc, fmtMs } from "../../lib/format.ts";

import { ModelCallView } from "./ModelCallView.tsx";

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

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolTraceView({ tool }: { tool: Dict }) {
  return (
    <details className="model-tool-node">
      <summary>
        <strong>{String(tool.tool || tool.tool_name || "未知工具")}</strong>
        <span>{String(tool.status || "未记录")}</span>
        {tool.duration_ms != null ? <span>{String(tool.duration_ms)} ms</span> : null}
      </summary>
      <div className="model-tool-node-body">
        {tool.text ? <p className="muted small">{String(tool.text)}</p> : null}
        <p className="muted small">工具输入</p>
        <pre>{pretty(tool.arguments ?? {})}</pre>
        <p className="muted small">工具输出</p>
        <pre>{pretty(tool.result ?? tool.observation ?? {})}</pre>
      </div>
    </details>
  );
}

function TimelineEntryView({ entry }: { entry: TraceTimelineEntry }) {
  if (entry.kind === "tool") return <ToolTraceView tool={entry.tool ?? {}} />;
  if (entry.kind === "answer") {
    const attachments = entry.attachments ?? [];
    return (
      <section className="trace-answer-block">
        <h5>最终回答</h5>
        <p>{esc(entry.answer) || "未记录"}</p>
        {attachments.length ? (
          <>
            <p className="muted small">交付素材（{attachments.length}）</p>
            <pre>{pretty(attachments)}</pre>
          </>
        ) : null}
      </section>
    );
  }
  if (!entry.call) return null;
  const title =
    entry.kind === "planner" ? "规划器调用" : entry.kind === "judge" ? "语义评审调用" : undefined;
  return <ModelCallView call={entry.call} title={title} />;
}

const STEP_LABELS: Record<string, string> = {
  plan: "规划",
  status: "状态",
  model_action: "模型动作（发起工具调用）",
  tool_result: "工具结果",
  tool_error: "工具错误",
  judge: "语义评审",
  terminal: "结束",
  guard: "门禁 / 恢复",
};

function ProgressStepView({ turn, step, index }: { turn: Dict; step: Dict; index: number }) {
  // 两个来源：PhotoBench 投影过的 `debug_trace`（字段在顶层）与主 API 的原始
  // `trace` 事件（字段在 payload 里）。同一块 UI 要同时认。
  const payload =
    typeof step.payload === "object" && step.payload !== null ? (step.payload as Dict) : {};
  const type = String(step.type || step.kind || "");
  const linked = debugCallForStep(turn, step);
  const label = STEP_LABELS[type] || type || `步骤 ${index + 1}`;
  const tool = step.tool ?? payload.tool;
  const argumentsValue = step.arguments ?? payload.arguments;
  const observationValue = step.observation ?? payload.result ?? payload.observation;
  const parentStepId = step.parent_step_id ?? payload.parent_step_id;
  const hasToolData = argumentsValue != null || observationValue != null || tool;
  return (
    <Fold className={`debug-step debug-step-${type || "step"}`} summary={<>
        <span className="debug-step-index">{index + 1}</span>
        <strong>{label}</strong>
        <span className="debug-step-status">{String(step.status || "已记录")}</span>
        {tool ? <span>工具 · {String(tool)}</span> : null}
        {parentStepId ? <span>父步骤 · {String(parentStepId)}</span> : null}
        {linked ? <span className="debug-step-linked">含模型完整输入 / 输出</span> : null}
      </>}>{() => <>
      {step.text ? <p className="muted small">{String(step.text)}</p> : null}
      {hasToolData ? (
        <div className="debug-step-tool">
          {argumentsValue != null ? (
            <>
              <p className="muted small">工具输入</p>
              <pre>{pretty(argumentsValue)}</pre>
            </>
          ) : null}
          {observationValue != null ? (
            <>
              <p className="muted small">工具输出</p>
              <pre>{pretty(observationValue)}</pre>
            </>
          ) : null}
        </div>
      ) : null}
      {linked ? <ModelCallView call={linked} title={`这一步的模型调用 · ${callLabel(linked.call_type)}`} /> : null}
      {!linked && !hasToolData ? <pre className="debug-step-raw">{pretty(step)}</pre> : null}
    </>}</Fold>
  );
}

function LegacySteps({ turn }: { turn: Dict }) {
  const steps = Array.isArray(turn.debug_trace) ? (turn.debug_trace as Dict[]) : [];
  if (!steps.length) return null;
  return (
    <div className="debug-steps">
      {steps.map((step, index) => (
        <Step key={index} step={step} index={index} />
      ))}
    </div>
  );
}

export interface DebugTracePanelProps {
  detail: RunItemDetail;
}

export function DebugTracePanel({ detail }: DebugTracePanelProps) {
  const rawTurns = runtimeTurns(detail);
  const turns: Dict[] = rawTurns.length
    ? rawTurns
    : (conversationTurns(detail) as unknown as Dict[]);
  if (!turns.length) return null;

  const modelCallCount = rawTurns.reduce((sum, turn) => sum + turnDebugCalls(turn).length, 0);
  const hasDebug = modelCallCount > 0;

  return (
    <Fold className="call-node debug-trace-node" summary={<>
        <strong>全流程完整轨迹</strong>
        <span>
          {turns.length} 轮用户问答 · {modelCallCount} 次模型调用 · 含每步实际输入 / 原始输出
        </span>
      </>}>{() => <div className="debug-trace-body">
        {!hasDebug ? (
          <p className="debug-trace-missing">
            该结果没有记录模型的完整输入 / 输出：它可能跑在本次改动之前，或采集开关
            （include_debug）未打开。工具入参 / 结果与进度事件仍按原样展示。
          </p>
        ) : null}
        {turns.map((turn, turnIndex) => {
          const index = Number(turn.index);
          const resolvedIndex = Number.isInteger(index) ? index : turnIndex;
          const timeline = turnTimeline(detail, resolvedIndex);
          const events = turnProgressEvents(turn);
          return (
            <Fold key={resolvedIndex} className="debug-turn debug-turn-full" summary={<header className="debug-turn-head">
                <div>
                  <span className="debug-turn-index">第 {resolvedIndex + 1} 轮</span>
                  <strong>{esc(turn.message) || "问答"}</strong>
                </div>
                <span>
                  {turn.agent_status ? `状态 ${String(turn.agent_status)}` : "状态未记录"}
                  {turn.termination_reason ? ` · ${String(turn.termination_reason)}` : ""}
                </span>
              </header>}>{() => <>
              <div className="trace-user-message">
                <small>用户</small>
                <p>{esc(turn.message) || "未记录"}</p>
              </div>
              <div className="trace-timeline">
                <h5>Agent 全流程（按发生顺序）</h5>
                {timeline.length ? (
                  timeline.map((entry) => <TimelineEntryView key={entry.key} entry={entry} />)
                ) : (
                  <p className="muted small">没有可展示的模型调用。</p>
                )}
              </div>
              <details className="trace-progress-events">
                <summary>
                  运行时事件（2.0 进度流 · {events.length || (Array.isArray(turn.debug_trace) ? turn.debug_trace.length : 0)} 条）
                </summary>
                {events.length ? (
                  <div className="debug-steps">
                    {events.map((step, stepIndex) => (
                      <ProgressStepView key={stepIndex} turn={turn} step={step} index={stepIndex} />
                    ))}
                  </div>
                ) : (
                  <LegacySteps turn={turn} />
                )}
              </details>
            </>}</Fold>
          );
        })}
      </div>}
    </Fold>
  );
}
