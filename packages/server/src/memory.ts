/**
 * MemoryStore:团队共享记忆。
 * 纯本地文件 ~/.openharness/memory.md,按行追加,最多保留 200 条。
 * 切换 Agent / 新对话注入摘要时附带最近几条,让跨会话经验得以沉淀。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_ENTRIES = 200;
const MAX_LEN = 300;

export class MemoryStore {
  private readonly file: string;

  constructor(file = path.join(os.homedir(), '.openharness', 'memory.md')) {
    this.file = file;
  }

  read(): string {
    try {
      if (existsSync(this.file)) return readFileSync(this.file, 'utf8');
    } catch {
      /* 无记忆 */
    }
    return '';
  }

  /** 记一笔:追加一行,超出上限裁剪最旧的 */
  append(text: string): void {
    const t = text.trim().replace(/\s+/g, ' ').slice(0, MAX_LEN);
    if (!t) return;
    const now = new Date();
    const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const lines = this.read().split('\n').filter((l) => l.trim());
    lines.push(`- [${stamp}] ${t}`);
    while (lines.length > MAX_ENTRIES) lines.shift();
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${lines.join('\n')}\n`, 'utf8');
  }

  /** 最近 n 条(用于注入摘要) */
  recent(n = 3): string[] {
    const lines = this.read().split('\n').filter((l) => l.trim());
    return lines.slice(-n);
  }
}
