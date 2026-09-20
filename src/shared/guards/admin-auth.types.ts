export const ADMIN_ROLES = ['dev', 'owner', 'admin'] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface AdminJwtPayload {
  sub: string;
  username: string;
  role: AdminRole;
  /**
   * The company this admin administers, carried for traceability only.
   * Authorization reads the value back from the database on every request, so
   * a token minted before a company move can never widen the caller's scope.
   */
  companyId: string | null;
  tokenType: 'admin';
  iat: number;
  exp: number;
}

export interface AuthenticatedAdmin {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  image: string | null;
  role: AdminRole;
  /** Tenant scope for every company-owned query. Null is the legacy scope. */
  companyId: string | null;
}

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && ADMIN_ROLES.includes(value as AdminRole);
}
