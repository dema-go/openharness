export * from './types.js';
export * from './adapter.js';

/** 工具函数:截断文本为人可读摘要 */
export function truncate(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}
