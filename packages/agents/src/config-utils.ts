/**
 * 配置展示共用工具:对象扁平化 + 密钥脱敏。
 * 原则:配置页绝不返回任何配置文件的原文。
 */
import { isSecretKey, maskSecret, type AgentConfigEntry } from '@openharness/core';

export function flattenSection(obj: Record<string, unknown>, prefix = ''): AgentConfigEntry[] {
  const out: AgentConfigEntry[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenSection(v as Record<string, unknown>, key));
    } else {
      const str = String(v ?? '');
      const secret = isSecretKey(k);
      out.push({ key, value: secret ? maskSecret(str) : str, masked: secret });
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
  return secret ? { key, value: maskSecret(value), masked: true } : { key, value };
}
