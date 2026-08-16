/**
 * 气泡正文渲染器:Markdown(marked+DOMPurify)→ KaTeX → mermaid 懒渲染。
 * 复制按钮用容器级事件委托;mermaid 作为独立 React 子树渲染,
 * SVG 写入自身 ref 节点(React 不管理其 innerHTML,重渲染也不会被清掉)。
 */
import { useEffect, useRef, useState } from 'react';
import { renderMarkdownAsync, type MarkdownPart } from '../lib/markdown';

export function MdBody(props: { text: string }): React.JSX.Element {
  const { text } = props;
  const [parts, setParts] = useState<MarkdownPart[] | null>(null);

  useEffect(() => {
    let alive = true;
    setParts(null);
    void renderMarkdownAsync(text).then((p) => {
      if (alive) setParts(p);
    });
    return () => {
      alive = false;
    };
  }, [text]);

  const onClick = (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('button.md-copy');
    if (!btn) return;
    const code = decodeURIComponent((btn as HTMLButtonElement).dataset.code ?? '');
    void navigator.clipboard.writeText(code).then(() => {
      btn.textContent = '已复制 ✓';
      setTimeout(() => {
        btn.textContent = '复制';
      }, 1500);
    });
  };

  return (
    <div className="md-body mt-0.5 text-[13px] leading-relaxed text-ink" onClick={onClick}>
      {parts === null ? (
        <p className="text-faint">解析中…</p>
      ) : (
        parts.map((p, i) =>
          typeof p === 'string' ? (
            <div key={i} dangerouslySetInnerHTML={{ __html: p }} />
          ) : (
            <MermaidDiagram key={i} code={p.code} />
          ),
        )
      )}
    </div>
  );
}

function MermaidDiagram(props: { code: string }): React.JSX.Element {
  const { code } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    void (async () => {
      try {
        // mermaid 包 "." 指向 core 构建(无 default 导出),经 Rollup 打包 default 还会丢失;
        // 改为运行时直载 vendor 完整 ESM。变量形式 + @vite-ignore 让 rollup 跳过静态解析。
        const vendorUrl = '/vendor/mermaid.esm.min.mjs';
        const mod = (await import(/* @vite-ignore */ vendorUrl)) as {
          default: {
            initialize: (o: Record<string, unknown>) => void;
            render: (id: string, code: string) => Promise<{ svg: string }>;
          };
        };
        const api = mod.default;
        api.initialize({ startOnLoad: false, theme: 'neutral', fontFamily: 'inherit' });
        const { svg } = await api.render(`md-m-${Math.random().toString(36).slice(2, 8)}`, code);
        if (alive) {
          el.innerHTML = svg;
          el.classList.add('md-mermaid-done');
        }
      } catch {
        if (alive) el.textContent = `(流程图渲染失败,原始代码)\n${code}`;
      }
    })();
    return () => {
      alive = false;
    };
  }, [code]);

  return <div ref={ref} className="md-mermaid" />;
}
