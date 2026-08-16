// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdownAsync, type MarkdownPart } from '../src/lib/markdown';

function htmlOf(parts: MarkdownPart[]): string {
  return parts.filter((p): p is string => typeof p === 'string').join('');
}

describe('Markdown 渲染与消毒(分段管线)', () => {
  it('渲染标题/列表/代码块/表格 + 复制按钮', async () => {
    const parts = await renderMarkdownAsync('## 标题\n- a\n\n```js\nconsole.log(1)\n```\n\n|x|y|\n|-|-|\n|1|2|');
    const html = htmlOf(parts);
    expect(html).toContain('<h2');
    expect(html).toContain('<li>');
    expect(html).toContain('<pre>');
    expect(html).toContain('<table>');
    expect(html).toContain('class="md-copy"');
  });

  it('mermaid 块拆分为独立段,不进入 HTML', async () => {
    const parts = await renderMarkdownAsync('```mermaid\ngraph TD; A-->B;\n```');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: 'mermaid', code: 'graph TD; A-->B;' });
  });

  it('mermaid 与正文交错时顺序保持', async () => {
    const parts = await renderMarkdownAsync('前文\n\n```mermaid\ngraph TD; A-->B;\n```\n\n后文');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain('前文');
    expect(parts[1]).toEqual({ type: 'mermaid', code: 'graph TD; A-->B;' });
    expect(parts[2]).toContain('后文');
  });

  it('KaTeX 公式渲染(懒加载仅在含 $ 时触发)', async () => {
    const html = htmlOf(await renderMarkdownAsync('欧拉公式 $e^{i\\pi}+1=0$ 结束'));
    expect(html).toContain('katex');
  });

  it('代码块内的 $ 不被当公式', async () => {
    const html = htmlOf(await renderMarkdownAsync('```bash\necho $HOME\n```'));
    expect(html).not.toContain('katex');
    expect(html).toContain('$HOME');
  });

  it('XSS 防护:script/onerror 被消毒', async () => {
    const html = htmlOf(await renderMarkdownAsync('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>'));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onerror');
  });
});
