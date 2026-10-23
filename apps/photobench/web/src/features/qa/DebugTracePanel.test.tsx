import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DebugTracePanel } from "./DebugTracePanel.tsx";

afterEach(cleanup);
it("轨迹按需展开，状态事件不会套用徽标到整行", async () => {
  const detail = { index: 0, runtime_turns: [{ index: 0, message: "问题", debug_trace: [{ type: "status", status: "complete", payload: { fact: "saved-event" } }] }] };
  const { container } = render(<DebugTracePanel detail={detail} />);
  expect(screen.queryByText("问题")).toBeNull();
  const root = container.querySelector("details")!;
  root.open = true;
  fireEvent(root, new Event("toggle"));
  expect(await screen.findByText("问题")).toBeTruthy();
  const turn = container.querySelector(".debug-turn") as HTMLDetailsElement;
  turn.open = true;
  fireEvent(turn, new Event("toggle"));
  const label = await screen.findByText("状态变化");
  const step = label.closest("details")!;
  expect(step.classList.contains("debug-kind-status")).toBe(true);
  expect(step.classList.contains("debug-step-status")).toBe(false);
  expect(screen.queryByText(/saved-event/)).toBeNull();
  step.open = true;
  fireEvent(step, new Event("toggle"));
  expect(await screen.findByText(/saved-event/)).toBeTruthy();
});
