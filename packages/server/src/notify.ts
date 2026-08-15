/**
 * macOS 桌面通知:优先 terminal-notifier(通知归属正确、可点击打开控制台),
 * 未安装时回退 osascript(注意:会显示为"脚本编辑器",体验差)。
 * 仅在任务状态收尾时由 TaskManager 触发,失败静默。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const CONSOLE_URL = 'http://127.0.0.1:3900';
const TARGETS = [
  '/opt/homebrew/terminal-notifier.app/Contents/MacOS/terminal-notifier',
  '/opt/homebrew/bin/terminal-notifier',
  '/usr/local/terminal-notifier.app/Contents/MacOS/terminal-notifier',
  '/usr/local/bin/terminal-notifier',
];

let notifierPath: string | null | undefined; // undefined=未探测, null=不可用

function resolveNotifier(): string | null {
  if (notifierPath !== undefined) return notifierPath;
  notifierPath = TARGETS.find((p) => existsSync(p)) ?? null;
  return notifierPath;
}

/** 发送后重探测路径(刚安装的 terminal-notifier 无需重启即可用) */
export function desktopNotify(title: string, message: string): void {
  const body = message.slice(0, 200);
  const bin = resolveNotifier();
  if (bin) {
    execFile(
      bin,
      ['-title', title, '-message', body, '-sound', 'default', '-open', CONSOLE_URL],
      (err) => {
        if (err) {
          notifierPath = undefined; // 失败可能是路径失效,下次重探测
          fallbackOsascript(title, body);
        }
      },
    );
  } else {
    fallbackOsascript(title, body);
  }
}

function fallbackOsascript(title: string, body: string): void {
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
  execFile('osascript', ['-e', script], () => {
    /* 通知失败不影响主流程 */
  });
}
