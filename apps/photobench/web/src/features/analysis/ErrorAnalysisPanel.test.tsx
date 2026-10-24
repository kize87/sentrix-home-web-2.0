import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    fireEvent.change(screen.getByLabelText("对比Run ID"), {target: {value: "other"}});
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
    expect(screen.getByLabelText("错误类别")).toHaveProperty(
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
