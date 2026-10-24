import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import { dimensions, displayLabel, percent, scores } from "./presentation.ts";
import type { AnalysisFilters, AnalysisReport } from "../../api/analysis.ts";

export function AnalysisChart({
  option,
  onClick,
  label,
  height,
}: {
  option: EChartsOption;
  onClick?: (name: string, value: unknown) => void;
  label: string;
  height?: number;
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
    instance.current.setOption({ ...option, animation: false }, { replaceMerge: ["series"] });
    renderedOption.current = nextOption;
  }, [option]);
  return (
    <div
      role="img"
      aria-label={label}
      ref={element}
      className="analysis-chart"
      style={height ? { height } : undefined}
    />
  );
}

export function AnalysisCharts({ report: r, filter }: {
  report: AnalysisReport;
  filter: (value: AnalysisFilters) => void;
}) {
  const [dimension, setDimension] = useState("task_type");
  const [ratio, setRatio] = useState(false);
  const [perspective, setPerspective] = useState("category");
  const [score, setScore] = useState("2");
  const selectedScore = scores.find(s => s.value === score)!;
  const scoreTotal = r.counts[`score_${score}`] || 0;
  const rows = r.groups[dimension] || [];
  const scoreRows = rows.map(row => ({
    value: row.value, count: Number(row[`score_${score}`] || 0),
  })).filter(row => row.count > 0).sort((a, b) => b.count - a.count);
  const scoreOverlap = scoreRows.reduce((total, row) => total + row.count, 0) > scoreTotal;
  const errors = r.errors;
  const types = r.groups.question_type || [];
  const qs = types.map(x => x.value);
  const es = errors.map(x => x.code);
  const actions = ["answer", "refuse", "clarify", "none", "unknown"];
  const selectGroup = (value: AnalysisFilters) => filter({
    ...Object.fromEntries(Object.keys(dimensions).map(key => [key, ""])),
    code: "", anomaly: "", recovery: "", execution: "", expected_action: "", actual_action: "",
    ...value,
  });
  const distribution: EChartsOption = {
    color: scores.map(x => x.color),
    tooltip: { trigger: "axis" },
    legend: { show: true, top: 0, type: "scroll" },
    grid: { containLabel: true, top: 55, left: 10, right: 45, bottom: 25 },
    xAxis: { type: "value", minInterval: ratio ? undefined : 1, max: ratio ? 100 : undefined,
      axisLabel: { formatter: ratio ? "{value}%" : "{value}" } },
    yAxis: { type: "category", inverse: true, data: rows.map(x => displayLabel(x.value)) },
    series: scores.map(s => ({
      labelLayout: { hideOverlap: true },
      name: s.label, type: "bar", stack: "scores", label: { show: true, formatter: "{c}" },
      data: rows.map(x => ({ name: JSON.stringify([x.value, s.value]),
        value: ratio ? Number((Number(x[`score_${s.value}`] || 0) / Math.max(1, x.total) * 100).toFixed(1)) : Number(x[`score_${s.value}`] || 0), label: { show: Number(x[`score_${s.value}`] || 0) / Math.max(1, ratio ? x.total : Math.max(...rows.map(row => row.total))) >= 0.035, formatter: ratio ? "{c}%" : "{c}" } })),
    })),
  };
  const scoreDistribution: EChartsOption = {
    color: [selectedScore.color],
    tooltip: { trigger: "axis" },
    grid: { containLabel: true, top: 20, left: 10, right: 55, bottom: 25 },
    xAxis: { type: "value", minInterval: ratio ? undefined : 1, max: ratio ? 100 : undefined,
      axisLabel: { formatter: ratio ? "{value}%" : "{value}" } },
    yAxis: { type: "category", inverse: true, data: scoreRows.map(row => displayLabel(row.value)) },
    legend: { show: false },
    series: [{ name: selectedScore.label, type: "bar", label: { show: true, position: "right", formatter: ratio ? "{c}%" : "{c}" },
      data: scoreRows.map(row => ({ name: row.value,
        value: ratio ? Number((row.count / scoreTotal * 100).toFixed(1)) : row.count })) }],
  };
  const errorOption: EChartsOption = {
    tooltip: { trigger: "axis" }, legend: { top: 0, type: "scroll" },
    grid: { containLabel: true, top: 60, left: 10, right: 35, bottom: 25 },
    xAxis: { type: "value", minInterval: 1 },
    yAxis: { type: "category", inverse: true, data: errors.map(x => x.label) },
    series: [
      { name: "发生异常的题", type: "bar", data: errors.map(x => x.affected_items), itemStyle: { color: "#638eb4" } },
      { name: "最终执行失败", type: "bar", data: errors.map(x => x.final_failed_items), itemStyle: { color: "#c35550" } },
      { name: "异常已恢复", type: "bar", data: errors.map(x => x.recovered_items), itemStyle: { color: "#287c65" } },
    ],
  };
  const heatmap: EChartsOption = {
    tooltip: {}, grid: { containLabel: true, bottom: 90, left: 10 },
    visualMap: { min: 0, max: Math.max(1, ...r.heatmap.map(x => x.count)), orient: "horizontal", left: "center", bottom: 0 },
    xAxis: { type: "category", data: errors.map(x => x.label), axisLabel: { rotate: 30 } },
    yAxis: { type: "category", data: qs.map(displayLabel) },
    series: [{ type: "heatmap", label: { show: true }, data: r.heatmap.map(x => [es.indexOf(x.code), qs.indexOf(x.question_type), x.count]) }],
  };
  const matrix: EChartsOption = {
    tooltip: {}, grid: { containLabel: true, bottom: 55 },
    visualMap: { min: 0, max: Math.max(1, ...r.behavior_matrix.map(x => x.count)), orient: "horizontal", left: "center", bottom: 0 },
    xAxis: { type: "category", name: "实际", data: actions.map(displayLabel) },
    yAxis: { type: "category", name: "预期", data: actions.map(displayLabel) },
    series: [{ type: "heatmap", label: { show: true }, data: r.behavior_matrix.map(x => [actions.indexOf(x.actual), actions.indexOf(x.expected), x.count]) }],
  };
  return <>
    <article className="analysis-distribution">
      <h4>分类表现</h4>
      <div className="analysis-toolbar" role="group" aria-label="统计角度">
        <button className="btn compact" aria-pressed={perspective === "category"} onClick={() => setPerspective("category")}>按题型看得分</button>
        <button className="btn compact" aria-pressed={perspective === "score"} onClick={() => setPerspective("score")}>按得分看题型</button>
      </div>
      <div className="analysis-toolbar">
        {perspective === "score" && <label>得分<select aria-label="分布得分" value={score} onChange={e => setScore(e.target.value)}>
          {scores.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select></label>}
        <label>分组方式<select aria-label="分布分组方式" value={dimension} onChange={e => setDimension(e.target.value)}>
          {Object.entries(dimensions).filter(([key]) => key !== "expected_action").map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>显示方式<select aria-label="分布显示方式" value={ratio ? "ratio" : "count"} onChange={e => setRatio(e.target.value === "ratio")}>
          <option value="count">题数</option><option value="ratio">{perspective === "score" ? "占该得分题目的比例" : "组内占比"}</option>
        </select></label>
      </div>
      {perspective === "score" ? <>
        <p>{selectedScore.label} · 共{scoreTotal}题</p>
        {scoreOverlap && <p className="analysis-hint">一题可属于多类，各类占比合计可能超过100%。</p>}
        {scoreRows.length ? <>
          <AnalysisChart label="所选得分的分类分布" option={scoreDistribution} height={Math.max(270, scoreRows.length * 42 + 65)} onClick={value => selectGroup({ [dimension]: value, score })} />
          <div className="analysis-table-scroll"><table>
            <caption>{selectedScore.label}的{dimensions[dimension]}分布 · 点击题数查看案例</caption>
            <thead><tr><th>类别</th><th>题数</th><th>占这{scoreTotal}题的比例</th></tr></thead>
            <tbody>{scoreRows.map(row => <tr key={row.value}>
              <th title={row.value}>{displayLabel(row.value)}</th>
              <td><button className="analysis-number" aria-label={`${displayLabel(row.value)} ${selectedScore.label}案例`} onClick={() => selectGroup({ [dimension]: row.value, score })}>{row.count}</button></td>
              <td>{percent(row.count, scoreTotal)}</td>
            </tr>)}</tbody>
          </table></div>
        </> : <p>{scoreTotal ? `这些题未记录${dimensions[dimension]}。` : `本轮没有${selectedScore.label}的题目。`}</p>}
      </> : <>
      {rows.reduce((n, row) => n + row.total, 0) > r.item_count && <p className="analysis-hint">一题可属于多类，各类题数有重叠。</p>}
      {rows.length ? <>
        <AnalysisChart label="分类答对答错分布" option={distribution} height={Math.max(270, rows.length * 42 + 95)} onClick={name => {
          const value: unknown = JSON.parse(name);
          if (Array.isArray(value) && value.length === 2) selectGroup({ [dimension]: String(value[0]), score: String(value[1]) });
        }} />
        <div className="analysis-table-scroll"><table>
          <caption>{dimensions[dimension]}表现 · 点击数字筛选案例</caption>
          <thead><tr><th>类别</th><th>总题数</th>{scores.map(s => <th key={s.value}>{s.label}</th>)}<th>答对率 / 有效评分</th></tr></thead>
          <tbody>{rows.map(row => { const valid = row.total - Number(row.score_None || 0); return <tr key={row.value}>
            <th title={row.value}>{displayLabel(row.value)}</th>
            <td><button className="analysis-number" onClick={() => selectGroup({ [dimension]: row.value, score: "" })}>{row.total}</button></td>
            {scores.map(s => <td key={s.value}><button className="analysis-number" aria-label={`${displayLabel(row.value)} ${s.label}`} onClick={() => selectGroup({ [dimension]: row.value, score: s.value })}>{Number(row[`score_${s.value}`] || 0)}</button></td>)}
            <td>{percent(Number(row.score_2 || 0), valid)} / {valid}题</td>
          </tr>})}</tbody>
        </table></div>
      </> : <p>暂无{dimensions[dimension]}分类。</p>}
      </>}
    </article>
    <details className="analysis-advanced">
      <summary>进阶排查：运行异常与行为预期</summary>
      <p>异常统计包含最终答对的题。</p>
      <div className="analysis-grid">
        <article><h4>运行异常分布 · 点击筛选</h4><p>全部 {r.item_count} 题中，{r.counts.affected_items || 0}题发生过异常，共 {r.counts.events || 0} 次；类别可重叠。</p>
          {!errors.length && <p>未记录到运行异常。</p>}
          <AnalysisChart label="错误分布" option={errorOption} onClick={name => selectGroup({ code: errors.find(x => x.label === name)?.code || "", score: "" })} />
        </article>
        <article><h4>题型与运行异常</h4><p>缺轨迹 {r.counts.missing_trace || 0}题。</p>
          <AnalysisChart label="题型错误热力图" option={heatmap} onClick={(_, value) => {
            if (Array.isArray(value)) selectGroup({ code: es[Number(value[0])], question_type: qs[Number(value[1])], score: "" });
          }} />
        </article>
      </div>
      <h4>对话轮级评分</h4>
      <p>共 {r.denominators.turns} 轮，有效评分 {r.denominators.turn_quality_valid} 轮，未评分 {r.denominators.turns - r.denominators.turn_quality_valid} 轮。</p>
      <table><thead><tr>{scores.map(s => <th key={s.value}>{s.label}</th>)}</tr></thead><tbody><tr>{scores.map(s => <td key={s.value}>{r.counts[`turn_score_${s.value}`] || 0}轮</td>)}</tr></tbody></table>
      <h4>行为预期 × 实际 · 点击筛选</h4>
      <p>有效判定 {r.denominators.behavior_valid} 轮，未判定 {r.denominators.behavior_missing} 轮。</p>
      <AnalysisChart label="行为混淆矩阵" option={matrix} onClick={(_, value) => {
        if (Array.isArray(value)) selectGroup({ actual_action: actions[Number(value[0])], expected_action: actions[Number(value[1])], score: "" });
      }} />
    </details>
  </>;
}
