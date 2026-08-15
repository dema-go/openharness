/**
 * macOS 桌面通知(osascript),浏览器关闭时也能收到任务收尾提醒。
 * 仅在任务状态收尾时由 TaskManager 触发,失败静默。
 */
import { execFile } from 'node:child_process';

export function desktopNotify(title: string, message: string): void {
  const body = message.slice(0, 150);
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
  execFile('osascript', ['-e', script], () => {
    /* 通知失败不影响主流程 */
  });
}
