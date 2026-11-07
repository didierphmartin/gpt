import { sql } from 'kysely';
import { config } from '../config/env';
import { db } from '../db/pools';
import { EditionConfig } from './Edition';
import { RobotAccount } from './RobotAccount';
import { RobotPolicy } from './RobotPolicy';

/** The 423 a locked (running robot) workflow answers to every edit (PHP WorkflowController::lockedResponse). */
export function lockedResponse(name: string): { success: false; error_code: 'locked'; error: string; status_code: 423 } {
  return { success: false, error_code: 'locked', error: `${name} is running as the robot. Unlock it first.`, status_code: 423 };
}

/**
 * Mirrors src/Services/RobotOwnership.php: a workflow owned by the robot is shared with every user who may use
 * the robot; its runs are the robot's.
 */
export class RobotOwnership {
  private robot: number | null = null;
  private robotLoaded = false;
  private readonly policy: RobotPolicy;

  constructor(cfg: EditionConfig = config, policy?: RobotPolicy) {
    this.policy = policy ?? new RobotPolicy(cfg);
  }

  async robotId(): Promise<number | null> {
    if (!this.robotLoaded) {
      this.robot = await RobotAccount.id();
      this.robotLoaded = true;
    }
    return this.robot;
  }

  /** The robot's id when the caller may use the robot, else null. */
  async robotFor(callerId: number): Promise<number | null> {
    return (await this.policy.canUse(callerId)) ? this.robotId() : null;
  }

  /** The robot rows a workflow owned by ownerId may link: the robot's when the owner is the robot or may use it, else null. */
  async linkRobotFor(ownerId: number): Promise<number | null> {
    return (await this.robotId()) === ownerId ? ownerId : this.robotFor(ownerId);
  }

  async isRobotOwned(workflowId: number): Promise<boolean> {
    const robot = await this.robotId();
    if (robot === null) return false;
    const r = await sql<any>`SELECT 1 AS one FROM agent_workflows WHERE id = ${workflowId} AND user_id = ${robot}`.execute(db);
    return r.rows.length > 0;
  }

  /** Who a run of this workflow executes as: the robot for a robot workflow the caller may use, else the caller. */
  async runAs(callerId: number, workflowId: number): Promise<number> {
    const robot = await this.robotFor(callerId);
    return robot !== null && (await this.isRobotOwned(workflowId)) ? robot : callerId;
  }

  /**
   * The workflow's name when the caller would run it as the robot (they may use the robot and it is robot-owned)
   * and it is locked, else null: a browser run door's refusal, checked only after access so it reveals nothing.
   */
  async lockedRunName(callerId: number, workflowId: number): Promise<string | null> {
    if ((await this.runAs(callerId, workflowId)) === callerId || !(await this.isLocked(workflowId))) return null;
    const r = await sql<any>`SELECT name FROM agent_workflows WHERE id = ${workflowId}`.execute(db);
    return String(r.rows[0]?.name ?? '');
  }

  /** Robot-owned and active: nobody edits it until it is unlocked. */
  async isLocked(workflowId: number): Promise<boolean> {
    if (!(await this.isRobotOwned(workflowId))) return false;
    const r = await sql<any>`SELECT 1 AS one FROM active_workflows WHERE workflow_id = ${workflowId}`.execute(db);
    return r.rows.length > 0;
  }
}
