import { describe, expect, it } from 'vitest';
import { Store, fillDayAxis } from '../src/store.js';

function newStore(): Store {
  return new Store(':memory:');
}

describe('Store 事件指纹去重', () => {
  it('同内容助手消息只入库一次', () => {
    const store = newStore();
    const e = {
      ts: 1,
      agent: 'codex' as const,
      projectDir: '/tmp',
      sessionId: 's1',
      kind: 'assistant-message' as const,
      summary: '收到',
      meta: { fullText: '收到' },
    };
    const seq1 = store.insertEvent(e);
    const seq2 = store.insertEvent({ ...e, ts: 2 }); // 发射路径 vs 文件路径
    expect(seq1).toBe(seq2);
    expect(store.events({ limit: 10 })).toHaveLength(1);
  });

  it('工具调用不去重(合法重复)', () => {
    const store = newStore();
    const e = { ts: 1, agent: 'claude' as const, projectDir: '/tmp', sessionId: 's1', kind: 'tool-call' as const, summary: '调用工具 exec' };
    const s1 = store.insertEvent(e);
    const s2 = store.insertEvent({ ...e, ts: 2 });
    expect(s1).not.toBe(s2);
    expect(store.events({ limit: 10 })).toHaveLength(2);
  });

  it('dedupeExistingEvents 清理存量重复', () => {
    const store = newStore();
    // 绕过指纹插入两条重复(模拟历史数据,直接 SQL)
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
    const ins = db.prepare(
      `INSERT INTO events (ts, agent, session_id, kind, summary, project_dir, input_tokens, output_tokens, model, meta_json, fingerprint)
       VALUES (1, 'codex', 's1', 'assistant-message', 'dup', NULL, NULL, NULL, NULL, '{"fullText":"dup"}', NULL)`,
    );
    ins.run();
    ins.run();
    expect(store.dedupeExistingEvents()).toBe(1);
    expect(store.events({ limit: 10 })).toHaveLength(1);
  });
});

describe('Store 会话分页与筛选', () => {
  it('q/beforeTs/includeEmpty 过滤与总数', () => {
    const store = newStore();
    store.upsertSession({ agent: 'claude', sessionId: 'a', projectDir: '/proj/alpha', title: 'Alpha 任务', firstTs: 1, lastTs: 10, messageCount: 3, inputTokens: 0, outputTokens: 0, resumeCommand: 'claude --resume a' });
    store.upsertSession({ agent: 'codex', sessionId: 'b', projectDir: '/proj/beta', title: 'Beta 任务', firstTs: 2, lastTs: 20, messageCount: 5, inputTokens: 0, outputTokens: 0, resumeCommand: 'codex resume b' });
    store.upsertSession({ agent: 'dsh', sessionId: 'c', projectDir: null, title: '会话 c', firstTs: 3, lastTs: 30, messageCount: 0, inputTokens: 0, outputTokens: 0, resumeCommand: 'dsh --resume c' });

    expect(store.sessionsCount({})).toBe(2); // 默认不含空会话
    expect(store.sessionsCount({ includeEmpty: true })).toBe(3);
    expect(store.sessionsCount({ agent: 'claude' })).toBe(1);
    expect(store.sessionsCount({ q: 'beta' })).toBe(1);

    const page = store.sessions({ beforeTs: 21, includeEmpty: true, limit: 10 });
    expect(page.map((s) => s.sessionId)).toEqual(['b', 'a']); // last_ts DESC 且 <20
  });
});

describe('Store 用量按天补零', () => {
  it('fillDayAxis 补齐缺失日期', () => {
    const from = new Date('2026-08-01T00:00:00').getTime();
    const to = new Date('2026-08-03T00:00:00').getTime();
    const out = fillDayAxis([{ day: '2026-08-02', i: 5, o: 3 }], from, to);
    expect(out.map((d) => d.day)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    expect(out[1]).toEqual({ day: '2026-08-02', i: 5, o: 3 });
    expect(out[0]!.i).toBe(0);
  });

  it('usage 近 3 天按天连续', () => {
    const store = newStore();
    const from = Date.now() - 2 * 86400_000;
    const report = store.usage({ from, to: Date.now() });
    expect(report.byDay).toHaveLength(3);
    expect(report.total).toEqual({ input: 0, output: 0 });
  });
});

describe('Store meta 与迁移', () => {
  it('resetAgentIndex 清事件/汇总/游标', () => {
    const store = newStore();
    store.insertEvent({ ts: 1, agent: 'codex', projectDir: null, sessionId: 's1', kind: 'session-start', summary: '会话开始' });
    store.upsertSession({ agent: 'codex', sessionId: 's1', projectDir: null, title: 't', firstTs: 1, lastTs: 1, messageCount: 1, inputTokens: 0, outputTokens: 0, resumeCommand: 'x' });
    store.set('/a/.codex/sessions/f.jsonl', 42);
    store.resetAgentIndex('codex', '%/.codex/sessions/%');
    expect(store.events({ limit: 10 })).toHaveLength(0);
    expect(store.sessionsCount({ includeEmpty: true })).toBe(0);
    expect(store.get('/a/.codex/sessions/f.jsonl')).toBe(0);
  });
});
