import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AnalysisReport } from "../../api/analysis.ts";
import { AnalysisChart, AnalysisCharts } from "./AnalysisCharts.tsx";

const chart = vi.hoisted(() => ({
  setOption: vi.fn(), on: vi.fn(), resize: vi.fn(), dispose: vi.fn(),
}));
const init = vi.hoisted(() => vi.fn(() => chart));
vi.mock("echarts", () => ({ init }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("轮询更新复用图表实例并使用最新点击回调，卸载才释放", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const first = vi.fn();
  const next = vi.fn();
  const view = render(<AnalysisChart label="错误" option={{}} onClick={first} />);
  view.rerender(<AnalysisChart label="错误" option={{ series: [] }} onClick={next} />);
  expect(init).toHaveBeenCalledTimes(1);
  expect(chart.setOption).toHaveBeenCalledTimes(2);
  expect(chart.setOption.mock.calls.every(([option]) => option.animation === false)).toBe(true);
  expect(chart.dispose).not.toHaveBeenCalled();
  const click = chart.on.mock.calls[0]?.[1] as (event: {name: string; value: number}) => void;
  act(() => click({name: "超时", value: 2}));
  expect(next).toHaveBeenCalledWith("超时", 2);
  expect(first).not.toHaveBeenCalled();
  view.unmount();
  expect(chart.dispose).toHaveBeenCalledTimes(1);
});

it("轮询相同统计、修改筛选及仅来源变化时不重绘；真实统计变化仍更新且点击回调不滞后", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const report: AnalysisReport = {
    schema_version: 1, rule_version: 2, generated_at: 1,
    item_count: 10, source: {}, result_fingerprint: "r", gt_fingerprint: "g",
    counts: { score_0: 6, score_1: 2, score_2: 2, events: 1 },
    denominators: { quality_valid: 10, quality_missing: 0, turns: 10,
      turn_quality_valid: 10, behavior_valid: 10, behavior_missing: 0 },
    errors: [{ code: "context_soft_limit", label: "上下文软预算预检",
      events: 1, affected_items: 1, final_failed_items: 0, recovered_items: 1 }],
    groups: {task_type: [{value: "T5_event_summary", total: 10, score_0: 6, score_1: 2, score_2: 2}], question_type: [{value: "fact", total: 10, score_0: 6, score_1: 2, score_2: 2}]},
    heatmap: [{question_type: "fact", code: "context_soft_limit", count: 1}],
    behavior_matrix: [{expected: "answer", actual: "answer", count: 10}], definitions: [],
  };
  const first = vi.fn(), latest = vi.fn();
  const view = render(<AnalysisCharts report={report} filter={first} />);
  expect(init).toHaveBeenCalledTimes(5);
  expect(chart.setOption).toHaveBeenCalledTimes(5);
  for (let poll = 0; poll < 12; poll++) {
    const refreshed = structuredClone(report);
    refreshed.source = { stale: poll % 2 === 0 };
    view.rerender(<AnalysisCharts report={refreshed} filter={latest} />);
  }
  expect(chart.setOption).toHaveBeenCalledTimes(5);
  expect(chart.dispose).not.toHaveBeenCalled();
  const clickHeatmap = chart.on.mock.calls[3]?.[1] as (e: {name: string; value: number[]}) => void;
  act(() => clickHeatmap({name: "", value: [0, 0, 1]}));
  expect(latest).toHaveBeenCalledWith(expect.objectContaining({code: "context_soft_limit", question_type: "fact"}));
  expect(first).not.toHaveBeenCalled();
  const changed = structuredClone(report);
  changed.errors[0]!.affected_items = 2;
  changed.heatmap[0]!.count = 2;
  view.rerender(<AnalysisCharts report={changed} filter={latest} />);
  expect(chart.setOption).toHaveBeenCalledTimes(7);
  expect(chart.setOption.mock.calls.at(-1)?.[0].series[0].data).toEqual([[0, 0, 2]]);
  expect(chart.setOption.mock.calls.every(([option]) => option.animation === false)).toBe(true);
});

it("默认任务类型展示正确/部分/错误/未评分，点击类别与分数共同筛选；无评分不显示0%", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const report = { schema_version: 1, rule_version: 2, generated_at: 1, item_count: 4,
    source: {}, result_fingerprint: "r", gt_fingerprint: "g", counts: {score_2: 1, score_1: 1, score_0: 1, score_None: 1},
    denominators: {quality_valid: 3, quality_missing: 1}, errors: [], heatmap: [], behavior_matrix: [], definitions: [],
    groups: {task_type: [{value: "T5_event_summary", total: 2, score_2: 1, score_1: 1}, {value: "T3_enumeration", total: 1, score_0: 1}, {value: "unknown", total: 1, score_None: 1}],
      angle: [{value: "time", total: 4, score_2: 1, score_1: 1, score_0: 1, score_None: 1}]},
  } as AnalysisReport;
  const filter = vi.fn();
  render(<AnalysisCharts report={report} filter={filter} />);
  expect(screen.getByText("事件总结")).toBeTruthy();
  expect(screen.getByText("统计枚举")).toBeTruthy();
  expect(screen.getByText("未覆盖 / 0题")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("事件总结 答对（2分）"));
  expect(filter).toHaveBeenLastCalledWith(expect.objectContaining({task_type: "T5_event_summary", score: "2", code: ""}));
  fireEvent.change(screen.getByLabelText("分布分组方式"), {target: {value: "angle"}});
  fireEvent.click(screen.getByLabelText("时间 部分答对（1分）"));
  expect(filter).toHaveBeenLastCalledWith(expect.objectContaining({angle: "time", score: "1", task_type: ""}));
});
