import Database from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { appPaths, ensureAppPaths } from '../config/paths.js';
import {
  ApprovalReceiptSchema,
  OrderRecordSchema,
  PaymentApprovalReceiptSchema,
  PaymentRecordSchema,
  PaymentSnapshotSchema,
  QuoteSnapshotSchema,
  StatusSnapshotSchema,
  type ApprovalReceipt,
  type OrderRecord,
  type PaymentApprovalReceipt,
  type PaymentRecord,
  type PaymentSnapshot,
  type QuoteSnapshot,
  type StatusSnapshot
} from '../domain/types.js';

export class StateDatabase {
  readonly db: Database.Database;

  private constructor(database: Database.Database) {
    this.db = database;
    this.migrate();
  }

  static async open(databaseFile = appPaths.databaseFile): Promise<StateDatabase> {
    if (databaseFile === appPaths.databaseFile) await ensureAppPaths();
    else await mkdir(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
    const database = new Database(databaseFile);
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    return new StateDatabase(database);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quotes (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        quote_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        quote_id TEXT,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS status_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        request_id TEXT PRIMARY KEY,
        quote_id TEXT NOT NULL,
        state TEXT NOT NULL,
        order_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_snapshots (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_approvals (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_records (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_idempotency (
        request_id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL,
        state TEXT NOT NULL,
        record_id TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  saveQuote(quote: QuoteSnapshot): void {
    const value = QuoteSnapshotSchema.parse(quote);
    this.db.prepare(`INSERT OR REPLACE INTO quotes(id,payload,created_at) VALUES(?,?,?)`)
      .run(value.id, JSON.stringify(value), value.quotedAt);
  }

  getQuote(id: string): QuoteSnapshot | undefined {
    const row = this.db.prepare('SELECT payload FROM quotes WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? QuoteSnapshotSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  saveApproval(approval: ApprovalReceipt): void {
    const value = ApprovalReceiptSchema.parse(approval);
    this.db.prepare(`INSERT OR REPLACE INTO approvals(id,quote_id,payload,created_at) VALUES(?,?,?,?)`)
      .run(value.id, value.quoteId, JSON.stringify(value), value.approvedAt);
  }

  getApproval(id: string): ApprovalReceipt | undefined {
    const row = this.db.prepare('SELECT payload FROM approvals WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? ApprovalReceiptSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  saveOrder(order: OrderRecord): void {
    const value = OrderRecordSchema.parse(order);
    this.db.prepare(`INSERT OR REPLACE INTO orders(id,quote_id,payload,updated_at) VALUES(?,?,?,?)`)
      .run(value.id, value.quoteId ?? null, JSON.stringify(value), value.updatedAt);
  }

  getOrder(id: string): OrderRecord | undefined {
    const row = this.db.prepare('SELECT payload FROM orders WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? OrderRecordSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  listOrders(limit = 50): OrderRecord[] {
    const rows = this.db.prepare('SELECT payload FROM orders ORDER BY updated_at DESC LIMIT ?').all(limit) as Array<{ payload: string }>;
    return rows.map((row) => OrderRecordSchema.parse(JSON.parse(row.payload)));
  }

  saveStatus(snapshot: StatusSnapshot): void {
    const value = StatusSnapshotSchema.parse(snapshot);
    this.db.prepare('INSERT INTO status_snapshots(order_id,payload,captured_at) VALUES(?,?,?)')
      .run(value.orderId, JSON.stringify(value), value.capturedAt);
  }

  latestStatus(orderId: string): StatusSnapshot | undefined {
    const row = this.db.prepare('SELECT payload FROM status_snapshots WHERE order_id = ? ORDER BY id DESC LIMIT 1')
      .get(orderId) as { payload: string } | undefined;
    return row ? StatusSnapshotSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  savePaymentSnapshot(snapshot: PaymentSnapshot): void {
    const value = PaymentSnapshotSchema.parse(snapshot);
    this.db.prepare('INSERT OR REPLACE INTO payment_snapshots(id,order_id,payload,created_at) VALUES(?,?,?,?)')
      .run(value.id, value.orderId, JSON.stringify(value), value.preparedAt);
  }

  getPaymentSnapshot(id: string): PaymentSnapshot | undefined {
    const row = this.db.prepare('SELECT payload FROM payment_snapshots WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? PaymentSnapshotSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  savePaymentApproval(approval: PaymentApprovalReceipt): void {
    const value = PaymentApprovalReceiptSchema.parse(approval);
    this.db.prepare('INSERT OR REPLACE INTO payment_approvals(id,payment_id,payload,created_at) VALUES(?,?,?,?)')
      .run(value.id, value.paymentId, JSON.stringify(value), value.approvedAt);
  }

  savePaymentRecord(record: PaymentRecord): void {
    const value = PaymentRecordSchema.parse(record);
    this.db.prepare('INSERT OR REPLACE INTO payment_records(id,payment_id,order_id,payload,updated_at) VALUES(?,?,?,?,?)')
      .run(value.id, value.paymentId, value.orderId, JSON.stringify(value), value.updatedAt);
  }

  getPaymentRecord(id: string): PaymentRecord | undefined {
    const row = this.db.prepare('SELECT payload FROM payment_records WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? PaymentRecordSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  beginPaymentRequest(requestId: string, paymentId: string): 'new' | 'existing' {
    const result = this.db.prepare('INSERT OR IGNORE INTO payment_idempotency(request_id,payment_id,state,updated_at) VALUES(?,?,?,?)')
      .run(requestId, paymentId, 'pending', new Date().toISOString());
    return result.changes === 1 ? 'new' : 'existing';
  }

  getPaymentRequest(requestId: string): { paymentId: string; state: string; recordId?: string } | undefined {
    const row = this.db.prepare('SELECT payment_id,state,record_id FROM payment_idempotency WHERE request_id = ?').get(requestId) as
      | { payment_id: string; state: string; record_id: string | null }
      | undefined;
    return row ? { paymentId: row.payment_id, state: row.state, recordId: row.record_id ?? undefined } : undefined;
  }

  finishPaymentRequest(requestId: string, state: 'succeeded' | 'unknown' | 'failed', recordId?: string): void {
    this.db.prepare('UPDATE payment_idempotency SET state = ?, record_id = ?, updated_at = ? WHERE request_id = ?')
      .run(state, recordId ?? null, new Date().toISOString(), requestId);
  }

  beginIdempotentRequest(requestId: string, quoteId: string): 'new' | 'existing' {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO idempotency(request_id,quote_id,state,updated_at) VALUES(?,?,?,?)`)
      .run(requestId, quoteId, 'pending', now);
    return result.changes === 1 ? 'new' : 'existing';
  }

  getIdempotency(requestId: string): { quoteId: string; state: string; orderId?: string } | undefined {
    const row = this.db.prepare('SELECT quote_id,state,order_id FROM idempotency WHERE request_id = ?').get(requestId) as
      | { quote_id: string; state: string; order_id: string | null }
      | undefined;
    return row ? { quoteId: row.quote_id, state: row.state, orderId: row.order_id ?? undefined } : undefined;
  }

  finishIdempotentRequest(requestId: string, state: 'succeeded' | 'unknown' | 'failed', orderId?: string): void {
    this.db.prepare('UPDATE idempotency SET state = ?, order_id = ?, updated_at = ? WHERE request_id = ?')
      .run(state, orderId ?? null, new Date().toISOString(), requestId);
  }

  close(): void {
    this.db.close();
  }
}
