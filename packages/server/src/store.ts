/**
 * Store:SQLite 索引(会话、事件、文件游标)。
 * 仅存索引与聚合,不复制任何工具的原始会话数据。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentId,
  ConversationAgentState,
  ConversationMessage,
  ConversationRole,
  ConversationSummary,
  CursorStore,
  EventKind,
  HarnessEvent,
  SessionSummary,
  TaskInfo,
} from '@openharness/core';

export class Store implements CursorStore {
  private readonly db: Database.Database;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project_dir TEXT,
        title TEXT NOT NULL,
        first_ts INTEGER NOT NULL,
        last_ts INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        resume_command TEXT NOT NULL,
        PRIMARY KEY (agent, session_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        project_dir TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        model TEXT,
        meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);
      CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
      CREATE TABLE IF NOT EXISTS cursors (
        file_path TEXT PRIMARY KEY,
        offset INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        cwd TEXT NOT NULL,
        prompt TEXT NOT NULL,
        session_id TEXT,
        state TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        exit_code INTEGER
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        conv_id TEXT NOT NULL,
        agent TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        task_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conv_msgs ON conversation_messages(conv_id, seq);
      CREATE TABLE IF NOT EXISTS conversation_agents (
        conv_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        session_id TEXT,
        cwd TEXT,
        PRIMARY KEY (conv_id, agent)
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // 迁移:旧库 events 表补 model 列(按模型用量聚合)
    const cols = this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'model')) {
      this.db.exec('ALTER TABLE events ADD COLUMN model TEXT');
    }
  }

  // ---- CursorStore ----
  get(filePath: string): number {
    const row = this.db.prepare('SELECT offset FROM cursors WHERE file_path = ?').get(filePath) as
      | { offset: number }
      | undefined;
    return row?.offset ?? 0;
  }

  set(filePath: string, offset: number): void {
    this.db
      .prepare('INSERT INTO cursors (file_path, offset) VALUES (?, ?) ON CONFLICT(file_path) DO UPDATE SET offset = excluded.offset')
      .run(filePath, offset);
  }

  // ---- sessions ----
  upsertSession(s: SessionSummary): void {
    this.db
      .prepare(
        `INSERT INTO sessions (agent, session_id, project_dir, title, first_ts, last_ts, message_count, input_tokens, output_tokens, resume_command)
         VALUES (@agent, @sessionId, @projectDir, @title, @firstTs, @lastTs, @messageCount, @inputTokens, @outputTokens, @resumeCommand)
         ON CONFLICT(agent, session_id) DO UPDATE SET
           project_dir = excluded.project_dir, title = excluded.title, first_ts = excluded.first_ts,
           last_ts = excluded.last_ts, message_count = excluded.message_count,
           input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
           resume_command = excluded.resume_command`,
      )
      .run(s);
  }

  sessions(opts: { agent?: string; limit?: number } = {}): SessionSummary[] {
    const { agent, limit = 100 } = opts;
    const where = agent ? 'WHERE agent = ?' : '';
    const params = agent ? [agent] : [];
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY last_ts DESC LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      agent: r.agent as SessionSummary['agent'],
      sessionId: r.session_id as string,
      projectDir: (r.project_dir as string | null) ?? null,
      title: r.title as string,
      firstTs: r.first_ts as number,
      lastTs: r.last_ts as number,
      messageCount: r.message_count as number,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      resumeCommand: r.resume_command as string,
    }));
  }

  sessionsCount(agent?: string): number {
    const row = this.db
      .prepare(agent ? 'SELECT COUNT(*) AS n FROM sessions WHERE agent = ?' : 'SELECT COUNT(*) AS n FROM sessions')
      .get(...(agent ? [agent] : [])) as { n: number };
    return row.n;
  }

  // ---- events ----
  insertEvent(e: HarnessEvent & { model?: string }): number {
    const info = this.db
      .prepare(
        `INSERT INTO events (ts, agent, session_id, kind, summary, project_dir, input_tokens, output_tokens, model, meta_json)
         VALUES (@ts, @agent, @sessionId, @kind, @summary, @projectDir, @inputTokens, @outputTokens, @model, @metaJson)`,
      )
      .run({
        ...e,
        inputTokens: e.usage?.input ?? null,
        outputTokens: e.usage?.output ?? null,
        model: e.model ?? null,
        metaJson: e.meta ? JSON.stringify(e.meta) : null,
      });
    return Number(info.lastInsertRowid);
  }

  events(opts: { limit?: number; agent?: string; session?: string; sinceSeq?: number } = {}): HarnessEvent[] {
    return this.eventsPage(opts).events;
  }

  /**
   * 分页查询:游标(beforeSeq 取更早)、类型多选、关键词。
   * 返回最新一页(时间正序)与是否还有更早数据。
   */
  eventsPage(
    opts: {
      limit?: number;
      agent?: string;
      session?: string;
      sinceSeq?: number;
      beforeSeq?: number;
      kinds?: EventKind[];
      q?: string;
    } = {},
  ): { events: HarnessEvent[]; hasMore: boolean } {
    const { limit = 100, agent, session, sinceSeq, beforeSeq, kinds, q } = opts;
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (agent) {
      clauses.push('agent = ?');
      params.push(agent);
    }
    if (session) {
      clauses.push('session_id = ?');
      params.push(session);
    }
    if (sinceSeq !== undefined) {
      clauses.push('seq > ?');
      params.push(sinceSeq);
    }
    if (beforeSeq !== undefined) {
      clauses.push('seq < ?');
      params.push(beforeSeq);
    }
    if (kinds && kinds.length > 0) {
      clauses.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
    }
    if (q) {
      clauses.push('summary LIKE ?');
      params.push(`%${q}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...params, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    return {
      hasMore,
      events: rows
        .slice(0, limit)
        .reverse()
        .map((r) => ({
          ts: r.ts as number,
          agent: r.agent as HarnessEvent['agent'],
          sessionId: r.session_id as string,
          kind: r.kind as HarnessEvent['kind'],
          summary: r.summary as string,
          projectDir: (r.project_dir as string | null) ?? null,
          seq: r.seq as number,
          usage:
            r.input_tokens != null || r.output_tokens != null
              ? { input: (r.input_tokens as number) ?? 0, output: (r.output_tokens as number) ?? 0 }
              : undefined,
          meta: r.meta_json ? (JSON.parse(r.meta_json as string) as Record<string, unknown>) : undefined,
        })),
    };
  }

  // ---- usage 聚合(F6)----
  /** 全部聚合按时间范围过滤:from/to 为毫秒时间戳,缺省 = 全量 */
  usage(opts: { from?: number; to?: number } = {}): UsageReport {
    const { from, to } = opts;
    const where: string[] = [];
    const params: number[] = [];
    if (from !== undefined) {
      where.push('ts >= ?');
      params.push(from);
    }
    if (to !== undefined) {
      where.push('ts <= ?');
      params.push(to);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db
      .prepare(`SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM events ${w}`)
      .get(...params) as { i: number; o: number };
    const toolCalls = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events ${w ? `${w} AND` : 'WHERE'} kind = 'tool-call'`)
      .get(...params) as { n: number };
    const byAgent = (
      this.db
        .prepare(
          `SELECT agent, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o
           FROM events ${w} GROUP BY agent ORDER BY i + o DESC`,
        )
        .all(...params) as Array<{ agent: string; i: number; o: number }>
    ).map((r) => ({ agent: r.agent as UsageReport['byAgent'][number]['agent'], input: r.i, output: r.o }));
    const byModel = (
      this.db
        .prepare(
          `SELECT COALESCE(model, '(未知)') AS m, agent,
                  COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o
           FROM events ${w} GROUP BY m, agent
           HAVING COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0) > 0
           ORDER BY i + o DESC`,
        )
        .all(...params) as Array<{ m: string; agent: string; i: number; o: number }>
    ).map((r) => ({ model: r.m, agent: r.agent as UsageReport['byModel'][number]['agent'], input: r.i, output: r.o }));
    const byDay = (
      this.db
        .prepare(
          `SELECT date(ts/1000,'unixepoch','localtime') AS day,
                  COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o
           FROM events ${w} GROUP BY day ORDER BY day ASC`,
        )
        .all(...params) as Array<{ day: string; i: number; o: number }>
    ).map((r) => ({ day: r.day, input: r.i, output: r.o }));
    const byProject = (
      this.db
        .prepare(
          `SELECT project_dir AS p, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o
           FROM events ${w ? `${w} AND` : 'WHERE'} project_dir IS NOT NULL AND project_dir != ''
           GROUP BY project_dir ORDER BY i + o DESC LIMIT 8`,
        )
        .all(...params) as Array<{ p: string; i: number; o: number }>
    ).map((r) => ({ project: r.p, input: r.i, output: r.o }));

    return { total: { input: total.i, output: total.o }, toolCalls: toolCalls.n, byAgent, byModel, byDay, byProject };
  }

  // ---- tasks 持久化 ----
  upsertTask(t: TaskInfo): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, agent, cwd, prompt, session_id, state, started_at, ended_at, exit_code)
         VALUES (@id, @agent, @cwd, @prompt, @sessionId, @state, @startedAt, @endedAt, @exitCode)
         ON CONFLICT(id) DO UPDATE SET
           agent = excluded.agent, cwd = excluded.cwd, prompt = excluded.prompt,
           session_id = excluded.session_id, state = excluded.state,
           started_at = excluded.started_at, ended_at = excluded.ended_at, exit_code = excluded.exit_code`,
      )
      .run({
        ...t,
        sessionId: t.sessionId ?? null,
        endedAt: t.endedAt ?? null,
        exitCode: t.exitCode ?? null,
      });
    // 保留最近 300 条,防无限膨胀
    this.db
      .prepare(
        `DELETE FROM tasks WHERE id NOT IN (
           SELECT id FROM tasks ORDER BY started_at DESC LIMIT 300
         )`,
      )
      .run();
  }

  loadTasks(): TaskInfo[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks ORDER BY started_at DESC LIMIT 300')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      agent: r.agent as TaskInfo['agent'],
      cwd: r.cwd as string,
      prompt: r.prompt as string,
      sessionId: (r.session_id as string | null) ?? null,
      state: r.state as TaskInfo['state'],
      startedAt: r.started_at as number,
      endedAt: r.ended_at != null ? (r.ended_at as number) : undefined,
      exitCode: r.exit_code != null ? (r.exit_code as number) : undefined,
    }));
  }

  /** 服务重启后,把遗留的 running/queued 任务归位 */
  settleStaleTasks(now: number): void {
    this.db
      .prepare(
        `UPDATE tasks SET state = CASE state WHEN 'queued' THEN 'stopped' ELSE 'error' END, ended_at = ?
         WHERE state IN ('running', 'queued')`,
      )
      .run(now);
  }

  close(): void {
    this.db.close();
  }

  // ---- 对话室 ----

  createConversation(id: string, title: string, now: number): void {
    this.db
      .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, title, now, now);
  }

  touchConversation(id: string, now: number): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id);
  }

  renameConversation(id: string, title: string, now: number): void {
    this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
  }

  listConversations(): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, COUNT(m.seq) AS message_count,
                (SELECT content FROM conversation_messages m2 WHERE m2.conv_id = c.id ORDER BY m2.seq DESC LIMIT 1) AS last_message
         FROM conversations c LEFT JOIN conversation_messages m ON m.conv_id = c.id
         GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 200`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      messageCount: r.message_count as number,
      lastMessage: (r.last_message as string | null) ?? undefined,
    }));
  }

  getConversation(id: string): ConversationSummary | undefined {
    return this.listConversations().find((c) => c.id === id);
  }

  addConversationMessage(
    convId: string,
    m: {
      agent?: AgentId | null;
      role: ConversationRole;
      content: string;
      taskId?: string | null;
      createdAt?: number;
    },
  ): ConversationMessage {
    const createdAt = m.createdAt ?? Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO conversation_messages (conv_id, agent, role, content, task_id, created_at)
         VALUES (@convId, @agent, @role, @content, @taskId, @createdAt)`,
      )
      .run({
        convId,
        agent: m.agent ?? null,
        role: m.role,
        content: m.content,
        taskId: m.taskId ?? null,
        createdAt,
      });
    this.touchConversation(convId, createdAt);
    return { seq: Number(info.lastInsertRowid), convId, agent: m.agent ?? null, role: m.role, content: m.content, taskId: m.taskId ?? null, createdAt };
  }

  /** 任务结束时回填 task 消息文案 */
  updateConversationTaskMessage(taskId: string, content: string, now: number): void {
    this.db
      .prepare("UPDATE conversation_messages SET content = ?, created_at = ? WHERE task_id = ? AND role = 'task'")
      .run(content, now, taskId);
  }

  /** 该任务是否已有 task 气泡(防止 task-start 事件早于 send() 建行导致重复) */
  hasConversationTaskMessage(convId: string, taskId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM conversation_messages WHERE conv_id = ? AND task_id = ? AND role = 'task' LIMIT 1")
        .get(convId, taskId),
    );
  }

  conversationMessages(convId: string, opts: { limit?: number; beforeSeq?: number } = {}): { messages: ConversationMessage[]; hasMore: boolean } {
    const { limit = 100, beforeSeq } = opts;
    const clauses = ['conv_id = ?'];
    const params: Array<string | number> = [convId];
    if (beforeSeq !== undefined) {
      clauses.push('seq < ?');
      params.push(beforeSeq);
    }
    const rows = this.db
      .prepare(`SELECT * FROM conversation_messages WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ?`)
      .all(...params, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    return {
      hasMore,
      messages: rows
        .slice(0, limit)
        .reverse()
        .map((r) => ({
          seq: r.seq as number,
          convId: r.conv_id as string,
          agent: (r.agent as AgentId | null) ?? null,
          role: r.role as ConversationRole,
          content: r.content as string,
          taskId: (r.task_id as string | null) ?? null,
          createdAt: r.created_at as number,
        })),
    };
  }

  conversationMessagesCount(convId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM conversation_messages WHERE conv_id = ?').get(convId) as { n: number };
    return row.n;
  }

  setConversationAgent(convId: string, agent: AgentId, sessionId: string | null, cwd: string | null): void {
    this.db
      .prepare(
        `INSERT INTO conversation_agents (conv_id, agent, session_id, cwd) VALUES (?, ?, ?, ?)
         ON CONFLICT(conv_id, agent) DO UPDATE SET session_id = excluded.session_id, cwd = excluded.cwd`,
      )
      .run(convId, agent, sessionId, cwd);
  }

  conversationAgents(convId: string): ConversationAgentState[] {
    const rows = this.db
      .prepare('SELECT * FROM conversation_agents WHERE conv_id = ?')
      .all(convId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      convId: r.conv_id as string,
      agent: r.agent as AgentId,
      sessionId: (r.session_id as string | null) ?? null,
      cwd: (r.cwd as string | null) ?? null,
    }));
  }

  /** 反向查找:某个原生会话当前挂在哪个对话上(供 watch 路径事件归因) */
  findConversationBySession(agent: AgentId, sessionId: string): string | undefined {
    const row = this.db
      .prepare('SELECT conv_id FROM conversation_agents WHERE agent = ? AND session_id = ? LIMIT 1')
      .get(agent, sessionId) as { conv_id: string } | undefined;
    return row?.conv_id;
  }

  deleteConversation(id: string): boolean {
    const info = this.db
      .prepare('DELETE FROM conversations WHERE id = ?')
      .run(id);
    if (info.changes === 0) return false;
    this.db.prepare('DELETE FROM conversation_messages WHERE conv_id = ?').run(id);
    this.db.prepare('DELETE FROM conversation_agents WHERE conv_id = ?').run(id);
    return true;
  }

  // ---- meta 与一次性迁移 ----

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** 重建某 Agent 的会话索引:清掉其事件/会话汇总/文件游标(数据可从本地文件再推导) */
  resetAgentIndex(agent: string, cursorPrefix: string): void {
    this.db.prepare('DELETE FROM events WHERE agent = ?').run(agent);
    this.db.prepare('DELETE FROM sessions WHERE agent = ?').run(agent);
    this.db.prepare('DELETE FROM cursors WHERE file_path LIKE ?').run(cursorPrefix);
  }
}

export interface UsageReport {
  total: { input: number; output: number };
  toolCalls: number;
  byAgent: Array<{ agent: string; input: number; output: number }>;
  byModel: Array<{ model: string; agent: string; input: number; output: number }>;
  byDay: Array<{ day: string; input: number; output: number }>;
  byProject: Array<{ project: string; input: number; output: number }>;
}
