import { useEffect, useState } from "react";
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
        {c.qa_id || c.index} · {c.score == null ? "缺分" : `${c.score}分`} ·
        执行{c.execution} · {c.events.length}次异常
      </summary>
      <h5>问题</h5>
      <p>{c.question}</p>
      <h5>参考答案</h5>
      <p>{c.reference_answer || "未记录"}</p>
      <h5>模型回答</h5>
      <p>{c.answer || "未记录"}</p>
      {c.text_truncated && <p>当前为截短摘要，完整内容可读取原始轨迹。</p>}
      <p>
        数据缺口：{c.missing.join("、") || "未发现"}；检索/交付定位信号：
        {c.signals.join("、") || "无已知信号"}
      </p>
      {c.turns.map((t) => (
        <div key={t.turn}>
          第{t.turn + 1}轮：预期 {t.expected || "未记录"} → 实际{" "}
          {t.actual || "未记录"}；结束原因 {t.termination_reason || "未记录"}
          <p>{t.judge_reason}</p>
        </div>
      ))}
      <ol>
        {c.events.map((e) => (
          <li key={e.event_id} id={`analysis-${e.event_id}`}>
            <b>{e.label}</b> · {e.recovery} · {e.role || "角色未记录"}
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
    void api<AnalysisPage>(
      `/analyses/${job.job_id}/cases?${new URLSearchParams({ ...filters, page: String(page), page_size: "20" })}`,
    )
      .then((x) => {
        if (alive) setData(x);
      })
      .catch((e) => {
        if (alive) setError(String(e));
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
  const r = job?.status === "completed" ? job.report : undefined;
  function filter(v: AnalysisFilters) {
    setFilters((old) => ({ ...old, ...v }));
    setPage(1);
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
  const compareRuns = () =>
    act(async () => {
      const other = await api<AnalysisJob>(runPath(otherRun.trim()));
      if (!other.job_id || other.status !== "completed" || other.stale)
        throw new Error("另一轮需要先生成有效规则报告。");
      setCompare(
        await post(runPath(runId), {
          kind: "compare",
          left_job: job?.job_id,
          right_job: other.job_id,
        }),
      );
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
              来源已变化，报告已过期。请重新生成后对比或诊断。
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
                    {h.kind} · {status[h.status] || h.status} ·{" "}
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
              <div className="analysis-stats">
                {[
                  ["总题数", r.item_count],
                  ["执行失败", r.counts.execution_failed || 0],
                  ["取消", r.counts.execution_cancelled || 0],
                  ["发生异常", r.counts.affected_items || 0],
                  ["全部异常恢复", r.counts.fully_recovered_items || 0],
                  ["缺分", r.denominators.quality_missing],
                ].map(([label, n]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{n}</strong>
                  </div>
                ))}
              </div>
              <p>
                范围：{String(r.source.status)} ·{" "}
                {r.source.mode === "build"
                  ? "仅导入与处理阶段"
                  : `${r.item_count}题`}{" "}
                · {new Date(r.generated_at * 1000).toLocaleString()}
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
              <AnalysisCharts report={r} filter={filter} />
              <details>
                <summary>题目覆盖全部维度</summary>
                {Object.entries(r.groups).map(([dim, rows]) => (
                  <div key={dim}>
                    <h4>{dim}</h4>
                    <table>
                      <thead>
                        <tr>
                          <th>类别</th>
                          <th>题数</th>
                          <th>有效分数</th>
                          <th>缺分</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((x) => (
                          <tr key={x.value}>
                            <td>{x.value}</td>
                            <td>{x.total}</td>
                            <td>{x.total - Number(x.score_None || 0)}</td>
                            <td>{x.score_None || 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </details>
              <h4>检索与交付定位信号</h4>
              <p>
                检索有效GT {r.counts.candidate_valid_items || 0}题；交付有效GT{" "}
                {r.counts.delivery_valid_items || 0}题；缺GT不判失败。
              </p>
              <p>
                候选未命中 {r.counts.candidate_miss || 0}题 · 候选命中但未交付{" "}
                {r.counts.candidate_hit_not_delivered || 0}题 · 已交付但回答低分{" "}
                {r.counts.delivered_low_score || 0}题
              </p>
              <h4>案例排查</h4>
              <div className="analysis-toolbar">
                {Object.entries({
                  code: ["错误类别", r.errors.map((x) => [x.code, x.label])],
                  question_type: [
                    "题型",
                    (r.groups.question_type || []).map((x) => [
                      x.value,
                      x.value,
                    ]),
                  ],
                  score: [
                    "分数",
                    ["0", "1", "2", "None"].map((x) => [
                      x,
                      x === "None" ? "缺分" : x,
                    ]),
                  ],
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
                    ["answer", "refuse", "clarify", "unknown"].map((x) => [
                      x,
                      x,
                    ]),
                  ],
                  actual_action: [
                    "实际行为",
                    ["answer", "refuse", "clarify", "none", "unknown"].map(
                      (x) => [x, x],
                    ),
                  ],
                  execution: [
                    "执行状态",
                    ["normal", "failed", "cancelled", "unknown"].map((x) => [
                      x,
                      x,
                    ]),
                  ],
                } as Record<string, [string, string[][]]>).map(
                  ([key, [label, values]]) => (
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
                  ),
                )}
                <button
                  className="btn compact"
                  onClick={() => {
                    setFilters({});
                    setPage(1);
                  }}
                >
                  清空筛选
                </button>
                {job && <Exports job={job} filters={filters} />}
              </div>
              <p>
                筛选命中 {data.total}/{r.item_count}题 · 第{page}页；已选择{" "}
                {selected.length}/20题用于AI诊断。
              </p>
              {data.items.map((c) => (
                <CaseCard
                  key={`${job?.job_id}-${c.index}`}
                  c={c}
                  runId={runId}
                  selected={selected.includes(c.index)}
                  toggle={() => {
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
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </button>
                <button
                  className="btn compact"
                  disabled={page * 20 >= data.total}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </button>
                <button className="btn compact" onClick={() => setSelected([])}>
                  清空选择
                </button>
              </div>
              <h4>两轮逐题对比</h4>
              <div className="analysis-toolbar">
                <label>
                  另一轮 Run ID
                  <input
                    aria-label="对比Run ID"
                    value={otherRun}
                    onChange={(e) => setOtherRun(e.target.value)}
                  />
                </label>
                <button
                  className="btn compact"
                  disabled={
                    pending ||
                    !!job?.stale ||
                    !otherRun.trim() ||
                    activeAnalysis(compare)
                  }
                  onClick={() => void compareRuns()}
                >
                  创建对比报告
                </button>
              </div>
              <h4>可选 AI 诊断</h4>
              <p>
                默认关闭。只分析选择的案例，每批最多20题，并发1；可分批继续。
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
                      ? `配对表现：${pretty(compare.report.quality_changes)}`
                      : "配置不具可比性，仅并排展示事实，不给出版本提升结论。"}
                  </p>
                  <p>
                    配置差异：
                    {compare.report.differences.join("、") ||
                      "未发现已记录差异"}
                    ；配对：{pretty(compare.report.pairing_counts)}；重复/空ID：
                    {compare.report.duplicates.join("、") || "无"}
                  </p>
                  <p>{compare.report.note}</p>
                  <p>未记录的关键配置：{compare.report.missing_configuration.join("、") || "无"}</p>
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
                          {row.qa_id} · {row.pairing} · {row.quality_change} ·
                          分数变化 {row.score_delta ?? "未知"}
                        </summary>
                        <p>
                          GT变化 {String(row.gt_changed)}；执行状态变化{" "}
                          {String(row.execution_changed)}；新增异常{" "}
                          {row.errors_added.join("、") || "无"}；消失异常{" "}
                          {row.errors_removed.join("、") || "无"}
                        </p>
                        <div className="analysis-grid">
                          <pre>{pretty(row.left)}</pre>
                          <pre>{pretty(row.right)}</pre>
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
