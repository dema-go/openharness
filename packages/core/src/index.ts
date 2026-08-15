export * from './types.js';
export * from './adapter.js';

/** 工具函数:截断文本为人可读摘要 */
export function truncate(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

const SECRET_KEY = /(token|api[_-]?key|apikey|secret|password|credential|\bauth\b)/i;

/** 判断配置键是否为敏感项 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** 密钥脱敏:保留前 4 后 4,其余替换为 • */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
}

const INJECTED_TAG = /^<\s*(system-reminder|recommended_plugins|app-context|permissions instructions|attached_files|attached_folders|environment_context|runtime_context|system_context)\b/i;

/**
 * 判断文本是否为"系统注入上下文"(system-reminder / recommended_plugins 等),
 * 而非用户真实输入。文件解析器遇到这类内容不得生成为 user-message 事件。
 */
export function isInjectedSystemText(text: string): boolean {
  return INJECTED_TAG.test(text.trimStart());
}

/**
 * 对话室任务会把"[对话背景]…\n\n[本轮消息] <真实输入>"整体作为工具入参。
 * 展示层只应呈现"[本轮消息]"之后的真实用户输入;无标记时原样返回。
 */
export function extractUserPrompt(text: string): string {
  const idx = text.indexOf('[本轮消息] ');
  if (idx < 0) return text;
  return text.slice(idx + '[本轮消息] '.length).trim() || text.trim();
}
