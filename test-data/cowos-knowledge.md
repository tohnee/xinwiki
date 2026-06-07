# CoWoS 先进封装技术产业链

## CoWoS 概述

CoWoS（Chip-on-Wafer-on-Substrate）是台积电开发的 2.5D/3D 先进封装技术平台，将多个芯片（逻辑、内存、I/O 等）通过硅中介层（Silicon Interposer）集成在单一基板上。CoWoS 是 NVIDIA H100/H200/B200 等 AI GPU 的核心封装方案。

## CoWoS 技术演进

- **CoWoS-S**：使用硅中介层（Silicon Interposer）的基础方案，中介层面积可达 3-4 倍光罩尺寸
- **CoWoS-R**：使用有机中介层（RDL Interposer），成本更低
- **CoWoS-L**：结合局部硅桥（LSI）和 RDL 的中介层方案，平衡性能和成本
- **CoWoS-SoW**：系统级晶圆集成，将整个晶圆作为基底

## 产业链关键环节

### 1. 设计/EDA 工具
- **Cadence / Synopsys**：提供 2.5D/3D IC 设计工具和多物理场仿真
- **Ansys**：热分析、电源完整性分析
- **参数**：多芯片协同设计、热仿真、信号完整性验证

### 2. 前段制造（Wafer Fab）
- **台积电**：芯片制造 + 中介层制造，掌握核心工艺
- **关键工艺**：TSV（硅通孔）刻蚀、Cu 填充、微凸点（μbump）制作

### 3. 中介层制造
- **台积电（主要）**：硅中介层及 CoWoS-L 的 LSI 桥制造
- **联电（UMC）**：部分中介层代工机会
- **欣兴 / 景硕**：ABF 载板等有机中介层材料

### 4. 封装与测试（OSAT）
- **日月光（ASE）**：全球最大封测厂，参与 CoWoS 后段封装
- **安靠（Amkor）**：提供 2.5D 封装服务
- **京元电子（KYEC）**：测试服务
- **矽品（SPIL）**：封装服务

### 5. 基板（Substrate）
- **揖斐电（Ibiden）**：ABF 载板龙头，供应 NVIDIA AI GPU 基板
- **新光电气（Shinko）**：高端 IC 载板
- **欣兴电子（Unimicron）**：ABF 载板产能扩张
- **景硕（Kinsus）**：FC-BGA 载板

### 6. 关键材料
- **ABF 材料**：味之素（Ajinomoto）
- **硅晶圆**：信越化学、SUMCO、环球晶圆
- **封装基板材料**：三菱瓦斯化学、日立化成
- **TSV 填充材料**：铜电镀液供应商

### 7. 设备供应商
- **应用材料（AMAT）/ 泛林（Lam Research）**：TSV 刻蚀与沉积设备
- **DISCO**：晶圆切割和减薄设备
- **东京电子（TEL）**：涂布显影设备
- **KLA / Onto Innovation**：检测和计量

## 产能与供需

- **当前 CoWoS 月产能**（2024 年底）：约 4-5 万片晶圆
- **2025 年目标**：扩产至 7-8 万片/月
- **2026 年目标**：突破 10 万片/月
- **供需状况**：持续供不应求，NVIDIA 占大部分产能，AMD/Broadcom 等排队等待
- **扩产地**：竹南、台中、台南、嘉义（新建）

## 竞争格局

- **三星 I-Cube / X-Cube**：三星的 2.5D/3D 封装方案，客户基础较弱
- **Intel EMIB / Foveros**：Intel 的嵌入式多芯片互连桥和 3D 堆叠
- **台积电优势**：CoWoS 生态系统最成熟，客户最多，良率最高

## 市场影响

- AI 芯片需求推动 CoWoS 产能持续紧张
- NVIDIA B200 采用 CoWoS-L，使用面积更大的中介层
- CoWoS 产能不足已影响 NVIDIA GPU 供应节奏
- 台积电加速扩产以缓解瓶颈
