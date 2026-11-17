export interface Rights {
  read: boolean;
  upload: boolean;
  write: boolean;
  deleteFiles: boolean;
  deleteFolders: boolean;
}
export interface Account {
  id: string;
  email: string;
  is_admin: boolean;
  is_active?: boolean;
  account_type?: 'internal' | 'external' | null;
}
export interface DirectShare {
  id: string;
  folderId: string | null;
  fileId: string | null;
  name: string;
  permission: 'read' | 'upload' | 'write';
  deleteFiles: boolean;
  deleteFolders: boolean;
  expiresAt?: string | null;
}
export type ObjectShare = DirectShare & { userId: string; email: string };
export interface FileVersion { id: string; version: number | null; saved_at: string; saved_by_email?: string | null; size: string }
export interface Folder { id: string; name: string; parent_id: string | null; rights: Rights }
export interface StoredFile {
  id: string; name: string; folder_id: string | null; owner_id: string;
  content_type: string; size: string; rights: Rights;
  created_at?: string | null; updated_at?: string | null; version?: number | null;
  created_by_email?: string | null; updated_by_email?: string | null;
  locked_by_email?: string | null;
}

const fileTypes = [
  { key: 'word', label: 'Word', icon: 'lucideFileText', extensions: /^(docx?|docm|odt|rtf)$/, mime: /msword|wordprocessing|opendocument.text/ },
  { key: 'excel', label: 'Tabelle', icon: 'lucideFileSpreadsheet', extensions: /^(xlsx?|xlsm|csv|ods)$/, mime: /excel|spreadsheet|text\/csv/ },
  { key: 'slides', label: 'Präsentation', icon: 'lucidePresentation', extensions: /^(pptx?|pptm|odp)$/, mime: /powerpoint|presentation/ },
  { key: 'pdf', label: 'PDF', icon: 'lucideFileBadge', extensions: /^pdf$/, mime: /application\/pdf/ },
  { key: 'image', label: 'Bild', icon: 'lucideImage', extensions: /^(jpe?g|png|gif|webp|svg|heic|tiff?|avif|bmp)$/, mime: /^image\// },
  { key: 'archive', label: 'Archiv', icon: 'lucideArchive', extensions: /^(zip|7z|rar|gz|tar|bz2|xz)$/, mime: /zip|rar|tar/ },
  { key: 'audio', label: 'Audio', icon: 'lucideMusic', extensions: /^(mp3|wav|aac|flac)$/, mime: /^audio\// },
  { key: 'video', label: 'Video', icon: 'lucideVideo', extensions: /^(mp4|mov|webm|mkv)$/, mime: /^video\// },
];

export function fileType(file: Pick<StoredFile, 'name' | 'content_type'>) {
  const extension = file.name.includes('.') ? file.name.split('.').at(-1)!.toLowerCase() : '';
  return fileTypes.find(type => type.extensions.test(extension))
    ?? fileTypes.find(type => type.mime.test(file.content_type.toLowerCase()))
    ?? { key: 'generic', label: 'Datei', icon: 'lucideFile' };
}

export function breadcrumb(folders: Folder[], id: string | null): Folder[] {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const path: Folder[] = [];
  const visited = new Set<string>();
  while (id && !visited.has(id)) {
    const folder = byId.get(id);
    if (!folder) break;
    path.unshift(folder);
    visited.add(id);
    id = folder.parent_id;
  }
  return path;
}

export function visibleContents(folders: Folder[], files: StoredFile[], id: string | null) {
  const visibleIds = new Set(folders.map(folder => folder.id));
  return {
    folders: folders.filter(folder => id ? folder.parent_id === id : !folder.parent_id || !visibleIds.has(folder.parent_id)),
    files: files.filter(file => id ? file.folder_id === id : !file.folder_id || !visibleIds.has(file.folder_id)),
  };
}

export function searchWorkspace(folders: Folder[], files: StoredFile[], query: string, type: string, since: string, editor: string) {
  const normalized = query.trim().toLocaleLowerCase('de');
  const editorName = editor.trim().toLocaleLowerCase('de');
  const matchesName = (name: string) => name.toLocaleLowerCase('de').includes(normalized);
  const sinceTime = since ? new Date(since + 'T00:00:00').getTime() : null;
  return {
    folders: type || since || editorName ? [] : folders.filter(folder => matchesName(folder.name)),
    files: files.filter(file => matchesName(file.name)
      && (!type || fileType(file).key === type)
      && (!editorName || (file.updated_by_email ?? '').toLocaleLowerCase('de').includes(editorName))
      && (sinceTime === null || (!!file.updated_at && new Date(file.updated_at).getTime() >= sinceTime))),
  };
}

export function canMoveTo(file: StoredFile, folder: Folder): boolean {
  return file.rights.write && folder.rights.write && folder.id !== file.folder_id;
}

export function fileActions(file: StoredFile, user: Account, folders: Folder[]) {
  const own = file.owner_id === user.id;
  const writable = folders.some(folder => folder.rights.write);
  return {
    edit: file.rights.write || (own && file.rights.upload),
    move: folders.some(folder => canMoveTo(file, folder)),
    copy: file.rights.write && writable,
    delete: user.is_admin || file.rights.deleteFiles || (own && file.rights.write),
  };
}

export function formatSize(value: string): string {
  const bytes = Number(value);
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(amount) + ' ' + units[unit];
}

export function canOpenOffice(file: StoredFile, user: Account): boolean {
  return /\.(docx|xlsx)$/i.test(file.name) && (file.rights.write || (file.owner_id === user.id && file.rights.upload));
}

// IDs keep paths unambiguous even when folders have identical names.
export function folderUrl(folders: Folder[], id: string | null): string {
  const path = breadcrumb(folders, id);
  return path.length ? '/ordner/' + path.map(folder => encodeURIComponent(folder.id) + '/' + encodeURIComponent(folder.name)).join('/') : '/';
}

export function folderFromUrl(folders: Folder[], pathname: string): string | null | undefined {
  if (pathname === '/') return null;
  const parts = pathname.split('/').filter(Boolean);
  if (parts.shift() !== 'ordner' || !parts.length || parts.length % 2) return undefined;
  let parent: string | null = null;
  try {
    for (let i = 0; i < parts.length; i += 2) {
      const id = decodeURIComponent(parts[i]);
      const folder = folders.find(item => item.id === id);
      if (!folder || (parent !== null && folder.parent_id !== parent)) return undefined;
      if (parent === null && folder.parent_id && folders.some(item => item.id === folder.parent_id)) return undefined;
      parent = id;
    }
  } catch { return undefined; }
  return parent;
}

export function formatDate(value?: string | null): string {
  if (!value) return 'Nicht verfügbar';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Nicht verfügbar' : new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
