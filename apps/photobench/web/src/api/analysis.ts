/** Derived analysis artifacts. Raw traces stay behind the existing item endpoint. */
export interface AnalysisEvent {
  event_id: string;
  code: string;
  label: string;
  source: string;
  turn: number;
  step_id: string | null;
  recovery: string;
  basis: string;
  role?: string;
  message?: string;
  call_id?: string;
  diagnostics?: Record<string, unknown>;
  event_index?: number;
}
export interface AnalysisTurn {
  turn: number;
  turn_id?: string;
  termination_reason: string;
  expected: string | null;
  actual: string | null;
  behavior_correct: boolean | null;
  judge_reason: string;
  score: number | null;
  ability_family?: string[];
  ability_type?: string[];
  benchmark_group?: string[];
  content_type?: string[];
  content_subtype?: string[];
  difficulty?: string[];
  answerability?: string[];
}
export interface AnalysisCase {
  index: number;
  qa_id: string;
  question: string;
  answer: string;
  reference_answer: string;
  score: number | null;
  execution: string;
  ability_taxonomy_version?: string | null;
  ability_labels?: Record<string, string>;
  dimensions: Record<string, string>;
  events: AnalysisEvent[];
  turns: AnalysisTurn[];
  missing: string[];
  signals: string[];
  text_truncated: boolean;
}
export interface BehaviorGroup {
  value: string; total: number; valid: number; correct: number; incorrect: number; missing: number;
}
export interface AnalysisReport {
  schema_version: number;
  rule_version: number;
  generated_at: number;
  ability_taxonomy_versions?: string[];
  ability_labels?: Record<string, string>;
  item_count: number;
  source: Record<string, unknown>;
  result_fingerprint: string;
  gt_fingerprint: string;
  annotation_fingerprint?: string;
  counts: Record<string, number>;
  denominators: Record<string, number>;
  errors: {
    code: string;
    label: string;
    affected_items: number;
    events: number;
    final_failed_items: number;
    recovered_items: number;
  }[];
  groups: Record<
    string,
    ({ value: string; total: number } & Record<string, string | number>)[]
  >;
  turn_groups?: AnalysisReport["groups"];
  behavior_groups?: BehaviorGroup[];
  behavior_scenarios?: BehaviorGroup[];
  heatmap: { content_type: string; code: string; count: number }[];
  ability_heatmap?: { ability_family: string; code: string; count: number }[];
  behavior_matrix: { expected: string; actual: string; count: number }[];
  definitions: string[];
}
export interface ComparisonReport {
  comparable: boolean;
  differences: string[];
  missing_configuration: string[];
  duplicates: string[];
  pairing_counts: Record<string, number>;
  quality_changes: Record<string, number> | null;
  sources: Record<string, unknown>;
  note: string;
  rows: {
    qa_id: string;
    pairing: string;
    quality_change: string;
    score_delta: number | null;
    execution_changed: boolean;
    errors_added: string[];
    errors_removed: string[];
    gt_changed: boolean;
    left: AnalysisCase | null;
    right: AnalysisCase | null;
  }[];
}
export interface DiagnosisReport {
  requested: number;
  covered: number;
  model: string;
  provider_id: string;
  note: string;
  cases: {
    index: number;
    qa_id: string;
    valid: boolean;
    result: {
      observations?: string;
      possible_causes?: string;
      missing_evidence?: string;
      recommendations?: string;
      experiments?: string;
      evidence_refs?: string[];
    };
    raw: string;
    error?: string;
  }[];
}
export interface AnalysisJob<T = AnalysisReport> {
  status: string;
  job_id?: string;
  run_id?: string;
  kind?: string;
  processed: number;
  stale?: boolean;
  error?: string;
  report?: T;
  created_at?: number;
  cancel_requested?: boolean;
}
export interface AnalysisPage {
  items: AnalysisCase[];
  total: number;
  page: number;
  page_size: number;
}
export type AnalysisFilters = Record<string, string>;
export const activeAnalysis = (job: AnalysisJob<unknown> | null) =>
  !!job && ["queued", "running", "paused", "cancelling"].includes(job.status);
