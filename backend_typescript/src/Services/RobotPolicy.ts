import { config } from '../config/env';
import { Edition, EditionConfig } from './Edition';
import { PackageResolver, ResolvedPackage } from './PackageResolver';

/** What the policy reads about the user (PackageResolver; injectable for tests). */
export interface RoleSource {
  resolveRole(userId: number | null): Promise<string>;
  resolveForUser(userId: number | null): Promise<ResolvedPackage>;
}

/**
 * Mirrors src/Services/RobotPolicy.php. Who may use (publish to, read) and manage (unpublish from)
 * the robot: everyone on Individual; else "use" = the role's use_robot capability, "manage" = admin.
 */
export class RobotPolicy {
  constructor(private readonly cfg: EditionConfig = config, private readonly resolver: RoleSource = new PackageResolver()) {}

  async canUse(userId: number): Promise<boolean> {
    if (Edition.current(this.cfg) === 'individual') return true;
    return ((await this.resolver.resolveForUser(userId)).capabilities?.use_robot ?? false) === true;
  }

  async canManage(userId: number): Promise<boolean> {
    return Edition.current(this.cfg) === 'individual' || (await this.resolver.resolveRole(userId)) === 'admin';
  }
}
