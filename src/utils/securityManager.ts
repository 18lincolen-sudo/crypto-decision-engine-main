/**
 * Security Manager - Handles encryption, validation, and secure storage
 */

interface EncryptedData {
  encrypted: string;
  iv: string;
  salt: string;
}

class SecurityManager {
  private readonly STORAGE_KEY_PREFIX = 'crypto_secure_';
  private readonly IV_LENGTH = 12;
  private readonly SALT_LENGTH = 16;
  private readonly KEY_LENGTH = 256;

  /**
   * Generate a random salt
   */
  private generateSalt(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(this.SALT_LENGTH));
  }

  /**
   * Generate a random IV
   */
  private generateIV(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(this.IV_LENGTH));
  }

  /**
   * Derive a key from password using PBKDF2
   */
  private async deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt.buffer as ArrayBuffer,
        iterations: 100000,
        hash: 'SHA-256'
      },
      passwordKey,
      {
        name: 'AES-GCM',
        length: this.KEY_LENGTH
      },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt data using AES-GCM
   */
  async encrypt(data: string, password: string): Promise<EncryptedData> {
    try {
      const encoder = new TextEncoder();
      const salt = this.generateSalt();
      const iv = this.generateIV();
      
      const key = await this.deriveKey(password, salt);
      
      const encrypted = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: iv.buffer as ArrayBuffer
        },
        key,
        encoder.encode(data)
      );

      return {
        encrypted: this.arrayBufferToBase64(encrypted),
        iv: this.arrayBufferToBase64(iv.buffer as ArrayBuffer),
        salt: this.arrayBufferToBase64(salt.buffer as ArrayBuffer)
      };
    } catch (error) {
      throw new Error(`Encryption failed: ${error}`);
    }
  }

  /**
   * Decrypt data using AES-GCM
   */
  async decrypt(encryptedData: EncryptedData, password: string): Promise<string> {
    try {
      const decoder = new TextDecoder();
      const salt = this.base64ToArrayBuffer(encryptedData.salt);
      const iv = this.base64ToArrayBuffer(encryptedData.iv);
      const encrypted = this.base64ToArrayBuffer(encryptedData.encrypted);
      
      const key = await this.deriveKey(password, new Uint8Array(salt));
      
      const decrypted = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv
        },
        key,
        encrypted
      );

      return decoder.decode(decrypted);
    } catch (error) {
      throw new Error(`Decryption failed: ${error}`);
    }
  }

  /**
   * Securely store encrypted credentials
   */
  async storeCredentials(credentials: any, masterPassword: string): Promise<void> {
    try {
      const credentialsJson = JSON.stringify(credentials);
      const encrypted = await this.encrypt(credentialsJson, masterPassword);
      
      localStorage.setItem(
        `${this.STORAGE_KEY_PREFIX}credentials`,
        JSON.stringify(encrypted)
      );
    } catch (error) {
      throw new Error(`Failed to store credentials: ${error}`);
    }
  }

  /**
   * Retrieve and decrypt credentials
   */
  async retrieveCredentials(masterPassword: string): Promise<any> {
    try {
      const encryptedData = localStorage.getItem(`${this.STORAGE_KEY_PREFIX}credentials`);
      if (!encryptedData) {
        return null;
      }

      const encrypted: EncryptedData = JSON.parse(encryptedData);
      const decrypted = await this.decrypt(encrypted, masterPassword);
      
      return JSON.parse(decrypted);
    } catch (error) {
      // Don't throw on decrypt failure - might be wrong password
      return null;
    }
  }

  /**
   * Validate API key format
   */
  validateApiKey(apiKey: string): boolean {
    if (!apiKey || typeof apiKey !== 'string') {
      return false;
    }
    
    // Basic format validation - alphanumeric and some special chars
    const apiKeyRegex = /^[A-Za-z0-9\-_]{8,}$/;
    return apiKeyRegex.test(apiKey.trim()) && apiKey.length >= 8 && apiKey.length <= 128;
  }

  /**
   * Validate secret key format
   */
  validateSecretKey(secretKey: string): boolean {
    if (!secretKey || typeof secretKey !== 'string') {
      return false;
    }
    
    // More strict validation for secret keys
    const secretKeyRegex = /^[A-Za-z0-9\-_\/\+]{16,}$/;
    return secretKeyRegex.test(secretKey.trim()) && secretKey.length >= 16 && secretKey.length <= 256;
  }

  /**
   * Sanitize input to prevent XSS
   */
  sanitizeInput(input: string): string {
    if (!input || typeof input !== 'string') {
      return '';
    }
    
    return input
      .replace(/[<>]/g, '') // Remove angle brackets
      .replace(/javascript:/gi, '') // Remove javascript: protocol
      .replace(/on\w+\s*=/gi, '') // Remove event handlers
      .trim();
  }

  /**
   * Validate numeric input
   */
  validateNumericInput(input: string, min?: number, max?: number): number | null {
    const num = parseFloat(input);
    
    if (isNaN(num) || !isFinite(num)) {
      return null;
    }
    
    if (min !== undefined && num < min) {
      return null;
    }
    
    if (max !== undefined && num > max) {
      return null;
    }
    
    return num;
  }

  /**
   * Clear all secure storage
   */
  clearSecureStorage(): void {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith(this.STORAGE_KEY_PREFIX)) {
        localStorage.removeItem(key);
      }
    });
  }

  /**
   * Convert ArrayBuffer to Base64
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert Base64 to ArrayBuffer
   */
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Generate secure random password for encryption
   */
  generateSecurePassword(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return this.arrayBufferToBase64(array.buffer);
  }

  /**
   * Hash sensitive data for comparison
   */
  async hashData(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    return this.arrayBufferToBase64(hashBuffer);
  }
}

export const securityManager = new SecurityManager();