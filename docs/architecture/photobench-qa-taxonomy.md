# PhotoBench QA 版本与分类

QA schema 2.0、分类1.0。分类唯一来源是 `domain/datasets/qa_taxonomy.py`；`scripts/export_qa_taxonomy.py` 生成前端字典，CI检查一致性。`GET /api/v1/qa-taxonomy` 提供同一字典。

## 独立维度

- `task_type` 大类：媒体检索、事实查询、统计整理、内容概述；`question_type` 是该大类下唯一小类。纯越权使用 `not_applicable`；并列任务待核使用 `pending_review`。
- `expected_action`：回答、澄清、拒答、回答并拒绝越权部分。`answerability`、`injection`、`difficulty` 独立保存。
- 多轮逐轮定义，题级采用最后实质任务；未执行轮不能进入已执行统计。媒体类型、轮数、GT数量从原始事实派生。
- 内容质量与行为符合率分别判断。混合行为只有规则2的Judge结果进入新行为统计，旧结果保留。

分类边界、难度四项依据、1167题逐题记录及字段迁移见数据版 `2026.10.24-taxonomy1/README.md`。此次为模型辅助整理，未替代人工审核。

## 输入冻结与来源

集合级 `manifest.qa_set_versions[qa_set]` 声明数据/schema/分类版本、QA文件SHA256。加载schema2验证ID唯一、分类父子关系、最终轮一致和文件哈希。

新run的 `qa_snapshot` 保存完整加载后的QA定义与 `definition_sha256`，包括默认策略、逐轮标签；执行、续跑、重评分使用该快照。列表/详情摘要仅投影来源元信息，durable run.json保留完整定义。

历史补标签使用 `album_id + qa_set + 原QA文件SHA256 + qa_id`。无法核验版本的字段保持未记录，不按裸ID连接最新题库。旧run重评分只使用已保存的逐轮参考答案；多轮缺少参考答案时明确拒绝。重评分前校验完整快照，保留旧评分历史，不自动触发重评分。

## 分析规则5

内容大/小类提供按题和按对话轮两种分布：题型内的得分，以及各得分下的题型。筛选轮级条件必须在同一轮成立，案例列表按题去重；行为始终按轮统计。

`not_applicable / pending_review / unknown` 单列，排除有效内容占比分母。运行异常热力图按题，行为图使用全部轮与有效判定轮各自分母。

结果/证据/标签指纹分开记录。标签变化不冒称GT变化；对比标签不同时可并排查看事实，不给出版本提升汇总。旧报告保留生成时来源。

HTML离线报告、JSON、CSV与页面使用同一派生报告和案例筛选。HTML转义原始文本，CSV防公式注入；完整轨迹按需加载。
