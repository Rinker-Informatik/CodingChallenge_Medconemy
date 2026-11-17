import type { Express, Request } from 'express';
import { z } from 'zod';
import type { OfficeSessions } from '../application/office.js';
import { route } from './middleware.js';

const sessionId = z.string().uuid();
const editorToken = (req: Request) => req.get('X-Office-Token')?.match(/^Bearer (.+)$/)?.[1];

export function mountEditorCallbacks(app: Express, editor: OfficeSessions) {
  app.get('/office/:id/source', route(async (req, res) => {
    const file = await editor.source(sessionId.parse(req.params.id), editorToken(req));
    res.set('Cache-Control', 'no-store').type(file.mime).send(file.data);
  }));
  app.post('/office/:id/callback', route(async (req, res) => {
    await editor.callback(sessionId.parse(req.params.id), editorToken(req));
    res.json({ error: 0 });
  }));
}

export function mountEditorActions(app: Express, editor: OfficeSessions) {
  app.post('/files/:id/editor', route(async (req, res) =>
    res.status(201).json(await editor.open(req.user, sessionId.parse(req.params.id)))));
  app.get('/editor/:id', route(async (req, res) =>
    res.set('Cache-Control', 'no-store').json(editor.status(req.user, sessionId.parse(req.params.id)))));
  app.post('/editor/:id/heartbeat', route(async (req, res) => { await editor.heartbeat(req.user, sessionId.parse(req.params.id)); res.status(204).end(); }));
  app.post('/editor/:id/close', route(async (req, res) => { await editor.close(req.user, sessionId.parse(req.params.id)); res.status(204).end(); }));
}
