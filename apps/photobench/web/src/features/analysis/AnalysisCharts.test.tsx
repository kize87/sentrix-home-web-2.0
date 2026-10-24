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
  expect(init).toHaveBeenCalledTimes(4);
  expect(chart.setOption).toHaveBeenCalledTimes(4);
  for (let poll = 0; poll < 12; poll++) {
    const refreshed = structuredClone(report);
    refreshed.source = { stale: poll % 2 === 0 };
    view.rerender(<AnalysisCharts report={refreshed} filter={latest} />);
  }
  expect(chart.setOption).toHaveBeenCalledTimes(4);
  expect(chart.dispose).not.toHaveBeenCalled();
  const clickHeatmap = chart.on.mock.calls[2]?.[1] as (e: {name: string; value: number[]}) => void;
  act(() => clickHeatmap({name: "", value: [0, 0, 1]}));
  expect(latest).toHaveBeenCalledWith(expect.objectContaining({code: "context_soft_limit", question_type: "fact"}));
  expect(first).not.toHaveBeenCalled();
  const changed = structuredClone(report);
  changed.errors[0]!.affected_items = 2;
  changed.heatmap[0]!.count = 2;
  view.rerender(<AnalysisCharts report={changed} filter={latest} />);
  expect(chart.setOption).toHaveBeenCalledTimes(6);
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
  const distribution = chart.setOption.mock.calls.find(([option]) => option.series?.[0]?.stack === "scores")?.[0];
  expect(distribution.series[0].data[0].label.show).toBe(true);
  expect(distribution.series[0].data[1].label.show).toBe(false);
  fireEvent.click(screen.getByLabelText("事件总结 答对（2分）"));
  expect(filter).toHaveBeenLastCalledWith(expect.objectContaining({task_type: "T5_event_summary", score: "2", code: ""}));
  fireEvent.change(screen.getByLabelText("分布分组方式"), {target: {value: "angle"}});
  fireEvent.click(screen.getByLabelText("时间 部分答对（1分）"));
  expect(filter).toHaveBeenLastCalledWith(expect.objectContaining({angle: "time", score: "1", task_type: ""}));
});

it("合并后的媒体检索与行为分类显示中文，窄柱段数字保留在表格", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const report = {
    item_count: 174, counts: {}, denominators: {turns: 174, turn_quality_valid: 174},
    groups: {task_type: [
      {value: "behavior", total: 129, score_2: 28, score_1: 40, score_0: 60, score_None: 1},
      {value: "T1_retrieve_media", total: 45, score_2: 2, score_1: 3, score_0: 40},
    ]}, errors: [], heatmap: [], behavior_matrix: [],
  } as unknown as AnalysisReport;
  const filter = vi.fn();
  render(<AnalysisCharts report={report} filter={filter} />);
  expect(screen.getAllByText("媒体检索")).toHaveLength(1);
  expect(screen.getByText("行为判断")).toBeTruthy();
  expect(screen.queryByText("behavior")).toBeNull();
  expect(screen.queryByText("怎么读这份报告")).toBeNull();
  const option = chart.setOption.mock.calls[0]?.[0];
  expect(option.yAxis.data).toEqual(["行为判断", "媒体检索"]);
  expect(option.series[0].data[1].label.show).toBe(false);
  expect(screen.getByLabelText("媒体检索 答对（2分）").textContent).toBe("2");
  fireEvent.click(screen.getByLabelText("媒体检索 答错（0分）"));
  expect(filter).toHaveBeenLastCalledWith(expect.objectContaining({task_type: "T1_retrieve_media", score: "0"}));
});

it("按得分看题型按题数排序，占比以该得分全部题为分母，图表和表格可查看案例", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const report = {
    item_count: 20, counts: {score_2: 5, score_0: 15}, denominators: {},
    groups: {task_type: [
      {value: "T1_retrieve_media", total: 11, score_2: 1, score_0: 10},
      {value: "behavior", total: 8, score_2: 3, score_0: 5},
      {value: "unknown", total: 1, score_2: 1},
    ]}, errors: [], heatmap: [], behavior_matrix: [],
  } as unknown as AnalysisReport;
  const filter = vi.fn();
  render(<AnalysisCharts report={report} filter={filter} />);
  fireEvent.click(screen.getByRole("button", {name: "按得分看题型"}));
  expect(screen.getByText("答对（2分） · 共5题")).toBeTruthy();
  expect(screen.getByText("60.0%")).toBeTruthy();
  expect(screen.getAllByText("20.0%")).toHaveLength(2);
  const scoreOption = () => chart.setOption.mock.calls.filter(([option]) => option.legend?.show === false).at(-1)![0];
  expect(scoreOption().yAxis.data).toEqual(["行为判断", "媒体检索", "未标注／未知"]);
  expect(scoreOption().series[0].data.map((x: {value: number}) => x.value)).toEqual([3, 1, 1]);
  fireEvent.click(screen.getByRole("button", {name: "行为判断 答对（2分）案例"}));
  expect(filter).toHaveBeenLastCalledWith(expect.objectContaining({task_type: "behavior", score: "2"}));
  fireEvent.change(screen.getByLabelText("分布显示方式"), {target: {value: "ratio"}});
  expect(scoreOption().series[0].data.map((x: {value: number}) => x.value)).toEqual([60, 20, 20]);
  fireEvent.change(screen.getByLabelText("分布得分"), {target: {value: "0"}});
  expect(scoreOption().yAxis.data).toEqual(["媒体检索", "行为判断"]);
  expect(screen.getByText("66.7%")).toBeTruthy();
  const click = chart.on.mock.calls.at(-1)![1] as (e: {name: string; value: number}) => void;
  act(() => click({name: "T1_retrieve_media", value: 66.7}));
  expect(filter).toHaveBeenLastCalledWith(expect.objectContaining({task_type: "T1_retrieve_media", score: "0"}));
  expect(chart.setOption.mock.calls.every(([, options]) => options.replaceMerge.includes("series"))).toBe(true);
  fireEvent.click(screen.getByRole("button", {name: "按题型看得分"}));
  expect(screen.queryByLabelText("分布得分")).toBeNull();
  expect(chart.setOption.mock.calls.at(-1)![0].series).toHaveLength(4);
});

it("所选得分无题、分类缺失及多标签重叠如实展示，不用全部题数计算比例", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const report = {item_count: 5, counts: {score_2: 2, score_1: 1}, denominators: {},
    groups: {task_type: [{value: "T2_fact_qa", total: 2, score_2: 2}, {value: "T5_event_summary", total: 1, score_2: 1}], angle: []},
    errors: [], heatmap: [], behavior_matrix: [],
  } as unknown as AnalysisReport;
  render(<AnalysisCharts report={report} filter={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", {name: "按得分看题型"}));
  expect(screen.getByText("100.0%")).toBeTruthy();
  expect(screen.getByText("50.0%")).toBeTruthy();
  expect(screen.getByText("一题可属于多类，各类占比合计可能超过100%。")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("分布得分"), {target: {value: "None"}});
  expect(screen.getByText("本轮没有未评分的题目。")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("分布得分"), {target: {value: "1"}});
  expect(screen.getByText("这些题未记录任务类型。")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("分布分组方式"), {target: {value: "angle"}});
  expect(screen.getByText("这些题未记录考察角度。")).toBeTruthy();
});
