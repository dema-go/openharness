/**
 * Supervisor 编排层:平台自身的 Agent 循环。
 * provider(LLM 协议)+ tools(工具注册表)+ manager(状态机)+ config(本地配置)。
 */
export * from './provider.js';
export * from './mock-provider.js';
export * from './tools.js';
export * from './config.js';
export * from './manager.js';
