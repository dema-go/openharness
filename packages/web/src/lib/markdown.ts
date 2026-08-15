/**
 * Markdown 渲染:Agent 回复多为 Markdown,对话气泡按需渲染。
 * marked 解析 + DOMPurify 消毒(XSS 防护:Agent 可能带回网页内容)。
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html);
}
