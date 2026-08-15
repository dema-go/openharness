/**
 * PresetStore:配置预设(cc switch 式)——多套配置快照,一键切换。
 * 仅存本机 ~/.openharness/presets.json;密钥明文只存在于该文件,
 * 下发(API 返回)一律按 isSecretKey 脱敏。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentId, AgentPreset, AgentPresetPublic } from '@openharness/core';
import { isSecretKey, maskSecret } from '@openharness/core';

export class PresetStore {
  private readonly file: string;
  private presets: AgentPreset[] = [];

  constructor(file = path.join(os.homedir(), '.openharness', 'presets.json')) {
    this.file = file;
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (Array.isArray(raw)) this.presets = raw as AgentPreset[];
    } catch {
      this.presets = [];
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.presets, null, 2)}\n`, 'utf8');
  }

  /** 下发形态:密钥值脱敏 */
  private toPublic(p: AgentPreset): AgentPresetPublic {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.values)) {
      values[k] = isSecretKey(k) ? maskSecret(v) : v;
    }
    return { id: p.id, name: p.name, agent: p.agent, values, createdAt: p.createdAt };
  }

  list(agent?: string): AgentPresetPublic[] {
    return this.presets
      .filter((p) => !agent || p.agent === agent)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => this.toPublic(p));
  }

  create(name: string, agent: AgentId, values: Record<string, string>): AgentPresetPublic {
    const preset: AgentPreset = {
      id: randomUUID(),
      name: name.trim() || `${agent} 预设 ${this.presets.length + 1}`,
      agent,
      values,
      createdAt: Date.now(),
    };
    this.presets.push(preset);
    this.persist();
    return this.toPublic(preset);
  }

  /** 供 apply 用:取明文(仅服务端内部) */
  getPlain(id: string): AgentPreset | undefined {
    return this.presets.find((p) => p.id === id);
  }

  delete(id: string): boolean {
    const before = this.presets.length;
    this.presets = this.presets.filter((p) => p.id !== id);
    if (this.presets.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }
}
