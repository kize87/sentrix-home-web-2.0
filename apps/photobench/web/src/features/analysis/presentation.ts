/** Display the dataset's saved labels; never infer a missing classification. */
export const dimensions: Record<string, string> = {
  task_type: "任务类型", question_type: "题目形式", angle: "考察角度",
  difficulty: "难度", answerability: "可回答性", media_type: "媒体类型",
  conversation_type: "对话形式", expected_action: "预期行为",
};
const labels: Record<string, string> = {
  T1_retrieve_media: "媒体检索", T1_media_retrieval: "媒体检索",
  T2_fact_qa: "事实问答", T3_enumeration: "统计枚举", T5_event_summary: "事件总结",
  event_memory_qa: "事件记忆问答", single_evidence_memory_qa: "单证据问答",
  fact_retrieval: "事实检索", event_summary: "事件总结", enumeration: "统计枚举",
  media_retrieval: "媒体检索", event_time: "事件时间", event_location: "事件地点",
  time: "时间", place: "地点", activity: "活动", people: "人物",
  scene_visual: "视觉细节", food_or_object: "食物／物品",
  easy: "简单", medium: "中等", hard: "困难",
  image: "图片", video: "视频", mixed: "图片与视频", single: "单轮", multi: "多轮",
  answerable: "可回答", unanswerable: "不可回答", partially_answerable: "部分可回答",
  answer: "回答", refuse: "拒答", clarify: "澄清", none: "未作答", unknown: "未标注／未知",
  improved: "改善", regressed: "退步", unchanged: "持平", paired: "定义一致", changed: "定义变化", unmatched: "未匹配",
  judge: "评分模型配置", judge_definition_fingerprints: "评分提示词", budgets: "执行预算", agent_limits: "Agent步数/工具上限", context_windows: "上下文窗口", model: "被测模型", device: "设备", build_revision: "代码版本",
  normal: "正常结束", failed: "执行失败", cancelled: "已取消",
};
export const displayLabel = (value: string) => labels[value] || value;
export const scores = [
  { value: "2", label: "答对（2分）", short: "答对", color: "#287c65" },
  { value: "1", label: "部分答对（1分）", short: "部分答对", color: "#ba8527" },
  { value: "0", label: "答错（0分）", short: "答错", color: "#c35550" },
  { value: "None", label: "未评分", short: "未评分", color: "#929baa" },
];
export const scoreLabel = (score: number | null) => scores.find(x => x.value === String(score ?? "None"))!.label;
export const percent = (n: number, valid: number) => valid > 0 ? `${(n / valid * 100).toFixed(1)}%` : "未覆盖";
