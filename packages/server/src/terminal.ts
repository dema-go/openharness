/**
 * 深链执行:在新 Terminal 窗口中运行恢复命令(macOS)。
 * 仅由用户点击触发,本地执行,不经过网络。
 */
import { execFile } from 'node:child_process';

export function openInTerminal(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = `tell application "Terminal"\n  activate\n  do script ${JSON.stringify(command)}\nend tell`;
    execFile('osascript', ['-e', script], (err) => {
      if (err) reject(new Error(err.message.trim().split('\n')[0] ?? 'osascript 失败'));
      else resolve();
    });
  });
}
