/**
 * Markdown 渲染:marked 解析 + DOMPurify 消毒(XSS 防护)。
 * 富文本升级(对标 Clowder rich blocks):
 * - KaTeX 数学公式(仅当文本含 $ 时才动态 import,不增加首屏体积)
 * - mermaid 流程图:拆分为独立 React 子树,由 MermaidDiagram 懒加载渲染
 * - 代码块附带「复制」按钮(容器级事件委托)
 *
 * 返回分段数组:字符串段(HTML,直接注入)与 mermaid 段(组件渲染)交替,
 * 保证 mermaid SVG 不受 React 重渲染的 innerHTML 管理影响。
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

export type MarkdownPart = string | { type: 'mermaid'; code: string };

const MERMAID_MARK = /<span data-mdm="\d+"><\/span>/g;

async function processMath(text: string): Promise<string> {
  if (!text.includes('$')) return text;
  const katex = (await import('katex')).default;
  const render = (src: string, display: boolean): string => {
    try {
      return katex.renderToString(src, { displayMode: display, throwOnError: false });
    } catch {
      return src;
    }
  };
  // 保护围栏代码块,避免块内 $ 被当公式
  const blocks: string[] = [];
  text = text.replace(/```[\s\S]*?```/g, (b) => {
    blocks.push(b);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, src: string) => render(src.trim(), true));
  text = text.replace(/\$([^$\n]+?)\$/g, (_m, src: string) => render(src.trim(), false));
  return text.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => blocks[Number(i)]!);
}

function decodeHtml(code: string): string {
  return code
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export async function renderMarkdownAsync(text: string): Promise<MarkdownPart[]> {
  const withMath = await processMath(text);
  let html = marked.parse(withMath, { async: false }) as string;
  const mermaidCodes: string[] = [];
  // 代码块:复制按钮 + mermaid 提取为标记(兼容无语言标签的裸围栏);
  // 标记用带 data 属性的 span(DOMPurify 会保留,而 \u0000 哨兵会被剥掉)
  html = html.replace(/<pre><code(?:\s+class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g, (_m, lang: string | undefined, code: string) => {
    const decoded = decodeHtml(code).trim();
    if (lang === 'mermaid') {
      const idx = mermaidCodes.length;
      mermaidCodes.push(decoded);
      return `<span data-mdm="${idx}"></span>`;
    }
    const cls = lang ? ` class="language-${lang}"` : '';
    return `<div class="md-codeblock"><pre><code${cls}>${code}</code></pre><button class="md-copy" data-code="${encodeURIComponent(decoded)}">复制</button></div>`;
  });
  const sanitized = DOMPurify.sanitize(html);
  const chunks = sanitized.split(MERMAID_MARK);
  const parts: MarkdownPart[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i] && chunks[i]!.trim()) parts.push(chunks[i]!);
    if (i < mermaidCodes.length) parts.push({ type: 'mermaid', code: mermaidCodes[i]! });
  }
  return parts;
}
