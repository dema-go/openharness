/**
 * 配置展示共用工具:对象扁平化 + 密钥脱敏。
 * 原则:配置页绝不返回任何配置文件的原文。
 */
import { isSecretKey, type AgentConfigEntry } from '@openharness/core';

/** 脱敏占位:绝不展示密钥任何片段(首尾字符也属泄露) */
const SECRET_PLACEHOLDER = '••••••••';

export function flattenSection(obj: Record<string, unknown>, prefix = ''): AgentConfigEntry[] {
  const out: AgentConfigEntry[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenSection(v as Record<string, unknown>, key));
    } else {
      const str = String(v ?? '');
      const secret = isSecretKey(k);
      out.push({ key, value: secret ? SECRET_PLACEHOLDER : str, masked: secret });
    }
  }
  return out;
}

/** 极简 TOML:提取 section → key/value(仅单行标量,忽略多行数组) */
export function parseTomlSections(content: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> = new Map();
  sections.set('', current);
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = new Map();
      sections.set(header[1]!.replace(/^"|"$/g, ''), current);
      continue;
    }
    if (line.startsWith('[')) continue; // 多行数组内容
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2]!.trim().replace(/^"|"$/g, '');
    if (value.startsWith('[')) continue; // 多行数组起始
    current.set(kv[1]!, value);
  }
  return sections;
}

export function entry(key: string, value: string): AgentConfigEntry {
  const secret = isSecretKey(key);
  return secret ? { key, value: SECRET_PLACEHOLDER, masked: true } : { key, value };
}

// ---------- 配置写入(逐行补丁:保留注释与其余内容) ----------

/** TOML 标量序列化 */
function tomlScalar(v: string): string {
  if (v === 'true' || v === 'false') return v;
  if (v !== '' && Number.isFinite(Number(v))) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** YAML 标量序列化(单行) */
function yamlScalar(v: string): string {
  if (v === '' || /[:#\[\]{}]|^\s|\s$/.test(v)) return JSON.stringify(v);
  return v;
}

/**
 * TOML 逐行补丁:更新既有键、缺失则插入到正确位置(根键插到首个 section 之前,
 * section 键插到该 section 末尾)。section 传 null 表示根级。
 */
export function patchToml(content: string, updates: Array<{ section: string | null; key: string; value: string }>): string {
  const lines = content.split('\n');
  const headerIndex = (name: string | null): number => {
    if (name === null || name === '') return -1;
    const re = new RegExp(`^\\[${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]$`);
    return lines.findIndex((l) => re.test(l.trim()));
  };
  for (const u of updates) {
    const hi = headerIndex(u.section);
    // 搜索范围:section 键 = 该 section 内部;根键 = 全文
    let start = 0;
    let end = lines.length;
    if (hi !== -1) {
      start = hi + 1;
      end = start;
      while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
    }
    const keyRe = new RegExp(`^\\s*${u.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
    let done = false;
    for (let i = start; i < end; i++) {
      if (keyRe.test(lines[i]!)) {
        lines[i] = `${u.key} = ${tomlScalar(u.value)}`;
        done = true;
        break;
      }
    }
    if (!done) {
      const newLine = `${u.key} = ${tomlScalar(u.value)}`;
      if (hi === -1 && u.section !== null) {
        // 补 section 头
        lines.push(`\n[${u.section}]`);
        lines.push(newLine);
      } else if (hi === -1) {
        // 根键:插到第一个 section 之前(或末尾)
        const firstSection = lines.findIndex((l) => /^\s*\[/.test(l.trim()));
        if (firstSection === -1) lines.push(newLine);
        else lines.splice(firstSection, 0, newLine);
      } else {
        lines.splice(end, 0, newLine);
      }
    }
  }
  return lines.join('\n');
}

/**
 * 缩进式 YAML 补丁(如 dsh settings.yaml):section 顶格,键缩进两格。
 * 更新既有键、缺失则插入 section 末尾(或文件末尾补 section)。
 */
export function patchYamlIndent(content: string, updates: Array<{ section: string | null; key: string; value: string }>): string {
  const lines = content.split('\n');
  for (const u of updates) {
    const hi = u.section === null ? -1 : lines.findIndex((l) => l.trim() === `${u.section}:`);
    let start = 0;
    let end = lines.length;
    if (hi !== -1) {
      start = hi + 1;
      end = start;
      // section 范围:直到下一个顶格(非缩进)行
      while (end < lines.length) {
        const t = lines[end]!.trim();
        if (t !== '' && !t.startsWith('#') && !/^\s/.test(lines[end]!)) break;
        end++;
      }
    }
    const keyRe = new RegExp(`^(\\s*)${u.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
    let done = false;
    for (let i = start; i < end; i++) {
      if (keyRe.test(lines[i]!)) {
        lines[i] = `  ${u.key}: ${yamlScalar(u.value)}`;
        done = true;
        break;
      }
    }
    if (!done) {
      const newLine = `  ${u.key}: ${yamlScalar(u.value)}`;
      if (hi === -1 && u.section !== null) {
        if (lines.length && lines[lines.length - 1]!.trim() !== '') lines.push('');
        lines.push(`${u.section}:`);
        lines.push(newLine);
      } else if (hi === -1) {
        lines.push(`${u.key}: ${yamlScalar(u.value)}`);
      } else {
        // 插入到 section 内容末尾(首个空行之前更整洁:直接插在 end 处)
        lines.splice(end, 0, newLine);
      }
    }
  }
  return lines.join('\n');
}

/**
 * 扁平 YAML 补丁(如 dsh .credentials.yaml:`KEY: value`)。
 */
export function patchYamlFlat(content: string, updates: Array<{ key: string; value: string }>): string {
  const lines = content.split('\n');
  for (const u of updates) {
    const keyRe = new RegExp(`^${u.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
    let done = false;
    for (let i = 0; i < lines.length; i++) {
      if (keyRe.test(lines[i]!)) {
        lines[i] = `${u.key}: ${yamlScalar(u.value)}`;
        done = true;
        break;
      }
    }
    if (!done) {
      while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
      lines.push(`${u.key}: ${yamlScalar(u.value)}`);
    }
  }
  return lines.join('\n');
}
