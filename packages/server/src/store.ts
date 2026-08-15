/**
 * Store:SQLite 索引(会话、事件、文件游标)。
 * 仅存索引与聚合,不复制任何工具的原始会话数据。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { CursorStore, HarnessEvent, SessionSummary } from '@openharness/core';

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
        meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);
      CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
      CREATE TABLE IF NOT EXISTS cursors (
        file_path TEXT PRIMARY KEY,
        offset INTEGER NOT NULL
      );
    `);
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
  insertEvent(e: HarnessEvent): number {
    const info = this.db
      .prepare(
        `INSERT INTO events (ts, agent, session_id, kind, summary, project_dir, input_tokens, output_tokens, meta_json)
         VALUES (@ts, @agent, @sessionId, @kind, @summary, @projectDir, @inputTokens, @outputTokens, @metaJson)`,
      )
      .run({
        ...e,
        inputTokens: e.usage?.input ?? null,
        outputTokens: e.usage?.output ?? null,
        metaJson: e.meta ? JSON.stringify(e.meta) : null,
      });
    return Number(info.lastInsertRowid);
  }

  events(opts: { limit?: number; agent?: string; session?: string; sinceSeq?: number } = {}): HarnessEvent[] {
    const { limit = 100, agent, session, sinceSeq } = opts;
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
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((r) => ({
      ts: r.ts as number,
      agent: r.agent as HarnessEvent['agent'],
      sessionId: r.session_id as string,
      kind: r.kind as HarnessEvent['kind'],
      summary: r.summary as string,
      projectDir: (r.project_dir as string | null) ?? null,
      usage:
        r.input_tokens != null || r.output_tokens != null
          ? { input: (r.input_tokens as number) ?? 0, output: (r.output_tokens as number) ?? 0 }
          : undefined,
      meta: r.meta_json ? (JSON.parse(r.meta_json as string) as Record<string, unknown>) : undefined,
    }));
  }

  // ---- usage 聚合(F6)----
  usage(): UsageReport {
    const total = this.db
      .prepare('SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM events')
      .get() as { i: number; o: number };
    const toolCalls = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'tool-call'")
      .get() as { n: number };
    const byAgent = (
      this.db
        .prepare(
          'SELECT agent, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM events GROUP BY agent ORDER BY i + o DESC',
        )
        .all() as Array<{ agent: string; i: number; o: number }>
    ).map((r) => ({ agent: r.agent as UsageReport['byAgent'][number]['agent'], input: r.i, output: r.o }));
    const since14d = Date.now() - 14 * 86400_000;
    const byDay = (
      this.db
        .prepare(
          `SELECT date(ts/1000,'unixepoch','localtime') AS day,
                  COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o
           FROM events WHERE ts >= ? GROUP BY day ORDER BY day ASC`,
        )
        .all(since14d) as Array<{ day: string; i: number; o: number }>
    ).map((r) => ({ day: r.day, input: r.i, output: r.o }));
    const byProject = (
      this.db
        .prepare(
          `SELECT project_dir AS p, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o
           FROM events WHERE project_dir IS NOT NULL AND project_dir != ''
           GROUP BY project_dir ORDER BY i + o DESC LIMIT 8`,
        )
        .all() as Array<{ p: string; i: number; o: number }>
    ).map((r) => ({ project: r.p, input: r.i, output: r.o }));

    return { total: { input: total.i, output: total.o }, toolCalls: toolCalls.n, byAgent, byDay, byProject };
  }

  close(): void {
    this.db.close();
  }
}

export interface UsageReport {
  total: { input: number; output: number };
  toolCalls: number;
  byAgent: Array<{ agent: string; input: number; output: number }>;
  byDay: Array<{ day: string; input: number; output: number }>;
  byProject: Array<{ project: string; input: number; output: number }>;
}
