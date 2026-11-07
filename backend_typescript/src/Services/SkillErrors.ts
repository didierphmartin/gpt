/**
 * The skill store's errors (PHP SkillNotFound, SkillForbidden, SkillPathInvalid, SkillClashException, SkillInUse,
 * SkillRequiredBy, PrivateSkillsRefused); statusCode() is the HTTP status the API answers with.
 */
export class SkillNotFound extends Error {
  statusCode(): number {
    return 404;
  }
}

export class SkillForbidden extends Error {
  statusCode(): number {
    return 403;
  }
}

export class SkillPathInvalid extends Error {
  statusCode(): number {
    return 400;
  }
}

export class SkillClashException extends Error {
  statusCode(): number {
    return 409;
  }
}

/** A public skill the robot's workflows bind cannot be made private, renamed or deleted; carries those workflows. */
export class SkillInUse extends Error {
  constructor(private readonly robotWorkflows: Array<{ id: number; name: string }>) {
    super('A workflow of the robot uses this skill.');
  }

  workflows(): Array<{ id: number; name: string }> {
    return this.robotWorkflows;
  }

  statusCode(): number {
    return 409;
  }
}

/**
 * A skill other skills need (their required skills, LangGraphPackage.requiredSkills) cannot be deleted, renamed or
 * made private; a skill cannot be made public with a required skill the caller cannot make public. 409.
 * reason: delete | rename | private | public | changed; requiredBy: the dependent skills the caller can see; needs:
 * (public) the required skill that blocks it.
 */
export class SkillRequiredBy extends Error {
  constructor(message: string, private readonly reason: string, private readonly skill: string,
    private readonly requiredBy: string[] = [], private readonly needs: string = '') {
    super(message);
  }

  data(): Record<string, any> {
    return {
      message: this.message, reason: this.reason, skill: this.skill, required_by: this.requiredBy,
      ...(this.needs !== '' ? { needs: this.needs } : {}),
    };
  }

  statusCode(): number {
    return 409;
  }
}

export type PrivateSkill = { path: string; owner_id: number; owner_name: string; missing?: true };

/** The robot can only use public skills (RobotSkillPolicy.MESSAGE). */
export const PRIVATE_SKILLS_MESSAGE = 'This workflow uses private skills. The robot can only use public skills.';

/** A robot workflow binds private skills; the robot can only use public ones. Answer with RobotSkillPolicy.refusal(). */
export class PrivateSkillsRefused extends Error {
  constructor(public readonly skills: PrivateSkill[]) {
    super(PRIVATE_SKILLS_MESSAGE);
  }
}
