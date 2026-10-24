import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AnalysisChart } from "./AnalysisCharts.tsx";

const chart = vi.hoisted(() => ({
  setOption: vi.fn(), on: vi.fn(), resize: vi.fn(), dispose: vi.fn(),
}));
const init = vi.hoisted(() => vi.fn(() => chart));
vi.mock("echarts", () => ({ init }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("轮询更新复用图表实例并使用最新点击回调，卸载才释放", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const first = vi.fn();
  const next = vi.fn();
  const view = render(<AnalysisChart label="错误" option={{}} onClick={first} />);
  view.rerender(<AnalysisChart label="错误" option={{ series: [] }} onClick={next} />);
  expect(init).toHaveBeenCalledTimes(1);
  expect(chart.setOption).toHaveBeenCalledTimes(2);
  expect(chart.dispose).not.toHaveBeenCalled();
  const click = chart.on.mock.calls[0]?.[1] as (event: {name: string; value: number}) => void;
  act(() => click({name: "超时", value: 2}));
  expect(next).toHaveBeenCalledWith("超时", 2);
  expect(first).not.toHaveBeenCalled();
  view.unmount();
  expect(chart.dispose).toHaveBeenCalledTimes(1);
});
