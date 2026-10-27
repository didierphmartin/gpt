import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { config } from '../config/env';
import { Ctx, ControllerResult } from '../Support/Http';
import { isServiceUser } from '../Services/RobotAccount';
import { Edition, EditionConfig } from '../Services/Edition';

/** PHP $config['webauthn']: rp_id, rp_name, and origins (list or comma-separated). */
export type WebAuthnConfig = { rp_id?: string; rp_name?: string; origins?: string[] | string };

/**
 * Mirrors src/Controllers/WebAuthnController.php — passkey/biometric login.
 *
 * authenticate() verifies the assertion before issuing a token: the single-use challenge bound to the
 * credential's user, the client data type and origin, the rpId hash, the user-present + user-verified
 * flags, and the signature against the stored public key (DER SubjectPublicKeyInfo, ES256 or RS256).
 *
 * challenge + authenticate are PUBLIC (login); register + delete require authentication.
 */
export class WebAuthnController {
  constructor(private readonly cfg: EditionConfig & { webauthn?: WebAuthnConfig } = config as any) {}

  private static readonly CHALLENGE_EXPIRY = 120; // seconds
  // authenticatorData flags: user present, user verified
  private static readonly FLAG_UP = 0x01;
  private static readonly FLAG_UV = 0x04;
  private readonly jwtSecret = config.auth.jwtSecret;
  private readonly jwtExpiry = (config.auth as any).jwtExpiry ?? 28800;
  private readonly refreshExpiry = (config.auth as any).refreshExpiry ?? 604800;

  /** POST /api/v1/webauthn/challenge */
  async challenge(ctx: Ctx): Promise<ControllerResult> {
    const action = ctx.body?.action ?? '';
    const credentialId = ctx.body?.credential_id ?? null;
    const email = ctx.body?.email ?? null;
    let allowCredentials: any[] = [];
    let userId: number;

    if (action === 'register') {
      // Registration requires a signed-in user.
      if (ctx.user_id == null) {
        return { success: false, message: 'Authentication required', status_code: 401 };
      }
      userId = Number(ctx.user_id);
    } else if (action === 'authenticate') {
      // Identify the user by credential_id (webapp flow) or email (Chrome-extension flow).
      // Credential ids are not secrets: authenticate() verifies the signature.
      if (credentialId) {
        const row = (await sql<{ user_id: number }>`SELECT user_id FROM webauthn_credentials WHERE credential_id = ${credentialId}`.execute(db)).rows[0];
        if (!row) {
          return { success: false, message: 'Credential not found', code: 'CREDENTIAL_NOT_FOUND', status_code: 404 };
        }
        userId = Number(row.user_id);
      } else if (email) {
        const user = (await sql<{ id: number }>`SELECT id FROM users WHERE email = ${email}`.execute(db)).rows[0];
        if (!user) {
          return { success: false, message: 'No account found for this email', code: 'USER_NOT_FOUND', status_code: 404 };
        }
        userId = Number(user.id);
        const rows = (await sql<{ credential_id: string }>`SELECT credential_id FROM webauthn_credentials WHERE user_id = ${userId}`.execute(db)).rows;
        if (rows.length === 0) {
          return {
            success: false,
            message: 'No passkey registered for this account. Sign in with email/password and enable biometric login first.',
            code: 'NO_CREDENTIALS',
            status_code: 404,
          };
        }
        allowCredentials = rows.map((r) => ({ id: r.credential_id, type: 'public-key', transports: ['internal'] }));
      } else {
        // Discoverable (no id, no email) sign-in would need a challenge bound to no user,
        // which webauthn_challenges cannot hold.
        return { success: false, message: 'Enter your email to sign in with a passkey.', code: 'EMAIL_REQUIRED', status_code: 400 };
      }
    } else {
      return { success: false, message: 'Unknown action', status_code: 400 };
    }

    // 32 random bytes, base64url (no padding) — matches PHP base64UrlEncode(random_bytes(32)).
    const challenge = crypto.randomBytes(32).toString('base64url');

    // Stored temporarily; authenticate() consumes it once.
    await sql`
      INSERT INTO webauthn_challenges (challenge, user_id, action, created_at)
      VALUES (${challenge}, ${userId}, ${action}, NOW())`.execute(db);

    const rpName = this.cfg.webauthn?.rp_name ?? 'Voice Assistant';
    return { success: true, challenge, rp_id: this.rpId(ctx), rp_name: rpName, allow_credentials: allowCredentials, status_code: 200 };
  }

  /** POST /api/v1/webauthn/register (protected) */
  async register(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? null;
    if (!userId) return { success: false, message: 'Authentication required', status_code: 401 };

    const credentialId = ctx.body?.credential_id ?? '';
    const publicKey = ctx.body?.public_key ?? '';
    if (!credentialId || !publicKey) {
      return { success: false, message: 'Credential ID and public key are required', status_code: 400 };
    }

    const existing = (await sql<{ id: number }>`SELECT id FROM webauthn_credentials WHERE credential_id = ${credentialId}`.execute(db)).rows[0];
    if (existing) return { success: false, message: 'Credential already registered', status_code: 409 };

    await sql`
      INSERT INTO webauthn_credentials (user_id, credential_id, public_key, created_at)
      VALUES (${Number(userId)}, ${credentialId}, ${publicKey}, NOW())`.execute(db);

    await this.cleanupChallenges();
    return { success: true, message: 'Credential registered successfully', status_code: 200 };
  }

  /** POST /api/v1/webauthn/authenticate (public — login) */
  async authenticate(ctx: Ctx): Promise<ControllerResult> {
    const refused = Edition.refuseLocalSignIn(this.cfg);
    if (refused) return refused;

    const credentialId = ctx.body?.credential_id ?? '';
    const clientDataJson = ctx.body?.client_data_json ?? '';
    const authenticatorData = ctx.body?.authenticator_data ?? '';
    const signature = ctx.body?.signature ?? '';

    const fields = [credentialId, clientDataJson, authenticatorData, signature];
    if (fields.some((f) => typeof f !== 'string' || f === '')) {
      return { success: false, message: 'Credential ID, client data, authenticator data and signature are required', status_code: 400 };
    }

    let cred = (
      await sql<any>`
        SELECT wc.public_key, u.id AS uid, u.email, u.first_name, u.last_name, u.kind, u.role, u.plan, u.provider, u.created_at
        FROM webauthn_credentials wc JOIN users u ON wc.user_id = u.id
        WHERE wc.credential_id = ${credentialId}`.execute(db)
    ).rows[0];

    // The robot is a service row: answer as for an unknown credential.
    if (cred && isServiceUser(cred)) cred = undefined;

    if (!cred) {
      return { success: false, message: 'Credential not found', code: 'CREDENTIAL_NOT_FOUND', status_code: 404 };
    }

    const userId = Number(cred.uid);
    const failure = await this.verifyAssertion(ctx, userId, String(cred.public_key ?? ''), clientDataJson, authenticatorData, signature);
    if (failure !== null) {
      console.error(`[WebAuthnController] Passkey sign-in refused: user_id=${userId}, reason=${failure}`);
      return { success: false, message: 'Passkey sign-in failed', status_code: 401 };
    }

    const tokens = this.generateTokens(userId);
    await sql`UPDATE users SET last_login = NOW() WHERE id = ${userId}`.execute(db);
    console.error(`[WebAuthnController] Biometric auth successful: user_id=${userId}`);
    await this.cleanupChallenges();

    return {
      success: true,
      message: 'Authentication successful',
      token: tokens.access_token,
      user: {
        id: String(userId),
        email: cred.email,
        first_name: cred.first_name,
        last_name: cred.last_name,
        role: cred.role ?? 'prospect',
        plan: cred.plan ?? 'free',
        provider: cred.provider ?? 'webauthn',
        last_login: this.phpDateNow(),
        created_at: cred.created_at ?? null,
      },
      status_code: 200,
    };
  }

  /** Verify a WebAuthn assertion. null when it holds, else the reason (for the log only). */
  private async verifyAssertion(
    ctx: Ctx, userId: number, publicKey: string, clientDataB64: string, authDataB64: string, signatureB64: string,
  ): Promise<string | null> {
    const clientData = WebAuthnController.base64UrlDecode(clientDataB64);
    const authData = WebAuthnController.base64UrlDecode(authDataB64);
    const signature = WebAuthnController.base64UrlDecode(signatureB64);
    if (!clientData || !authData || !signature) return 'undecodable base64url';

    let client: any;
    try {
      client = JSON.parse(clientData.toString('utf8'));
    } catch {
      return 'bad clientDataJSON';
    }
    if (!client || typeof client !== 'object' || typeof client.challenge !== 'string') return 'bad clientDataJSON';

    // The challenge is single use: consume it before any other check.
    if (!(await this.consumeChallenge(client.challenge, userId))) return 'unknown, expired or reused challenge';

    if (client.type !== 'webauthn.get') return 'clientDataJSON type is not webauthn.get';

    const rpId = this.rpId(ctx);
    if (!this.originAllowed(String(client.origin ?? ''), rpId)) return 'origin not allowed';

    // authenticatorData = rpIdHash (32) | flags (1) | signCount (4) | ...
    if (authData.length < 37) return 'authenticatorData too short';
    const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
    if (!crypto.timingSafeEqual(rpIdHash, authData.subarray(0, 32))) return 'rpIdHash mismatch';
    const flags = authData[32];
    if ((flags & WebAuthnController.FLAG_UP) === 0 || (flags & WebAuthnController.FLAG_UV) === 0) {
      return 'user presence or verification flag missing';
    }

    let key: crypto.KeyObject;
    try {
      const der = WebAuthnController.base64UrlDecode(publicKey);
      if (!der) return 'stored public key unreadable';
      key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    } catch {
      return 'stored public key unreadable';
    }

    const signed = Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]);
    let ok = false;
    try {
      ok = crypto.verify('sha256', signed, key, signature);
    } catch {
      ok = false;
    }
    return ok ? null : 'bad signature';
  }

  /**
   * Delete the challenge and tell whether it was a live sign-in challenge issued for this user.
   * Deleted whatever the answer, so it is single use.
   */
  private async consumeChallenge(challenge: string, userId: number): Promise<boolean> {
    const row = (
      await sql<{ user_id: number; action: string; age: number }>`
        SELECT user_id, action, UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(created_at) AS age
        FROM webauthn_challenges WHERE challenge = ${challenge}`.execute(db)
    ).rows[0];
    if (!row) return false;

    const res = await sql`DELETE FROM webauthn_challenges WHERE challenge = ${challenge}`.execute(db);
    if (Number(res.numAffectedRows ?? 0) !== 1) return false; // a concurrent request consumed it first

    const age = Number(row.age);
    return Number(row.user_id) === userId && row.action === 'authenticate' && age >= 0 && age <= WebAuthnController.CHALLENGE_EXPIRY;
  }

  /** Relying party id: config webauthn.rp_id, else the request host without port. */
  private rpId(ctx: Ctx): string {
    const host = String(ctx.headers?.host ?? 'localhost');
    const rpId = this.cfg.webauthn?.rp_id ?? host ?? 'localhost';
    return String(rpId).replace(/:\d+$/, ''); // WebAuthn rp_id is a domain — strip the port
  }

  /**
   * The assertion origin must be one of config webauthn.origins when set; otherwise its host must be
   * the rp id, over https (http only on localhost, as browsers allow). Any port.
   */
  private originAllowed(origin: string, rpId: string): boolean {
    let origins = this.cfg.webauthn?.origins;
    if (typeof origins === 'string') origins = origins.trim() === '' ? [] : origins.split(',').map((o) => o.trim());
    if (Array.isArray(origins) && origins.length > 0) {
      const strip = (o: string) => String(o).replace(/\/+$/, '');
      return origins.map(strip).includes(strip(origin));
    }

    // An origin is exactly scheme://host[:port]
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/:?#@\s]+)(?::(\d+))?$/i.exec(origin);
    if (!m) return false;
    const [, scheme, host] = m;
    if (host.toLowerCase() !== rpId.toLowerCase()) return false;
    return scheme === 'https' || (scheme === 'http' && ['localhost', '127.0.0.1'].includes(rpId));
  }

  /** Base64URL decode; null when not valid base64url (matches PHP base64_decode(..., true)). */
  private static base64UrlDecode(data: string): Buffer | null {
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(data)) return null;
    return Buffer.from(data, 'base64url');
  }

  /** DELETE /api/v1/webauthn/register (protected) */
  async delete(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? null;
    if (!userId) return { success: false, message: 'Authentication required', status_code: 401 };

    const credentialId = ctx.body?.credential_id ?? '';
    if (!credentialId) return { success: false, message: 'Credential ID is required', status_code: 400 };

    const res = await sql`DELETE FROM webauthn_credentials WHERE credential_id = ${credentialId} AND user_id = ${Number(userId)}`.execute(db);
    const deleted = Number(res.numAffectedRows ?? 0) > 0;

    return { success: true, message: deleted ? 'Credential deleted' : 'Credential not found or not owned by user', status_code: 200 };
  }

  private generateTokens(userId: number): { access_token: string; refresh_token: string } {
    const access_token = jwt.sign({ iss: 'gpt-chat', sub: userId, type: 'access' }, this.jwtSecret, { algorithm: 'HS256', expiresIn: this.jwtExpiry });
    const refresh_token = jwt.sign({ iss: 'gpt-chat', sub: userId, type: 'refresh' }, this.jwtSecret, { algorithm: 'HS256', expiresIn: this.refreshExpiry });
    return { access_token, refresh_token };
  }

  private phpDateNow(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  private async cleanupChallenges(): Promise<void> {
    try {
      await sql`DELETE FROM webauthn_challenges WHERE created_at < DATE_SUB(NOW(), INTERVAL ${WebAuthnController.CHALLENGE_EXPIRY} SECOND)`.execute(db);
    } catch {
      /* ignore cleanup errors (matches PHP) */
    }
  }
}
