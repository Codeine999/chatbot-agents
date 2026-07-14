export const ADMIN_ROLES = ['dev', 'owner', 'admin'] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface AdminJwtPayload {
  sub: string;
  username: string;
  role: AdminRole;
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
  picture: string | null;
  role: AdminRole;
}

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && ADMIN_ROLES.includes(value as AdminRole);
}
