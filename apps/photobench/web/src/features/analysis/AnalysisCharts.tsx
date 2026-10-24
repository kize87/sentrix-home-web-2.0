import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import type { AnalysisFilters, AnalysisReport } from "../../api/analysis.ts";

export function AnalysisChart({
  option,
  onClick,
  label,
}: {
  option: EChartsOption;
  onClick?: (name: string, value: unknown) => void;
  label: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<ReturnType<typeof echarts.init> | null>(null);
  const renderedOption = useRef<string | null>(null);
  const clickHandler = useRef(onClick);
  useEffect(() => {
    clickHandler.current = onClick;
  }, [onClick]);
  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current, undefined, { renderer: "svg" });
    instance.current = chart;
    chart.on("click", (event) => {
      clickHandler.current?.(event.name, event.value);
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      instance.current = null;
      renderedOption.current = null;
    };
  }, []);
  useEffect(() => {
    // Polling returns fresh objects for the same saved report. Heatmap renders
    // recreate labels, so submitting identical options restarts their fade-in.
    const nextOption = JSON.stringify(option);
    if (!instance.current || renderedOption.current === nextOption) return;
    instance.current.setOption({ ...option, animation: false });
    renderedOption.current = nextOption;
  }, [option]);
  return (
    <div
      role="img"
      aria-label={label}
      ref={element}
      className="analysis-chart"
    />
  );
}

const colors = ["#cf6159", "#d2a352", "#408f83", "#96a1b3"];
export function AnalysisCharts({
  report: r,
  filter,
}: {
  report: AnalysisReport;
  filter: (value: AnalysisFilters) => void;
}) {
  const errors = r.errors;
  const types = r.groups.question_type || [];
  const qs = types.map((x) => x.value);
  const es = errors.map((x) => x.code);
  const actions = ["answer", "refuse", "clarify", "none", "unknown"];
  const quality: EChartsOption = {
    color: colors,
    tooltip: { trigger: "axis" },
    legend: { top: 0, type: "scroll" },
    grid: { containLabel: true, top: 55, bottom: 30 },
    xAxis: { type: "category", data: ["题级", "对话轮级"] },
    yAxis: { type: "value", minInterval: 1 },
    series: ["0", "1", "2", "None"].map((score) => ({
      name: score === "None" ? "缺分" : `${score}分`,
      type: "bar",
      stack: "scores",
      data: [
        r.counts[`score_${score}`] || 0,
        r.counts[`turn_score_${score}`] || 0,
      ],
    })),
  };
  const errorOption: EChartsOption = {
    tooltip: { trigger: "axis" },
    legend: { top: 0, type: "scroll" },
    grid: { containLabel: true, top: 60, left: 10, bottom: 30 },
    xAxis: { type: "value", minInterval: 1 },
    yAxis: {
      type: "category",
      inverse: true,
      data: errors.map((x) => x.label),
    },
    series: [
      {
        name: "受影响题数",
        type: "bar",
        data: errors.map((x) => x.affected_items),
        itemStyle: { color: "#638eb4" },
      },
      {
        name: "最终执行失败题数",
        type: "bar",
        data: errors.map((x) => x.final_failed_items),
        itemStyle: { color: colors[0] },
      },
      {
        name: "已恢复题数",
        type: "bar",
        data: errors.map((x) => x.recovered_items),
        itemStyle: { color: colors[2] },
      },
    ],
  };
  const typeOption: EChartsOption = {
    color: colors,
    tooltip: { trigger: "axis" },
    legend: { top: 0, type: "scroll" },
    grid: { containLabel: true, top: 55, bottom: 50 },
    xAxis: { type: "category", data: qs, axisLabel: { rotate: 15 } },
    yAxis: { type: "value", minInterval: 1 },
    series: ["0", "1", "2", "None"].map((score) => ({
      name: score === "None" ? "缺分" : `${score}分`,
      type: "bar",
      stack: "scores",
      data: types.map((x) => Number(x[`score_${score}`] || 0)),
    })),
  };
  const heatmap: EChartsOption = {
    tooltip: {},
    grid: { containLabel: true, bottom: 80 },
    visualMap: {
      min: 0,
      max: Math.max(1, ...r.heatmap.map((x) => x.count)),
      orient: "horizontal",
      left: "center",
      bottom: 0,
    },
    xAxis: {
      type: "category",
      data: errors.map((x) => x.label),
      axisLabel: { rotate: 30 },
    },
    yAxis: { type: "category", data: qs },
    series: [
      {
        type: "heatmap",
        label: { show: true },
        data: r.heatmap.map((x) => [
          es.indexOf(x.code),
          qs.indexOf(x.question_type),
          x.count,
        ]),
      },
    ],
  };
  const matrix: EChartsOption = {
    tooltip: {},
    grid: { containLabel: true, bottom: 55 },
    visualMap: {
      min: 0,
      max: Math.max(1, ...r.behavior_matrix.map((x) => x.count)),
      orient: "horizontal",
      left: "center",
      bottom: 0,
    },
    xAxis: { type: "category", name: "实际", data: actions },
    yAxis: { type: "category", name: "预期", data: actions },
    series: [
      {
        type: "heatmap",
        label: { show: true },
        data: r.behavior_matrix.map((x) => [
          actions.indexOf(x.actual),
          actions.indexOf(x.expected),
          x.count,
        ]),
      },
    ],
  };
  return (
    <>
      <div className="analysis-grid">
        <article>
          <h4>质量分布</h4>
          <p>
            题 {r.item_count}，有效 {r.denominators.quality_valid}，缺分{" "}
            {r.denominators.quality_missing}；轮 {r.denominators.turns}，有效{" "}
            {r.denominators.turn_quality_valid}
          </p>
          <AnalysisChart label="分数分布" option={quality} />
        </article>
        <article>
          <h4>错误分布 · 点击筛选</h4>
          <p>
            分母 {r.item_count} 题；类别可重叠；共 {r.counts.events || 0} 次事件
          </p>
          <AnalysisChart
            label="错误分布"
            option={errorOption}
            onClick={(name) =>
              filter({ code: errors.find((x) => x.label === name)?.code || "" })
            }
          />
        </article>
        <article>
          <h4>题型表现 · 点击筛选</h4>
          <p>
            分母 {r.item_count} 题，未知题型{" "}
            {r.counts.missing_question_type || 0}；堆叠含缺分
          </p>
          <AnalysisChart
            label="题型表现"
            option={typeOption}
            onClick={(name) => filter({ question_type: name })}
          />
        </article>
        <article>
          <h4>题型 × 错误 · 点击筛选</h4>
          <p>
            分母 {r.item_count} 题，缺轨迹 {r.counts.missing_trace || 0}
            ；类别可重叠
          </p>
          <AnalysisChart
            label="题型错误热力图"
            option={heatmap}
            onClick={(_, value) => {
              if (Array.isArray(value))
                filter({
                  code: es[Number(value[0])],
                  question_type: qs[Number(value[1])],
                });
            }}
          />
        </article>
      </div>
      <h4>行为预期 × 实际 · 点击筛选</h4>
      <p>
        分母 {r.denominators.turns} 轮，有效 {r.denominators.behavior_valid}
        ，缺失 {r.denominators.behavior_missing}；未出现的行为为未覆盖。
      </p>
      <AnalysisChart
        label="行为混淆矩阵"
        option={matrix}
        onClick={(_, value) => {
          if (Array.isArray(value))
            filter({
              actual_action: actions[Number(value[0])],
              expected_action: actions[Number(value[1])],
            });
        }}
      />
    </>
  );
}
