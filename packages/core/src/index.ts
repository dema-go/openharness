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
