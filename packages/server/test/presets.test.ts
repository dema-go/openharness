import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PresetStore } from '../src/presets.js';

describe('PresetStore 密钥零片段', () => {
  it('下发时密钥值不包含任何原文片段', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oh-presets-'));
    try {
      const store = new PresetStore(path.join(dir, 'presets.json'));
      const p = store.create('生产配置', 'claude', {
        'env.ANTHROPIC_AUTH_TOKEN': 'sk-abcdef1234567890secret',
        'env.ANTHROPIC_BASE_URL': 'https://open.bigmodel.cn/api/anthropic',
      });
      expect(p.values['env.ANTHROPIC_AUTH_TOKEN']).not.toContain('abcdef');
      expect(p.values['env.ANTHROPIC_AUTH_TOKEN']).not.toContain('secret');
      expect(p.values['env.ANTHROPIC_BASE_URL']).toContain('bigmodel'); // 非密钥原样
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('apply 用明文,list 用脱敏;删除生效', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oh-presets-'));
    try {
      const store = new PresetStore(path.join(dir, 'presets.json'));
      const p = store.create('测试', 'dsh', { 'cred.DEEPSEEK_API_KEY': 'sk-plain-secret' });
      const plain = store.getPlain(p.id)!;
      expect(plain.values['cred.DEEPSEEK_API_KEY']).toBe('sk-plain-secret');
      expect(store.delete(p.id)).toBe(true);
      expect(store.list()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
