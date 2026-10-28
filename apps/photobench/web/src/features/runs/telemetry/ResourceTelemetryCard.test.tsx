import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "../../../api/types.ts";
import { RESOURCE_PROTOCOL } from "../../../lib/telemetry.ts";
import { TelemetryCard } from "./TelemetryCard.tsx";
const charts = vi.hoisted(() => ({ instances: [] as any[], init: vi.fn() }));
vi.mock("echarts", () => ({ init: charts.init }));
beforeEach(() => {
  charts.instances.length = 0;
  charts.init.mockReset().mockImplementation(() => {
    const instance = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
    charts.instances.push(instance);
    return instance;
  });
});
afterEach(cleanup);
function run(): Run {
  const history = [0, 1, 5].map((t, i) => ({ t, protocol_version: RESOURCE_PROTOCOL,
    system_memory_used_mib: 1024, model_process_system_memory_used_mib: i === 1 ? null : 256,
    product_stack_memory_mib: 512, device_gpu_memory_mib: 2048, model_process_gpu_memory_mib: 1536,
    phase: i < 2 ? "photo_import" : "qa_eval", phase_label: i < 2 ? "数据导入" : "QA 测评",
    product_stack_gpu_memory_mib: null, cpu_utilization_pct: 50, power_draw_w: 10, power_scope: "macmon_sys_power" }));
  return { run_id: "new", status: "running", telemetry_live: { protocol_version: RESOURCE_PROTOCOL,
    source: "host_nvml", status: "running", samples_count: 3, history, latest: history[2],
    peak: { system_memory_used_mib: 2048 } } } as Run;
}
describe("resource telemetry v1", () => {
  it("draws two main graphs and preserves nulls and real gaps", () => {
    const view = render(<TelemetryCard run={run()} />);
    expect(charts.init).toHaveBeenCalledTimes(2);
    expect(view.getByRole("img", { name: "内存占用趋势" })).toBeTruthy();
    expect(view.getByRole("img", { name: "GPU 内存占用趋势" })).toBeTruthy();
    const memory = charts.instances[0].setOption.mock.calls[0][0];
    const gpu = charts.instances[1].setOption.mock.calls[0][0];
    expect(memory.series.map((s: any) => s.name)).toEqual(["主模型内存", "产品内存", "整机内存"]);
    expect(gpu.series.map((s: any) => s.name)).toEqual(["主模型 GPU 内存", "产品 GPU 内存", "整机／整卡 GPU 内存"]);
    expect(memory.xAxis.type).toBe("value");
    expect(memory.series[0].markArea.data[0]).toEqual([{ name: "数据导入", xAxis: 0 }, { xAxis: 5 }]);
    expect(memory.series[0].data).toEqual([[0, .25], [1, null], [3, null], [5, .25]]);
    expect(memory.series[0].connectNulls).toBe(false);
    expect(gpu.series[1].data.every((point: any[]) => point[1] === null)).toBe(true);
    expect(view.container.querySelector(".live-telemetry-metrics")?.textContent).not.toMatch(/KV|RSS|PSS|nvmap/);
  });
  it("shows only device GPU reference for Mac without filling model or product values", () => {
    const value = run();
    value.telemetry_live!.source = "apple_unified";
    value.telemetry_live!.latest!.model_process_gpu_memory_mib = null;
    const view = render(<TelemetryCard run={value} />);
    const gpu = charts.instances[1].setOption.mock.calls[0][0];
    expect(gpu.series.map((s: any) => s.name)).toEqual(["整机 GPU 分配（参考）"]);
    expect(gpu.series[0].data[0]).toEqual([0, 2]);
    const cards = view.container.querySelector(".live-telemetry-metrics")!;
    expect(cards.children.length).toBe(4);
    expect(cards.textContent).not.toContain("主模型 GPU 内存");
    expect(cards.textContent).not.toContain("产品 GPU 内存");
    expect(cards.textContent).toContain("整机 GPU 分配（参考）");
  });
  it("keeps instances across identical polling and disposes both on unmount", () => {
    const view = render(<TelemetryCard run={run()} />);
    view.rerender(<TelemetryCard run={run()} />);
    expect(charts.init).toHaveBeenCalledTimes(2);
    charts.instances.forEach(instance => expect(instance.setOption).toHaveBeenCalledTimes(1));
    view.unmount();
    charts.instances.forEach(instance => expect(instance.dispose).toHaveBeenCalledTimes(1));
  });
  it("expands three separate graphs for utilization, temperature and power", () => {
    const view = render(<TelemetryCard run={run()} />);
    const details = view.getByText("利用率、温度与功率").closest("details")!;
    expect(details.open).toBe(false);
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(charts.init).toHaveBeenCalledTimes(5);
    expect(charts.instances.slice(2).map(instance => instance.setOption.mock.calls[0][0].yAxis.name)).toEqual(["%", "°C", "W"]);
    expect(view.container.textContent).toContain("Mac 系统功率估计");
  });
  it("does not invent gaps between sparse downsampled points", () => {
    const value = run();
    value.telemetry_live!.samples_count = 30;
    render(<TelemetryCard run={value} />);
    expect(charts.instances[0].setOption.mock.calls[0][0].series[2].data).toEqual([[0, 1], [1, 1], [5, 1]]);
  });
});
