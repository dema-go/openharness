import { useEffect, useState } from 'react';
import { AGENT_DISPLAY, type AgentId } from '@openharness/core';
import { api, type AgentConfigInfo } from '../lib/api';

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
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-[12px] text-faint">加载配置摘要…</p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <p className="mb-4 max-w-2xl text-[12px] leading-relaxed text-faint">
        只读展示各工具的本地配置摘要。任何密钥/token 均已脱敏,配置原文不会离开本机,也不会被 OpenHarness 保存。
      </p>
      <div className="space-y-5">
        {configs.map((cfg) => (
          <section key={cfg.agent} className="rounded-sm border border-line bg-panel p-4">
            <h3 className="font-display text-[14px] font-500 text-paper">
              {AGENT_DISPLAY[cfg.agent as AgentId] ?? cfg.agent}
            </h3>
            <div className="mt-3 space-y-4">
              {cfg.sections.map((s) => (
                <div key={s.title}>
                  <p className="mb-1.5 font-mono text-[11px] text-faint">{s.title}</p>
                  <dl className="space-y-1">
                    {s.items.map((it) => (
                      <div key={it.key} className="flex items-baseline gap-3">
                        <dt className="w-56 shrink-0 truncate font-mono text-[11px] text-dim" title={it.key}>
                          {it.key}
                        </dt>
                        <dd
                          className={`min-w-0 flex-1 break-all font-mono text-[11px] leading-relaxed ${
                            it.masked ? 'text-amber/90' : 'text-paper'
                          }`}
                        >
                          {it.value}
                          {it.masked && <span className="ml-2 text-[10px] text-faint">已脱敏</span>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
              {cfg.sections.length === 0 && <p className="text-[12px] text-faint">无可用配置摘要</p>}
            </div>
            {(cfg.notes ?? []).length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-line pt-3">
                {cfg.notes!.map((n, i) => (
                  <li key={i} className="text-[11px] leading-relaxed text-faint">
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
