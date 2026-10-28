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
type Line = { key: string; label: string };
type Graph = { title: string; unit: string; divisor: number; lines: Line[] };
const GRAPHS: Graph[] = [
  { title: "内存占用", unit: "GiB", divisor: 1024, lines: RESOURCE_MEMORY_FIELDS.slice(0, 3).map(([label, key]) => ({ label, key })) },
  { title: "GPU 内存占用", unit: "GiB", divisor: 1024, lines: RESOURCE_MEMORY_FIELDS.slice(3).map(([label, key]) => ({ label, key })) },
  { title: "利用率", unit: "%", divisor: 1, lines: [{ key: "cpu_utilization_pct", label: "整机 CPU" }, { key: "gpu_utilization_pct", label: "GPU" }] },
  { title: "温度", unit: "°C", divisor: 1, lines: [{ key: "cpu_temperature_c", label: "CPU" }, { key: "temperature_c", label: "GPU" }] },
  { title: "功率", unit: "W", divisor: 1, lines: [{ key: "power_draw_w", label: "采集范围内功率" }] },
];

function option(graph: Graph, history: Point[], snapshots: boolean, sampledDown: boolean): EChartsOption {
  const start = telemetryNumber(history[0]?.t) ?? 0;
  const times = history.map((point, i) => snapshots ? i + 1 : (telemetryNumber(point.t) ?? start) - start);
  const areas: Array<[{ name: string; xAxis: number }, { xAxis: number }]> = [];
  if (!snapshots) {
    let first = 0;
    for (let i = 1; i <= history.length; i++) {
      if (i < history.length && history[i]?.phase === history[first]?.phase) continue;
      if (history[first]?.phase) areas.push([
        { name: history[first]!.phase_label || history[first]!.phase, xAxis: times[first]! },
        { xAxis: times[Math.min(i, history.length - 1)]! },
      ]);
      first = i;
    }
  }
  return {
    animation: false,
    grid: { left: 65, right: 28, top: 56, bottom: 65 },
    legend: { type: "scroll", top: 6 },
    tooltip: { trigger: "axis", confine: true, valueFormatter: (value) => typeof value === "number" ? `${value.toFixed(2)} ${graph.unit}` : "未采集" },
    xAxis: { type: "value", min: snapshots ? 1 : 0, name: snapshots ? "快照序号" : "经过时间（秒）" },
    yAxis: { type: "value", min: 0, name: graph.unit },
    dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 18, bottom: 14 }],
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
        ...(lineIndex === 0 && areas.length ? { markArea: { silent: true, itemStyle: { color: "rgba(120,140,160,0.06)" },
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
  useEffect(() => {
    if (!canvas.current || history.length < 2) return;
    chart.current ??= echarts.init(canvas.current);
    if (previous.current !== revision) {
      chart.current.setOption(option(graph, history, snapshots, sampledDown), true);
      previous.current = revision;
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
  }, [graph, history, snapshots, sampledDown, revision]);
  useEffect(() => () => { chart.current?.dispose(); chart.current = null; }, []);
  return <div className="telemetry-chart"><b>{graph.title}</b>
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
  const graphs = useMemo(() => isMac
    ? [GRAPHS[0]!, { ...GRAPHS[1]!, lines: [{ key: "device_gpu_memory_mib", label: "整机 GPU 分配（参考）" }] }]
    : GRAPHS.slice(0, 2), [isMac]);
  const revision = JSON.stringify([history, snapshots, sampledDown, isMac]);
  const [extra, setExtra] = useState(false);
  const sampleCount = telemetrySampleCount(run);
  const diagnostics = telemetryObservationRows(run);
  if (!sampleCount && !diagnostics.length) return null;
  return <details open className="phase-card result-phase-card gpu-result-card live-telemetry-card">
    <summary className="phase-title"><b>实时资源遥测</b><span className={`phase-status ${live.status === "running" ? "running" : "completed"}`}>
      {live.status === "running" ? "实时更新中" : live.status === "stop_pending" ? "停止未确认" : "已停止"}
    </span></summary>
    <p className="metric-calc-time">内存与 GPU 分配分开统计。产品包含主模型。缺失值显示为未采集，曲线断开。</p>
    <div className="phase-metrics live-telemetry-metrics">{fields.map(([label, key]) =>
      <div className="phase-metric" key={key}><span>{label}</span>
        <strong>{telemetryNumber(latest[key]) === null ? "未采集" : fmtMemory(latest[key])}</strong>
        <small>采样峰值 {telemetryNumber(stats[key]?.peak) === null ? "未记录" : fmtMemory(stats[key].peak)}</small>
      </div>)}
    </div>
    {graphs.map(graph => <ResourceGraph key={graph.title} {...{ graph, history, snapshots, sampledDown, revision }} />)}
    <small className="muted">{snapshots ? "阶段快照，横轴为序号。" : run?.history_mode === "full"
      ? `完整测评过程，${sampleCount} 个采样点，绘制 ${history.length} 点。`
      : `当前遥测窗口，绘制 ${history.length} 点，整轮已采集 ${sampleCount} 点。`}
      {!snapshots ? "横轴从窗口首点计时。峰值来自全部有效采样。" : ""}</small>
    <details onToggle={event => setExtra(event.currentTarget.open)}>
      <summary>利用率、温度与功率</summary>
      <p className="muted">功率范围：{POWER_LABELS[latest.power_scope || stats.power_scope] ?? "未记录"}。不同设备的功率范围可能不同。</p>
      {extra ? GRAPHS.slice(2).map(graph => <ResourceGraph key={graph.title} {...{ graph, history, snapshots, sampledDown, revision }} />) : null}
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
