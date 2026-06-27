export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  level: LogLevel;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  /** Returns a logger that prefixes messages with `[scope]`. */
  child(scope: string): Logger;
}

class ConsoleLogger implements Logger {
  constructor(
    public level: LogLevel = "info",
    private readonly scope = "",
  ) {}

  private emit(level: Exclude<LogLevel, "silent">, msg: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const prefix = this.scope ? `[${this.scope}] ` : "";
    const line = `${prefix}${msg}`;
    if (level === "error") console.error(line, ...args);
    else if (level === "warn") console.warn(line, ...args);
    else console.error(line, ...args); // info/debug to stderr so stdout stays clean for reports
  }

  debug(msg: string, ...args: unknown[]): void {
    this.emit("debug", msg, args);
  }
  info(msg: string, ...args: unknown[]): void {
    this.emit("info", msg, args);
  }
  warn(msg: string, ...args: unknown[]): void {
    this.emit("warn", msg, args);
  }
  error(msg: string, ...args: unknown[]): void {
    this.emit("error", msg, args);
  }
  child(scope: string): Logger {
    const next = this.scope ? `${this.scope}:${scope}` : scope;
    return new ConsoleLogger(this.level, next);
  }
}

export function createLogger(level: LogLevel = "info", scope = ""): Logger {
  return new ConsoleLogger(level, scope);
}

/** A logger that discards everything — handy for tests and library use. */
export const silentLogger: Logger = createLogger("silent");
