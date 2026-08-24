// ═══════════════════════════════════════════════════════════════════════════
// KV Store — Firestore (production) + local file (dev fallback)
// ═══════════════════════════════════════════════════════════════════════════

import { createHmac, randomBytes, timingSafeEqual, sign } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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

  async get(key: string): Promise<string | null> {
    const token = await this.ensureToken();
    if (!token) return null;
    try {
      const res = await fetch(`${this.baseUrl}/kv/${encodeURIComponent(key)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) return null;
      const data = await res.json() as { fields?: { value?: { stringValue?: string } } };
      return data.fields?.value?.stringValue ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const token = await this.ensureToken();
    if (!token) return;
    try {
      await fetch(`${this.baseUrl}/kv/${encodeURIComponent(key)}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            value: { stringValue: value },
            updatedAt: { integerValue: String(Date.now()) }
          }
        })
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

class LocalKV {
  private file: string;

  constructor(file: string) {
    this.file = file;
  }

  async get(key: string): Promise<string | null> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const data = JSON.parse(raw) as Record<string, string>;
      return data[key] ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      // Read full file to preserve other keys
      let full: Record<string, string> = {};
      try {
        full = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
      } catch {
        // ignore
      }
      full[key] = value;
      await writeFile(this.file, JSON.stringify(full, null, 2), 'utf8');
    } catch (err) {
      console.warn('[kv] local set failed:', err);
    }
  }

  async del(key: string): Promise<void> {
    try {
      let full: Record<string, string> = {};
      try {
        full = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
      } catch {
        return;
      }
      delete full[key];
      await writeFile(this.file, JSON.stringify(full, null, 2), 'utf8');
    } catch {
      // ignore
    }
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
    // Fallback to local if remote miss (cold start after deploy)
    return this.local.get(k);
  }

  async set(key: string, value: string): Promise<void> {
    const k = this.k(key);
    if (process.env.NODE_ENV !== 'production') {
      await this.local.set(k, value);
      return;
    }
    await this.firestore.set(k, value);
    // Also write locally as immediate fallback
    await this.local.set(k, value);
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
