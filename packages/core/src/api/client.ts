import { request } from 'node:http';

/** Talks to a running core's local API (Unix socket or localhost + token). */
export class LocalApiClient {
  constructor(
    private readonly on: { socketPath: string; token?: string } | { url: string; token: string },
  ) {}

  get<T = unknown>(path: string): Promise<T> {
    return this.call('GET', path);
  }
  post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.call('POST', path, body);
  }
  put<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.call('PUT', path, body);
  }
  delete<T = unknown>(path: string): Promise<T> {
    return this.call('DELETE', path);
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = {};
    if (payload) headers['content-type'] = 'application/json';
    if (this.on.token) headers.authorization = `Bearer ${this.on.token}`;
    const target =
      'socketPath' in this.on
        ? { socketPath: this.on.socketPath, path }
        : (() => {
            const u = new URL(path, this.on.url);
            return { host: u.hostname, port: Number(u.port), path: u.pathname + u.search };
          })();
    return new Promise((resolve, reject) => {
      const req = request({ ...target, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            return reject(new Error(`bad response from core (${res.statusCode})`));
          }
          if ((res.statusCode ?? 500) >= 400) {
            const e = json as { error?: string; message?: string };
            return reject(
              Object.assign(new Error(e.message ?? e.error ?? 'request failed'), {
                code: e.error,
                status: res.statusCode,
              }),
            );
          }
          resolve(json as T);
        });
      });
      req.on('error', reject);
      if (payload) req.end(payload);
      else req.end();
    });
  }
}
