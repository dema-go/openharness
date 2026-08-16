// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown';

describe('Markdown 渲染与消毒', () => {
  it('渲染标题/列表/代码块/表格', () => {
    const html = renderMarkdown('## 标题\n- a\n- b\n\n```js\nconsole.log(1)\n```\n\n|x|y|\n|-|-|\n|1|2|');
    expect(html).toContain('<h2');
    expect(html).toContain('<li>');
    expect(html).toContain('<pre>');
    expect(html).toContain('<table>');
  });

  it('XSS 防护:script/onerror 被消毒', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onerror');
  });
});
