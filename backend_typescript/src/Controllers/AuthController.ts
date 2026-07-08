import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { db } from '../db/pools';
import { config } from '../config/env';
import { Ctx, ControllerResult } from '../Support/Http';

/** Mirrors src/Controllers/AuthController.php (JWT, app-key, and Firebase helpers folded in). */
export class AuthController {
  // ---- helpers --------------------------------------------------------------

  private nowString(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  private normalizePlan(plan: unknown): string {
    let p = String(plan ?? '').toLowerCase().trim();
    const i = p.indexOf('_');
    if (i !== -1) p = p.slice(i + 1);
    return p === 'standard' || p === 'premium' ? p : 'free';
  }

  private roleForPlan(plan: string): string {
    return plan === 'free' ? 'prospect' : 'user';
  }

  private planRank(plan: unknown): number {
    return ({ free: 0, standard: 1, premium: 2 } as Record<string, number>)[this.normalizePlan(plan)] ?? 0;
  }

  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  private generateTokens(userId: number) {
    const secret = config.auth.jwtSecret;
    const access_token = jwt.sign({ iss: 'gpt-chat', sub: userId, type: 'access' }, secret, { algorithm: 'HS256', expiresIn: config.auth.jwtExpiry });
    const refresh_token = jwt.sign({ iss: 'gpt-chat', sub: userId, type: 'refresh' }, secret, { algorithm: 'HS256', expiresIn: config.auth.refreshExpiry });
    return { access_token, refresh_token, expires_in: config.auth.jwtExpiry };
  }

  private verifyJwt(token: string): { sub?: number | string } {
    return jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] }) as any;
  }

  private appKeyPepper(): string {
    const explicit = process.env.USER_APP_KEY_SECRET ?? '';
    if (explicit !== '') return explicit;
    return crypto.createHmac('sha256', config.auth.jwtSecret).update('user_app_key.v1').digest('hex');
  }

  private hashAppKey(fullKey: string): string {
    return crypto.createHmac('sha256', this.appKeyPepper()).update(fullKey).digest('hex');
  }

  private generateAppKeyMaterial(): { key: string; prefix: string; hash: string } {
    const rand = crypto.randomBytes(16).toString('hex');
    const key = 'uak_' + rand;
    return { key, prefix: key.slice(0, 12), hash: this.hashAppKey(key) };
  }

  private firebaseProjectId(): string {
    return config.firebase.projectId;
  }

  private certCache: { certs: Record<string, string>; fetchedAt: number } | null = null;

  private async googleSecureTokenCerts(): Promise<Record<string, string>> {
    if (this.certCache && Date.now() - this.certCache.fetchedAt < 3_600_000) return this.certCache.certs;
    const url = process.env.FIREBASE_CERTS_URL ?? 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`secure-token cert fetch failed: ${res.status}`);
    const certs = (await res.json()) as Record<string, string>;
    this.certCache = { certs, fetchedAt: Date.now() };
    return certs;
  }

  private async verifyFirebaseIdToken(idToken: string): Promise<any | null> {
    try {
      const decoded = jwt.decode(idToken, { complete: true });
      if (!decoded || typeof decoded === 'string') return null;
      const kid = decoded.header.kid;
      if (!kid || decoded.header.alg !== 'RS256') return null;
      const certs = await this.googleSecureTokenCerts();
      const cert = certs[kid];
      if (!cert) return null;
      const projectId = this.firebaseProjectId();
      const payload = jwt.verify(idToken, cert, {
        algorithms: ['RS256'],
        audience: projectId,
        issuer: 'https://securetoken.google.com/' + projectId,
      }) as any;
      if (!payload || typeof payload === 'string' || !payload.sub) return null;
      return payload;
    } catch (e: any) {
      console.error('[firebase] ID token verification failed:', e?.message ?? e);
      return null;
    }
  }

  // ---- endpoints ------------------------------------------------------------

  async login(ctx: Ctx): Promise<ControllerResult> {
    const { email, password } = ctx.body;
    if (!email || !password) return { status_code: 400, success: false, message: 'Email and password are required' };

    const lookup = String(email).trim().toLowerCase();
    const user = await db.selectFrom('users').selectAll().where('email', '=', lookup).executeTakeFirst();
    if (!user || !user.password) return { status_code: 401, success: false, message: 'Invalid email or password' };

    const ok = await bcrypt.compare(String(password), user.password.replace(/^\$2y\$/, '$2b$'));
    if (!ok) return { status_code: 401, success: false, message: 'Invalid email or password' };

    const last = this.nowString();
    await db.updateTable('users').set({ last_login: last }).where('id', '=', user.id).execute();
    const tokens = this.generateTokens(user.id);

    return {
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name,
          role: user.role ?? 'prospect', plan: user.plan ?? 'free', provider: user.provider ?? 'email',
          last_login: last, created_at: user.created_at ?? null,
          app_key_prefix: user.app_key_prefix ?? null, app_key_created_at: user.app_key_created_at ?? null,
        },
        access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in,
      },
    };
  }

  verify(ctx: Ctx): ControllerResult {
    const header = (ctx.headers['authorization'] ?? ctx.headers['Authorization']) as string | undefined;
    const m = header ? /Bearer\s+(.*)$/i.exec(header) : null;
    if (!m) return { status_code: 401, success: false, message: 'Authorization token required' };
    try {
      const decoded = this.verifyJwt(m[1]);
      return { success: true, message: 'Token is valid', data: { user_id: decoded.sub } };
    } catch {
      return { status_code: 401, success: false, message: 'Invalid or expired token' };
    }
  }

  logout(_ctx: Ctx): ControllerResult {
    return { success: true, message: 'Logout successful' };
  }

  async register(ctx: Ctx): Promise<ControllerResult> {
    const email = String(ctx.body.email ?? '').trim().toLowerCase();
    const password = ctx.body.password;
    const firstName = String(ctx.body.first_name ?? '').trim();
    const lastName = String(ctx.body.last_name ?? '').trim();
    const ledgerUserId = String(ctx.body.ledger_user_id ?? '').trim();

    if (!email || !password) return { status_code: 400, success: false, message: 'Email and password are required' };
    if (!this.isValidEmail(email)) return { status_code: 400, success: false, message: 'Invalid email format' };
    if (!ledgerUserId)
      return {
        status_code: 400, success: false,
        message: 'Registration requires a valid subscription. Please register through synergyaichat.com',
        code: 'LEDGER_ACCOUNT_REQUIRED',
      };

    const plan = this.normalizePlan(ctx.body.plan ?? 'free');
    const role = this.roleForPlan(plan);

    const existing = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
    if (existing) return { status_code: 409, success: false, message: 'Email already registered' };

    const hashed = await bcrypt.hash(String(password), 10);
    const res = await db
      .insertInto('users')
      .values({ email, password: hashed, first_name: firstName, last_name: lastName, role, ledger_user_id: ledgerUserId, plan, provider: 'email' } as any)
      .executeTakeFirst();

    const userId = Number(res.insertId);
    const now = this.nowString();
    const tokens = this.generateTokens(userId);

    return {
      success: true,
      message: 'Registration successful',
      data: {
        user: {
          id: userId, email, first_name: firstName, last_name: lastName, role, plan, provider: 'email',
          last_login: now, created_at: now, app_key_prefix: null, app_key_created_at: null,
        },
        access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in,
      },
    };
  }

  async linkPhone(ctx: Ctx): Promise<ControllerResult> {
    if (!ctx.user_id) return { status_code: 401, success: false, message: 'Authentication required' };
    const phone = ctx.body.phone_number;
    if (!phone) return { status_code: 400, success: false, message: 'Phone number is required' };

    const other = await db.selectFrom('users').select('id').where('phone', '=', phone).where('id', '!=', ctx.user_id).executeTakeFirst();
    if (other) return { status_code: 409, success: false, message: 'Phone number is already linked to another account' };

    await db.updateTable('users').set({ phone }).where('id', '=', ctx.user_id).execute();
    return { success: true, message: 'Phone number linked successfully' };
  }

  async unlinkPhone(ctx: Ctx): Promise<ControllerResult> {
    if (!ctx.user_id) return { status_code: 401, success: false, message: 'Authentication required' };
    await db.updateTable('users').set({ phone: null }).where('id', '=', ctx.user_id).execute();
    return { success: true, message: 'Phone number unlinked successfully' };
  }

  async upgradePlan(ctx: Ctx): Promise<ControllerResult> {
    if (!ctx.user_id) return { status_code: 401, success: false, message: 'Authentication required' };
    const plan = this.normalizePlan(ctx.body.plan);
    if (plan !== 'standard' && plan !== 'premium') return { status_code: 400, success: false, message: 'Invalid plan. Must be standard or premium.' };
    const role = this.roleForPlan(plan);
    await db.updateTable('users').set({ plan, role: role as any }).where('id', '=', ctx.user_id).execute();
    return { success: true, message: `Plan upgraded to ${plan}`, plan, role };
  }

  private requireJwt(ctx: Ctx): ControllerResult | null {
    if (!ctx.user_id || ctx.auth_type !== 'jwt') return { status_code: 401, success: false, message: 'Authentication required' };
    return null;
  }

  async generateAppKey(ctx: Ctx): Promise<ControllerResult> {
    const guard = this.requireJwt(ctx);
    if (guard) return guard;
    const { key, prefix, hash } = this.generateAppKeyMaterial();
    const now = this.nowString();
    await db.updateTable('users').set({ app_key_hash: hash, app_key_prefix: prefix, app_key_created_at: now }).where('id', '=', ctx.user_id!).execute();
    return {
      success: true,
      message: 'App key generated. Save it now — it will not be shown again.',
      data: { app_key: key, app_key_prefix: prefix, app_key_created_at: now },
    };
  }

  async revokeAppKey(ctx: Ctx): Promise<ControllerResult> {
    const guard = this.requireJwt(ctx);
    if (guard) return guard;
    await db.updateTable('users').set({ app_key_hash: null, app_key_prefix: null, app_key_created_at: null }).where('id', '=', ctx.user_id!).execute();
    return { success: true, message: 'App key revoked.' };
  }

  private async requireAdmin(ctx: Ctx): Promise<ControllerResult | null> {
    const guard = this.requireJwt(ctx);
    if (guard) return guard;
    const caller = await db.selectFrom('users').select('role').where('id', '=', ctx.user_id!).executeTakeFirst();
    if (!caller || caller.role !== 'admin') return { status_code: 403, success: false, message: 'Admin privileges required' };
    return null;
  }

  async adminGenerateAppKeyForUser(ctx: Ctx): Promise<ControllerResult> {
    const guard = await this.requireAdmin(ctx);
    if (guard) return guard;
    const targetUserId = parseInt(String(ctx.body.user_id ?? 0), 10) || 0;
    if (targetUserId <= 0) return { status_code: 400, success: false, message: 'user_id is required' };
    const target = await db.selectFrom('users').select('id').where('id', '=', targetUserId).executeTakeFirst();
    if (!target) return { status_code: 404, success: false, message: 'User not found' };
    const { key, prefix, hash } = this.generateAppKeyMaterial();
    const now = this.nowString();
    await db.updateTable('users').set({ app_key_hash: hash, app_key_prefix: prefix, app_key_created_at: now }).where('id', '=', targetUserId).execute();
    return {
      success: true,
      message: 'App key generated for user. Save it now — it will not be shown again.',
      data: { user_id: targetUserId, app_key: key, app_key_prefix: prefix, app_key_created_at: now },
    };
  }

  async adminRevokeAppKeyForUser(ctx: Ctx): Promise<ControllerResult> {
    const guard = await this.requireAdmin(ctx);
    if (guard) return guard;
    const targetUserId = parseInt(String(ctx.body.user_id ?? 0), 10) || 0;
    if (targetUserId <= 0) return { status_code: 400, success: false, message: 'user_id is required' };
    await db.updateTable('users').set({ app_key_hash: null, app_key_prefix: null, app_key_created_at: null }).where('id', '=', targetUserId).execute();
    return { success: true, message: 'App key revoked.', data: { user_id: targetUserId } };
  }

  /** POST /api/v1/auth/firebase — verifies the ID token, derives identity from verified claims. */
  async firebaseAuth(ctx: Ctx): Promise<ControllerResult> {
    const provider = ctx.body.provider ?? '';
    const idToken = ctx.body.idToken ?? '';
    const userData = ctx.body.userData ?? {};

    if (!idToken) return { status_code: 400, success: false, message: 'Invalid authentication data' };

    const claims = await this.verifyFirebaseIdToken(String(idToken));
    if (!claims) return { status_code: 401, success: false, message: 'Invalid or expired authentication token' };

    const verifiedEmail = claims.email ? String(claims.email).trim().toLowerCase() : '';
    const verifiedPhone = claims.phone_number ? String(claims.phone_number).trim() : '';
    const firebaseUid = String(claims.sub ?? '');
    const hasEmail = verifiedEmail !== '';
    const hasPhone = verifiedPhone !== '';
    if (!hasEmail && !hasPhone) return { status_code: 400, success: false, message: 'Invalid authentication data' };

    const email = hasEmail ? verifiedEmail : verifiedPhone.toLowerCase() + '@phone.auth';
    const phoneNumber: string | null = hasPhone ? verifiedPhone : null;
    const firstName = userData.first_name ?? '';
    const lastName = userData.last_name ?? '';

    const ledgerUserId = String(userData.ledger_user_id ?? ctx.body.ledger_user_id ?? '').trim();
    const plan = this.normalizePlan(userData.plan ?? ctx.body.plan ?? 'free');
    const role = this.roleForPlan(plan);

    const existing = await db
      .selectFrom('users')
      .selectAll()
      .where((eb) => {
        const ors = [eb('email', '=', email), eb('firebase_uid', '=', firebaseUid)];
        if (phoneNumber !== null) ors.push(eb('phone', '=', phoneNumber));
        return eb.or(ors);
      })
      .executeTakeFirst();

    let userId: number;
    let respUser: any;

    if (existing) {
      const newFirebaseUid = existing.firebase_uid ?? firebaseUid;
      const newPhone = existing.phone ?? phoneNumber;
      await db.updateTable('users').set({ last_login: this.nowString(), firebase_uid: newFirebaseUid, provider: provider as any, phone: newPhone }).where('id', '=', existing.id).execute();
      userId = existing.id;
      let rPlan = existing.plan ?? 'free';
      let rRole = existing.role ?? 'prospect';
      if (plan !== 'free' && (existing.role ?? '') !== 'admin' && this.planRank(plan) > this.planRank(existing.plan ?? 'free')) {
        await db.updateTable('users').set({ plan, role: role as any }).where('id', '=', existing.id).execute();
        rPlan = plan;
        rRole = role as any;
      }
      respUser = { ...existing, plan: rPlan, role: rRole };
    } else {
      if (!ledgerUserId)
        return {
          status_code: 400, success: false,
          message: 'Registration requires a valid subscription. Please register through synergyaichat.com',
          code: 'LEDGER_ACCOUNT_REQUIRED',
        };
      const ins = await db
        .insertInto('users')
        .values({ email, first_name: firstName, last_name: lastName, firebase_uid: firebaseUid, provider: provider as any, phone: phoneNumber, role: role as any, ledger_user_id: ledgerUserId, plan } as any)
        .executeTakeFirst();
      userId = Number(ins.insertId);
      respUser = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
    }

    const tokens = this.generateTokens(userId);
    return {
      success: true,
      message: 'Authentication successful',
      data: {
        user: {
          id: userId, email: respUser.email, first_name: respUser.first_name, last_name: respUser.last_name,
          role: respUser.role ?? 'prospect', plan: respUser.plan ?? 'free', provider: respUser.provider ?? 'firebase',
          last_login: this.nowString(), created_at: respUser.created_at ?? null,
          app_key_prefix: respUser.app_key_prefix ?? null, app_key_created_at: respUser.app_key_created_at ?? null,
        },
        access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in,
      },
    };
  }

  /** POST /api/v1/auth — legacy action dispatcher (gates protected actions centrally). */
  async handleAction(ctx: Ctx): Promise<ControllerResult> {
    const action = ctx.body?.action ?? '';
    const protectedActions = ['link_phone', 'unlink_phone', 'upgrade_plan', 'generate_app_key', 'revoke_app_key', 'admin_generate_app_key', 'admin_revoke_app_key'];
    if (protectedActions.includes(action) && !ctx.user_id) {
      return { status_code: 401, success: false, message: 'Authentication required' };
    }
    switch (action) {
      case 'login': return this.login(ctx);
      case 'register': return this.register(ctx);
      case 'firebase': return this.firebaseAuth(ctx);
      case 'verify': return this.verify(ctx);
      case 'logout': return this.logout(ctx);
      case 'link_phone': return this.linkPhone(ctx);
      case 'unlink_phone': return this.unlinkPhone(ctx);
      case 'upgrade_plan': return this.upgradePlan(ctx);
      case 'generate_app_key': return this.generateAppKey(ctx);
      case 'revoke_app_key': return this.revokeAppKey(ctx);
      case 'admin_generate_app_key': return this.adminGenerateAppKeyForUser(ctx);
      case 'admin_revoke_app_key': return this.adminRevokeAppKeyForUser(ctx);
      default: return { status_code: 400, success: false, message: 'Invalid action' };
    }
  }
}
