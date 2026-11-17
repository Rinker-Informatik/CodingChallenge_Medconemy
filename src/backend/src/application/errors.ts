export class AppError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function fail(status: number, message: string): never {
  throw new AppError(status, message);
}

export function requirePermission(allowed: boolean): void {
  if (!allowed) fail(403, 'Keine Berechtigung');
}
