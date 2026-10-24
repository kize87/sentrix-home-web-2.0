import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, post } from "../../api/client.ts";
import type { AnalysisReport } from "../../api/analysis.ts";
import { ErrorAnalysisPanel } from "./ErrorAnalysisPanel.tsx";

vi.mock("../../api/client.ts", () => ({
  BASE: "/api/v1",
  api: vi.fn(),
  post: vi.fn(),
}));
vi.mock("./AnalysisCharts.tsx", () => ({
  AnalysisCharts: ({
    filter,
  }: {
    filter: (x: Record<string, string>) => void;
  }) => (
    <button onClick={() => filter({ code: "context_soft_limit" })}>
      选择上下文异常柱
    </button>
  ),
}));
const scrollIntoView = vi.fn();
beforeEach(() => { HTMLElement.prototype.scrollIntoView = scrollIntoView; });
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const report: AnalysisReport = {
  schema_version: 1,
  rule_version: 1,
  generated_at: 1,
  item_count: 1,
  source: { status: "completed" },
  result_fingerprint: "r",
  gt_fingerprint: "g",
  counts: { execution_normal: 1, affected_items: 1 },
  denominators: {
    qa: 1,
    quality_valid: 1,
    quality_missing: 0,
    turns: 1,
    turn_quality_valid: 1,
    behavior_valid: 1,
    behavior_missing: 0,
    model_calls: 2,
    tool_calls: 1,
    tool_json_recorded: 1,
  },
  errors: [
    {
      code: "context_soft_limit",
      label: "上下文软预算预检",
      affected_items: 1,
      events: 1,
      final_failed_items: 0,
      recovered_items: 1,
    },
  ],
  groups: { question_type: [{ value: "fact", total: 1 }] },
  heatmap: [],
  behavior_matrix: [],
  definitions: ["恢复有来源"],
};
function setup(stale = false) {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.startsWith("/runs?")) return { runs: [{ run_id: "r", status: "completed" }, { run_id: "other", status: "completed", qa_set: "sample", model_name: "model" }], has_next: false } as never;
    if (path === "/config")
      return {
        judge_providers: [{ id: "test", label: "诊断", model: "J" }],
      } as never;
    if (path.includes("/cases?"))
      return {
        items: [
          {
            index: 0,
            qa_id: "q1",
            question: "Q",
            answer: "A",
            reference_answer: "GT",
            score: 0,
            execution: "normal",
            dimensions: {},
            events: [],
            turns: [],
            missing: [],
            signals: [],
            text_truncated: false,
          },
        ],
        total: 1,
        page: 1,
        page_size: 20,
      } as never;
    return {
      job_id: "j",
      run_id: "r",
      kind: "rules",
      status: "completed",
      processed: 1,
      stale,
      report,
    } as never;
  });
}
describe("错误分析闭环", () => {
  it("来源过期时禁用对比与AI，即使已选择案例和模型", async () => {
    setup(true);
    render(<ErrorAnalysisPanel runId="r" terminal />);
    fireEvent.click(screen.getByText("错误分析 展开"));
    await screen.findByLabelText("选择 q1");
    fireEvent.click(screen.getByLabelText("选择 q1"));
    fireEvent.change(screen.getByLabelText("分析模型"), {target: {value: "test"}});
    fireEvent.change(screen.getByLabelText("选择对比运行"), {target: {value: "other"}});
    expect((screen.getByText("创建对比报告") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("确认并分析所选案例") as HTMLButtonElement).disabled).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
  it("折叠时不读取报告和轨迹；图表筛选和导出使用相同条件", async () => {
    setup();
    render(<ErrorAnalysisPanel runId="r" terminal />);
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("错误分析 展开"));
    await screen.findByText("选择上下文异常柱");
    fireEvent.click(screen.getByText("选择上下文异常柱"));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.stringContaining("code=context_soft_limit"),
      ),
    );
    expect(screen.getByText("导出 HTML").getAttribute("href")).toContain(
      "code=context_soft_limit",
    );
    expect(vi.mocked(api).mock.calls.some(([p]) => p.includes("/items/"))).toBe(
      false,
    );
    expect(screen.getByLabelText("运行异常类别")).toHaveProperty(
      "value",
      "context_soft_limit",
    );
  });
  it("AI默认不运行，必须选择案例和模型并确认，发送最多20题的明确索引", async () => {
    setup();
    vi.mocked(post).mockResolvedValue({
      job_id: "ai",
      kind: "ai",
      status: "queued",
      processed: 0,
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ErrorAnalysisPanel runId="r" terminal />);
    fireEvent.click(screen.getByText("错误分析 展开"));
    await screen.findByLabelText("选择 q1");
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("选择 q1"));
    fireEvent.change(screen.getByLabelText("分析模型"), {
      target: { value: "test" },
    });
    fireEvent.click(screen.getByText("确认并分析所选案例"));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/runs/r/analysis", {
        kind: "ai",
        parent_job: "j",
        indices: [0],
        provider_id: "test",
      }),
    );
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("J"));
    confirm.mockRestore();
  });
  it("拒绝确认时不启动AI", async () => {
    setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ErrorAnalysisPanel runId="r" terminal />);
    fireEvent.click(screen.getByText("错误分析 展开"));
    await screen.findByLabelText("选择 q1");
    fireEvent.click(screen.getByLabelText("选择 q1"));
    fireEvent.change(screen.getByLabelText("分析模型"), {
      target: { value: "test" },
    });
    fireEvent.click(screen.getByText("确认并分析所选案例"));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(post).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

it("全选本页、快捷选低分及异常题只选择不发模型请求，保留分类并限制20题", async () => {
  setup();
  const fallback = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path.includes("page_size=100")) return {items: Array.from({length: 25}, (_, index) => ({index})), total: 25} as never;
    return fallback(path, options);
  });
  render(<ErrorAnalysisPanel runId="r" terminal />);
  fireEvent.click(screen.getByText("错误分析 展开"));
  await screen.findByLabelText("选择 q1");
  fireEvent.click(screen.getByText("全选本页"));
  expect((screen.getByLabelText("选择 q1") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByText("选择未完全答对题"));
  await screen.findByText(/未完全答对题：已选 20 题/);
  expect(api).toHaveBeenCalledWith(expect.stringContaining("score=low"));
  fireEvent.click(screen.getByText("选择运行异常题"));
  await screen.findByText(/运行异常题：已选 20 题/);
  expect(api).toHaveBeenCalledWith(expect.stringContaining("anomaly=yes"));
  expect(post).not.toHaveBeenCalled();
});

it("下拉选择运行后无需手输ID，可直接创建对比", async () => {
  setup();
  vi.mocked(post).mockResolvedValue({job_id: "compare", status: "completed", processed: 0});
  render(<ErrorAnalysisPanel runId="r" terminal />);
  fireEvent.click(screen.getByText("错误分析 展开"));
  await screen.findByRole("option", {name: /model.*sample/});
  fireEvent.change(screen.getByLabelText("选择对比运行"), {target: {value: "other"}});
  fireEvent.click(screen.getByText("创建对比报告"));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/runs/r/analysis", {kind: "compare", left_job: "j", right_job: "j"}));
  expect(screen.queryByLabelText("对比Run ID")).toBeNull();
});

it("另一轮无报告时自动准备规则报告，完成后衔接对比", async () => {
  setup();
  const fallback = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/runs/other/analysis") return {status: "not_generated"} as never;
    if (path === "/analyses/prepared") return {job_id: "prepared", status: "completed", processed: 1} as never;
    return fallback(path, options);
  });
  vi.mocked(post).mockImplementation(async (path) => ({job_id: path === "/runs/other/analysis" ? "prepared" : "comparison", status: path === "/runs/other/analysis" ? "queued" : "completed", processed: 0}) as never);
  render(<ErrorAnalysisPanel runId="r" terminal />);
  fireEvent.click(screen.getByText("错误分析 展开"));
  await screen.findByRole("option", {name: /model.*sample/});
  fireEvent.change(screen.getByLabelText("选择对比运行"), {target: {value: "other"}});
  fireEvent.click(screen.getByText("创建对比报告"));
  await screen.findByText(/正在准备所选运行的规则报告/);
  await waitFor(() => expect(post).toHaveBeenCalledWith("/runs/r/analysis", {kind: "compare", left_job: "j", right_job: "prepared"}), {timeout: 3500});
  expect(post).toHaveBeenCalledWith("/runs/other/analysis", {kind: "rules"});
});

it("统计点击将焦点和视口移到案例，案例在AI和对比之前；下拉筛选不跳页", async () => {
  setup();
  render(<ErrorAnalysisPanel runId="r" terminal />);
  fireEvent.click(screen.getByText("错误分析 展开"));
  await screen.findByLabelText("选择 q1");
  const heading = screen.getByRole("heading", {name: "题目列表"});
  expect(scrollIntoView).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("选择上下文异常柱"));
  expect(document.activeElement).toBe(heading);
  expect(scrollIntoView).toHaveBeenCalledWith({block: "start", behavior: "instant"});
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("筛选命中 1/1题"));
  const card = screen.getByLabelText("选择 q1").closest("details")!;
  for (const title of ["AI 辅助分析", "两轮逐题对比"]) {
    expect(card.compareDocumentPosition(screen.getByRole("heading", {name: title})) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  const calls = scrollIntoView.mock.calls.length;
  fireEvent.change(screen.getByLabelText("回答结果"), {target: {value: "0"}});
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringContaining("score=0")));
  expect(scrollIntoView).toHaveBeenCalledTimes(calls);
  fireEvent.click(screen.getByText("全部题目"));
  expect(document.activeElement).toBe(heading);
  await waitFor(() => expect(screen.getByLabelText("运行异常类别")).toHaveProperty("value", ""));
  expect(screen.getByLabelText("回答结果")).toHaveProperty("value", "");
  expect(post).not.toHaveBeenCalled();
});
