import { randomBytes } from 'node:crypto';
import type { Invitations } from '../application/invitations.js';
import type { Trash } from '../application/trash.js';
import type { Activity } from '../application/activity.js';
import type { OfficeSessions } from '../application/office.js';
import { mountEditorActions, mountEditorCallbacks } from './office.js';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAdmin } from '../application/authorization.js';
import type { AccountCommands } from '../application/commands/accounts.js';
import type { FolderCommands } from '../application/commands/folders.js';
import type { FileCommands } from '../application/commands/files.js';
import type { ShareCommands } from '../application/commands/shares.js';
import type { AccountQueries } from '../application/queries/accounts.js';
import type { FolderQueries } from '../application/queries/folders.js';
import type { FileQueries } from '../application/queries/files.js';
import { fail } from '../application/errors.js';
import { authentication, errorHandler, route } from './middleware.js';

const uuid = z.string().uuid();
const accountType = z.enum(['internal', 'external']);
const shareRights = z.object({
  permission: z.enum(['read', 'upload', 'write']),
  deleteFiles: z.boolean().default(false),
  deleteFolders: z.boolean().default(false),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});
const name = z.string().trim().min(1).max(255).refine(value => !/[\/\\\x00-\x1f]/.test(value));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const uploadedFile = (file: Express.Multer.File | undefined) => {
  if (!file) return fail(400, 'Datei fehlt');
  return { buffer: file.buffer, contentType: file.mimetype, size: file.size };
};

export function createApp(services: { accountCommands: AccountCommands; accountQueries: AccountQueries; folderCommands: FolderCommands; folderQueries: FolderQueries; fileCommands: FileCommands; fileQueries: FileQueries; shareCommands: ShareCommands; invitations?: Invitations; editor?: OfficeSessions; trash?: Trash; activity?: Activity }) {
  const { accountCommands, accountQueries, folderCommands, folderQueries, fileCommands, fileQueries, shareCommands } = services;
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.post('/auth/login', route(async (req, res) => {
    const input = z.object({ email: z.string().email(), password: z.string().max(256) }).parse(req.body);
    res.json(await accountCommands.signIn(input.email, input.password));
  }));
  if (services.invitations) app.post('/auth/accept-invitation', route(async (req, res) => {
    const input = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: z.string().min(12).max(72) }).parse(req.body);
    await services.invitations!.accept(input.token, input.password);
    res.status(204).end();
  }));
  if (services.editor) mountEditorCallbacks(app, services.editor);
  app.use(authentication(accountQueries));
  if (services.editor) mountEditorActions(app, services.editor);
  app.get('/features', route(async (_req, res) => res.json({ officeEditing: !!services.editor })));
  app.get('/me', route(async (req, res) => res.json(req.user)));
  if (services.activity) app.get('/activity', route(async (req, res) => res.json(await services.activity!.list(req.user))));
  if (services.trash) {
    app.get('/trash', route(async (req, res) => res.json(await services.trash!.list(req.user))));
    app.post('/trash/:id/restore', route(async (req, res) => { await services.trash!.restore(req.user, uuid.parse(req.params.id)); res.status(204).end(); }));
  }
  app.get('/users', route(async (req, res) => res.json(await accountQueries.listUsers(req.user))));
  app.get('/share-recipients', route(async (req, res) => res.json(await accountQueries.listShareRecipients(req.user))));
  if (services.invitations) app.post('/users/invite', route(async (req, res) => {
    requireAdmin(req.user);
    const input = z.object({ email: z.string().email().max(254), isAdmin: z.boolean().default(false), accountType: accountType.optional() }).parse(req.body);
    const account = await accountCommands.createUser(req.user, { ...input, password: randomBytes(32).toString('base64url') });
    const result = await services.invitations!.send(req.user, account.id);
    res.status(201).json({ ...account, ...result });
  }));
  app.post('/users', route(async (req, res) => {
    requireAdmin(req.user);
    const input = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(72), isAdmin: z.boolean().default(false), accountType: accountType.optional() }).parse(req.body);
    res.status(201).json(await accountCommands.createUser(req.user, input));
  }));
  if (services.invitations) app.post('/users/:id/invitation', route(async (req, res) => {
    res.json(await services.invitations!.send(req.user, uuid.parse(req.params.id), true));
  }));
  app.patch('/users/:id', route(async (req, res) => {
    requireAdmin(req.user);
    const { accountType: type } = z.object({ accountType }).parse(req.body);
    await accountCommands.classifyAccount(req.user, uuid.parse(req.params.id), type);
    res.status(204).end();
  }));
  app.post('/users/:id/admin', route(async (req, res) => {
    await accountCommands.promoteInternalUser(req.user, uuid.parse(req.params.id));
    res.status(204).end();
  }));
  app.patch('/users/:id/status', route(async (req, res) => {
    const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
    await accountCommands.setActive(req.user, uuid.parse(req.params.id), isActive);
    res.status(204).end();
  }));
  app.post('/users/:id/sessions/revoke', route(async (req, res) => {
    await accountCommands.revokeSessions(req.user, uuid.parse(req.params.id));
    res.status(204).end();
  }));
  app.get('/users/:id/shares', route(async (req, res) =>
    res.json(await accountQueries.listSharesForUser(req.user, uuid.parse(req.params.id)))));
  app.get('/folders', route(async (req, res) => res.json(await folderQueries.listVisibleFolders(req.user))));
  app.post('/folders', route(async (req, res) => {
    const input = z.object({ name, parentId: uuid.nullable().default(null) }).parse(req.body);
    res.status(201).json(await folderCommands.createFolder(req.user, input.name, input.parentId));
  }));
  app.delete('/folders/:id', route(async (req, res) => { await folderCommands.deleteFolderTree(req.user, uuid.parse(req.params.id)); res.status(204).end(); }));
  app.get('/files', route(async (req, res) => res.json(await fileQueries.listVisibleFiles(req.user))));
  app.post('/folders/:id/files', upload.single('file'), route(async (req, res) => {
    const input = uploadedFile(req.file);
    const keep = req.get('X-Upload-Keep');
    const replaceId = req.get('X-Upload-Replace');
    if ((keep && keep !== 'true') || (keep && replaceId)) fail(400, 'Ungültige Upload-Auswahl.');
    res.status(201).json(await fileCommands.uploadFile(req.user, uuid.parse(req.params.id), name.parse(req.file!.originalname), input,
      { keep: keep === 'true', replaceId: replaceId ? uuid.parse(replaceId) : undefined }));
  }));
  app.get('/files/:id/download', route(async (req, res) => {
    const file = await fileQueries.downloadFile(req.user, uuid.parse(req.params.id));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.send(file.data);
  }));
  app.get('/files/:id/versions', route(async (req, res) => res.json(await fileQueries.listVersions(req.user, uuid.parse(req.params.id)))));
  app.get('/files/:id/versions/:versionId/download', route(async (req, res) => {
    const version = await fileQueries.downloadVersion(req.user, uuid.parse(req.params.id), uuid.parse(req.params.versionId));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(version.name)}`);
    res.send(version.data);
  }));
  app.post('/files/:id/versions/:versionId/restore', route(async (req, res) => {
    await fileCommands.restoreVersion(req.user, uuid.parse(req.params.id), uuid.parse(req.params.versionId));
    res.status(204).end();
  }));
  app.post('/files/:id/edit-lock', route(async (req, res) => {
    res.status(201).json(await fileCommands.acquireEditLock(req.user, uuid.parse(req.params.id)));
  }));
  app.put('/files/:id/edit-lock', route(async (req, res) => {
    const { token } = z.object({ token: uuid }).parse(req.body);
    await fileCommands.renewEditLock(req.user, uuid.parse(req.params.id), token);
    res.status(204).end();
  }));
  app.delete('/files/:id/edit-lock', route(async (req, res) => {
    const { token } = z.object({ token: uuid }).parse(req.body);
    await fileCommands.releaseEditLock(req.user, uuid.parse(req.params.id), token);
    res.status(204).end();
  }));
  app.put('/files/:id/content', upload.single('file'), route(async (req, res) => {
    const input = uploadedFile(req.file);
    const token = req.header('X-Edit-Lock');
    await fileCommands.replaceFileContent(req.user, uuid.parse(req.params.id), input, undefined, token ? uuid.parse(token) : undefined);
    res.status(204).end();
  }));
  app.patch('/files/:id', route(async (req, res) => {
    const input = z.object({ name: name.optional(), folderId: uuid.optional(), copy: z.boolean().default(false) })
      .refine(value => value.name !== undefined || value.folderId !== undefined || value.copy).parse(req.body);
    const id = uuid.parse(req.params.id);
    const result = input.copy
      ? await fileCommands.copyFile(req.user, id, input)
      : await fileCommands.changeFileMetadata(req.user, id, input);
    res.json(result);
  }));
  app.delete('/files/:id', route(async (req, res) => { await fileCommands.deleteFile(req.user, uuid.parse(req.params.id)); res.status(204).end(); }));
  app.get('/folders/:id/shares', route(async (req, res) => res.json(await shareCommands.listObjectShares(req.user, { folderId: uuid.parse(req.params.id) }))));
  app.get('/files/:id/shares', route(async (req, res) => res.json(await shareCommands.listObjectShares(req.user, { fileId: uuid.parse(req.params.id) }))));
  app.post('/shares', route(async (req, res) => {
    const input = shareRights.extend({ userId: uuid, folderId: uuid.optional(), fileId: uuid.optional() })
      .refine(value => !!value.folderId !== !!value.fileId).parse(req.body);
    res.status(201).json(await shareCommands.grantShare(req.user, input));
  }));
  app.patch('/shares/:id', route(async (req, res) => {
    await shareCommands.changeShare(req.user, uuid.parse(req.params.id), shareRights.parse(req.body));
    res.status(204).end();
  }));
  app.delete('/shares/:id', route(async (req, res) => { await shareCommands.revokeShare(req.user, uuid.parse(req.params.id)); res.status(204).end(); }));
  app.use(errorHandler);
  return app;
}
