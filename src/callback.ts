import { createHmac } from "node:crypto";
import { CliError, type CallbackSpec, type State, type Task } from "./state.js";
export function validateCallback(spec: CallbackSpec): void {
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    throw new CliError(
      "INVALID_CALLBACK",
      "Callback must be an absolute HTTPS or loopback HTTP URL.",
    );
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new CliError(
      "INVALID_CALLBACK",
      "Use HTTPS or loopback HTTP without credentials or fragments.",
    );
  if (spec.secretEnv && !process.env[spec.secretEnv])
    throw new CliError(
      "CALLBACK_SECRET_MISSING",
      `Set environment variable ${spec.secretEnv} before callback delivery.`,
    );
}
export function queueCallback(task: Task): void {
  if (!task.callback) return;
  task.delivery = {
    eventId: `${task.id}:${task.revision}`,
    delivered: false,
    attempts: 0,
    payload: {
      schemaVersion: 1,
      eventId: `${task.id}:${task.revision}`,
      taskId: task.id,
      operation: task.operation,
      status: task.status,
      occurredAt: task.updatedAt,
      authenticated:
        task.operation.startsWith("auth.") &&
        task.status === "succeeded" &&
        (task.data.authenticated === true || task.data.loggedIn === true),
      error: task.error?.code,
    },
  };
}
export async function deliverCallback(
  state: State,
  task: Task,
  retry = false,
): Promise<void> {
  if (!task.callback) return;
  if (!retry || !task.delivery) queueCallback(task);
  if (!task.delivery || task.delivery.delivered) return;
  task.delivery.attempts++;
  await state.save(task);
  try {
    validateCallback(task.callback);
    const body = JSON.stringify(task.delivery.payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-jlc-event-id": task.delivery.eventId,
    };
    if (task.callback.secretEnv)
      headers["x-jlc-signature"] =
        "sha256=" +
        createHmac("sha256", process.env[task.callback.secretEnv]!)
          .update(body)
          .digest("hex");
    const response = await fetch(task.callback.url, {
      method: "POST",
      body,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.body?.cancel();
    task.delivery.delivered = true;
    delete task.delivery.error;
  } catch (error) {
    task.delivery.error =
      error instanceof Error ? error.message : "Callback delivery failed";
  }
  await state.save(task);
}
