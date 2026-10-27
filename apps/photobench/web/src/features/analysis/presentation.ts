import { taxonomyLabels } from "../../lib/qaTaxonomy.ts";
/** Display the dataset's saved labels; never infer a missing classification. */
export const dimensions: Record<string, string> = {
  ability_family: "一级能力", ability_type: "二级能力", benchmark_group: "测试分组",
  content_type: "内容题型", content_subtype: "细分题型",
  difficulty: "难度", answerability: "可回答性", media_type: "媒体类型",
  conversation_type: "对话形式",
};
const labels: Record<string, string> = {
  T1_retrieve_media: "媒体检索", T1_media_retrieval: "媒体检索",
  T2_fact_qa: "事实问答", T3_enumeration: "统计枚举", T5_event_summary: "事件总结",
  multi_turn_clarify: "多轮澄清", evidence_insufficient: "证据不足",
  prompt_injection: "指令注入", clarification: "澄清提问", unanswerable_fact: "不可回答事实",
  answerable_after_clarification: "澄清后可回答", needs_clarification: "需澄清",
  event_memory_qa: "事件记忆问答", single_evidence_memory_qa: "单证据问答",
  fact_retrieval: "事实检索", event_summary: "事件总结", enumeration: "统计枚举",
  media_retrieval: "媒体检索", event_time: "事件时间", event_location: "事件地点",
  time: "时间", place: "地点", activity: "活动", people: "人物",
  scene_visual: "视觉细节", food_or_object: "食物／物品",
  easy: "简单", medium: "中等", hard: "困难",
  image: "图片", video: "视频", mixed: "图片与视频", single: "单轮", multi: "多轮",
  answerable: "可回答", unanswerable: "不可回答", partially_answerable: "部分可回答",
  answer: "直接回答", refuse: "拒答", clarify: "澄清", none: "未作答", unknown: "未标注／未知",
  improved: "改善", regressed: "退步", unchanged: "持平", paired: "定义一致", changed: "定义变化", unmatched: "未匹配",
  annotations: "题目标签", qa_snapshot: "题库版本与定义",
  judge_config: "评分模型配置", judge_definition_fingerprints: "评分提示词", budgets: "执行预算", agent_limits: "Agent步数/工具上限", context_windows: "上下文窗口", model: "被测模型", device: "设备", build_revision: "代码版本",
  recovered: "已恢复", not_recovered: "未恢复", agent: "主模型", planner: "规划模型",
  judge: "评分模型", tool: "工具", tool_internal: "工具内部模型",
  candidate_miss: "未检索到参考媒体", candidate_hit_not_delivered: "已检索到但未交付", delivered_low_score: "已交付但回答低分",
  trace: "执行轨迹", gt: "参考答案", retrieval_gt: "检索参考答案", behavior: "行为测试（原标签）",
  question_type: "题型", model_call_records: "模型调用记录", judge_call_records: "评分调用记录", tool_model_call_records: "工具模型调用记录",
  answered: "回答结束", answered_with_gap: "回答不完整", policy_refusal: "已拒答", parse_failure: "输出格式错误",
  step_budget_exhausted: "达到步骤上限", tool_budget_exhausted: "达到工具调用上限", timeout: "执行超时", model_error: "模型出错", guard_blocked: "安全检查拦截", planner_blocked: "规划失败",
  completed: "已完成", completed_with_errors: "完成但有错误", interrupted: "已中断",
  normal: "正常结束", failed: "执行失败", cancelled: "已取消",
};
export const displayLabel = (value: string) => value.split(" / ").map(part => taxonomyLabels[part] || labels[part] || part).join("、");
export const scores = [
  { value: "2", label: "满分（2分）", short: "满分", color: "#287c65" },
  { value: "1", label: "部分完成（1分）", short: "部分完成", color: "#ba8527" },
  { value: "0", label: "未完成（0分）", short: "未完成", color: "#c35550" },
  { value: "None", label: "未评分", short: "未评分", color: "#929baa" },
];
export const scoreLabel = (score: number | null) => scores.find(x => x.value === String(score ?? "None"))!.label;
export const percent = (n: number, valid: number) => valid > 0 ? `${(n / valid * 100).toFixed(1)}%` : "未覆盖";
