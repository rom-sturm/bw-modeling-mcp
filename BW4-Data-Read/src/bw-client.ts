import axios, { AxiosInstance, AxiosResponse } from 'axios';
import https from 'https';

// Media types for each BW object type (from BW/4HANA discovery)
// These hardcoded values serve as fallback defaults; loadMediaTypes() overwrites them at runtime.
export const MEDIA_TYPES: Record<string, string> = {
  adso: 'application/vnd.sap.bw.modeling.adso-v1_7_0+xml',
  iobj: 'application/vnd.sap-bw-modeling.iobj-v2_2_0+xml',
  trfn: 'application/vnd.sap.bw.modeling.trfn-v1_0_0+xml',
  dtpa: 'application/vnd.sap.bw.modeling.dtpa-v1_0_0+xml',
  area: 'application/vnd.sap.bw.modeling.area-v1_1_0+xml',
  trcs: 'application/vnd.sap.bw.modeling.trcs-v1_0_0+xml',
};

export interface GetResult {
  body: string;
  headers: Record<string, string>;
}

export class BwClient {
  private http: AxiosInstance;
  private csrfToken: string | null = null;
  private cookies: Map<string, string> = new Map();
  // Basic Auth is only sent during the initial CSRF fetch to establish the session.
  // All subsequent requests use the session cookie only.
  private readonly basicAuth: string;

  constructor(url: string, user: string, password: string, client: string, language?: string) {
    this.basicAuth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    this.http = axios.create({
      baseURL: url,
      headers: {
        'sap-client': client,
        'X-sap-adt-sessiontype': 'stateful',
        ...(language ? { 'sap-language': language } : {}),
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
    });
    delete this.http.defaults.headers.post['Content-Type'];
    delete (this.http.defaults.headers as any).common['Content-Type'];
  }

  // ── Session info (debug) ──────────────────────────────────────────────────

  public sessionInfo(): Record<string, string> {
    return Object.fromEntries(this.cookies.entries());
  }

  // ── Cookie management ──────────────────────────────────────────────────────

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private updateCookies(response: AxiosResponse): void {
    const setCookies = response.headers['set-cookie'];
    if (!setCookies) return;
    for (const c of setCookies) {
      const part = c.split(';')[0];
      const eqIdx = part.indexOf('=');
      if (eqIdx > 0) {
        this.cookies.set(
          part.substring(0, eqIdx).trim(),
          part.substring(eqIdx + 1).trim()
        );
      }
    }
  }

  // ── CSRF token ─────────────────────────────────────────────────────────────

  private async fetchCsrfToken(): Promise<void> {
    const response = await this.http.get('/sap/bw/modeling/repo/is/systeminfo', {
      headers: {
        'X-CSRF-Token': 'Fetch',
        Accept: 'application/xml',
        Authorization: this.basicAuth,
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    const token = response.headers['x-csrf-token'] as string | undefined;
    if (!token || token.toLowerCase() === 'fetch') {
      throw new Error(
        `Failed to fetch CSRF token (HTTP ${response.status}). Check BW_URL, BW_USER, BW_PASSWORD, BW_CLIENT.`
      );
    }
    this.csrfToken = token;
  }

  private async ensureCsrf(): Promise<void> {
    if (!this.csrfToken) {
      await this.fetchCsrfToken();
    }
  }

  private cookieHeaders(): Record<string, string> {
    const hdr = this.cookieHeader();
    return hdr ? { Cookie: hdr } : {};
  }

  // ── Public HTTP helpers ────────────────────────────────────────────────────

  async get(path: string, accept: string): Promise<GetResult> {
    await this.ensureCsrf();
    const IOBJ_ACCEPT_ALL = 'application/vnd.sap-bw-modeling.iobj-v1_0_0+xml, application/vnd.sap-bw-modeling.iobj-v1_1_0+xml, application/vnd.sap-bw-modeling.iobj-v1_2_0+xml, application/vnd.sap-bw-modeling.iobj-v1_3_0+xml, application/vnd.sap-bw-modeling.iobj-v1_4_0+xml, application/vnd.sap-bw-modeling.iobj-v1_5_0+xml, application/vnd.sap-bw-modeling.iobj-v1_6_0+xml, application/vnd.sap-bw-modeling.iobj-v1_7_0+xml, application/vnd.sap-bw-modeling.iobj-v1_8_0+xml, application/vnd.sap-bw-modeling.iobj-v1_9_0+xml, application/vnd.sap-bw-modeling.iobj-v2_0_0+xml, application/vnd.sap-bw-modeling.iobj-v2_1_0+xml, application/vnd.sap-bw-modeling.iobj-v2_2_0+xml, application/vnd.sap-bw-modeling.iobj-v2_3_0+xml, application/vnd.sap-bw-modeling.iobj-v2_4_0+xml';
    const resolvedAccept = accept.includes('iobj') ? IOBJ_ACCEPT_ALL : `application/xml, ${accept}`;
    const response = await this.http.get(path, {
      headers: {
        Accept: resolvedAccept,
        'bwmt-level': '50',
        'X-CSRF-Token': this.csrfToken!,
        ...this.cookieHeaders(),
      },
      responseType: 'text',
      transformResponse: [(data) => data],
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`GET ${path} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /** Returns the current CSRF token, fetching it first if needed. */
  async getCsrfToken(): Promise<string> {
    await this.ensureCsrf();
    return this.csrfToken!;
  }

  /** Clears the cached CSRF token, forcing a fresh fetch on the next request. */
  public clearCsrfToken(): void {
    this.csrfToken = null;
  }

  /**
   * GET with a completely clean axios instance — no default headers at all.
   * Only sends Authorization (Basic Auth) + Cookie + CSRF token + the headers
   * explicitly passed by the caller.
   */
  async rawGet(
    url: string,
    headers: Record<string, string>
  ): Promise<{ body: string; headers: Record<string, string> }> {
    const csrfToken = await this.getCsrfToken();
    const freshHttp = axios.create({
      baseURL: this.http.defaults.baseURL,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      headers: { common: {}, get: {}, post: {}, put: {}, patch: {}, delete: {}, head: {} } as any,
    });
    const cookieHdr = this.cookieHeader();
    const response = await freshHttp.get(url, {
      headers: {
        Authorization: this.basicAuth,
        'X-CSRF-Token': csrfToken,
        ...(cookieHdr ? { Cookie: cookieHdr } : {}),
        ...headers,
      },
      responseType: 'text',
      transformResponse: [(data) => data],
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`GET ${url} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * POST with a completely clean axios instance — no default headers at all.
   * Only sends Authorization (Basic Auth) + Cookie + the headers explicitly passed.
   */
  async rawPost(
    url: string,
    body: string,
    headers: Record<string, string>
  ): Promise<{ body: string; headers: Record<string, string> }> {
    const freshHttp = axios.create({
      baseURL: this.http.defaults.baseURL,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      headers: { common: {}, get: {}, post: {}, put: {}, patch: {}, delete: {}, head: {} } as any,
    });
    const cookieHdr = this.cookieHeader();
    const response = await freshHttp.post(url, body, {
      headers: {
        Authorization: this.basicAuth,
        ...(cookieHdr ? { Cookie: cookieHdr } : {}),
        ...headers,
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`POST ${url} → HTTP ${response.status}\n${response.data}`);
    }
    return {
      body: response.data as string,
      headers: response.headers as Record<string, string>,
    };
  }

  /**
   * Fetch the BW modeling discovery document and populate MEDIA_TYPES at runtime.
   */
  async loadMediaTypes(): Promise<void> {
    const response = await this.http.get('/sap/bw/modeling/discovery', {
      headers: {
        Accept: 'application/atomsvc+xml',
        Authorization: this.basicAuth,
        ...this.cookieHeaders(),
      },
      responseType: 'text',
    });
    this.updateCookies(response);
    if (response.status >= 400) {
      throw new Error(`Discovery GET → HTTP ${response.status}\n${response.data}`);
    }
    const xml: string = response.data as string;
    const collectionRe = /<app:collection\s+href="([^"]+)"[\s\S]*?<app:accept>([^<]+)<\/app:accept>/g;
    let match: RegExpExecArray | null;
    while ((match = collectionRe.exec(xml)) !== null) {
      const href = match[1];
      const mediaType = match[2].trim();
      const key = href.split('/').pop()?.toLowerCase();
      if (key && mediaType && mediaType.endsWith('+xml')) {
        const extractVersion = (mt: string) => {
          const m = mt.match(/-v(\d+)_(\d+)_(\d+)\+xml$/);
          return m ? parseInt(m[1]) * 10000 + parseInt(m[2]) * 100 + parseInt(m[3]) : 0;
        };
        const existing = MEDIA_TYPES[key];
        if (!existing || extractVersion(mediaType) >= extractVersion(existing)) {
          MEDIA_TYPES[key] = mediaType;
        }
      }
    }
    process.stderr.write(`[bw4-data-read] Loaded media types: ${JSON.stringify(MEDIA_TYPES)}\n`);
  }
}

export function createClientFromEnv(): BwClient {
  const url = process.env.BW_URL;
  const user = process.env.BW_USER;
  const password = process.env.BW_PASSWORD;
  const client = process.env.BW_CLIENT ?? '001';
  const language = process.env.BW_LANGUAGE;
  if (!url || !user || !password) {
    throw new Error(
      'Required environment variables missing: BW_URL, BW_USER, BW_PASSWORD'
    );
  }
  return new BwClient(url, user, password, client, language);
}
