import crypto from 'crypto';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { config } from '../config/env';
import { Ctx, ControllerResult } from '../Support/Http';
import { Edition, EditionConfig } from '../Services/Edition';

/**
 * Mirrors src/Controllers/WebAuthnController.php — passkey/biometric login.
 *
 * Passkey sign-in is off (PASSKEY_SIGNIN_OFF, 503) until assertions are verified; registering
 * and deleting passkeys still work.
 *
 * challenge + authenticate are PUBLIC (login); register + delete require authentication.
 */
export class WebAuthnController {
  constructor(private readonly editionCfg: EditionConfig = config) {}

  private static readonly CHALLENGE_EXPIRY = 120; // seconds

  /** POST /api/v1/webauthn/challenge */
  async challenge(ctx: Ctx): Promise<ControllerResult> {
    const action = ctx.body?.action ?? '';

    // Passkey sign-in is off until assertions are verified (see authenticate()).
    if (action !== 'register') return this.passkeySignInOff();

    // Registration requires a signed-in user.
    if (ctx.user_id == null) {
      return { success: false, message: 'Authentication required', status_code: 401 };
    }
    const userId = Number(ctx.user_id);

    // 32 random bytes, base64url (no padding) — matches PHP base64UrlEncode(random_bytes(32)).
    const challenge = crypto.randomBytes(32).toString('base64url');

    await sql`
      INSERT INTO webauthn_challenges (challenge, user_id, action, created_at)
      VALUES (${challenge}, ${userId}, ${action}, NOW())
      ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), action = VALUES(action), created_at = NOW()`.execute(db);

    const host = String(ctx.headers?.host ?? 'localhost');
    let rpId = (config as any).webauthn?.rp_id ?? host ?? 'localhost';
    rpId = String(rpId).replace(/:\d+$/, ''); // WebAuthn rp_id is a domain — strip the port
    const rpName = (config as any).webauthn?.rp_name ?? 'Voice Assistant';

    return { success: true, challenge, rp_id: rpId, rp_name: rpName, allow_credentials: [], status_code: 200 };
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
  async authenticate(_ctx: Ctx): Promise<ControllerResult> {
    const refused = Edition.refuseLocalSignIn(this.editionCfg);
    if (refused) return refused;
    return this.passkeySignInOff();
  }

  /**
   * Sign-in with a passkey stays off until authenticate() verifies the assertion: the stored
   * single-use challenge, origin, rpId hash, the signature against the stored public key, and the
   * sign counter. Without that, a credential id alone (handed out by challenge() for any email)
   * signed anyone in. Registering and deleting passkeys still work.
   */
  private passkeySignInOff(): ControllerResult {
    return {
      success: false,
      message: 'Passkey sign-in is turned off for now. Sign in with your email and password.',
      code: 'PASSKEY_SIGNIN_OFF',
      status_code: 503,
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

  private async cleanupChallenges(): Promise<void> {
    try {
      await sql`DELETE FROM webauthn_challenges WHERE created_at < DATE_SUB(NOW(), INTERVAL ${WebAuthnController.CHALLENGE_EXPIRY} SECOND)`.execute(db);
    } catch {
      /* ignore cleanup errors (matches PHP) */
    }
  }
}
