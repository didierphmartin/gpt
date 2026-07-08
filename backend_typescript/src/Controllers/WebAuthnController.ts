import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { config } from '../config/env';
import { Ctx, ControllerResult } from '../Support/Http';

/**
 * Mirrors src/Controllers/WebAuthnController.php — passkey/biometric login.
 *
 * IMPORTANT faithful-mirror note: the PHP implementation does NO cryptographic verification.
 * register() stores the credential without verifying the attestation; authenticate() looks the
 * credential up and, if it exists and an authenticator_data + signature are present (i.e. the browser
 * ran the WebAuthn ceremony), issues a JWT — it does NOT verify the assertion signature against the
 * stored public key (the PHP has an explicit TODO for that). We replicate this trust-the-browser
 * behavior exactly; hardening it would diverge from PHP and belongs in the pre-prod list.
 *
 * challenge + authenticate are PUBLIC (login); register + delete require authentication.
 */
export class WebAuthnController {
  private static readonly CHALLENGE_EXPIRY = 120; // seconds
  private readonly jwtSecret = config.auth.jwtSecret;
  private readonly jwtExpiry = (config.auth as any).jwtExpiry ?? 28800;
  private readonly refreshExpiry = (config.auth as any).refreshExpiry ?? 604800;

  /** POST /api/v1/webauthn/challenge */
  async challenge(ctx: Ctx): Promise<ControllerResult> {
    const action = ctx.body?.action ?? '';
    let userId: number = 0;
    const credentialId = ctx.body?.credential_id ?? null;
    const email = ctx.body?.email ?? null;
    let allowCredentials: any[] = [];

    if (action === 'register') {
      if (ctx.user_id == null) {
        return { success: false, message: 'Authentication required', status_code: 401 };
      }
      userId = Number(ctx.user_id);
    }

    if (action === 'authenticate') {
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
        // Discoverable-credential flow — no specific user yet.
        userId = 0;
      }
    }

    // 32 random bytes, base64url (no padding) — matches PHP base64UrlEncode(random_bytes(32)).
    const challenge = crypto.randomBytes(32).toString('base64url');

    // Persist only when the user is known (matches PHP: discoverable/unbound challenges are skipped).
    if (userId !== 0) {
      await sql`
        INSERT INTO webauthn_challenges (challenge, user_id, action, created_at)
        VALUES (${challenge}, ${userId}, ${action}, NOW())
        ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), action = VALUES(action), created_at = NOW()`.execute(db);
    }

    const host = String(ctx.headers?.host ?? 'localhost');
    let rpId = (config as any).webauthn?.rp_id ?? host ?? 'localhost';
    rpId = String(rpId).replace(/:\d+$/, ''); // WebAuthn rp_id is a domain — strip the port
    const rpName = (config as any).webauthn?.rp_name ?? 'Voice Assistant';

    return { success: true, challenge, rp_id: rpId, rp_name: rpName, allow_credentials: allowCredentials, status_code: 200 };
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
    const credentialId = ctx.body?.credential_id ?? '';
    const authenticatorData = ctx.body?.authenticator_data ?? '';
    const signature = ctx.body?.signature ?? '';

    if (!credentialId || !signature) {
      return { success: false, message: 'Credential ID and signature are required', status_code: 400 };
    }

    const cred = (
      await sql<any>`
        SELECT u.id AS uid, u.email, u.first_name, u.last_name, u.role, u.plan, u.provider, u.created_at
        FROM webauthn_credentials wc JOIN users u ON wc.user_id = u.id
        WHERE wc.credential_id = ${credentialId}`.execute(db)
    ).rows[0];

    if (!cred) {
      return { success: false, message: 'Credential not found', code: 'CREDENTIAL_NOT_FOUND', status_code: 404 };
    }

    // No signature verification (mirrors PHP): only require the browser-produced fields to be present.
    if (!authenticatorData || !signature) {
      return { success: false, message: 'Invalid authentication data', status_code: 400 };
    }

    const userId = Number(cred.uid);
    const tokens = this.generateTokens(userId);
    await sql`UPDATE users SET last_login = NOW() WHERE id = ${userId}`.execute(db);
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

  /** PHP date('Y-m-d H:i:s') of now (server-local time), for the echoed last_login. */
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
