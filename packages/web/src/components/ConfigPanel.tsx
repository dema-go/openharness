import { useCallback, useEffect, useState } from 'react';
import { AGENT_DISPLAY, type AgentId, type AgentPresetPublic, type ConfigFieldDef } from '@openharness/core';
import { api, type AgentConfigInfo } from '../lib/api';
import { AGENT_CHARACTER, AgentAvatar } from './ComicIcons';

interface Feedback {
  ok: boolean;
  text: string;
}

function fmtDate(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ts);
}

export function ConfigPanel(): React.JSX.Element {
  const [configs, setConfigs] = useState<AgentConfigInfo[] | null>(null);
  const [schemas, setSchemas] = useState<Record<string, ConfigFieldDef[]>>({});
  const [presets, setPresets] = useState<AgentPresetPublic[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [presetNames, setPresetNames] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [busyAgent, setBusyAgent] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [cfg, pre] = await Promise.all([api.config(), api.presets()]);
    setConfigs(cfg);
    setPresets(pre);
    const schemaMap: Record<string, ConfigFieldDef[]> = {};
    await Promise.all(
      cfg.map(async (c) => {
        try {
          schemaMap[c.agent] = await api.configSchema(c.agent);
        } catch {
          schemaMap[c.agent] = [];
        }
      }),
    );
    setSchemas(schemaMap);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setConfigs([]));
  }, [refresh]);

  if (!configs) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="font-mono text-[12px] text-faint">翻档案中…</p>
      </div>
    );
  }

  const setDraft = (agent: string, key: string, value: string) =>
    setDrafts((prev) => ({ ...prev, [`${agent}\u0000${key}`]: value }));

  const saveAgent = async (agent: AgentId) => {
    const values: Record<string, string> = {};
    for (const f of schemas[agent] ?? []) {
      const v = drafts[`${agent}\u0000${f.key}`] ?? '';
      if (v.trim() !== '') values[f.key] = v.trim();
    }
    if (Object.keys(values).length === 0) {
      setFeedback((p) => ({ ...p, [agent]: { ok: false, text: '没有可保存的修改' } }));
      return;
    }
    setBusyAgent(agent);
    try {
      const { applied } = await api.updateConfig(agent, values);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const k of applied) delete next[`${agent}\u0000${k}`];
        return next;
      });
      setFeedback((p) => ({ ...p, [agent]: { ok: true, text: `已写入 ${applied.length} 项配置` } }));
      await refresh();
    } catch (err) {
      setFeedback((p) => ({
        ...p,
        [agent]: { ok: false, text: err instanceof Error ? err.message : '写入失败' },
      }));
    } finally {
      setBusyAgent(null);
    }
  };

  const snapshotPreset = async (agent: AgentId) => {
    setBusyAgent(agent);
    try {
      const p = await api.savePreset({ name: presetNames[agent] ?? '', agent });
      setPresetNames((prev) => ({ ...prev, [agent]: '' }));
      setFeedback((p_) => ({ ...p_, [agent]: { ok: true, text: `已存为预设「${p.name}」` } }));
      await refresh();
    } catch (err) {
      setFeedback((p_) => ({
        ...p_,
        [agent]: { ok: false, text: err instanceof Error ? err.message : '快照失败' },
      }));
    } finally {
      setBusyAgent(null);
    }
  };

  const applyPreset = async (agent: AgentId, id: string, name: string) => {
    setBusyAgent(agent);
    try {
      await api.applyPreset(id);
      setFeedback((p) => ({ ...p, [agent]: { ok: true, text: `已切换到预设「${name}」` } }));
      await refresh();
    } catch (err) {
      setFeedback((p) => ({
        ...p,
        [agent]: { ok: false, text: err instanceof Error ? err.message : '应用失败' },
      }));
    } finally {
      setBusyAgent(null);
    }
  };

  const deletePreset = async (agent: AgentId, id: string) => {
    if (!window.confirm('删除这个预设?')) return;
    try {
      await api.deletePreset(id);
      setPresets((prev) => prev.filter((p) => p.id !== id));
    } catch {
      setFeedback((p) => ({ ...p, [agent]: { ok: false, text: '删除失败' } }));
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="bubble mb-5 max-w-2xl font-display text-[12.5px] text-ink">
        可直接修改各工具的配置(api key / baseUrl / 模型等),写回原配置文件;还可把整套配置存为预设,
        一键切换(参考 cc switch)。密钥明文只存本机,页面不回显任何片段;密钥字段留空即保持不变。
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {configs.map((cfg, i) => {
          const agent = cfg.agent as AgentId;
          const fields = schemas[cfg.agent] ?? [];
          const agentPresets = presets.filter((p) => p.agent === cfg.agent);
          const fb = feedback[cfg.agent];
          const groups = [...new Set(fields.map((f) => f.group))];
          return (
            <section key={cfg.agent} className={`comic-card p-4 ${i % 2 === 0 ? '-rotate-[0.3deg]' : 'rotate-[0.3deg]'}`}>
              <div className="flex items-center gap-2.5">
                <AgentAvatar agent={agent} size={38} />
                <h3 className="font-display text-[15px] text-ink">
                  {AGENT_DISPLAY[agent] ?? agent}
                  <span className="ml-2 text-[11px] text-faint">{AGENT_CHARACTER[agent]?.name}</span>
                </h3>
                <span className="ml-auto font-mono text-[10px] text-faint">配置写回原文件</span>
              </div>

              {fields.length === 0 ? (
                <p className="mt-3 text-[12px] text-dim">
                  {agent === 'cursor'
                    ? 'Cursor 凭据走 OAuth 登录(钥匙串),无可编辑配置文件;修改 api key / baseUrl 请用 cursor-agent login。'
                    : '该工具暂无可编辑配置字段。'}
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {groups.map((g) => (
                    <div key={g}>
                      <p className="mb-1.5 font-mono text-[10.5px] text-faint">▸ {g}</p>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {fields
                          .filter((f) => f.group === g)
                          .map((f) => {
                            const draft = drafts[`${cfg.agent}\u0000${f.key}`] ?? '';
                            return (
                              <label key={f.key} className="block" title={f.hint}>
                                <span className="mb-0.5 flex items-baseline justify-between gap-2">
                                  <span className="truncate font-mono text-[10.5px] text-dim">{f.label}</span>
                                  {f.secret && f.hasValue && (
                                    <span className="shrink-0 font-mono text-[9px] text-green">已设置</span>
                                  )}
                                </span>
                                {f.type === 'select' ? (
                                  <select
                                    value={draft}
                                    onChange={(e) => setDraft(cfg.agent, f.key, e.target.value)}
                                    className="comic-input py-1 text-[11.5px]"
                                  >
                                    <option value="">{f.value ? `当前:${f.value}` : '未设置'}</option>
                                    {(f.options ?? []).map((o) => (
                                      <option key={o} value={o}>
                                        {o}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    type={f.secret ? 'password' : 'text'}
                                    value={draft}
                                    onChange={(e) => setDraft(cfg.agent, f.key, e.target.value)}
                                    placeholder={
                                      f.secret
                                        ? f.hasValue
                                          ? '已设置(留空不改)'
                                          : '留空不改'
                                        : f.value || '未设置'
                                    }
                                    className="comic-input py-1 text-[11.5px]"
                                  />
                                )}
                              </label>
                            );
                          })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {fields.length > 0 && (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void saveAgent(agent)}
                    disabled={busyAgent === cfg.agent}
                    className="comic-btn bg-red px-3 py-1.5 text-[12.5px] text-white disabled:opacity-40"
                  >
                    {busyAgent === cfg.agent ? '写入中…' : '保存配置'}
                  </button>
                  {fb && (
                    <span className={`font-mono text-[10.5px] ${fb.ok ? 'text-green' : 'text-red'}`}>{fb.text}</span>
                  )}
                </div>
              )}

              {/* 预设管理 */}
              {fields.length > 0 && (
                <div className="mt-4 border-t-2 border-dashed border-faint/60 pt-3">
                  <p className="font-display text-[12.5px] text-ink">
                    配置预设<span className="ml-2 font-mono text-[10px] text-faint">{agentPresets.length} 套</span>
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      value={presetNames[cfg.agent] ?? ''}
                      onChange={(e) => setPresetNames((p) => ({ ...p, [cfg.agent]: e.target.value }))}
                      placeholder="新预设名称(存当前配置)"
                      className="comic-input flex-1 py-1 text-[11.5px]"
                    />
                    <button
                      type="button"
                      onClick={() => void snapshotPreset(agent)}
                      disabled={busyAgent === cfg.agent}
                      className="comic-btn shrink-0 bg-yellow px-2.5 py-1 font-mono text-[11px] text-ink disabled:opacity-40"
                    >
                      存为预设
                    </button>
                  </div>
                  {agentPresets.length > 0 && (
                    <ul className="mt-2 space-y-1.5">
                      {agentPresets.map((p) => (
                        <li
                          key={p.id}
                          className="flex items-center gap-2 rounded-lg border-2 border-ink bg-white px-2.5 py-1.5"
                          style={{ boxShadow: '1.5px 1.5px 0 #221D15' }}
                        >
                          <span className="min-w-0 flex-1 truncate font-display text-[12px] text-ink" title={p.name}>
                            {p.name}
                          </span>
                          <span className="shrink-0 font-mono text-[9.5px] text-faint">
                            {Object.keys(p.values).length} 项 · {fmtDate(p.createdAt)}
                          </span>
                          <button
                            type="button"
                            onClick={() => void applyPreset(agent, p.id, p.name)}
                            disabled={busyAgent === cfg.agent}
                            className="shrink-0 font-display text-[11px] text-green hover:underline disabled:opacity-40"
                          >
                            应用
                          </button>
                          <button
                            type="button"
                            onClick={() => void deletePreset(agent, p.id)}
                            className="shrink-0 font-mono text-[10px] text-red hover:underline"
                          >
                            删除
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {(cfg.notes ?? []).length > 0 && (
                <ul className="mt-3 space-y-1 border-t-2 border-dashed border-faint/60 pt-3">
                  {cfg.notes!.map((n, j) => (
                    <li key={j} className="text-[11px] leading-relaxed text-faint">
                      · {n}
                    </li>
                  ))}
                </ul>
              )}

              <details className="mt-3">
                <summary className="cursor-pointer font-mono text-[10.5px] text-faint hover:text-dim">
                  其他配置(只读)▾
                </summary>
                <div className="mt-2 space-y-3">
                  {cfg.sections.map((s) => (
                    <div key={s.title}>
                      <p className="mb-1 font-mono text-[10px] text-faint">▸ {s.title}</p>
                      <dl className="space-y-1">
                        {s.items.map((it) => (
                          <div key={it.key} className="flex items-baseline gap-3">
                            <dt className="w-48 shrink-0 truncate font-mono text-[10px] text-dim" title={it.key}>
                              {it.key}
                            </dt>
                            <dd
                              className={`min-w-0 flex-1 break-all font-mono text-[10px] leading-relaxed ${
                                it.masked ? 'text-red' : 'text-ink'
                              }`}
                            >
                              {it.value}
                              {it.masked && <span className="ml-2 text-[9px] text-faint">已脱敏</span>}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                  {cfg.sections.length === 0 && <p className="text-[11px] text-faint">无可用配置摘要</p>}
                </div>
              </details>
            </section>
          );
        })}
      </div>
    </div>
  );
}
