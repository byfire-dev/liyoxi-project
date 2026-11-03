export class ProbeError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 502;
  constructor(code: string, status: ProbeError["status"] = 400) {
    super(code);
    this.status = status;
  }
}
