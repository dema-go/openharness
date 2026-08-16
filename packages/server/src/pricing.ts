/**
 * PricingStore:模型价目表(费用估算)。
 * 存于 ~/.openharness/pricing.json,{ models: {name:{input,output}(美元/百万 tokens)}, default:{...} }。
 * 价格仅作估算,用户可在用量账本页配置。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ModelPrice {
  input: number;
  output: number;
}

export interface Pricing {
  models: Record<string, ModelPrice>;
  default: ModelPrice;
}

const DEFAULT_PRICING: Pricing = {
  models: {
    'gpt-5.6-sol': { input: 1.25, output: 10 },
    'glm-5.3': { input: 0.7, output: 2.2 },
    'glm-5': { input: 0.7, output: 2.2 },
    'deepseek-v4-pro': { input: 0.28, output: 0.42 },
    'claude-sonnet-4': { input: 3, output: 15 },
  },
  default: { input: 1, output: 4 },
};

export class PricingStore {
  private readonly file: string;
  private pricing: Pricing;

  constructor(file = path.join(os.homedir(), '.openharness', 'pricing.json')) {
    this.file = file;
    this.pricing = structuredClone(DEFAULT_PRICING);
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Pricing>;
        if (raw.models && typeof raw.models === 'object') this.pricing.models = { ...DEFAULT_PRICING.models, ...raw.models };
        if (raw.default) this.pricing.default = { ...DEFAULT_PRICING.default, ...raw.default };
      }
    } catch {
      /* 缺省价目表 */
    }
  }

  get(): Pricing {
    return structuredClone(this.pricing);
  }

  set(next: Pricing): void {
    this.pricing = {
      models: { ...(next.models ?? {}) },
      default: { ...(next.default ?? DEFAULT_PRICING.default) },
    };
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.pricing, null, 2)}\n`, 'utf8');
  }

  /** 按模型名取价,未知模型用默认价 */
  priceOf(model: string): ModelPrice {
    return this.pricing.models[model] ?? this.pricing.default;
  }
}
