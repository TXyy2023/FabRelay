import type { Page } from "playwright";

export type Operation =
  | "auth.login"
  | "auth.status"
  | "account.show"
  | "pcb.upload"
  | "pcb.options"
  | "pcb.set"
  | "pcb.preview"
  | "pcb.quote"
  | "pcb.check"
  | "pcb.submit"
  | "orders.list"
  | "orders.show"
  | "orders.progress"
  | "payment.prepare"
  | "payment.execute"
  | "xiaozhi.ask";
export type Status =
  | "succeeded"
  | "needs_input"
  | "needs_login"
  | "needs_confirmation"
  | "handoff"
  | "unknown"
  | "failed";
export interface BusinessResult {
  resume?: boolean;
  status: Status;
  data: Record<string, unknown>;
  error?: { code: string; message: string };
  next?: string[];
}
export interface AdapterContext {
  effectStarted?: boolean;
  taskId: string;
  timeoutMs: number;
  artifactDir: string;
  input: Record<string, unknown>;
  previous?: Record<string, unknown>;
  beforeEffect: (
    kind: "submit" | "pay",
    binding: Record<string, unknown>,
  ) => Promise<void>;
}
export interface SiteAdapter {
  run(
    operation: Operation,
    page: Page,
    context: AdapterContext,
  ): Promise<BusinessResult>;
  reconcile(
    operation: Operation,
    page: Page,
    context: AdapterContext,
  ): Promise<BusinessResult>;
}
export interface BrowserConfig {
  engine: "obscura" | "chrome";
  endpoint?: string;
  executable?: string;
  port?: number;
  timeoutMs?: number;
}
export interface BrowserConnection {
  page: Page;
  endpoint: string;
  targetId: string;
  save(): Promise<void>;
  disconnect(): Promise<void>;
  diagnostic(directory: string): Promise<Record<string, unknown>>;
}
export interface BrowserProvider {
  connect(
    config: BrowserConfig,
    directory: string,
    targetId?: string,
  ): Promise<BrowserConnection>;
  doctor(config: BrowserConfig): Promise<Record<string, unknown>>;
}
