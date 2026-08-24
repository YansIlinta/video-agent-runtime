export interface LogContext { projectId?: string; workflowRunId?: string; jobId?: string; provider?: string; operation?: string; durationMs?: number; status?: string; [key: string]: unknown }

export class StructuredLogger {
  constructor(private readonly level: "error" | "warn" | "info" | "debug" = "info") {}
  private emit(level: "error" | "warn" | "info" | "debug", message: string, context: LogContext = {}) {
    const priorities = { error: 0, warn: 1, info: 2, debug: 3 };
    if (priorities[level] > priorities[this.level]) return;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...context });
    if (level === "error") console.error(line); else if (level === "warn") console.warn(line); else if (level === "debug") console.debug(line); else console.info(line);
  }
  error(message: string, context?: LogContext) { this.emit("error", message, context); }
  warn(message: string, context?: LogContext) { this.emit("warn", message, context); }
  info(message: string, context?: LogContext) { this.emit("info", message, context); }
  debug(message: string, context?: LogContext) { this.emit("debug", message, context); }
}
