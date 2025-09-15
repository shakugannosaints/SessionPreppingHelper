# 备团助手（TRPG 模组整理软件）

一个轻量的本地 Web 应用，用于以“节点 + 字段”的方式整理 TRPG 模组信息，并以图谱形式查看与编辑关联关系。

## 功能概览

- 节点/字段：创建节点，添加文本/标签/引用/数值字段，编辑/删除字段。
- 可视化：基于字段样式（标签决定颜色、数值决定大小），支持拖拽、平滑缩放、自动/分层布局；新建节点落在“当前视图中心”，刷新不重置视角。
- 关联关系：
  - 自动关联（Rule B）：若节点有“标签=Tag 且 名称=Name”，则与“显式字段 key=Tag, value=Name”的节点建立自动连线；箭头指向“含有标签的节点”，自动边为虚线。
  - 手动关联：可自定义连线并命名，双向箭头。
  - 过滤：可按字段键筛选（例如只按“地点”标签派生的自动边）。
  - 选择性隐藏自动关联：点击任意自动边（虚线）即可隐藏；左侧“被隐藏的自动关联”中可恢复。
- 边弧度与标签：
  - 支持按住 Shift/Ctrl 在边上拖动，调整弧度（可向两侧弯曲），文本自动随弧度旋转；可一键开/关“显示连线文本”。
  - 手动边的弧度会持久化到 link；自动边的弧度会持久化到 `autoEdgeOverrides`（按 source->target 覆盖）。
  - 自动布局后，会为未锁定的同对节点边分配对称扇形弧度，减小重叠；你手动调整过的弧度不会被覆盖。
- 搜索和筛选：支持关键字、`key:`、`value:`、`key:value`，空格/AND 为且，OR/或 为或；以过滤方式隐藏不匹配节点/边。
- 模板：可保存常用字段组合，一键创建标准节点（如 NPC 模板）。
- 导入导出：JSON（全量）、CSV（节点字段明细）、Markdown（可读报告）。
- 撤销/重做：按钮与快捷键（Ctrl+Z / Ctrl+Y），历史保存在内存（重启后清空）。
- 本地持久化：数据在内存缓存，延迟落盘到 `app/data.json`（原子写入 + 重试 + 自动修复）；模板在 `app/templates.json`。

## 运行环境

- Windows / macOS / Linux
- Python 3.9+

## 快速开始

1) 安装依赖

```powershell
python -m venv .venv; .\.venv\Scripts\Activate.ps1; pip install -r requirements.txt
```

2) 启动服务

```powershell
python -m app.main
```

3) 打开浏览器访问

```
http://127.0.0.1:5000/
```

## 数据结构

- 节点（Node）
  - id: string (uuid)
  - fields: Array<{ key: string; type: 'text'|'tag'|'ref'|'number'; value: string|number }>
  - position?: { x: number; y: number }

- 手动关联（Link）
  - id: string (uuid)
  - source: string (nodeId)
  - target: string (nodeId)
  - label?: string
  - type: 'manual'
  - cpd?: number （可选，连线弧度，支持负值表示向另一侧弯曲）

- 自动边覆盖（AutoEdgeOverrides）
  - 结构：`autoEdgeOverrides: { "<source>-><target>": number(cpd) }`
  - 说明：存储自动边的弧度覆盖；服务端在返回自动边时合并此值。


## 导入导出

- JSON：全量导出/导入（节点 + 手动关联 + 被隐藏的自动关联对 + 自动边弧度覆盖 `autoEdgeOverrides`）。
- CSV：导出节点字段明细（列：node_id, field_key, field_type, field_value）。
- Markdown：导出节点清单（可读文档）。

### 关于“被隐藏的自动关联”

- 数据结构存放在 `app/data.json` 的 `suppressedAutoPairs` 字段中，元素形如 `{ "a": "节点ID1", "b": "节点ID2" }`（顺序无关）。
- 在计算自动关联时，会跳过上述成对节点之间的自动连线；无需影响其他任何自动连线。
- 在 UI 中：
  - 点击图上的“虚线”（自动连线）→ 确认后将该条隐藏。
  - 左侧“被隐藏的自动关联”列表可逐条“恢复”。

### 关于“连线弧度与文本”

- 调整弧度：按住 Shift/Ctrl，在边上按下并上下拖动；手动边的弧度会保存到 link，自动边保存到 `autoEdgeOverrides`。
- 显示文本：在工具栏使用“显示连线文本”开关，快速开/关边上的 label。
- 自动布局：会为未锁定的同对节点边分配对称弧度；已调整（已持久化）的边不受影响。

## 快捷键

- 撤销/重做：Ctrl+Z / Ctrl+Y
- 新建节点：N（新节点落在当前视图中心）
- 开始连线：L 或 A（随后点击两个节点）
- 复制选中节点：Ctrl+Shift+K（工具栏亦有按钮）
- 为选中节点添加字段：F
- 删除选中：Delete / Backspace（手动边=删除；自动边=隐藏；节点=删除并移除相关手动边）

## 常见字段与样式映射

- 标签（tag）影响颜色：
  - NPC: #4F8EF7（蓝）
  - 地点: #34C759（绿）
  - 剧情: #F59E0B（橙）
  - 其他标签使用稳定哈希生成的颜色。
- 数值字段影响大小（取节点内所有数值字段的最大值作为基准，线性映射 30px ~ 80px）。

## 模板示例

默认内置模板：

- NPC 模板：姓名(text)、标签(tag=NPC)、地点(text)、动机(text)
- 地点 模板：名称(text)、标签(tag=地点)

## 开发

- 后端：Flask，见 `app/main.py`。
- 数据存储：JSON 文件，见 `app/storage.py`。
- 前端：原生 HTML/JS + Cytoscape.js，见 `app/static/`。
