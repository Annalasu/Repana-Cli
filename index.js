#!/usr/bin/env node
import fs from "fs/promises";
import path from "path";
import { exec, execFile } from "child_process";
import inquirer from "inquirer";
import chalk from "chalk";
import figlet from "figlet";
import ora from "ora";
import open from "open";

import os from "os";

// 将配置文件存放到用户主目录，使得全局调用时配置通用
const CONFIG_FILE = path.resolve(os.homedir(), ".repana.json");

const FOCUS_OPTIONS = [
    { key: "0", name: "创建README", prompt: "重点分析整个代码库的功能用途、环境依赖及结构，生成一份标准的开源级 README 面向开发/使用者的项目文档。" },
    { key: "1", name: "架构总览", prompt: "重点分析系统架构、模块边界、依赖关系与分层设计。" },
    { key: "2", name: "模块职责", prompt: "重点分析每个主要模块/目录职责、输入输出、关键接口。" },
    { key: "3", name: "数据流", prompt: "重点分析核心业务的数据流、状态变化与调用链路。" },
    { key: "4", name: "代码质量", prompt: "重点分析可维护性、潜在风险、技术债与改进建议。" },
    { key: "5", name: "新人上手", prompt: "重点生成面向新人的上手文档与代码阅读路径。" },
    { key: "6", name: "项目业务分析", prompt: "重点分析业务模块结构、核心业务方法、方法依赖关系和跨模块调用链路。" },
];

const STANDARD_PROFILE = {
    maxFiles: 250,
    maxDepth: 6,
    maxFileBytes: 180 * 1024,
    maxSnippetChars: 3500,
    maxSnippetFiles: 140
};

// ========================
// 核心工具函数
// ========================

function shouldSkipDir(name) {
    const skip = new Set([
        ".git", ".svn", ".hg", "node_modules", "dist", "build", "coverage", ".next", ".cache", "bin", "obj"
    ]);
    return skip.has(name);
}

function likelyTextFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const textExts = new Set([
        ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".cs", ".csproj", ".sln", ".java", ".kt", ".go",
        ".rs", ".py", ".rb", ".php", ".json", ".yaml", ".yml", ".toml", ".ini", ".xml", ".md", ".txt",
        ".html", ".css", ".scss", ".less", ".sql", ".sh", ".ps1", ".bat", ".cmd"
    ]);
    if (textExts.has(ext)) return true;
    const base = path.basename(filePath).toLowerCase();
    return ["dockerfile", "makefile", "readme", ".gitignore"].includes(base);
}

async function buildRepoFileIndex(rootPath, profile, report) {
    const files = [];
    const treeLines = [];

    async function walk(currentPath, depth) {
        if (depth > profile.maxDepth || files.length >= profile.maxFiles) return;
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name, "en"));

        for (const entry of entries) {
            if (files.length >= profile.maxFiles) break;

            const abs = path.join(currentPath, entry.name);
            const rel = path.relative(rootPath, abs) || ".";
            const indent = "  ".repeat(depth);

            if (entry.isDirectory()) {
                if (shouldSkipDir(entry.name)) continue;
                treeLines.push(`${indent}- ${entry.name}/`);
                await walk(abs, depth + 1);
            } else {
                treeLines.push(`${indent}- ${entry.name}`);
                files.push({ abs, rel });
            }
        }
    }

    await walk(rootPath, 0);

    return {
        rootPath,
        fileCount: files.length,
        tree: treeLines.join("\n"),
        files
    };
}

async function buildSnapshotFromFileIndex(index, profile, report, pickedRelPaths = null) {
    const files = Array.isArray(pickedRelPaths) && pickedRelPaths.length
        ? index.files.filter((x) => pickedRelPaths.includes(x.rel))
        : index.files;
    const snippets = [];
    let scannedTextFiles = 0;
    for (const file of files) {
        if (snippets.length >= profile.maxSnippetFiles) break;
        if (!likelyTextFile(file.abs)) continue;
        scannedTextFiles += 1;

        try {
            const stat = await fs.stat(file.abs);
            if (stat.size > profile.maxFileBytes) continue;
            const content = await fs.readFile(file.abs, "utf8");
            snippets.push(`### ${file.rel}\n\`\`\`\n${content.slice(0, profile.maxSnippetChars)}\n\`\`\``);
        } catch {
            // skip unreadable
        }
    }

    return {
        fileCount: index.fileCount,
        textFileCount: scannedTextFiles,
        snippetCount: snippets.length,
        selectedFileCount: files.length,
        tree: index.tree,
        snippets: snippets.join("\n\n")
    };
}

async function buildKnowledgeSnapshot(rawInput, report) {
    const value = String(rawInput || "").trim();
    if (!value) {
        return { sourceCount: 0, snippetCount: 0, snippets: "", directives: [] };
    }

    const candidates = value
        .split(/\r?\n|;/)
        .map((x) => x.trim())
        .filter(Boolean);

    if (!candidates.length) {
        return { sourceCount: 0, snippetCount: 0, snippets: "", directives: [] };
    }

    const maxFiles = 40;
    const maxDepth = 4;
    const maxFileBytes = 100 * 1024;
    const maxChars = 6000;
    const acceptedExt = new Set([".txt", ".md"]);
    const files = [];
    const visited = new Set();
    const directives = [];

    async function collectFromDir(rootDir, depth) {
        if (depth > maxDepth || files.length >= maxFiles) return;
        const entries = await fs.readdir(rootDir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name, "en"));

        for (const entry of entries) {
            if (files.length >= maxFiles) break;
            const abs = path.join(rootDir, entry.name);
            if (entry.isDirectory()) {
                if (shouldSkipDir(entry.name)) continue;
                await collectFromDir(abs, depth + 1);
                continue;
            }
            const ext = path.extname(entry.name).toLowerCase();
            if (!acceptedExt.has(ext)) continue;
            if (visited.has(abs)) continue;
            visited.add(abs);
            files.push(abs);
        }
    }

    for (const inputPath of candidates) {
        const abs = path.resolve(inputPath);
        try {
            const stat = await fs.stat(abs);
            if (stat.isDirectory()) {
                await collectFromDir(abs, 0);
                continue;
            }
            const ext = path.extname(abs).toLowerCase();
            if (acceptedExt.has(ext) && !visited.has(abs)) {
                visited.add(abs);
                files.push(abs);
            }
        } catch {
            report(`知识库路径不可读，已跳过: ${abs}`, "warn");
        }
        if (files.length >= maxFiles) break;
    }

    const snippets = [];
    for (const abs of files) {
        if (snippets.length >= maxFiles) break;
        try {
            const stat = await fs.stat(abs);
            if (stat.size > maxFileBytes) continue;
            const content = await fs.readFile(abs, "utf8");
            const rel = path.relative(process.cwd(), abs) || abs;
            snippets.push(`### ${rel}\n\`\`\`\n${content.slice(0, maxChars)}\n\`\`\``);

            const lines = content.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
            for (const line of lines) {
                const explicit = line.match(/^(DOC_INSTRUCTION|文档指令)\s*[:：]\s*(.+)$/i);
                if (explicit) {
                    directives.push(explicit[2].trim());
                }
            }
        } catch {
            // skip unreadable knowledge file
        }
    }

    if (snippets.length) {
        report(`知识库已加载 ${snippets.length} 份文档。`, "info");
    } else {
        report("未读取到可用的知识库文档（仅支持 .txt/.md 且需可读）。", "warn");
    }

    return {
        sourceCount: candidates.length,
        snippetCount: snippets.length,
        snippets: snippets.join("\n\n"),
        directives: Array.from(new Set(directives))
    };
}

function parseJsonObject(text) {
    const raw = String(text || "").trim();
    if (!raw) throw new Error("AI 规划返回为空。");
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1].trim() : raw;
    return JSON.parse(body);
}

function createFileCatalog(index, maxLines = 320) {
    return index.files
        .slice(0, maxLines)
        .map((x) => `- ${x.rel}`)
        .join("\n");
}

function extractDeltaText(delta) {
    if (typeof delta === "string") return delta;
    if (Array.isArray(delta)) {
        return delta
            .map((item) => {
                if (!item) return "";
                if (typeof item === "string") return item;
                if (typeof item.text === "string") return item.text;
                return "";
            })
            .join("");
    }
    return "";
}

async function readSseContent(res, onDelta) {
    if (!res.body) throw new Error("流式响应体为空。");
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let full = "";

    for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        for (; ;) {
            const idx = buffer.indexOf("\n");
            if (idx < 0) break;
            const rawLine = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const line = rawLine.trim();
            if (!line || line.startsWith(":")) continue;
            if (!line.startsWith("data:")) continue;

            const payload = line.slice(5).trim();
            if (!payload) continue;
            if (payload === "[DONE]") return full;

            let json = null;
            try {
                json = JSON.parse(payload);
            } catch {
                continue;
            }

            const deltaText = extractDeltaText(json?.choices?.[0]?.delta?.content);
            if (deltaText) {
                full += deltaText;
                if (onDelta) onDelta(deltaText, full.length);
            }
        }
    }

    const tail = decoder.decode();
    if (tail) buffer += tail;
    const remains = buffer.split("\n").map((x) => x.trim()).filter(Boolean);
    for (const line of remains) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
            const json = JSON.parse(payload);
            const deltaText = extractDeltaText(json?.choices?.[0]?.delta?.content);
            if (deltaText) {
                full += deltaText;
                if (onDelta) onDelta(deltaText, full.length);
            }
        } catch {
            // ignore malformed tail line
        }
    }

    if (!full) throw new Error("流式响应未包含可用内容。");
    return full;
}

async function callAiApi({
    apiBase,
    apiKey,
    model,
    focusPrompt,
    finalMdRequirements,
    repoPath,
    snapshot,
    knowledgeSnapshot,
    onDelta,
    onInfo
}) {
    const endpoint = `${apiBase.replace(/\/$/, "")}/chat/completions`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000);

    try {
        const basePayload = {
            model,
            messages: [
                {
                    role: "system",
                    content: [
                        "你是资深软件架构师与代码分析专家，输出结构化、清晰、可追溯的 Markdown 文档。",
                        "外部知识库是高优先级上下文：你必须先阅读知识库，再据此解读代码并生成结论。",
                        "按所选方向聚焦主题，避免无关展开。",
                        "文档避免冗长的配置细节、部署说明和空泛的未来规划。"
                    ].join("\n")
                },
                {
                    role: "user",
                    content: [
                        `请分析仓库：${repoPath}`,
                        `分析方向及其它侧重说明：${focusPrompt}`,
                        "",
                        "输出要求：",
                        "你必须严格按以下协议输出：",
                        "1) 先输出 4~8 行过程说明，每行必须以 [PROGRESS] 开头。",
                        "2) 过程说明行使用中文，描述当前分析动作，例如：正在梳理模块、正在识别调用链。",
                        "3) 完成过程说明后，单独输出一行：[FINAL_MD_BEGIN]",
                        "4) 在 [FINAL_MD_BEGIN] 之后，只输出最终 Markdown 文档，不要再输出 [PROGRESS]。",
                        "",
                        "最终 Markdown 文档内容要求：",
                        ...finalMdRequirements.map((item, idx) => `${idx + 1}. ${item}`),
                        "",
                        "全局约束（必须遵守）：",
                        "- 外部知识库优先级最高，先按知识库语义理解代码再输出文档。",
                        "- 尽量落到具体模块、函数/方法名和调用关系，减少空泛描述。",
                        "- 可视化内容优先使用 Mermaid 代码块（```mermaid ... ```），并根据内容选择合适图型（如 flowchart、sequenceDiagram、classDiagram）。",
                        "- 流程与依赖关系通常使用 flowchart；时序交互可使用 sequenceDiagram；结构关系可使用 classDiagram。节点文本包含模块或方法名，边上标注业务目的。",
                        "- Mermaid 语法必须严格正确：先声明图类型；节点 ID 仅使用英文字母/数字/下划线；节点显示文本放在 [] 或 () 中；避免在 ID 中使用空格、中文或特殊符号。",
                        "- Mermaid 边语法保持简单一致（如 A --> B 或 A -->|说明| B），避免混用复杂箭头和不闭合括号；输出前自行检查每个 Mermaid 代码块可独立渲染。",
                        "- 精简配置、启动、部署、环境细节；仅在理解主线必须时提及。",
                        "- 减少“未来建议/下一步计划”类内容，除非方向明确要求。",
                        "",
                        `外部知识库条目数（输入路径）：${knowledgeSnapshot?.sourceCount || 0}`,
                        `外部知识库文档数（采样）：${knowledgeSnapshot?.snippetCount || 0}`,
                        `外部知识库显式指令数：${knowledgeSnapshot?.directives?.length || 0}`,
                        "外部知识库显式指令（必须执行）：",
                        (knowledgeSnapshot?.directives?.length ? knowledgeSnapshot.directives.map((x) => `- ${x}`).join("\n") : "(无)"),
                        "外部知识库内容（先阅读本段再阅读代码）：",
                        knowledgeSnapshot?.snippets || "(未挂载外部知识库)",
                        "",
                        `仓库文件数（采样）：${snapshot.fileCount}`,
                        `实际纳入分析文件数：${snapshot.selectedFileCount || snapshot.fileCount}`,
                        `文本文件数（采样）：${snapshot.textFileCount}`,
                        `代码片段数（采样）：${snapshot.snippetCount}`,
                        "仓库树：",
                        snapshot.tree || "(空)",
                        "",
                        "代码片段采样：",
                        snapshot.snippets || "(无可读文本文件)"
                    ].join("\n")
                }
            ],
            temperature: 0.2
        };

        const requestOnce = async (useStream) => {
            const reqBody = useStream ? { ...basePayload, stream: true } : basePayload;
            const res = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`
                },
                body: JSON.stringify(reqBody),
                signal: controller.signal
            });

            if (!res.ok) {
                throw new Error(`API 调用失败 (${res.status}): ${await res.text()}`);
            }

            const contentType = String(res.headers.get("content-type") || "").toLowerCase();
            if (useStream && contentType.includes("text/event-stream")) {
                return await readSseContent(res, onDelta);
            }

            const json = await res.json();
            const content = json?.choices?.[0]?.message?.content;
            if (!content) throw new Error("API 返回内容为空。请检查模型或 API 网关兼容性。");
            if (onDelta) onDelta(content, content.length);
            return content;
        };

        try {
            return await requestOnce(true);
        } catch (streamErr) {
            if (onInfo) onInfo("流式输出不可用，自动切换为非流式模式。");
            return await requestOnce(false);
        }
    } catch (err) {
        if (err?.name === "AbortError") {
            throw new Error("AI 调用超时（5分钟）。");
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function callAiPlannerApi({
    apiBase,
    apiKey,
    model,
    focusPrompt,
    finalMdRequirements,
    repoPath,
    repoIndex,
    knowledgeSnapshot
}) {
    const endpoint = `${apiBase.replace(/\/$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);

    try {
        const payload = {
            model,
            messages: [
                {
                    role: "system",
                    content: [
                        "你是代码检索规划助手，只负责挑选后续需要深入阅读的文件。",
                        "必须根据分析方向与输出要求来选择文件。",
                        "只输出 JSON，不输出 Markdown、解释文本或代码块。"
                    ].join("\n")
                },
                {
                    role: "user",
                    content: [
                        `仓库路径：${repoPath}`,
                        `分析方向及其它侧重：${focusPrompt}`,
                        "最终文档要求：",
                        ...finalMdRequirements.map((x, idx) => `${idx + 1}. ${x}`),
                        "",
                        `外部知识库显式指令数：${knowledgeSnapshot?.directives?.length || 0}`,
                        "",
                        `仓库采样文件总数：${repoIndex.fileCount}`,
                        "仓库树：",
                        repoIndex.tree || "(空)",
                        "",
                        "可选文件清单：",
                        createFileCatalog(repoIndex),
                        "",
                        "请输出严格 JSON，结构如下：",
                        "{",
                        '  "selectedFiles": [',
                        '    { "path": "相对路径", "reasonByFocus": "说明该文件对应哪个方向要求" }',
                        "  ]",
                        "}",
                        "约束：",
                        "- selectedFiles 长度 20~80。",
                        "- path 必须从可选文件清单中选择，不能虚构。",
                        "- reasonByFocus 必须紧扣分析方向和文档章节要求。"
                    ].join("\n")
                }
            ],
            temperature: 0
        };

        const res = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        if (!res.ok) {
            throw new Error(`AI 规划调用失败 (${res.status}): ${await res.text()}`);
        }

        const json = await res.json();
        const content = json?.choices?.[0]?.message?.content;
        if (!content) throw new Error("AI 规划返回为空。");
        return parseJsonObject(content);
    } catch (err) {
        if (err?.name === "AbortError") {
            throw new Error("AI 规划超时（120秒）。");
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function readConfig() {
    try {
        const raw = await fs.readFile(CONFIG_FILE, "utf8");
        return JSON.parse(raw);
    } catch {
        return {
            apiBase: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
            apiKey: ""
        };
    }
}

async function writeConfig(partial) {
    const cfg = { ...(await readConfig()), ...partial };
    await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}


// ========================
// 交互与主流程
// ========================

async function inqPrompt(questions) {
    const pfx = chalk.cyan('>>');
    const arr = Array.isArray(questions) ? questions : [questions];
    arr.forEach(q => {
        if (!q.prefix) q.prefix = pfx;
    });
    return inquirer.prompt(arr);
}

function displayWelcome() {
    console.log(chalk.cyan(figlet.textSync('RepAna Cli', { horizontalLayout: 'full' })));
    console.log(chalk.gray('AI 代码仓分析与文档生成工具 (RepAna Cli)'));
    console.log();
}

function displayHelp() {
    console.log(chalk.yellow('用法:'));
    console.log(`  repana         启动主要分析流程`);
    console.log(`  repana config  配置大模型 (API Key, Base URL, Model)`);
    console.log(`  repana help    显示此帮助信息`);
    console.log();
}

async function configModel() {
    const currentCfg = await readConfig();
    console.log(chalk.blue('--- 大模型配置 ---'));
    const answers = await inqPrompt([
        {
            type: 'input',
            name: 'apiBase',
            message: 'API Base URL:',
            default: currentCfg.apiBase,
        },
        {
            type: 'input',
            name: 'model',
            message: 'Model:',
            default: currentCfg.model,
        },
        {
            type: 'password',
            name: 'apiKey',
            message: 'API Key:',
            mask: '*',
            default: currentCfg.apiKey,
        }
    ]);

    if (answers.apiKey.trim() === '') {
        // 保持原来的
        answers.apiKey = currentCfg.apiKey;
    }

    await writeConfig(answers);
    console.log(chalk.green(`✓ 配置已全局保存到 ${CONFIG_FILE}\n`));
}

async function startWorkflow() {
    const cfg = await readConfig();

    // 检查 API Key
    if (!cfg.apiKey) {
        console.log(chalk.yellow('检测到尚未配置大模型 API Key，请先配置：'));
        await configModel();
        // 重新读取配置
        Object.assign(cfg, await readConfig());
    }

    console.log(chalk.cyan(`\n当前工作目录: ${process.cwd()}`));
    const answers = await inqPrompt([
        {
            type: 'input',
            name: 'codePath',
            message: '请输入代码库目录 (留空默认当前目录):',
            default: process.cwd()
        },
        {
            type: 'input',
            name: 'knowledgePath',
            message: '请输入知识库目录 (选填，支持 txt/md 文件或目录):',
        },
        {
            type: 'list',
            name: 'focusType',
            message: '请选择分析方向:',
            choices: [
                { name: '预设', value: 'preset' },
                { name: '自定义分析提示', value: 'custom' }
            ]
        }
    ]);

    let finalFocusPrompt = '';
    let finalMdRequirements = [];

    if (answers.focusType === 'preset') {
        const presetAnswer = await inqPrompt([
            {
                type: 'list',
                name: 'focusIndex',
                message: '请选择预设分析方向:',
                choices: FOCUS_OPTIONS.map(opt => ({ name: `${opt.key}. ${opt.name}`, value: opt.key }))
            }
        ]);
        const selectedFocus = FOCUS_OPTIONS.find(f => f.key === presetAnswer.focusIndex);
        finalFocusPrompt = selectedFocus.prompt;

        const reqs = {
            "0": ["项目名称与简介", "核心特性摘要", "环境依赖与快速开始", "主要模块与使用说明", "项目目录结构"],
            "1": ["标题与摘要", "架构分层与模块边界", "关键组件/服务职责与依赖关系", "关键设计决策"],
            "2": ["标题与摘要", "模块清单（按目录/模块分组）", "每模块职责、输入输出与关键接口", "模块间依赖与协作关系"],
            "3": ["标题与摘要", "关键业务流程概览", "端到端数据流步骤与调用链路", "状态变化与持久化节点"],
            "4": ["标题与摘要", "质量概览（可维护性/复杂度/规范/测试）", "关键问题清单（含影响与可能位置）", "技术债与优先级排序", "具体改进建议"],
            "5": ["标题与摘要", "代码结构与关键入口", "核心模块阅读顺序与建议", "常见任务与定位路径"],
            "6": ["标题与摘要", "业务模块清单（按目录/模块分组）", "核心业务方法与方法职责说明", "模块间方法依赖关系", "关键业务流程调用链路"]
        };
        finalMdRequirements = reqs[presetAnswer.focusIndex];
    } else {
        // 自定义分析
        const customOptions = await inqPrompt([
            {
                type: 'list',
                name: 'promptType',
                message: '提示词输入方式?',
                choices: [
                    { name: '直接输入提示词', value: 'input' },
                    { name: '导入提示词文件(.md/.txt)', value: 'file' }
                ]
            },
            {
                type: 'input',
                name: 'promptContent',
                message: '请输入提示词内容:',
                when: (ans) => ans.promptType === 'input'
            },
            {
                type: 'input',
                name: 'promptFile',
                message: '请输入提示词文件路径:',
                when: (ans) => ans.promptType === 'file'
            },
            {
                type: 'input',
                name: 'focusEmphasis',
                message: '请输入分析文档侧重点:',
            },
            {
                type: 'input',
                name: 'docFormat',
                message: '请输入文档格式说明（如：1. 摘要 2. 模块 xxx）:',
            }
        ]);

        let promptContext = '';
        if (customOptions.promptType === 'file') {
            try {
                promptContext = await fs.readFile(path.resolve(customOptions.promptFile), 'utf8');
            } catch (e) {
                console.log(chalk.red('\n无法读取提示词文件，将留空。'));
            }
        } else {
            promptContext = customOptions.promptContent;
        }

        finalFocusPrompt = `背景提示：\n${promptContext}\n侧重点：${customOptions.focusEmphasis}`;
        finalMdRequirements = [
            "标题与摘要",
            ...customOptions.docFormat.split(/[,，\n]/).filter(f => f.trim()),
            "关键结论与改进建议"
        ];
    }

    const outAnswer = await inqPrompt([
        {
            type: 'input',
            name: 'outputFile',
            message: '请输入输出文档路径 (留空默认 [代码库目录]/Analysis/doc.md):'
        }
    ]);
    const finalCodePath = answers.codePath.trim() ? path.resolve(answers.codePath) : process.cwd();
    const finalOutputFile = outAnswer.outputFile.trim()
        ? path.resolve(outAnswer.outputFile)
        : path.resolve(finalCodePath, "Analysis", "doc.md");

    console.log(chalk.cyan('\n────────────────────────────────────'));
    console.log(chalk.cyan('开始分析生成（AI自主规划 + 标准采样）'));
    console.log(chalk.cyan('代码库:'), answers.codePath);
    console.log(chalk.cyan('大模型:'), cfg.model);
    console.log(chalk.cyan('────────────────────────────────────\n'));

    const spinner = ora('初始化...').start();
    let progressLineCount = 0;

    const report = (msg, type = 'info') => {
        // 过滤掉 [PROGRESS] 前缀并用 spinner 显示
        spinner.text = msg.replace(/^\[PROGRESS\]\s*/, '').trim();
        if (type === 'warn') {
            spinner.warn(msg);
            spinner.start();
        } else if (type === 'success') {
            spinner.succeed(msg);
            spinner.start();
        }
    };

    try {
        const codePath = finalCodePath;
        try {
            const st = await fs.stat(codePath);
            if (!st.isDirectory()) throw new Error('不是有效的目录');
        } catch {
            throw new Error(`路径不存在或不是目录: ${codePath}`);
        }

        spinner.text = '扫描仓库目录...';
        const repoIndex = await buildRepoFileIndex(codePath, STANDARD_PROFILE, report);
        spinner.succeed(`目录扫描完成: 发现 ${repoIndex.fileCount} 个文件`);

        let knowledgeSnapshot = { sourceCount: 0, snippetCount: 0, snippets: "", directives: [] };
        if (answers.knowledgePath && answers.knowledgePath.trim()) {
            spinner.start('正在加载知识库...');
            knowledgeSnapshot = await buildKnowledgeSnapshot(answers.knowledgePath, report);
            if (knowledgeSnapshot.snippetCount === 0) {
                spinner.warn('未读取到任何可用的外部知识库文档。');
            } else {
                spinner.succeed(`知识库加载完成: 包含 ${knowledgeSnapshot.snippetCount} 份文档片段`);
            }
        }

        spinner.start('正在由 AI Agent 规划需要抓取的文件...');
        const plan = await callAiPlannerApi({
            apiBase: cfg.apiBase,
            apiKey: cfg.apiKey,
            model: cfg.model,
            focusPrompt: finalFocusPrompt,
            finalMdRequirements: finalMdRequirements,
            repoPath: codePath,
            repoIndex,
            knowledgeSnapshot
        });

        const selectedPaths = (plan?.selectedFiles || []).map(x => String(x?.path || "").trim()).filter(Boolean);
        const validSet = new Set(repoIndex.files.map((x) => x.rel));
        const validPaths = Array.from(new Set(selectedPaths)).filter((x) => validSet.has(x));

        if (!validPaths.length) {
            throw new Error("AI 规划结果无有效文件（路径不在可选清单中）。");
        }
        spinner.succeed(`AI 规划完成: 确定了需要阅读的 ${validPaths.length} 个核心文件。`);

        // 提取代码片段
        spinner.start('正在提取代码片段...');
        const snapshot = await buildSnapshotFromFileIndex(repoIndex, STANDARD_PROFILE, report, validPaths);
        spinner.succeed(`片段提取成功: 读取文本文件 ${snapshot.textFileCount}`);

        spinner.start('正在调用 AI 生成分析文档 (可能需要几十秒至几分钟)...');

        let mdStarted = false;
        let mdBuffer = "";
        let protoBuffer = "";

        const rawOutput = await callAiApi({
            apiBase: cfg.apiBase,
            apiKey: cfg.apiKey,
            model: cfg.model,
            focusPrompt: finalFocusPrompt,
            finalMdRequirements: finalMdRequirements,
            repoPath: codePath,
            snapshot,
            knowledgeSnapshot,
            onInfo: (line) => spinner.info(line),
            onDelta: (delta) => {
                if (mdStarted) {
                    mdBuffer += delta;
                } else {
                    protoBuffer += delta;
                    const marker = "[FINAL_MD_BEGIN]";
                    const markerIdx = protoBuffer.indexOf(marker);

                    if (markerIdx >= 0) {
                        const header = protoBuffer.slice(0, markerIdx);
                        header.split(/\r?\n/).forEach(line => {
                            line = line.trim();
                            if (line.startsWith("[PROGRESS]")) {
                                spinner.text = line.replace(/^\[PROGRESS\]\s*/, '').trim();
                            }
                        });
                        mdStarted = true;
                        spinner.text = 'AI 已进入正式生成 Markdown 阶段，正在接收流式数据...';
                        mdBuffer += protoBuffer.slice(markerIdx + marker.length);
                        protoBuffer = "";
                        return;
                    }

                    const lastNewline = protoBuffer.lastIndexOf("\n");
                    if (lastNewline >= 0) {
                        const complete = protoBuffer.slice(0, lastNewline + 1);
                        protoBuffer = protoBuffer.slice(lastNewline + 1);
                        complete.split(/\r?\n/).forEach(line => {
                            line = line.trim();
                            if (line.startsWith("[PROGRESS]")) {
                                spinner.text = line.replace(/^\[PROGRESS\]\s*/, '').trim();
                            }
                        });
                    }
                }
            }
        });

        spinner.succeed('AI 分析生成完毕');

        let finalMd = "";
        if (mdStarted) {
            finalMd = mdBuffer.trimStart();
        } else {
            const marker = "[FINAL_MD_BEGIN]";
            const idx = rawOutput.indexOf(marker);
            if (idx >= 0) {
                finalMd = rawOutput.slice(idx + marker.length).trimStart();
            } else {
                finalMd = rawOutput;
            }
        }

        spinner.start('保存文档...');
        await fs.mkdir(path.dirname(finalOutputFile), { recursive: true });
        await fs.writeFile(finalOutputFile, finalMd, "utf8");
        spinner.succeed(`全部完成！生成完毕提示：文档已保存至 ${finalOutputFile}`);

        // 直接触发打开文档
        console.log(chalk.gray(`正在调用系统默认程序打开: ${finalOutputFile}`));
        await open(finalOutputFile);

    } catch (err) {
        spinner.fail(`执行过程中发生错误: ${err.message}`);
    }
}


// ========================
// CLI 参数解析
// ========================

const args = process.argv.slice(2);
const command = args[0] || '';

if (command === 'help' || command === '--help' || command === '-h') {
    displayHelp();
    process.exit(0);
}

displayWelcome();

async function waitForNextRound() {
    console.log(chalk.gray('\n✨ 本轮分析已结束'));
    console.log(chalk.gray('按下 回车键 (Enter) 开始下一轮分析，或按下 Esc 键退出...'));
    return new Promise((resolve) => {
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        const handleKey = (key) => {
            // ctrl-c or ESC
            if (key === '\u0003' || key === '\u001b') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', handleKey);
                resolve(false);
            }
            // Enter
            if (key === '\r' || key === '\n') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', handleKey);
                resolve(true);
            }
        };

        stdin.on('data', handleKey);
    });
}

if (command === 'config') {
    configModel().catch(err => {
        console.error(chalk.red(err.message));
        process.exit(1);
    });
} else {
    (async () => {
        while (true) {
            try {
                await startWorkflow();
            } catch (err) {
                console.error(chalk.red("严重错误: "), err);
            }
            const next = await waitForNextRound();
            if (!next) {
                process.exit(0);
            }
            console.log(); // 换行排版
        }
    })();
}
