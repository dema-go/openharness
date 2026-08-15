#!/usr/bin/env node
/**
 * 日期一致性检查:扫描文档与设计稿中的所有年份,与系统时钟比对。
 *
 * 背景:2026-08 曾发生"文档把当前日期写成 2025"的事故——
 * 写文档的 Agent 凭模型记忆写年份,而非查系统时钟。
 * 本脚本是第二道防线:任何与系统年份不一致的年份引用都会被报告。
 *
 * 合法例外(外部资料的真实年份,如调查/文章/历史事件)按"整行包含"加入 ALLOWLIST。
 * 用法: node scripts/check-dates.mjs   —— 有告警时退出码为 1
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 扫描范围:docs/、design/ 全部文件 + 根目录下的这几个 Markdown */
const ROOT_FILES = ["README.md", "TODO.md", "CHANGELOG.md"];
const DIRS = ["docs", "design"];
const EXT = /\.(md|html)$/;

/**
 * 外部资料的真实年份(不是"当前日期"),按行匹配放行。
 * 新增条目时注明理由。
 */
const ALLOWLIST = [
  // 引用的外部资料:《Stack Overflow 2025 开发者调查》的解读文章,调查本身发布于 2025,
  // 2026 年调查(2026-06 开放)尚未发布结果,故保留 2025(见 docs/stack-decision.md)。
  "Stack Overflow 2025 调查",
];

const currentYear = new Date().getFullYear();

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(p)) out.push(p);
  }
  return out;
}

const files = [...ROOT_FILES, ...DIRS.flatMap((d) => walk(d))];
const findings = [];
const re = /\b(19|20)\d{2}\b/g;

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (ALLOWLIST.some((a) => line.includes(a))) return;
    for (const m of line.matchAll(re)) {
      if (Number(m[0]) !== currentYear) {
        findings.push(`  ${file}:${i + 1}  年份 ${m[0]} ≠ 系统年份 ${currentYear}
      ${line.trim()}`);
      }
    }
  });
}

if (findings.length) {
  console.error(`⚠️  发现 ${findings.length} 处与系统年份(${currentYear})不一致的年份引用:\n`);
  console.error(findings.join("\n"));
  console.error(
    '\n处理方式:若是"当前日期"写错 → 改为系统年份;' +
      '若是外部资料的真实年份 → 加入 scripts/check-dates.mjs 的 ALLOWLIST 并注明理由。',
  );
  process.exit(1);
}
console.log(`✅ 日期检查通过:docs/、design/ 与根文档中的年份均与系统时钟一致(${currentYear})。`);
