import { describe, expect, it } from 'vitest';
import {
  extractUserPrompt,
  isInjectedSystemText,
  isSecretKey,
  maskSecret,
  truncate,
} from '../src/index.js';

describe('core 工具函数', () => {
  it('truncate 截断并压平空白', () => {
    expect(truncate('a b\nc', 4)).toBe('a b…');
    expect(truncate('短文本', 10)).toBe('短文本');
  });

  it('isSecretKey 识别常见密钥键名', () => {
    expect(isSecretKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(isSecretKey('token')).toBe(true);
    expect(isSecretKey('password')).toBe(true);
    expect(isSecretKey('model')).toBe(false);
  });

  it('maskSecret 短值全掩码', () => {
    expect(maskSecret('abc12345')).toBe('••••••••');
    expect(maskSecret('sk-abcdefghijklmnop')).toContain('••••••••');
  });

  it('isInjectedSystemText 识别系统注入标签', () => {
    expect(isInjectedSystemText('<system-reminder> 遵守规范')).toBe(true);
    expect(isInjectedSystemText('<recommended_plugins>\n插件列表')).toBe(true);
    expect(isInjectedSystemText('<app-context>桌面上下文')).toBe(true);
    expect(isInjectedSystemText('帮我分析这段代码')).toBe(false);
    expect(isInjectedSystemText('  <permissions instructions> 沙箱说明')).toBe(true);
  });

  it('extractUserPrompt 提取[本轮消息]后的真实输入', () => {
    const injected = '[对话背景] 之前的对话…\n\n[本轮消息] 帮我改个 bug';
    expect(extractUserPrompt(injected)).toBe('帮我改个 bug');
    expect(extractUserPrompt('普通消息没有标记')).toBe('普通消息没有标记');
  });
});
