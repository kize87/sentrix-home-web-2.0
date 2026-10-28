# 独立音频 ASR 评测工具

这个目录与 Sentrix 主项目隔离：

- 不 import `sentrix`；
- 不启动前端、FastAPI、SQLite 或向量数据库；
- 使用自己的虚拟环境、数据目录和输出目录；
- 支持 FunASR 或 Apple Silicon 上的 MLX Whisper，模型加载一次后逐条评测；
- 计算 CER、质量门禁误放行率、检索文本覆盖率、RTF、加载时间和峰值内存。

这里评估的是“ASR 输出是否适合作为检索文本”。它不会加载主项目的文本嵌入模型，因此不把
结果冒充成向量检索 Recall@K。

## 1. 环境

要求 Python 3.11、`ffmpeg` 和 `ffprobe`：

```bash
cd audio_eval
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

模型和 Hugging Face 数据均保存在各自的默认缓存中，不写入主项目的 `data/`。

## 2. 准备下载好的 Hugging Face 数据

以 FLEURS 普通话为例。如果你下载的是整个数据集仓库：

```bash
.venv/bin/python prepare_hf.py \
  --dataset /你的下载目录/google-fleurs \
  --config cmn_hans_cn \
  --split test \
  --audio-column audio \
  --text-column transcription \
  --limit 100 \
  --seed 42 \
  --output data/fleurs-zh-100
```

`--dataset` 也支持：

- `datasets.save_to_disk()` 生成的目录；
- 单个 `.parquet` 文件；
- HF 名称，例如 `google/fleurs`（这种写法会联网下载）。

脚本固定随机种子抽样，并统一转成 16 kHz、单声道、PCM WAV。输出清单格式为：

```json
{"id":"sample-id","audio":"/absolute/path/sample.wav","text":"标准人工转写"}
```

如果其他数据集的列名不同，通过 `--audio-column`、`--text-column`、`--id-column` 调整。

如果下载的是 FLEURS 官方的 `test.tsv` 和 `audio/test.tar.gz` 原始包，解压后可直接生成清单：

```bash
.venv/bin/python prepare_fleurs_raw.py \
  --tsv data/fleurs-cmn-hans-cn-test.tsv \
  --audio-dir data/fleurs-cmn-hans-cn-test-audio/test \
  --limit 100 \
  --seed 42 \
  --output data/fleurs-zh-100
```

## 3. 运行评测

AliMeeting Eval 可以先按人工标注切成句子级单声道音频。远场会从八通道阵列录音中固定选择一个声道，近场使用对应说话人的耳麦录音：

```bash
.venv/bin/python prepare_alimeeting.py \
  --dataset-root data/alimeeting/extracted/Eval_Ali \
  --track far \
  --limit 100 \
  --seed 42 \
  --max-overlap-ratio 0 \
  --output data/alimeeting-far-nonoverlap-100

.venv/bin/python prepare_alimeeting.py \
  --dataset-root data/alimeeting/extracted/Eval_Ali \
  --track near \
  --limit 100 \
  --seed 42 \
  --output data/alimeeting-near-100
```

默认只保留 1–20 秒且至少有 4 个有效字符的片段，并按源会议/说话人轮询抽样，避免样本集中在少数会议中。远场纯 ASR 评测建议传 `--max-overlap-ratio 0`，避免把多人重叠和说话人分离问题混入识别准确率；不传则可作为真实重叠压力测试。

CPU 基线：

```bash
.venv/bin/python evaluate.py \
  --manifest data/fleurs-zh-100/manifest.jsonl \
  --output outputs/fleurs-zh-100-paraformer-cpu \
  --model paraformer-zh \
  --vad-model fsmn-vad \
  --punc-model ct-punc \
  --device cpu \
  --bad-cer-threshold 0.20
```

第一次运行会下载模型。模型加载一次后常驻，样本严格串行处理，避免并发抬高内存。

Apple Silicon 上评测量化 Whisper small：

```bash
.venv/bin/python evaluate.py \
  --manifest data/alimeeting-near-100/manifest.jsonl \
  --output outputs/alimeeting-near-100-whisper-small-4bit-mlx-storage \
  --backend mlx-whisper \
  --model mlx-community/whisper-small-mlx-4bit \
  --device mlx \
  --language zh \
  --warmup 1 \
  --bad-cer-threshold 0.20
```

Whisper 原始中文可能混用繁体和简体。MLX 适配层保留 `raw_hypothesis`，同时使用 OpenCC
繁转简后再计算 CER、执行门禁并写入检索文本，避免书写体系差异被误算成识别错误。

使用 WorldMM 同款 Distil-Whisper large-v3.5（Apple Silicon 上由 CTranslate2 CPU int8
运行）：

```bash
.venv/bin/python evaluate.py \
  --manifest data/alimeeting-near-100/manifest.jsonl \
  --output outputs/alimeeting-near-100-distil-whisper-large-v3.5-cpu-int8-storage \
  --backend faster-whisper \
  --model distil-large-v3.5 \
  --device cpu \
  --compute-type int8 \
  --language zh \
  --warmup 1 \
  --bad-cer-threshold 0.20
```

该模型官方定位为 English-family Distil-Whisper；中文 AliMeeting 结果用于验证适配性，
不能根据其保留的多语言词表预设中文效果。

评测本地下载的 Qwen3-ASR 或 Fun-ASR-Nano Transformers 权重：

```bash
.venv/bin/python evaluate.py \
  --manifest data/alimeeting-near-100/manifest.jsonl \
  --output outputs/alimeeting-near-5-qwen3-asr-0.6b-mps \
  --backend transformers-asr \
  --model models/Qwen3-ASR-0.6B-hf \
  --device mps \
  --compute-type float16 \
  --language zh \
  --limit 5
```

将 `--model` 换成 `models/Fun-ASR-Nano-2512-hf` 即可测 Fun-ASR-Nano。
Fun-ASR-Nano 在本机 MPS FP16 实测会退化成重复标点，评测器会拒绝该组合；请同时把
`--compute-type` 改为 `float32`。
这两个 Hugging Face 生成式权重在此评测器中只返回整段文本；分段暂时记录为覆盖整条音频，
不能把它当作真实的词级时间戳评测。

先用 5 条检查环境：

```bash
.venv/bin/python evaluate.py \
  --manifest data/fleurs-zh-100/manifest.jsonl \
  --output outputs/smoke \
  --limit 5 \
  --device cpu
```

## 4. 输出

每次评测生成：

| 文件 | 内容 |
|---|---|
| `results.jsonl` | 每条音频的原文、识别文本、分段、门禁原因、CER、耗时和 RTF |
| `results.csv` | 便于在表格中筛选的扁平结果 |
| `summary.json` | 完整机器可读汇总、模型配置和门禁阈值 |
| `report.md` | 直接阅读的评测报告 |
| `audio_memory.sqlite3` | 独立的转写、分段和 FTS 检索文本存储 |

关键指标：

- `corpus_cer`：所有编辑数除以所有参考字符数；
- `searchable_projection_cer`：只看门禁放行后、实际会进入检索的文本，其整体 CER；
- `searchable_rate`：至少有一个片段通过门禁的样本比例；
- `false_accept_rate_among_bad`：CER 超阈值的样本中仍进入检索的比例；
- `pollution_rate_among_searchable`：所有可检索样本中明显错误样本的比例；
- `good_sample_coverage`：CER 未超阈值的样本中被门禁保留的比例；
- `overall_rtf`：总推理时间除以总音频时长，越小越快。
- 存储阶段另外统计写入成功率、内容完整性、总耗时、单条耗时和数据库大小；
- PyTorch MPS 运行时记录 MPS allocated/driver allocated；MLX 运行时分别记录 active、cache
  和 MLX 内部历史峰值。不同运行时的内存指标定义不同，不能直接相加。

## 5. 门禁边界

`evalkit/gate.py` 是第一版门禁的独立镜像，版本写入每份报告。当前 Paraformer 和 SenseVoice
如果不返回置信度或对齐分数，结构正常的文本仍会放行，但记录 `no_acoustic_score`。Whisper
则把平均 token 对数概率转换为置信度，并使用 `1 - no_speech_prob` 作为语音概率。因此最值得观察的是：

1. `no_acoustic_score` 出现多少次；
2. 高 CER 样本是否仍被放行；
3. 加噪后错误放行率是否明显升高；
4. 正常样本是否被门禁过度拦截。

## 6. 只运行工具自身测试

不安装 FunASR 也可以测试 CER 和门禁规则：

```bash
python3.11 -m unittest discover -s tests -v
```
