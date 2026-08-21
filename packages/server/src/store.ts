/**
 * Store:SQLite 索引(会话、事件、文件游标)。
 * 仅存索引与聚合,不复制任何工具的原始会话数据。
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentId,
  ConversationAgentState,
  ConversationMessage,
  ConversationRole,
  ConversationStage,
  ConversationSummary,
  CursorStore,
  EventKind,
  HarnessEvent,
  SessionSummary,
  SupervisorRunRecord,
  SupervisorStepRecord,
  TaskInfo,
} from '@openharness/core';

function supervisorRunFromRow(r: Record<string, unknown>): SupervisorRunRecord {
  let usage = { input: 0, output: 0 };
  try {
    if (r.usage_json) usage = JSON.parse(r.usage_json as string) as typeof usage;
  } catch {
    /* 损坏按零处理 */
  }
  let plan: SupervisorRunRecord['plan'] = null;
  try {
    if (r.plan_json) plan = JSON.parse(r.plan_json as string) as SupervisorRunRecord['plan'];
  } catch {
    /* 损坏按无计划处理 */
  }
  return {
    id: r.id as string,
    goal: r.goal as string,
    cwd: r.cwd as string,
    mode: r.mode as SupervisorRunRecord['mode'],
    bypassPermissions: r.bypass_permissions === 1,
    state: r.state as SupervisorRunRecord['state'],
    plan,
    report: (r.report as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    usage,
    createdAt: r.created_at as number,
    endedAt: r.ended_at != null ? (r.ended_at as number) : null,
  };
}

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
        updated_at INTEGER NOT NULL,
        stage TEXT NOT NULL DEFAULT 'idea'
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
      CREATE TABLE IF NOT EXISTS supervisor_runs (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        cwd TEXT NOT NULL,
        mode TEXT NOT NULL,
        state TEXT NOT NULL,
        plan_json TEXT,
        report TEXT,
        error TEXT,
        usage_json TEXT,
        created_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS supervisor_steps (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        title TEXT NOT NULL,
        agent TEXT NOT NULL,
        prompt TEXT NOT NULL,
        acceptance_check TEXT NOT NULL,
        auto_check INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        task_id TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        output TEXT,
        verify_result TEXT,
        verify_reason TEXT,
        PRIMARY KEY (run_id, step_id)
      );
    `);
    // 迁移:旧库 events 表补 model 列(按模型用量聚合)
    const cols = this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'model')) {
      this.db.exec('ALTER TABLE events ADD COLUMN model TEXT');
    }
    // 迁移:补 fingerprint 列(内容指纹,发射路径与文件监听路径的去重依据)
    if (!cols.some((c) => c.name === 'fingerprint')) {
      this.db.exec('ALTER TABLE events ADD COLUMN fingerprint TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_fingerprint ON events(fingerprint)');
    }
    // 迁移:conversations 补 stage 列(特性生命周期阶段)
    const convCols = this.db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>;
    if (!convCols.some((c) => c.name === 'stage')) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN stage TEXT NOT NULL DEFAULT 'idea'");
    }
    // 迁移:supervisor_runs 补 bypass_permissions 列(编排派发跳过 Worker 权限确认)
    const supCols = this.db.prepare('PRAGMA table_info(supervisor_runs)').all() as Array<{ name: string }>;
    if (!supCols.some((c) => c.name === 'bypass_permissions')) {
      this.db.exec('ALTER TABLE supervisor_runs ADD COLUMN bypass_permissions INTEGER NOT NULL DEFAULT 0');
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

  sessions(opts: { agent?: string; q?: string; beforeTs?: number; limit?: number; includeEmpty?: boolean } = {}): SessionSummary[] {
    const { agent, q, beforeTs, limit = 100, includeEmpty = false } = opts;
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (agent) {
      clauses.push('agent = ?');
      params.push(agent);
    }
    if (q) {
      clauses.push('(title LIKE ? OR project_dir LIKE ? OR session_id LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (beforeTs !== undefined) {
      clauses.push('last_ts < ?');
      params.push(beforeTs);
    }
    if (!includeEmpty) clauses.push('message_count > 0');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
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

  sessionsCount(opts: { agent?: string; q?: string; includeEmpty?: boolean } = {}): number {
    const { agent, q, includeEmpty = false } = opts;
    const clauses: string[] = [];
    const params: Array<string> = [];
    if (agent) {
      clauses.push('agent = ?');
      params.push(agent);
    }
    if (q) {
      clauses.push('(title LIKE ? OR project_dir LIKE ? OR session_id LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (!includeEmpty) clauses.push('message_count > 0');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM sessions ${where}`)
      .get(...params) as { n: number };
    return row.n;
  }

  // ---- events ----
  insertEvent(e: HarnessEvent & { model?: string }): number {
    // 内容指纹去重:同一条真实消息经"发射路径"(stdout 流)与"文件监听路径"(会话文件)
    // 各入库一次是重复的根源;按 agent+session+kind+全文 计算指纹,存在即跳过。
    // 代价:同一会话里逐字相同的消息只会记一条(对"重试"类消息是合理收敛)。
    const fullText = typeof e.meta?.fullText === 'string' ? e.meta.fullText.trim() : '';
    const fpBase = (e.kind === 'assistant-message' || e.kind === 'user-message')
      ? `${e.agent}|${e.sessionId}|${e.kind}|${fullText || e.summary}`
      : '';
    const fingerprint = fpBase ? createHash('sha1').update(fpBase).digest('hex') : null;
    if (fingerprint) {
      const dup = this.db.prepare('SELECT seq FROM events WHERE fingerprint = ? LIMIT 1').get(fingerprint) as
        | { seq: number }
        | undefined;
      if (dup) return dup.seq;
    }
    const info = this.db
      .prepare(
        `INSERT INTO events (ts, agent, session_id, kind, summary, project_dir, input_tokens, output_tokens, model, meta_json, fingerprint)
         VALUES (@ts, @agent, @sessionId, @kind, @summary, @projectDir, @inputTokens, @outputTokens, @model, @metaJson, @fingerprint)`,
      )
      .run({
        ...e,
        inputTokens: e.usage?.input ?? null,
        outputTokens: e.usage?.output ?? null,
        model: e.model ?? null,
        metaJson: e.meta ? JSON.stringify(e.meta) : null,
        fingerprint,
      });
    return Number(info.lastInsertRowid);
  }

  /** 一次性:清理历史重复事件(去重列上线前入库的)。返回删除条数。 */
  dedupeExistingEvents(): number {
    const rows = this.db
      .prepare(
        `SELECT seq, agent, session_id, kind, summary, meta_json FROM events
         WHERE kind IN ('assistant-message', 'user-message') ORDER BY seq ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    const seen = new Set<string>();
    const dups: number[] = [];
    for (const r of rows) {
      let fullText = '';
      try {
        const meta = r.meta_json ? (JSON.parse(r.meta_json as string) as Record<string, unknown>) : undefined;
        fullText = typeof meta?.fullText === 'string' ? meta.fullText.trim() : '';
      } catch {
        /* 忽略坏 meta */
      }
      const fp = createHash('sha1')
        .update(`${r.agent}|${r.session_id}|${r.kind}|${fullText || r.summary}`)
        .digest('hex');
      if (seen.has(fp)) dups.push(r.seq as number);
      else seen.add(fp);
    }
    if (dups.length) {
      const del = this.db.prepare('DELETE FROM events WHERE seq = ?');
      const tx = this.db.transaction(() => {
        for (const seq of dups) del.run(seq);
      });
      tx();
    }
    return dups.length;
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
    const byDayRows = (
      this.db
        .prepare(
          `SELECT date(ts/1000,'unixepoch','localtime') AS day,
                  COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o
           FROM events ${w} GROUP BY day ORDER BY day ASC`,
        )
        .all(...params) as Array<{ day: string; i: number; o: number }>
    );
    // 按天轴补零:范围内每一天都有数据点,避免有数据的日期挤在一起被误读为连续
    const byDay = fillDayAxis(byDayRows, from, to).map((r) => ({ day: r.day, input: r.i, output: r.o }));
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

  // ---- Supervisor 编排层 ----

  upsertSupervisorRun(r: SupervisorRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO supervisor_runs (id, goal, cwd, mode, bypass_permissions, state, plan_json, report, error, usage_json, created_at, ended_at)
         VALUES (@id, @goal, @cwd, @mode, @bypassPermissions, @state, @planJson, @report, @error, @usageJson, @createdAt, @endedAt)
         ON CONFLICT(id) DO UPDATE SET
           goal = excluded.goal, cwd = excluded.cwd, mode = excluded.mode, bypass_permissions = excluded.bypass_permissions,
           state = excluded.state,
           plan_json = excluded.plan_json, report = excluded.report, error = excluded.error,
           usage_json = excluded.usage_json, created_at = excluded.created_at, ended_at = excluded.ended_at`,
      )
      .run({
        id: r.id,
        goal: r.goal,
        cwd: r.cwd,
        mode: r.mode,
        bypassPermissions: r.bypassPermissions === true ? 1 : 0,
        state: r.state,
        planJson: r.plan ? JSON.stringify(r.plan) : null,
        report: r.report,
        error: r.error,
        usageJson: JSON.stringify(r.usage),
        createdAt: r.createdAt,
        endedAt: r.endedAt ?? null,
      });
    // 保留最近 100 条 run,防无限膨胀
    this.db
      .prepare(
        `DELETE FROM supervisor_runs WHERE id NOT IN (
           SELECT id FROM supervisor_runs ORDER BY created_at DESC LIMIT 100
         )`,
      )
      .run();
  }

  getSupervisorRun(id: string): SupervisorRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM supervisor_runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? supervisorRunFromRow(row) : undefined;
  }

  listSupervisorRuns(limit = 50): SupervisorRunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM supervisor_runs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(supervisorRunFromRow);
  }

  upsertSupervisorStep(s: SupervisorStepRecord): void {
    this.db
      .prepare(
        `INSERT INTO supervisor_steps (run_id, step_id, title, agent, prompt, acceptance_check, auto_check, state, task_id, attempt, output, verify_result, verify_reason)
         VALUES (@runId, @stepId, @title, @agent, @prompt, @acceptanceCheck, @autoCheck, @state, @taskId, @attempt, @output, @verifyResult, @verifyReason)
         ON CONFLICT(run_id, step_id) DO UPDATE SET
           title = excluded.title, agent = excluded.agent, prompt = excluded.prompt,
           acceptance_check = excluded.acceptance_check, auto_check = excluded.auto_check,
           state = excluded.state, task_id = excluded.task_id, attempt = excluded.attempt,
           output = excluded.output, verify_result = excluded.verify_result, verify_reason = excluded.verify_reason`,
      )
      .run({
        ...s,
        autoCheck: s.autoCheck ? 1 : 0,
        taskId: s.taskId ?? null,
        output: s.output ?? null,
        verifyResult: s.verifyResult ?? null,
        verifyReason: s.verifyReason ?? null,
      });
  }

  listSupervisorSteps(runId: string): SupervisorStepRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM supervisor_steps WHERE run_id = ? ORDER BY rowid')
      .all(runId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      runId: r.run_id as string,
      stepId: r.step_id as string,
      title: r.title as string,
      agent: r.agent as SupervisorStepRecord['agent'],
      prompt: r.prompt as string,
      acceptanceCheck: r.acceptance_check as string,
      autoCheck: Boolean(r.auto_check),
      state: r.state as SupervisorStepRecord['state'],
      taskId: (r.task_id as string | null) ?? null,
      attempt: r.attempt as number,
      output: (r.output as string | null) ?? null,
      verifyResult: (r.verify_result as 'pass' | 'fail' | null) ?? null,
      verifyReason: (r.verify_reason as string | null) ?? null,
    }));
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

  setConversationStage(id: string, stage: ConversationStage, now: number): void {
    this.db.prepare('UPDATE conversations SET stage = ?, updated_at = ? WHERE id = ?').run(stage, now, id);
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
      stage: (r.stage as ConversationStage | null) ?? 'idea',
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

/** 按天聚合补零:from/to 为毫秒时间戳,缺省时以事件最早时间到今天为轴 */
export function fillDayAxis(
  rows: Array<{ day: string; i: number; o: number }>,
  from?: number,
  to?: number,
): Array<{ day: string; i: number; o: number }> {
  const map = new Map(rows.map((r) => [r.day, r]));
  let start = from;
  let end = to;
  if (start === undefined || end === undefined) {
    const range = rows.length ? rows : undefined;
    if (range && range.length > 0) {
      start = new Date(`${range[0]!.day}T00:00:00`).getTime();
      end = new Date(`${range[range.length - 1]!.day}T00:00:00`).getTime();
    }
  }
  if (start === undefined || end === undefined) return rows;
  const out: Array<{ day: string; i: number; o: number }> = [];
  const fmt = (t: number): string => {
    const d = new Date(t);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  };
  for (let t = start; t <= end; t += 86400_000) {
    const key = fmt(t);
    out.push(map.get(key) ?? { day: key, i: 0, o: 0 });
  }
  return out;
}
