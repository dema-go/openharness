import { useEffect, useState } from 'react';
import { AGENT_DISPLAY, type AgentId } from '@openharness/core';
import { api, type AgentConfigInfo } from '../lib/api';
import { AGENT_CHARACTER, AgentAvatar } from './ComicIcons';

export function ConfigPanel(): React.JSX.Element {
  const [configs, setConfigs] = useState<AgentConfigInfo[] | null>(null);

  useEffect(() => {
    api
      .config()
      .then(setConfigs)
      .catch(() => setConfigs([]));
  }, []);

  if (!configs) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="font-mono text-[12px] text-faint">翻档案中…</p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="bubble mb-5 max-w-2xl font-display text-[12.5px] text-ink">
        只读展示各工具的本地配置摘要。任何密钥/token 均已脱敏,配置原文不会离开本机。
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {configs.map((cfg, i) => (
          <section key={cfg.agent} className={`comic-card p-4 ${i % 2 === 0 ? '-rotate-[0.3deg]' : 'rotate-[0.3deg]'}`}>
            <div className="flex items-center gap-2.5">
              <AgentAvatar agent={cfg.agent as AgentId} size={38} />
              <h3 className="font-display text-[15px] text-ink">
                {AGENT_DISPLAY[cfg.agent as AgentId] ?? cfg.agent}
                <span className="ml-2 text-[11px] text-faint">{AGENT_CHARACTER[cfg.agent as AgentId]?.name}</span>
              </h3>
            </div>
            <div className="mt-3 space-y-4">
              {cfg.sections.map((s) => (
                <div key={s.title}>
                  <p className="mb-1.5 font-mono text-[10.5px] text-faint">▸ {s.title}</p>
                  <dl className="space-y-1">
                    {s.items.map((it) => (
                      <div key={it.key} className="flex items-baseline gap-3">
                        <dt className="w-56 shrink-0 truncate font-mono text-[10.5px] text-dim" title={it.key}>
                          {it.key}
                        </dt>
                        <dd
                          className={`min-w-0 flex-1 break-all font-mono text-[10.5px] leading-relaxed ${
                            it.masked ? 'text-red' : 'text-ink'
                          }`}
                        >
                          {it.value}
                          {it.masked && <span className="ml-2 text-[9.5px] text-faint">已脱敏</span>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
              {cfg.sections.length === 0 && <p className="text-[12px] text-faint">无可用配置摘要</p>}
            </div>
            {(cfg.notes ?? []).length > 0 && (
              <ul className="mt-3 space-y-1 border-t-2 border-dashed border-faint/60 pt-3">
                {cfg.notes!.map((n, j) => (
                  <li key={j} className="text-[11px] leading-relaxed text-faint">
                    · {n}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
