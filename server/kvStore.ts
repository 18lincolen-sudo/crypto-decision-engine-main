// ═══════════════════════════════════════════════════════════════════════════
// KV Store — Firestore (production) + local file (dev fallback)
// ═══════════════════════════════════════════════════════════════════════════

import { sign } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '.data');

interface ServiceAccount {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(serviceAccount: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claimSet = base64url(Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: serviceAccount.token_uri,
    exp: now + 3600,
    iat: now
  })));

  const signingInput = `${header}.${claimSet}`;
  const signed = sign('sha256', Buffer.from(signingInput), {
    key: serviceAccount.private_key,
    format: 'pem'
  });
  const jwt = `${signingInput}.${base64url(signed)}`;

  const res = await fetch(serviceAccount.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth2 token exchange failed: ${res.status} ${text}`);
  }

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

class FirestoreKV {
  private projectId: string;
  private serviceAccount: ServiceAccount | null = null;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private baseUrl: string;

  constructor() {
    this.projectId = process.env.FIREBASE_PROJECT_ID || '';
    const keyJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (keyJson) {
      try {
        this.serviceAccount = JSON.parse(keyJson);
      } catch {
        console.warn('[kv] Invalid FIREBASE_SERVICE_ACCOUNT_KEY JSON');
      }
    }
    this.baseUrl = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents`;
  }

  isConfigured(): boolean {
    return Boolean(this.projectId && this.serviceAccount);
  }

  async ensureToken(): Promise<string | null> {
    if (!this.isConfigured()) return null;
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    const token = await getAccessToken(this.serviceAccount!);
    this.accessToken = token;
    this.tokenExpiry = Date.now() + 55 * 60 * 1000; // 55 min
    return token;
  }

  /** Parse Firestore document response, extracting value and optional expiresAt */
  private parseDoc(data: { fields?: Record<string, unknown> }): string | null {
    const fields = data.fields;
    if (!fields) return null;

    // Check TTL — if expired, treat as null
    const expiresAt = fields.expiresAt?.integerValue;
    if (expiresAt && Number(expiresAt) < Date.now()) {
      return null; // expired
    }

    return fields.value?.stringValue ?? null;
  }

  async get(key: string): Promise<string | null> {
    const token = await this.ensureToken();
    if (!token) return null;
    try {
      const res = await fetch(`${this.baseUrl}/kv/${encodeURIComponent(key)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) return null;
      const data = await res.json() as { fields?: Record<string, unknown> };
      return this.parseDoc(data);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const token = await this.ensureToken();
    if (!token) return;
    try {
      const fields: Record<string, unknown> = {
        value: { stringValue: value },
        updatedAt: { integerValue: String(Date.now()) }
      };
      if (ttlMs && ttlMs > 0) {
        fields.expiresAt = { integerValue: String(Date.now() + ttlMs) };
      }
      await fetch(`${this.baseUrl}/kv/${encodeURIComponent(key)}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fields })
      });
    } catch (err) {
      console.warn('[kv] Firestore set failed:', err);
    }
  }

  async del(key: string): Promise<void> {
    const token = await this.ensureToken();
    if (!token) return;
    try {
      await fetch(`${this.baseUrl}/kv/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch {
      // ignore
    }
  }
}

const fileQueues = new Map<string, Promise<unknown>>();
function enqueue<T>(file: string, task: () => Promise<T>): Promise<T> {
  const prev = fileQueues.get(file) ?? Promise.resolve();
  const next = prev.then(task, task);
  fileQueues.set(file, next.catch(() => {}));
  return next;
}

class LocalKV {
  private file: string;

  constructor(file: string) {
    this.file = file;
  }

  async get(key: string): Promise<string | null> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const data = JSON.parse(raw) as Record<string, { value: string; expiresAt?: number }>;
      const entry = data[key];
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        return null; // expired
      }
      return entry.value;
    } catch {
      return null;
    }
  }

  private async writeAtomic(full: Record<string, { value: string; expiresAt?: number }>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(full, null, 2), 'utf8');
    await rename(tmp, this.file);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    return enqueue(this.file, async () => {
      try {
        let full: Record<string, { value: string; expiresAt?: number }> = {};
        try {
          full = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, { value: string; expiresAt?: number }>;
        } catch { /* ignore */ }
        full[key] = {
          value,
          ...(ttlMs && ttlMs > 0 ? { expiresAt: Date.now() + ttlMs } : {})
        };
        await this.writeAtomic(full);
      } catch (err) {
        console.warn('[kv] local set failed:', err);
      }
    });
  }

  async del(key: string): Promise<void> {
    return enqueue(this.file, async () => {
      try {
        let full: Record<string, { value: string; expiresAt?: number }> = {};
        try {
          full = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, { value: string; expiresAt?: number }>;
        } catch { return; }
        delete full[key];
        await this.writeAtomic(full);
      } catch { /* ignore */ }
    });
  }
}

class KVStore {
  private firestore: FirestoreKV;
  private local: LocalKV;
  private prefix: string;

  constructor(prefix: string, localFile: string) {
    this.prefix = prefix;
    this.firestore = new FirestoreKV();
    this.local = new LocalKV(localFile);
  }

  private k(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async get(key: string): Promise<string | null> {
    const k = this.k(key);
    if (process.env.NODE_ENV !== 'production') {
      return this.local.get(k);
    }
    const remote = await this.firestore.get(k);
    if (remote !== null) return remote;
    return this.local.get(k);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const k = this.k(key);
    if (process.env.NODE_ENV !== 'production') {
      await this.local.set(k, value, ttlMs);
      return;
    }
    await this.firestore.set(k, value, ttlMs);
    await this.local.set(k, value, ttlMs);
  }

  async del(key: string): Promise<void> {
    const k = this.k(key);
    await this.firestore.del(k);
    await this.local.del(k);
  }
}

export function createKVStore(prefix: string, localFile: string): KVStore {
  return new KVStore(prefix, localFile);
}
