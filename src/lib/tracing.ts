/**
 * Structured observability.
 *
 * - Every request/comp phase gets a trace ID, durable across the call chain.
 * - Logs are single-line JSON so any aggregator (Datadog, Grafana Loki, Cloudflare
 *   Logpush, Vercel Logs, Logtail) can parse them without a custom processor.
 * - A `log.level` setting controls verbosity so logs don't turn into cost at scale.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 } as const;
type Level = keyof typeof LEVELS;

function threshold(): number {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase() as Level;
  return LEVELS[raw] ?? LEVELS.info;
}

function emit(level: Level, event: string, data: Record<string, unknown> = {}) {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(data.traceId ? { traceId: data.traceId } : {}),
    ...data,
  });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, data?: Record<string, unknown>) => emit("debug", event, data),
  info: (event: string, data?: Record<string, unknown>) => emit("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit("warn", event, data),
  errorUserside: (event: string, data?: Record<string, unknown>) => emit("warn", event, data),
  error: (event: string, err: unknown, data: Record<string, unknown> = {}) => {
    emit("error", event, {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 2000) : undefined,
      ...data,
    });
  },
};

/** Fresh trace ID per request, propagated through headers for distributed tracing. */
export function traceId(request?: Request): string {
  const incoming = request?.headers.get("x-trace-id") || request?.headers.get("x-request-id");
  return incoming && incoming.length <= 64 ? incoming : crypto.randomUUID();
}

/** Runtime config snapshot — surfaced at /api/monitoring for health dashboards. */
export function runtime() {
  return {
    node: process.version,
    env: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL || "info",
    ai: Boolean(process.env.OPENAI_API_KEY),
    whatsappWorker: Boolean(process.env.WA_WORKER_URL),
    telegram: Boolean(process.env.TELEGRAM_ADMIN_BOT_TOKEN),
    storage: Boolean(process.env.SUPABASE_URL),
    secrets: { ingest: Boolean(process.env.INGEST_TOKEN), cron: Boolean(process.env.CRON_SECRET) },
  };
}
