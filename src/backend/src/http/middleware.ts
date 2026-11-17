import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import type { User } from '../domain/models.js';
import { AppError } from '../application/errors.js';
import type { AccountQueries } from '../application/queries/accounts.js';

export type AuthenticatedRequest = Request & { user: User };
export const route = (handler: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { Promise.resolve(handler(req as AuthenticatedRequest, res)).catch(next); };

export function authentication(accounts: AccountQueries) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    accounts.authenticateToken(token).then(user => { (req as AuthenticatedRequest).user = user; next(); }).catch(next);
  };
}
export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) return res.status(400).json({ error: 'Ungültige Eingabe', details: error.flatten() });
  if (error instanceof AppError) return res.status(error.status).json({ error: error.message });
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.message });
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return res.status(409).json({ error: 'Eintrag existiert bereits' });
  console.error(error);
  return res.status(500).json({ error: 'Interner Fehler' });
}
