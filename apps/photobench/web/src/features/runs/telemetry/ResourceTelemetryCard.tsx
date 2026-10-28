import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import type { EChartsOption, EChartsType } from "echarts";
import type { Run } from "../../../api/types.ts";
import { fmtMemory } from "../../../lib/format.ts";
import {
  gpuMetricsView, RESOURCE_MEMORY_FIELDS, telemetryChart, telemetryLiveState,
  telemetryNumber, telemetryObservationRows, telemetryPlatform, telemetrySampleCount,
} from "../../../lib/telemetry.ts";

type Point = Record<string, any>;
type Line = { key: string; label: string; color?: string; gpu?: boolean };
type Graph = { title: string; unit: string; divisor: number; lines: Line[] };
const SCOPE_COLORS = ["#5470c6", "#c66b24", "#27866a"];
const PHASE_COLORS: Record<string, string> = {
  model_deploy: "#64748b", album_create: "#0891b2", identity_seed: "#6366f1",
  photo_import: "#0284c7", pipeline_processing: "#d97706", qa_eval: "#059669", gpu_metrics: "#9333ea",
};
const GRAPHS: Graph[] = [
  { title: "内存与显存占用", unit: "GiB", divisor: 1024,
    lines: RESOURCE_MEMORY_FIELDS.map(([label, key], i) => ({ label, key, color: SCOPE_COLORS[i % 3], gpu: i >= 3 })) },
  { title: "利用率", unit: "%", divisor: 1, lines: [{ key: "cpu_utilization_pct", label: "整机 CPU" }, { key: "gpu_utilization_pct", label: "GPU" }] },
  { title: "温度", unit: "°C", divisor: 1, lines: [{ key: "cpu_temperature_c", label: "CPU" }, { key: "temperature_c", label: "GPU" }] },
  { title: "功率", unit: "W", divisor: 1, lines: [{ key: "power_draw_w", label: "采集范围内功率" }] },
];

function option(graph: Graph, history: Point[], snapshots: boolean, sampledDown: boolean, phaseColors: boolean): EChartsOption {
  const start = telemetryNumber(history[0]?.t) ?? 0;
  const times = history.map((point, i) => snapshots ? i + 1 : (telemetryNumber(point.t) ?? start) - start);
  const areas: Array<[{ name: string; xAxis: number; itemStyle: { color: string } }, { xAxis: number }]> = [];
  const pieces: Array<{ gte: number; lt?: number; lte?: number; color: string }> = [];
  if (!snapshots) {
    let first = 0;
    for (let i = 1; i <= history.length; i++) {
      if (i < history.length && history[i]?.phase === history[first]?.phase) continue;
      if (history[first]?.phase) {
        const color = PHASE_COLORS[history[first]!.phase] ?? "#64748b";
        const end = times[Math.min(i, history.length - 1)]!;
        areas.push([
          { name: history[first]!.phase_label || history[first]!.phase, xAxis: times[first]!, itemStyle: { color: `${color}16` } },
          { xAxis: end },
        ]);
        pieces.push({ gte: times[first]!, ...(i === history.length ? { lte: end } : { lt: end }), color });
      }
      first = i;
    }
  }
  return {
    animation: false,
    grid: { left: 65, right: 35, top: 56, bottom: 80 },
    legend: { type: "scroll", top: 6 },
    tooltip: { trigger: "axis", confine: true, valueFormatter: (value) => typeof value === "number" ? `${value.toFixed(2)} ${graph.unit}` : "未采集" },
    xAxis: { type: "value", min: snapshots ? 1 : 0, max: times.at(-1), boundaryGap: [0, 0],
      name: snapshots ? "快照序号" : "经过时间（秒）", nameLocation: "middle", nameGap: 32 },
    yAxis: { type: "value", min: 0, name: graph.unit },
    dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 18, bottom: 4 }],
    visualMap: phaseColors && pieces.length ? [{ type: "piecewise", show: false, dimension: 0,
      seriesIndex: graph.lines.map((_, index) => index), pieces, outOfRange: { color: "#64748b" } }] : [],
    series: graph.lines.map((line, lineIndex) => {
      const points: Array<[number, number | null]> = [];
      history.forEach((point, i) => {
        if (i && !snapshots && (point.gap_before === true || (!sampledDown && times[i]! - times[i - 1]! > 3))) {
          points.push([(times[i]! + times[i - 1]!) / 2, null]);
        }
        const value = telemetryNumber(point[line.key]);
        points.push([times[i]!, value === null ? null : value / graph.divisor]);
      });
      return { name: line.label, type: "line", showSymbol: false, connectNulls: false, smooth: false, data: points,
        emphasis: { focus: "series", blurScope: "coordinateSystem", lineStyle: { width: 3 } },
        blur: { lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 } },
        itemStyle: { color: phaseColors ? "#64748b" : line.color },
        lineStyle: { ...(!phaseColors && line.color ? { color: line.color } : {}), type: line.gpu ? "dashed" as const : "solid" as const },
        ...(lineIndex === 0 && areas.length ? { markArea: { silent: true,
          label: { show: true, color: "#687888", fontSize: 10, position: "insideTop" as const }, data: areas } } : {}),
      };
    }),
  };
}

function ResourceGraph({ graph, history, snapshots, sampledDown, revision }: {
  graph: Graph; history: Point[]; snapshots: boolean; sampledDown: boolean; revision: string;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const previous = useRef("");
  const [phaseColors, setPhaseColors] = useState(false);
  useEffect(() => {
    if (!canvas.current || history.length < 2) return;
    chart.current ??= echarts.init(canvas.current);
    const drawingRevision = `${revision}:${phaseColors}`;
    if (previous.current !== drawingRevision) {
      chart.current.setOption(option(graph, history, snapshots, sampledDown, phaseColors), { replaceMerge: ["series", "visualMap"] });
      previous.current = drawingRevision;
    }
    chart.current.resize();
    const resize = () => chart.current?.resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(canvas.current);
    // A parent details element may be collapsed while the chart is mounted.
    const parents: HTMLDetailsElement[] = [];
    let element: HTMLElement | null = canvas.current.parentElement;
    while (element) {
      if (element instanceof HTMLDetailsElement) { parents.push(element); element.addEventListener("toggle", resize); }
      element = element.parentElement;
    }
    return () => { observer?.disconnect(); parents.forEach(parent => parent.removeEventListener("toggle", resize)); };
  }, [graph, history, snapshots, sampledDown, revision, phaseColors]);
  useEffect(() => () => { chart.current?.dispose(); chart.current = null; }, []);
  return <div className="telemetry-chart"><div className="telemetry-chart-header"><b>{graph.title}</b>
    {!snapshots && history.some(point => point.phase) ? <label>
      <input type="checkbox" checked={phaseColors} onChange={event => setPhaseColors(event.target.checked)} />曲线按阶段着色
    </label> : null}</div>
    {history.length >= 2
      ? <div ref={canvas} className="telemetry-chart-canvas" role="img" aria-label={`${graph.title}趋势`} />
      : <p className="muted">等待至少两个采样点。</p>}
    {!history.some(point => graph.lines.some(line => telemetryNumber(point[line.key]) !== null))
      ? <small className="muted">此范围未采集到有效数据。</small> : null}
  </div>;
}

const RESOURCE_LABELS: Record<string, string> = {
  model_process_memory: "主模型内存", product_process_memory: "产品内存", device_memory: "整机内存",
  model_gpu_memory: "主模型 GPU 内存", product_gpu_memory: "产品 GPU 内存", device_gpu_memory: "整机 GPU 内存",
  cpu_utilization: "CPU 利用率", gpu_utilization: "GPU 利用率", cpu_temperature: "CPU 温度",
  gpu_temperature: "GPU 温度", power: "功率",
};
const POWER_LABELS: Record<string, string> = {
  gpu_device: "NVIDIA 显卡功率", module_estimate: "AGX 模块功率估计", module_input: "NX 模块输入功率",
  macmon_sys_power: "Mac 系统功率估计", system: "Mac 系统功率估计", system_estimate: "Mac 系统功率估计",
};
export function ResourceTelemetryCard({ run }: { run: Run | null | undefined }) {
  const live = telemetryLiveState(run);
  const stats = gpuMetricsView(run);
  const latest: Point = live.latest ?? {};
  const history = useMemo(() => telemetryChart(run)?.history ?? [], [run]);
  const snapshots = !Array.isArray(live.history) || live.history.length < 2;
  const sampledDown = telemetrySampleCount(run) > history.length;
  const isMac = telemetryPlatform(latest) === "apple_unified" || live.source === "apple_unified";
  const fields = isMac
    ? [...RESOURCE_MEMORY_FIELDS.slice(0, 3), ["整机 GPU 分配（参考）", "device_gpu_memory_mib"] as const]
    : RESOURCE_MEMORY_FIELDS;
  const graph = useMemo(() => isMac
    ? { ...GRAPHS[0]!, lines: [...GRAPHS[0]!.lines.slice(0, 3),
      { ...GRAPHS[0]!.lines[5]!, label: "整机 GPU 分配（参考）" }] }
    : GRAPHS[0]!, [isMac]);
  const revision = JSON.stringify([history, snapshots, sampledDown, isMac]);
  const [extra, setExtra] = useState(false);
  const sampleCount = telemetrySampleCount(run);
  const diagnostics = telemetryObservationRows(run);
  if (!sampleCount && !diagnostics.length) return null;
  return <details open className="phase-card result-phase-card gpu-result-card live-telemetry-card">
    <summary className="phase-title"><b>实时资源遥测</b><span className={`phase-status ${live.status === "running" ? "running" : "completed"}`}>
      {live.status === "running" ? "实时更新中" : live.status === "stop_pending" ? "停止未确认" : "已停止"}
    </span></summary>
    <p className="metric-calc-time">内存与显存统一用 GiB 展示，实线为内存，虚线为 GPU 分配。默认同色表示相同范围，背景色区分阶段。悬浮图例可单独查看一项。产品包含主模型，各项不相加。</p>
    <div className="phase-metrics live-telemetry-metrics">{fields.map(([label, key]) =>
      <div className="phase-metric" key={key}><span>{label}</span>
        <strong>{telemetryNumber(latest[key]) === null ? "未采集" : fmtMemory(latest[key])}</strong>
        <small>采样峰值 {telemetryNumber(stats[key]?.peak) === null ? "未记录" : fmtMemory(stats[key].peak)}</small>
      </div>)}
    </div>
    <ResourceGraph {...{ graph, history, snapshots, sampledDown, revision }} />
    <small className="muted">{snapshots ? "阶段快照，横轴为序号。" : run?.history_mode === "full"
      ? `完整测评过程，${sampleCount} 个采样点，绘制 ${history.length} 点。`
      : `当前遥测窗口，绘制 ${history.length} 点，整轮已采集 ${sampleCount} 点。`}
      {!snapshots ? `${run?.history_mode === "full" ? "横轴从本轮首个采样点计时。" : ""}峰值来自全部有效采样，可缩放查看细节。` : ""}</small>
    <details onToggle={event => setExtra(event.currentTarget.open)}>
      <summary>利用率、温度与功率</summary>
      <p className="muted">功率范围：{POWER_LABELS[latest.power_scope || stats.power_scope] ?? "未记录"}。不同设备的功率范围可能不同。</p>
      {extra ? GRAPHS.slice(1).map(graph => <ResourceGraph key={graph.title} {...{ graph, history, snapshots, sampledDown, revision }} />) : null}
    </details>
    <details className="metric-definition-panel"><summary>指标说明与采集状态</summary>
      <p>Linux 进程内存取相关进程 PSS 合计；PSS 按比例分摊共享页。Mac 按整组进程估计驻留内存。整机内存为总物理内存减空闲页，包含驻留缓存。</p>
      <p>153 GPU 值来自 NVML；Orin 来自 nvmap 分配记录；Mac 仅显示 IORegistry 提供的整机 GPU 分配参考值，当前模型服务未提供进程 GPU 占用。统一内存设备上的 GPU 分配可能与进程内存重叠，两项不相加。产品 GPU 来源不齐时留空。</p>
      <p>目标每秒采样。来源超过 3 秒有效期即留空。利用率、温度、功率分别绘图，功率只表示标明的硬件范围。</p>
      {Object.entries(latest.resource_metrics ?? {}).filter(([, raw]) => (raw as Point).status !== "available").map(([key, raw]) =>
        <p key={key}>{RESOURCE_LABELS[key] ?? "资源指标"}：{(raw as Point).reason === "runtime_does_not_expose_process_gpu_bytes" ? "模型服务未提供进程 GPU 占用" : (raw as Point).reason === "product_gpu_sources_incomplete" ? "产品 GPU 来源未齐全" : "来源不可用或已过期"}</p>)}
      {diagnostics.map(row => <p key={row[0]}>{row[0]}：{row[1]} · {row[2]}</p>)}
    </details>
  </details>;
}
