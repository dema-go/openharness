/**
 * 事件总线:索引流水线与 WebSocket 广播之间的枢纽。
 */
import { EventEmitter } from 'node:events';
import type {
  AgentStatus,
  ConversationMessage,
  HarnessEvent,
  SupervisorRunRecord,
  SupervisorStepRecord,
  TaskInfo,
} from '@openharness/core';

export type BusMessage =
  | { type: 'event'; data: HarnessEvent }
  | { type: 'status'; data: AgentStatus[] }
  | { type: 'task'; data: TaskInfo }
  | { type: 'conversation'; data: { convId: string; message: ConversationMessage } }
  | { type: 'supervisor'; data: { run: SupervisorRunRecord; steps?: SupervisorStepRecord[] } };

const emitter = new EventEmitter();
export const bus = emitter;

export function broadcast(msg: BusMessage): void {
  emitter.emit('message', msg);
}

export function onMessage(cb: (msg: BusMessage) => void): () => void {
  emitter.on('message', cb);
  return () => emitter.off('message', cb);
}
