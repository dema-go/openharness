import { describe, expect, it } from 'vitest';
import { patchToml, patchYamlFlat, patchYamlIndent } from '../src/config-utils.js';

describe('patchToml 逐行补丁', () => {
  it('既有根键原位替换,其余内容字节级保留', () => {
    const src = 'notify = [\n  "a",\n]\nmodel = "gpt-5"\nsandbox_mode = "workspace-write"\n\n[desktop]\nfoo = 1\n';
    const out = patchToml(src, [{ section: null, key: 'model', value: 'gpt-6' }]);
    expect(out).toContain('model = "gpt-6"');
    expect(out).toContain('notify = [');
    expect(out).toContain('[desktop]\nfoo = 1');
    expect(out.split('model = ').length).toBe(2); // 只出现一次
  });

  it('缺失根键插入到首个 section 之前', () => {
    const src = 'model = "gpt-5"\n\n[desktop]\nfoo = 1\n';
    const out = patchToml(src, [{ section: null, key: 'model_provider', value: 'x' }]);
    const lines = out.split('\n');
    expect(lines.indexOf('model_provider = "x"')).toBeGreaterThan(-1);
    expect(lines.indexOf('model_provider = "x"')).toBeLessThan(lines.indexOf('[desktop]'));
  });

  it('section 内键替换与插入', () => {
    const src = '[model_providers.a]\nname = "A"\nbase_url = "http://old"\n';
    const out = patchToml(src, [
      { section: 'model_providers.a', key: 'base_url', value: 'http://new' },
      { section: 'model_providers.a', key: 'wire_api', value: 'chat' },
    ]);
    expect(out).toContain('base_url = "http://new"');
    expect(out).toContain('wire_api = "chat"');
    expect(out.indexOf('[model_providers.a]')).toBeLessThan(out.indexOf('wire_api'));
  });

  it('section 不存在时补 section 头', () => {
    const src = 'model = "gpt-5"\n';
    const out = patchToml(src, [{ section: 'new_sec', key: 'k', value: 'v' }]);
    expect(out).toContain('[new_sec]');
    expect(out).toContain('k = "v"');
  });
});

describe('patchYamlIndent 缩进式 YAML 补丁', () => {
  const src = 'ui-onboarding:\n  welcomeNoticeVersion: v1\nagent-default-model:\n  provider: a\n  model: m\n';

  it('既有键原位替换', () => {
    const out = patchYamlIndent(src, [{ section: 'agent-default-model', key: 'model', value: 'm2' }]);
    expect(out).toContain('  model: m2');
    expect(out).toContain('welcomeNoticeVersion: v1');
    expect(out.split('\n').filter((l) => /^\s+model:/.test(l))).toHaveLength(1);
  });

  it('缺失键插入 section 末尾', () => {
    const out = patchYamlIndent(src, [{ section: 'agent-default-model', key: 'reasoningEffort', value: 'max' }]);
    const lines = out.split('\n');
    const idx = lines.indexOf('  reasoningEffort: max');
    expect(idx).toBeGreaterThan(lines.indexOf('  model: m'));
    expect(lines.indexOf('ui-onboarding:')).toBeLessThan(idx);
  });

  it('缺失 section 追加到文件末尾', () => {
    const out = patchYamlIndent(src, [{ section: 'permission', key: 'defaultPreset', value: 'read-only' }]);
    expect(out).toContain('permission:');
    expect(out).toContain('  defaultPreset: read-only');
  });
});

describe('patchYamlFlat 扁平 YAML 补丁', () => {
  it('既有键替换、缺失键追加', () => {
    const src = 'DEEPSEEK_API_KEY: sk-old\n';
    const out = patchYamlFlat(src, [
      { key: 'DEEPSEEK_API_KEY', value: 'sk-new' },
      { key: 'ZAI_KEY', value: 'z1' },
    ]);
    expect(out).toContain('DEEPSEEK_API_KEY: sk-new');
    expect(out).toContain('ZAI_KEY: z1');
    expect(out.split('DEEPSEEK_API_KEY:').length).toBe(2);
  });

  it('含特殊字符的值加引号', () => {
    const out = patchYamlFlat('', [{ key: 'K', value: 'a: b' }]);
    expect(out).toContain('K: "a: b"');
  });
});
