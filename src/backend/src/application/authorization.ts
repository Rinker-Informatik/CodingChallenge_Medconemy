import type { User } from '../domain/models.js';
import { fail } from './errors.js';

export function requireAdmin(user: User): void {
  if (!user.is_admin) fail(403, 'Administrator erforderlich');
}
