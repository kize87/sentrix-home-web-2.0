import { useEffect, useRef, useState } from "react";
import { api, BASE, post } from "../../api/client.ts";
import type {
  AnalysisCase,
  AnalysisEvent,
  AnalysisFilters,
  AnalysisJob,
  AnalysisPage,
  ComparisonReport,
  DiagnosisReport,
} from "../../api/analysis.ts";
import { activeAnalysis } from "../../api/analysis.ts";
import { ComparisonPicker } from "./ComparisonPicker.tsx";
import { dimensions, displayLabel, percent, scoreLabel, scores } from "./presentation.ts";
import { AnalysisCharts } from "./AnalysisCharts.tsx";
import "./analysis.css";

const status: Record<string, string> = {
  not_generated: "尚未生成",
  queued: "等待测评退出",
  running: "分析中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "重启中断",
};
const pretty = (x: unknown) => JSON.stringify(x, null, 2);
const runPath = (id: string) => `/runs/${encodeURIComponent(id)}/analysis`;
interface RawItem {
  qa_id?: string;
  judge?: unknown;
  task_judge?: unknown;
  evidence_judge?: unknown;
  runtime_turns?: { trace?: unknown[]; message?: string }[];
  model_call_metrics?: Record<string, unknown>[];
  tool_trace?: Record<string, unknown>[];
}
function Evidence({
  runId,
  c,
  event,
}: {
  runId: string;
  c: AnalysisCase;
  event: AnalysisEvent;
}) {
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState("");
  async function load() {
    try {
      const { item } = await api<{ item: RawItem }>(
        `/runs/${encodeURIComponent(runId)}/items/${c.index}`,
      );
      if (item.qa_id !== c.qa_id)
        throw new Error("原始题目位置已变化，请重新生成报告。");
      const match = (r: Record<string, unknown>) =>
        Number(r.conversation_turn || 0) === event.turn &&
        (event.call_id
          ? r.call_id === event.call_id
          : r.step_id === event.step_id);
      const trace = item.runtime_turns?.[event.turn]?.trace || [];
      setData({
        reference: event,
        judges:
          event.role === "judge"
            ? {
                answer: item.judge,
                behavior: item.task_judge,
                evidence: item.evidence_judge,
              }
            : undefined,
        model_calls: (item.model_call_metrics || []).filter(match),
        tools: (item.tool_trace || []).filter(match),
        trace_steps:
          event.event_index == null
            ? trace.filter((x) =>
                pretty(x).includes(String(event.step_id || event.code)),
              )
            : [trace[event.event_index]],
      });
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div>
      <button className="btn compact" onClick={() => void load()}>
        定位原始轨迹：轮{event.turn + 1} / {event.step_id || event.source}
      </button>
      {error && <p role="alert">{error}</p>}
      {data != null && <pre>{pretty(data)}</pre>}
    </div>
  );
}
function CaseCard({
  c,
  runId,
  selected,
  toggle,
}: {
  c: AnalysisCase;
  runId: string;
  selected: boolean;
  toggle: () => void;
}) {
  return (
    <details className="analysis-case" id={`analysis-i${c.index}:case`}>
      <summary>
        <input
          aria-label={`选择 ${c.qa_id}`}
          type="checkbox"
          checked={selected}
          onClick={(e) => e.stopPropagation()}
          onChange={toggle}
        />{" "}
        <span className={`analysis-outcome outcome-${c.score ?? "None"}`}>{scoreLabel(c.score)}</span>{" "}
        {c.question || c.qa_id || c.index}
        <small>{c.qa_id} · {displayLabel(c.dimensions.content_subtype || "unknown")} · {(c.dimensions.content_type === "unknown" ? "未标注内容题型" : displayLabel(c.dimensions.content_type || "unknown"))} · {displayLabel(c.execution)} · {c.events.length}次运行异常</small>
      </summary>
      <h5>问题</h5>
      <p>{c.question}</p>
      <h5>参考答案</h5>
      <p>{c.reference_answer || "未记录"}</p>
      <h5>模型回答</h5>
      <p>{c.answer || "未记录"}</p>
      {c.text_truncated && <p>当前为截短摘要，完整内容可读取原始轨迹。</p>}
      <p>
        数据缺口：{c.missing.map(displayLabel).join("、") || "未发现"}；检索/交付定位信号：
        {c.signals.map(displayLabel).join("、") || "无已知信号"}
      </p>
      {c.turns.map((t) => (
        <div key={t.turn}>
          第{t.turn + 1}轮：预期 {t.expected ? displayLabel(t.expected) : "未记录"} → 实际{" "}
          {t.actual ? displayLabel(t.actual) : "未记录"}；{t.behavior_correct === null ? "行为未判定" : t.behavior_correct ? "行为符合预期" : "行为不符合预期"}；结束原因 {t.termination_reason ? displayLabel(t.termination_reason) : "未记录"}
          <p>{t.judge_reason}</p>
        </div>
      ))}
      <ol>
        {c.events.map((e) => (
          <li key={e.event_id} id={`analysis-${e.event_id}`}>
            <b>{e.label}</b> · {displayLabel(e.recovery)} · {e.role ? displayLabel(e.role) : "角色未记录"}
            <p>{e.message}</p>
            <small>
              证据 {e.event_id} · {e.source} · 分类依据 {e.basis}
            </small>
            <Evidence runId={runId} c={c} event={e} />
          </li>
        ))}
      </ol>
    </details>
  );
}
function Exports({
  job,
  filters = {},
}: {
  job: AnalysisJob<unknown>;
  filters?: AnalysisFilters;
}) {
  return (
    <span className="analysis-toolbar">
      {["html", "json", "csv"].map((format) => (
        <a
          className="btn compact"
          key={format}
          href={`${BASE}/analyses/${job.job_id}/export?${new URLSearchParams({ ...filters, format })}`}
          download
        >
          导出 {format.toUpperCase()}
        </a>
      ))}
    </span>
  );
}

export function ErrorAnalysisPanel({
  runId,
  terminal,
}: {
  runId: string;
  terminal: boolean;
}) {
  const [viewJob, setViewJob] = useState("");
  const [open, setOpen] = useState(false),
    [job, setJob] = useState<AnalysisJob | null>(null),
    [error, setError] = useState("");
  const [tick, setTick] = useState(0),
    [filters, setFilters] = useState<AnalysisFilters>({}),
    [page, setPage] = useState(1);
  const [data, setData] = useState<AnalysisPage>({
    items: [],
    total: 0,
    page: 1,
    page_size: 20,
  });
  const caseHeading = useRef<HTMLHeadingElement>(null);
  const selectionEpoch = useRef(0);
  useEffect(() => { selectionEpoch.current++; }, [filters, job?.job_id]);
  const [casesLoading, setCasesLoading] = useState(false);
  const [selectionNote, setSelectionNote] = useState("");
  const [diagnosed, setDiagnosed] = useState<number[]>([]);
  const [preparingOther, setPreparingOther] = useState<AnalysisJob | null>(null);
  const [selected, setSelected] = useState<number[]>([]),
    [provider, setProvider] = useState("");
  const [providers, setProviders] = useState<
    { id: string; label?: string; model?: string }[]
  >([]);
  const [ai, setAi] = useState<AnalysisJob<DiagnosisReport> | null>(null),
    [compare, setCompare] = useState<AnalysisJob<ComparisonReport> | null>(
      null,
    );
  const [otherRun, setOtherRun] = useState(""),
    [pending, setPending] = useState(false),
    [history, setHistory] = useState<AnalysisJob<unknown>[]>([]),
    [cp, setCp] = useState(1);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const abort = new AbortController();
    const load = async () => {
      try {
        const x = await api<AnalysisJob>(
          viewJob ? `/analyses/${viewJob}` : runPath(runId),
          {
            signal: abort.signal,
          },
        );
        if (alive) setJob(x);
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      abort.abort();
      window.clearInterval(timer);
    };
  }, [open, runId, tick, viewJob]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api<{ judge_providers?: typeof providers }>("/config")
      .then((x) => {
        if (alive) setProviders(x.judge_providers || []);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [open]);
  useEffect(() => {
    if (!open || job?.status !== "completed" || !job.job_id) return;
    let alive = true;
    setCasesLoading(true);
    void api<AnalysisPage>(
      `/analyses/${job.job_id}/cases?${new URLSearchParams({ ...filters, page: String(page), page_size: "20" })}`,
    )
      .then((x) => {
        if (alive) { setData(x); setCasesLoading(false); }
      })
      .catch((e) => {
        if (alive) { setError(String(e)); setData({ items: [], total: 0, page, page_size: 20 }); setCasesLoading(false); }
      });
    return () => {
      alive = false;
    };
  }, [open, job?.status, job?.job_id, filters, page]);
  useEffect(() => {
    if (!open || (!activeAnalysis(ai) && !activeAnalysis(compare))) return;
    let alive = true;
    const poll = async () => {
      try {
        if (activeAnalysis(ai)) {
          const x = await api<AnalysisJob<DiagnosisReport>>(
            `/analyses/${ai?.job_id}`,
          );
          if (alive) setAi(x);
        }
        if (activeAnalysis(compare)) {
          const x = await api<AnalysisJob<ComparisonReport>>(
            `/analyses/${compare?.job_id}`,
          );
          if (alive) setCompare(x);
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open, ai, compare]);
  useEffect(() => {
    setSelected([]); setSelectionNote(""); setDiagnosed([]); setAi(null); setCompare(null); setPreparingOther(null);
  }, [job?.job_id]);
  useEffect(() => {
    if (ai?.report) setDiagnosed(old => [...new Set([...old, ...ai.report!.cases.filter(c => c.valid).map(c => c.index)])]);
  }, [ai?.report]);
  useEffect(() => {
    if (!open || !preparingOther?.job_id) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const other = await api<AnalysisJob>(`/analyses/${preparingOther.job_id}`);
          if (!alive) return;
          if (other.status === "completed" && !other.stale) {
            const result = await post<AnalysisJob<ComparisonReport>>(runPath(runId), { kind: "compare", left_job: job?.job_id, right_job: other.job_id });
            if (alive) { setCompare(result); setPreparingOther(null); setCp(1); }
          } else if (activeAnalysis(other)) setPreparingOther(other);
          else { setError(`对比运行的报告${status[other.status] || other.status}，请重试。${other.error || ""}`); setPreparingOther(null); }
        } catch (e) { if (alive) { setError(String(e)); setPreparingOther(null); } }
      })();
    }, 1500);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [open, preparingOther, job?.job_id, runId]);
  const r = job?.status === "completed" ? job.report : undefined;
  function filter(v: AnalysisFilters, replace = false) {
    setFilters((old) => replace ? v : { ...old, ...v });
    setPage(1); setCasesLoading(true); setSelected([]); setSelectionNote("");
  }
  function browseCases(value: AnalysisFilters) {
    filter(value, true);
    caseHeading.current?.focus({ preventScroll: true });
    caseHeading.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }
  async function act(fn: () => Promise<void>) {
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  }
  const generate = () =>
    act(async () => {
      setViewJob("");
      setJob(await post(runPath(runId), { kind: "rules" }));
      setSelected([]);
      setPage(1);
      setTick((x) => x + 1);
    });
  const diagnose = () =>
    act(async () => {
      const p = providers.find((x) => x.id === provider);
      if (!p || !selected.length) return;
      if (
        !window.confirm(
          `使用 ${p.label || p.id} / ${p.model || "配置模型"} 分析所选 ${selected.length} 题？案例证据将发送给该模型。每批最多20题，结论仅为建议。`,
        )
      )
        return;
      setAi(
        await post(runPath(runId), {
          kind: "ai",
          parent_job: job?.job_id,
          indices: selected,
          provider_id: provider,
        }),
      );
    });
  const chooseBatch = (extra: AnalysisFilters, label: string, skipDiagnosed = false) =>
    act(async () => {
      if (!job?.job_id || job.stale) return;
      const epoch = selectionEpoch.current;
      const chosen: number[] = [];
      let currentPage = 1, total = 0;
      do {
        const result = await api<AnalysisPage>(`/analyses/${job.job_id}/cases?${new URLSearchParams({ ...filters, ...extra, page: String(currentPage), page_size: "100" })}`);
        if (epoch !== selectionEpoch.current) return;
        total = result.total;
        for (const c of result.items) {
          if ((!skipDiagnosed || !diagnosed.includes(c.index)) && !chosen.includes(c.index)) chosen.push(c.index);
          if (chosen.length >= 20) break;
        }
        currentPage++;
      } while (skipDiagnosed && chosen.length < 20 && (currentPage - 1) * 100 < total);
      setSelected(chosen);
      setSelectionNote(`${label}：已选 ${chosen.length} 题（匹配 ${total} 题，每批最多20题${skipDiagnosed ? "，跳过本报告本次会话已有效诊断题" : ""}）。仅选题，尚未发送给分析模型。`);
    });
  const compareRuns = () =>
    act(async () => {
      if (!otherRun || otherRun === runId) return;
      let other = await api<AnalysisJob>(runPath(otherRun));
      if (!other.job_id || other.status !== "completed" || other.stale) {
        if (!activeAnalysis(other) || other.stale) other = await post(runPath(otherRun), { kind: "rules" });
        setPreparingOther(other);
        return;
      }
      setCompare(await post(runPath(runId), { kind: "compare", left_job: job?.job_id, right_job: other.job_id }));
      setCp(1);
    });
  const openHistory = (h: AnalysisJob<unknown>) =>
    act(async () => {
      if (h.kind === "rules") {
        setViewJob(h.job_id || "");
        setSelected([]);
        setPage(1);
        setJob(await api(`/analyses/${h.job_id}`));
      } else if (h.kind === "ai") setAi(await api(`/analyses/${h.job_id}`));
      else setCompare(await api(`/analyses/${h.job_id}`));
    });
  const filterOptions: Record<string, [string, string[][]]> = r ? {
                  code: ["运行异常类别", r.errors.map((x) => [x.code, x.label])],
                  content_unit: ["内容统计单位", [["qa", "题（最终任务）"], ["turn", "对话轮"]]],
                  ...Object.fromEntries(Object.entries(dimensions).map(([key, label]) => [key, [label, ((filters.content_unit === "turn" ? r.turn_groups : r.groups)?.[key] || []).map(x => [x.value, key === "content_type" && x.value === "unknown" ? "未标注内容题型" : displayLabel(x.value)])]])),
                  test_scenario: ["测试场景", (r.behavior_scenarios || []).map(x => [x.value, x.value === "unknown" ? "未标注专项场景" : displayLabel(x.value)])],
                  behavior_result: ["行为判定", [["correct", "符合预期"], ["incorrect", "不符合预期"], ["missing", "未判定"]]],
                  score: ["任务完成质量", [...scores.map(x => [x.value, x.label]), ["low", "未得满分（0/1分）"]]],
                  anomaly: ["运行异常", [["yes", "发生过异常"], ["no", "未记录异常"]]],
                  recovery: [
                    "恢复状态",
                    [
                      ["recovered", "已恢复"],
                      ["not_recovered", "未恢复"],
                      ["unknown", "未知"],
                    ],
                  ],
                  expected_action: [
                    "预期行为",
                    ["answer", "refuse", "clarify", "answer_and_refuse", "unknown"].map((x) => [
                      x,
                      displayLabel(x),
                    ]),
                  ],
                  actual_action: [
                    "实际行为",
                    ["answer", "refuse", "clarify", "answer_and_refuse", "none", "unknown"].map(
                      (x) => [x, displayLabel(x)],
                    ),
                  ],
                  execution: [
                    "执行状态",
                    ["normal", "failed", "cancelled", "unknown"].map((x) => [
                      x,
                      displayLabel(x),
                    ]),
                  ],
                } : {};
  const renderFilter = (key: string, label: string, values: string[][]) => (
                    <label key={key}>
                      {label}
                      <select
                        aria-label={label}
                        value={filters[key] || ""}
                        onChange={(e) => filter({ [key]: e.target.value })}
                      >
                        <option value="">全部</option>
                        {values.map(([v, text]) => (
                          <option key={v} value={v}>
                            {text}
                          </option>
                        ))}
                      </select>
                    </label>
  );
  return (
    <section className="analysis-panel">
      <button
        className="btn"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        错误分析 {open ? "收起" : "展开"}
      </button>
      {open && (
        <>
          <div className="analysis-toolbar">
            <b>{status[job?.status || ""] || "读取分析状态…"}</b>
            {activeAnalysis(job) && <span>已处理 {job?.processed} 题</span>}
            <button
              className="btn compact"
              disabled={!terminal || pending || activeAnalysis(job)}
              onClick={() => void generate()}
            >
              {job?.job_id ? "重新生成规则报告" : "生成规则报告"}
            </button>
            {activeAnalysis(job) && (
              <button
                className="btn compact"
                onClick={() =>
                  void act(async () => {
                    await post(`/analyses/${job?.job_id}/cancel`, {});
                    setTick((x) => x + 1);
                  })
                }
              >
                取消分析
              </button>
            )}
            <button
              className="btn compact"
              onClick={() =>
                void act(async () =>
                  setHistory(
                    await api(`/runs/${encodeURIComponent(runId)}/analyses`),
                  ),
                )
              }
            >
              历史分析任务
            </button>
          </div>
          {!terminal && <p>测评和采样退出后自动分析；历史运行可手动生成。</p>}
          {job?.stale && (
            <p className="error">
              报告需更新，请重新生成后查看。
            </p>
          )}
          {(error || job?.error) && (
            <p className="error" role="alert">
              {error || job?.error}
            </p>
          )}
          {history.length > 0 && (
            <details open>
              <summary>历史任务（旧报告保留来源）</summary>
              {history.map((h) => (
                <p key={h.job_id}>
                  <button
                    className="btn compact"
                    onClick={() => void openHistory(h)}
                  >
                    {({rules: "统计报告", compare: "逐题对比", ai: "AI分析"} as Record<string, string>)[h.kind || ""]} · {status[h.status] || h.status} ·{" "}
                    {h.created_at
                      ? new Date(h.created_at * 1000).toLocaleString()
                      : h.job_id}
                  </button>
                </p>
              ))}
            </details>
          )}
          {r && (
            <>
              <h3>本轮任务完成质量</h3>
              <p className="analysis-lead">满分率 <b>{percent(r.counts.score_2 || 0, r.denominators.quality_valid)}</b> · 有效评分 {r.denominators.quality_valid}/{r.item_count} 题</p>
              <div className="analysis-stats">
                <button className="analysis-stat" onClick={() => browseCases({})}><span>全部题目</span><strong>{r.item_count}</strong></button>
                {scores.map(score => <button key={score.value} className={`analysis-stat outcome-${score.value}`} onClick={() => browseCases({ score: score.value })}>
                  <span>{score.label}</span><strong>{r.counts[`score_${score.value}`] || 0}</strong><small>占全部题目 {percent(r.counts[`score_${score.value}`] || 0, r.item_count)}</small>
                </button>)}
              </div>
              <div className="analysis-runtime-summary">
                <b>运行情况</b>
                <span>发生过异常 {r.counts.affected_items || 0}题</span><span>全部异常已恢复 {r.counts.fully_recovered_items || 0}题</span>
                <span>最终执行失败 {r.counts.execution_failed || 0}题</span><span>取消 {r.counts.execution_cancelled || 0}题</span>
              </div>
              <p>
                {status[String(r.source.status)] || displayLabel(String(r.source.status))} ·{" "}
                {r.source.mode === "build"
                  ? "仅导入与处理阶段"
                  : `${r.item_count}题`}{" "}
                · {new Date(r.generated_at * 1000).toLocaleString()}
                {!!r.source.qa_snapshot && <span> · 数据版本 {String((r.source.qa_snapshot as Record<string, unknown>).dataset_version || "未记录")} · 分类版本 {String((r.source.qa_snapshot as Record<string, unknown>).taxonomy_version || "未记录")}</span>}
              </p>
              <details>
                <summary>统计口径、来源与数据完整性</summary>
                <ul>
                  {r.definitions.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
                <p>
                  缺轨迹 {r.counts.missing_trace || 0}；缺GT{" "}
                  {r.counts.missing_gt || 0}；缺检索GT{" "}
                  {r.counts.missing_retrieval_gt || 0}；缺行为信息{" "}
                  {r.counts.missing_behavior || 0}题。
                </p>
                <p>
                  主链模型调用 {r.denominators.model_calls} 次，工具内部模型{" "}
                  {r.denominators.tool_model_calls ?? 0} 次，Judge{" "}
                  {r.denominators.judge_calls ?? 0} 次；工具调用{" "}
                  {r.denominators.tool_calls} 次；记录参数JSON{" "}
                  {r.denominators.tool_json_recorded} 次，非法{" "}
                  {r.counts.tool_json_invalid || 0} 次。
                </p>
                <pre>
                  {pretty({
                    source: r.source,
                    denominators: r.denominators,
                    result_fingerprint: r.result_fingerprint,
                    gt_fingerprint: r.gt_fingerprint,
                    rule_version: r.rule_version,
                  })}
                </pre>
              </details>
              <AnalysisCharts report={r} filter={browseCases} />
              <details>
                <summary>全部分类明细</summary>
                {Object.entries(r.groups).filter(([dim]) => dim in dimensions).map(([dim, rows]) => (
                  <div key={dim}>
                    <h4>{dimensions[dim] || dim}</h4>
                    <table>
                      <thead>
                        <tr>
                          <th>类别</th>
                          <th>题数</th>
                          <th>2分</th><th>1分</th><th>0分</th><th>有效评分</th>
                          <th>未评分</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((x) => (
                          <tr key={x.value}>
                            <td title={x.value}>{(dim === "content_type" && x.value === "unknown" ? "未标注内容题型" : displayLabel(x.value))}</td>
                            <td>{x.total}</td>
                            <td>{x.score_2 || 0}</td><td>{x.score_1 || 0}</td><td>{x.score_0 || 0}</td><td>{x.total - Number(x.score_None || 0)}</td>
                            <td>{x.score_None || 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </details>
              <details>
              <summary>检索与交付</summary>
              <p>
                检索有参考答案 {r.counts.candidate_valid_items || 0}题；交付有参考答案{" "}
                {r.counts.delivery_valid_items || 0}题。
              </p>
              <p>
                候选未命中 {r.counts.candidate_miss || 0}题 · 候选命中但未交付{" "}
                {r.counts.candidate_hit_not_delivered || 0}题 · 已交付但回答低分{" "}
                {r.counts.delivered_low_score || 0}题
              </p>
              </details>
              <h3 ref={caseHeading} tabIndex={-1} className="analysis-case-heading">题目列表</h3>
              <div className="analysis-toolbar">
                {Object.entries(filterOptions).filter(([key]) => ["score", "content_type", "code"].includes(key)).map(([key, [label, values]]) => renderFilter(key, label, values))}
                <details className="analysis-extra-filters">
                  <summary>更多筛选{Object.entries(filters).filter(([key, value]) => value && !["score", "content_type", "code"].includes(key)).length > 0 ? " · 已设置" : ""}</summary>
                  <div className="analysis-toolbar">{Object.entries(filterOptions).filter(([key]) => !["score", "content_type", "code"].includes(key)).map(([key, [label, values]]) => renderFilter(key, label, values))}</div>
                </details>
                <button
                  className="btn compact"
                  onClick={() => {
                    setFilters({});
                    setPage(1); setSelected([]); setSelectionNote("");
                  }}
                >
                  清空筛选
                </button>
                {job && <Exports job={job} filters={filters} />}
              </div>
              <p role="status">
                {casesLoading ? "正在读取筛选结果…" : `筛选命中 ${data.total}/${r.item_count}题 · 第${page}页`}
                ；已选择 {selected.length}/20题用于AI诊断。
              </p>
              <div className="analysis-toolbar analysis-bulk">
                <button className="btn compact" disabled={pending || casesLoading || !data.items.length || !!job?.stale} onClick={() => { setSelected(data.items.map(c => c.index)); setSelectionNote("已选择本页全部题目，仅选题，尚未发送给分析模型。"); }}>全选本页</button>
                <button className="btn compact" disabled={pending || !!job?.stale} onClick={() => void chooseBatch({}, "当前筛选结果")}>选择当前筛选（最多20题）</button>
                <button className="btn compact" disabled={pending || !!job?.stale} onClick={() => void chooseBatch({ score: "low" }, "未得满分题")}>选择未得满分题</button>
                <button className="btn compact" disabled={pending || !!job?.stale} onClick={() => void chooseBatch({ anomaly: "yes" }, "运行异常题")}>选择运行异常题</button>
                <button className="btn compact" disabled={pending || !!job?.stale || !diagnosed.length} onClick={() => void chooseBatch({}, "下一批未分析题", true)}>选择下一批未分析题</button>
                <button className="btn compact" onClick={() => { setSelected([]); setSelectionNote(""); }}>清空选择</button>
              </div>
              <p className="analysis-hint">批量选择沿用当前分类，每批最多20题。异常题也可能得满分。</p>
              {selectionNote && <p role="status">{selectionNote}</p>}
              {casesLoading ? null : data.total === 0 ? <p>没有符合当前条件的题目。可清空筛选查看全部。</p> : data.items.map((c) => (
                <CaseCard
                  key={`${job?.job_id}-${c.index}`}
                  c={c}
                  runId={runId}
                  selected={selected.includes(c.index)}
                  toggle={() => {
                    if (pending) return;
                    setSelectionNote("");
                    if (selected.includes(c.index))
                      setSelected(selected.filter((i) => i !== c.index));
                    else if (selected.length < 20)
                      setSelected([...selected, c.index]);
                    else setError("每批最多20题，可分批继续。");
                  }}
                />
              ))}
              <div className="analysis-toolbar">
                <button
                  className="btn compact"
                  disabled={casesLoading || page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </button>
                <button
                  className="btn compact"
                  disabled={casesLoading || page * 20 >= data.total}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </button>
              </div>
              <h3>AI 辅助分析</h3>
              <p>
                已选 {selected.length} 题，选择模型后确认开始。
              </p>
              <div className="analysis-toolbar">
                <select
                  aria-label="分析模型"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                >
                  <option value="">选择分析模型</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label || p.id} / {p.model}
                    </option>
                  ))}
                </select>
                <button
                  className="btn compact"
                  disabled={
                    pending ||
                    !!job?.stale ||
                    !selected.length ||
                    !provider ||
                    activeAnalysis(ai)
                  }
                  onClick={() => void diagnose()}
                >
                  确认并分析所选案例
                </button>
              </div>
              <h3>两轮逐题对比</h3>
              <p>选择另一轮，与本轮逐题比较。</p>
              <ComparisonPicker runId={runId} value={otherRun} onChange={setOtherRun} disabled={pending || !!preparingOther || activeAnalysis(compare)} />
              <div className="analysis-toolbar">
                <button className="btn compact" disabled={pending || !!job?.stale || !otherRun || !!preparingOther || activeAnalysis(compare)} onClick={() => void compareRuns()}>创建对比报告</button>
                {preparingOther && <><span role="status">正在准备所选运行的规则报告：{status[preparingOther.status] || preparingOther.status}，完成后自动对比。</span><button className="btn compact" onClick={() => setPreparingOther(null)}>停止等待</button></>}
              </div>
            </>
          )}
          {compare && (
            <section>
              <h4>逐题对比 · {status[compare.status]}</h4>
              {compare.error && <p role="alert">{compare.error}</p>}
              {compare.stale && <p>来源已过期</p>}
              {activeAnalysis(compare) && (
                <button
                  className="btn compact"
                  onClick={() =>
                    void act(async () =>
                      setCompare(
                        await post(`/analyses/${compare.job_id}/cancel`, {}),
                      ),
                    )
                  }
                >
                  取消对比
                </button>
              )}
              {compare.report && (
                <>
                  <p>
                    {compare.report.comparable
                      ? `另一轮相对本轮：改善 ${compare.report.quality_changes?.improved || 0} 题，退步 ${compare.report.quality_changes?.regressed || 0} 题，持平 ${compare.report.quality_changes?.unchanged || 0} 题，缺分等无法判定 ${compare.report.quality_changes?.unknown || 0} 题。`
                      : "配置不具可比性，仅并排展示事实，不给出版本提升结论。"}
                  </p>
                  <p>
                    配置差异：
                    {compare.report.differences.map(displayLabel).join("、") ||
                      "未发现已记录差异"}
                    ；定义一致 {compare.report.pairing_counts.paired || 0}题，定义变化 {compare.report.pairing_counts.changed || 0}题，未匹配 {compare.report.pairing_counts.unmatched || 0}题；重复/空ID：
                    {compare.report.duplicates.join("、") || "无"}
                  </p>
                  <p>{compare.report.note}</p>
                  <p>未记录的关键配置：{compare.report.missing_configuration.map(displayLabel).join("、") || "无"}</p>
                  <Exports job={compare} />
                  <details>
                    <summary>来源与配置</summary>
                    <pre>{pretty(compare.report.sources)}</pre>
                  </details>
                  {compare.report.rows
                    .slice((cp - 1) * 20, cp * 20)
                    .map((row) => (
                      <details key={row.qa_id}>
                        <summary>
                          {row.qa_id} · {displayLabel(row.pairing)} · {displayLabel(row.quality_change)} ·
                          分数变化 {row.score_delta ?? "未知"}
                        </summary>
                        <p>
                          参考答案变化 {row.gt_changed ? "有" : "无"}；执行状态变化{" "}
                          {row.execution_changed ? "有" : "无"}；新增异常{" "}
                          {row.errors_added.join("、") || "无"}；消失异常{" "}
                          {row.errors_removed.join("、") || "无"}
                        </p>
                        <div className="analysis-grid">
                          {[["本轮（基准）", row.left], ["所选另一轮", row.right]].map(([label, entry]) => {
                            const c = entry as AnalysisCase | null;
                            return <article key={String(label)}><h5>{String(label)}</h5>{c ? <><p>{c.question}</p><p>{scoreLabel(c.score)} · {displayLabel(c.execution)} · {c.events.length}次异常</p><h5>模型回答</h5><p>{c.answer || "未记录"}</p><h5>参考答案</h5><p>{c.reference_answer || "未记录"}</p><details><summary>完整案例数据</summary><pre>{pretty(c)}</pre></details></> : <p>此轮未匹配到该题。</p>}</article>;
                          })}
                        </div>
                      </details>
                    ))}
                  <button
                    className="btn compact"
                    disabled={cp <= 1}
                    onClick={() => setCp(cp - 1)}
                  >
                    对比上一页
                  </button>
                  <button
                    className="btn compact"
                    disabled={cp * 20 >= compare.report.rows.length}
                    onClick={() => setCp(cp + 1)}
                  >
                    对比下一页
                  </button>
                </>
              )}
            </section>
          )}
          {ai && (
            <section>
              <h4>AI 诊断建议 · {status[ai.status]}</h4>
              <p>已处理 {ai.processed}题</p>
              {ai.error && <p role="alert">{ai.error}</p>}
              {ai.stale && <p>来源已过期</p>}
              {activeAnalysis(ai) && (
                <button
                  className="btn compact"
                  onClick={() =>
                    void act(async () =>
                      setAi(await post(`/analyses/${ai.job_id}/cancel`, {})),
                    )
                  }
                >
                  取消AI诊断
                </button>
              )}
              {ai.report && (
                <>
                  <p>
                    {ai.report.model} · 覆盖 {ai.report.covered}/
                    {ai.report.requested}题；{ai.report.note}
                  </p>
                  <Exports job={ai} />
                  {ai.report.cases.map((c) => (
                    <details key={c.index}>
                      <summary>
                        {c.qa_id} ·{" "}
                        {c.valid ? "证据引用校验通过" : "无效结果，请勿采用"}
                      </summary>
                      {c.valid ? (
                        <>
                          <p>观察：{c.result.observations}</p>
                          <p>可能原因：{c.result.possible_causes}</p>
                          <p>缺少证据：{c.result.missing_evidence}</p>
                          <p>建议修改：{c.result.recommendations}</p>
                          <p>验证实验：{c.result.experiments}</p>
                          <p>
                            证据：
                            {c.result.evidence_refs?.map((ref) => (
                              <a key={ref} href={`#analysis-${ref}`}>
                                {ref}{" "}
                              </a>
                            ))}
                          </p>
                        </>
                      ) : (
                        <pre>{c.error || c.raw}</pre>
                      )}
                    </details>
                  ))}
                </>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
