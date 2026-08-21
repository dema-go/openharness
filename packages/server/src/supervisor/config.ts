/**
 * SupervisorConfigStore:编排层 LLM 配置(Provider/baseUrl/model/apiKey)。
 * 沿用 PresetStore 的本地文件模式:明文仅存 ~/.openharness/supervisor.json,
 * 对外(getPublic)绝不回传密钥片段,只报 hasApiKey。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SupervisorLlmConfig {
  provider: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface SupervisorConfigPublic {
  provider: 'openai-compatible';
  baseUrl: string;
  model: string;
  /** 密钥是否已设置(任何片段都不下发) */
  hasApiKey: boolean;
  /** 三要素齐备,可发起编排 */
  configured: boolean;
}

const DEFAULTS: Omit<SupervisorLlmConfig, 'apiKey'> = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
};

export class SupervisorConfigStore {
  private readonly file: string;

  constructor(file = path.join(os.homedir(), '.openharness', 'supervisor.json')) {
    this.file = file;
  }

  private readRaw(): Partial<SupervisorLlmConfig> {
    try {
      if (existsSync(this.file)) {
        return JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SupervisorLlmConfig>;
      }
    } catch {
      /* 配置损坏时按未配置处理 */
    }
    return {};
  }

  private writeRaw(cfg: SupervisorLlmConfig): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  }

  /** 三要素齐备的完整配置;未配置返回 null */
  resolved(): SupervisorLlmConfig | null {
    const raw = this.readRaw();
    const baseUrl = raw.baseUrl?.trim() || DEFAULTS.baseUrl;
    const model = raw.model?.trim() || DEFAULTS.model;
    const apiKey = raw.apiKey?.trim() ?? '';
    if (!apiKey) return null;
    return { provider: 'openai-compatible', baseUrl, model, apiKey };
  }

  getPublic(): SupervisorConfigPublic {
    const raw = this.readRaw();
    const baseUrl = raw.baseUrl?.trim() || DEFAULTS.baseUrl;
    const model = raw.model?.trim() || DEFAULTS.model;
    const hasApiKey = Boolean(raw.apiKey?.trim());
    return { provider: 'openai-compatible', baseUrl, model, hasApiKey, configured: hasApiKey };
  }

  /** 更新配置:apiKey 留空/缺省 = 不改(与四 Agent 配置页同一约定);返回实际应用字段 */
  update(input: { baseUrl?: string; model?: string; apiKey?: string }): { applied: string[] } {
    const raw = this.readRaw();
    const next: SupervisorLlmConfig = {
      provider: 'openai-compatible',
      baseUrl: input.baseUrl?.trim() || raw.baseUrl?.trim() || DEFAULTS.baseUrl,
      model: input.model?.trim() || raw.model?.trim() || DEFAULTS.model,
      apiKey: input.apiKey?.trim() ? input.apiKey.trim() : raw.apiKey?.trim() ?? '',
    };
    this.writeRaw(next);
    const applied: string[] = [];
    if (input.baseUrl?.trim()) applied.push('baseUrl');
    if (input.model?.trim()) applied.push('model');
    if (input.apiKey?.trim()) applied.push('apiKey');
    return { applied };
  }
}
