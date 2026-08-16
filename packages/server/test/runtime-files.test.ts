import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory.js';
import { RoleStore, DEFAULT_ROLES } from '../src/roles.js';

describe('RoleStore 角色卡', () => {
  it('缺省角色卡 + 注入最前置', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oh-roles-'));
    try {
      const store = new RoleStore(path.join(dir, 'roles.json'));
      expect(store.get('claude')).toBe(DEFAULT_ROLES.claude);
      const p = store.inject('claude', '帮我改 bug');
      expect(p.startsWith('[角色设定]')).toBe(true);
      expect(p.endsWith('帮我改 bug')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('set 后持久化并生效', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oh-roles-'));
    const file = path.join(dir, 'roles.json');
    try {
      const store = new RoleStore(file);
      store.set('dsh', '新角色:复盘专家');
      const reloaded = new RoleStore(file);
      expect(reloaded.get('dsh')).toBe('新角色:复盘专家');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MemoryStore 共享记忆', () => {
  it('追加、裁剪、recent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oh-mem-'));
    const file = path.join(dir, 'memory.md');
    try {
      const store = new MemoryStore(file);
      store.append('第一条经验');
      store.append('第二条经验');
      expect(readFileSync(file, 'utf8')).toContain('第一条经验');
      expect(store.recent(1)).toHaveLength(1);
      expect(store.recent(1)[0]).toContain('第二条经验');
      expect(store.recent(5)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('超出上限裁剪最旧', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oh-mem-'));
    const file = path.join(dir, 'memory.md');
    try {
      const store = new MemoryStore(file);
      for (let i = 0; i < 205; i++) store.append(`条目${i}`);
      const lines = store.read().split('\n').filter(Boolean);
      expect(lines).toHaveLength(200);
      expect(lines[0]).toContain('条目5');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
