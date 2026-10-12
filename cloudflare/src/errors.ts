/** One refusal shape for MCP and HTTP (SPEC S8). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }

  toJSON() {
    return { error: this.code, message: this.message, ...this.extra };
  }
}
