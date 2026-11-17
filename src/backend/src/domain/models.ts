import type { Level, Rights } from './permissions.js';

export type AccountType = 'internal' | 'external';
export type User = { id: string; email: string; is_admin: boolean; account_type?: AccountType | null; is_active?: boolean; session_version?: number };
export type Folder = { id: string; name: string; parent_id: string | null; owner_id: string };
export type FileRecord = {
  id: string; name: string; folder_id: string; owner_id: string;
  object_key: string; content_type: string; size: string;
  created_at?: string | null; updated_at?: string | null; updated_by?: string | null; version?: number | null;
  created_by_email?: string | null; updated_by_email?: string | null;
  locked_by_email?: string | null;
};
export type FileVersion = { id: string; file_id: string; object_key: string; content_type: string; size: string; version: number | null; saved_at: string; saved_by: string | null; saved_by_email?: string | null };
export type ShareRights = { permission: Level; deleteFiles: boolean; deleteFolders: boolean; expiresAt?: string | null };
export type DirectShare = ShareRights & { id: string; folderId: string | null; fileId: string | null; name: string };
export type ShareInput = ShareRights & {
  userId: string; folderId?: string; fileId?: string;
};
export type Upload = { buffer: Buffer; contentType: string; size: number };
export type FolderWithRights = Folder & { rights: Rights };
