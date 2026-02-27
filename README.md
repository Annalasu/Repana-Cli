# Repana-Cli

这是一个基于 AI 的代码库分析与 Markdown 文档生成工具，通过命令行交互即可对任意代码项目进行多维度分析并输出标准化文档。

## 核心特性摘要

- **多维度分析模板**：内置创建README、架构总览、模块职责、数据流、代码质量、新人上手、项目业务分析7种分析方向
- **智能文件过滤与索引**：自动跳过 `.git`/`node_modules` 等常见忽略目录，识别文本类型代码文件
- **全局命令调用**：支持在任意目录下通过 `repana` 命令直接调用
- **可配置分析策略**：通过配置文件控制文件数量、深度、大小等采样阈值
- **配置持久化**：API Key 等配置保存于用户主目录 `~/.repana.json`，全局通用

## 环境依赖与快速开始

### 环境要求
- Node.js >= 18

### 快速开始
```bash
# 1. 进入项目目录
cd Repana-Cli

# 2. 安装依赖
npm install

# 3. 注册全局命令
npm link

# 4. 首次配置（设置 API Base URL、Model、API Key）
repana config

# 5. 在任意代码项目根目录下运行
repana
```

## 主要模块与使用说明

### 入口与交互流程
```mermaid
flowchart LR
    A[repana 命令] --> B[读取/初始化配置 ~/.repana.json]
    B --> C[构建仓库文件索引 buildRepoFileIndex]
    C --> D[通过 inquirer 选择分析方向]
    D --> E[生成代码快照 buildSnapshotFromFileIndex]
    E --> F[调用 AI 生成文档]
    F --> G[保存至 Analysis/doc.md 并可选打开]
```

### 核心函数说明
| 函数 | 功能描述 |
|------|----------|
| `shouldSkipDir(name)` | 判断是否需要跳过的目录（如 .git、node_modules） |
| `likelyTextFile(filePath)` | 根据扩展名和文件名判断是否为文本代码文件 |
| `buildRepoFileIndex(rootPath, profile, report)` | 递归扫描目录，生成文件列表与目录树结构 |
| `buildSnapshotFromFileIndex(index, profile, report, pickedRelPaths)` | 根据索引构建代码片段快照 |

## 项目目录结构

```
Repana-Cli/
├── index.js              # 主入口文件，包含 CLI 逻辑与核心工具函数
├── package.json          # 项目配置与依赖声明
├── package-lock.json     # 依赖版本锁定文件
└── README.md             # 项目说明文档
```

## 卸载指引

如果你不再需要使用该工具，可以通过以下步骤干净地卸载：

```bash
# 解除 npm 全局命令的软链接
npm uninstall -g repana

# (可选) 删除用户目录下的持久化配置文件
# Windows (PowerShell):
Remove-Item ~/.repana.json

# Mac / Linux:
rm ~/.repana.json

```


