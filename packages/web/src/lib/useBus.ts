/**
 * 总线钩子:与 server 的 /ws 保持长连接,自动重连。
 * 消息按类型分发给回调;断线状态通过 connected 暴露。
 */
import { useEffect, useRef, useState } from 'react';
import type {
  AgentStatus,
  ConversationMessage,
  HarnessEvent,
  SupervisorRunRecord,
  SupervisorStepRecord,
  TaskInfo,
} from '@openharness/core';

export interface BusMessage {
  type: 'event' | 'status' | 'task' | 'conversation' | 'supervisor';
  data:
    | HarnessEvent
    | AgentStatus[]
    | TaskInfo
    | { convId: string; message: ConversationMessage }
    | { run: SupervisorRunRecord; steps?: SupervisorStepRecord[] };
}

export function useBus(handlers: {
  onEvent: (e: HarnessEvent) => void;
  onStatus: (s: AgentStatus[]) => void;
  onTask: (t: TaskInfo) => void;
  onConversation: (d: { convId: string; message: ConversationMessage }) => void;
  onSupervisor?: (d: { run: SupervisorRunRecord; steps?: SupervisorStepRecord[] }) => void;
}): boolean {
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as BusMessage;
          const h = handlersRef.current;
          if (msg.type === 'event') h.onEvent(msg.data as HarnessEvent);
          else if (msg.type === 'status') h.onStatus(msg.data as AgentStatus[]);
          else if (msg.type === 'task') h.onTask(msg.data as TaskInfo);
          else if (msg.type === 'conversation') {
            const d = msg.data as { convId: string; message: ConversationMessage };
            if (d.convId) h.onConversation(d);
          } else if (msg.type === 'supervisor') {
            const d = msg.data as { run: SupervisorRunRecord; steps?: SupervisorStepRecord[] };
            if (d.run?.id) h.onSupervisor?.(d);
          }
        } catch {
          /* 忽略坏消息 */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return connected;
}
