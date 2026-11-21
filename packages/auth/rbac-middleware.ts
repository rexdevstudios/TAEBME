import { Role } from '../shared/types/domain';

export type Capability =
  | 'VIEW_TOKENS'
  | 'CONNECT_WALLET'
  | 'CREATE_LAUNCH_DRAFT'
  | 'PUBLISH_LAUNCH'
  | 'GRADUATE_LAUNCH'
  | 'TRADE_MANUALLY'
  | 'ENABLE_LIVE_AGENT'
  | 'REVIEW_FLAGGED_TOKEN'
  | 'FREEZE_TOKEN'
  | 'MANAGE_BILLING_PLANS'
  | 'OVERRIDE_RISK_ENGINE'
  | 'SETTLE_BOUNTY_CLAIM'
  // B3.2: Merkle snapshot lifecycle management (draft, finalize, publish-intent).
  // Restricted to SUPER_ADMIN and LAUNCH_ADMIN — does NOT grant on-chain signing authority.
  | 'MANAGE_SNAPSHOTS';

const RBAC_MATRIX: Record<Capability, Role[]> = {
  VIEW_TOKENS: [
    'SUPER_ADMIN', 'SYSTEM_ADMIN', 'RISK_ADMIN', 'LAUNCH_ADMIN',
    'BILLING_ADMIN', 'MODERATOR', 'TRADER', 'CREATOR'
  ],
  CONNECT_WALLET: [
    'SUPER_ADMIN', 'SYSTEM_ADMIN', 'RISK_ADMIN', 'LAUNCH_ADMIN',
    'BILLING_ADMIN', 'MODERATOR', 'TRADER', 'CREATOR'
  ],
  CREATE_LAUNCH_DRAFT: ['SUPER_ADMIN', 'LAUNCH_ADMIN', 'CREATOR', 'TRADER'],
  PUBLISH_LAUNCH: ['SUPER_ADMIN', 'LAUNCH_ADMIN', 'CREATOR'],
  GRADUATE_LAUNCH: ['SUPER_ADMIN', 'LAUNCH_ADMIN'],
  TRADE_MANUALLY: ['SUPER_ADMIN', 'TRADER', 'CREATOR'],
  ENABLE_LIVE_AGENT: ['SUPER_ADMIN', 'TRADER'],
  REVIEW_FLAGGED_TOKEN: ['SUPER_ADMIN', 'MODERATOR', 'RISK_ADMIN'],
  FREEZE_TOKEN: ['SUPER_ADMIN', 'MODERATOR', 'RISK_ADMIN'],
  MANAGE_BILLING_PLANS: ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'BILLING_ADMIN'],
  OVERRIDE_RISK_ENGINE: ['SUPER_ADMIN'], // Requires Dual Control Break-Glass!
  SETTLE_BOUNTY_CLAIM: ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'TRADER', 'CREATOR'],
  // B3.2: Snapshot lifecycle — draft creation, finalization, and publication intent.
  // Does NOT grant key signing or on-chain broadcasting authority.
  MANAGE_SNAPSHOTS: ['SUPER_ADMIN', 'LAUNCH_ADMIN'],
};

export interface UserContext {
  userId: string;
  roles: Role[];
  status: 'ACTIVE' | 'SUSPENDED' | 'FROZEN';
}

export class RbacGuard {
  /**
   * Memeriksa apakah user memiliki peran yang diizinkan untuk kapabilitas tertentu.
   */
  static authorize(user: UserContext, capability: Capability): void {
    if (user.status !== 'ACTIVE') {
      throw new Error(`AUTH_ACCOUNT_${user.status}: User account is ${user.status}. Access denied.`);
    }

    const allowedRoles = RBAC_MATRIX[capability];
    if (!allowedRoles) {
      throw new Error(`RBAC_UNKNOWN_CAPABILITY: Capability ${capability} is not defined in RBAC Matrix.`);
    }

    const hasPermission = user.roles.some((role) => allowedRoles.includes(role));

    if (!hasPermission) {
      throw new Error(
        `RBAC_FORBIDDEN: User ${user.userId} with roles [${user.roles.join(', ')}] lacks capability ${capability}`
      );
    }
  }

  /**
   * Mengembalikan seluruh kapabilitas yang dimiliki kombinasi roles user (SSOT dari RBAC_MATRIX).
   */
  static getCapabilitiesForRoles(roles: Role[]): Capability[] {
    if (!Array.isArray(roles) || roles.length === 0) return [];
    const caps: Capability[] = [];
    for (const [cap, allowedRoles] of Object.entries(RBAC_MATRIX) as Array<[Capability, Role[]]>) {
      if (roles.some((r) => allowedRoles.includes(r))) {
        caps.push(cap);
      }
    }
    return caps;
  }

  /**
   * Memeriksa apakah suatu aksi membutuhkan Dual-Control (Multi-Admin approval)
   */
  static requiresDualControl(capability: Capability): boolean {
    return capability === 'OVERRIDE_RISK_ENGINE' || capability === 'MANAGE_BILLING_PLANS';
  }
}
