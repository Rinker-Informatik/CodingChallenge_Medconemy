export type Level = 'read' | 'upload' | 'write';
export type Share = { permission: Level; delete_files: boolean; delete_folders: boolean };
export type Rights = {
  read: boolean;
  upload: boolean;
  write: boolean;
  deleteFiles: boolean;
  deleteFolders: boolean;
};

export function rights(admin: boolean, shares: Share[]): Rights {
  return {
    read: admin || shares.length > 0,
    upload: admin || shares.some(share => share.permission !== 'read'),
    write: admin || shares.some(share => share.permission === 'write'),
    deleteFiles: admin || shares.some(share => share.delete_files),
    deleteFolders: admin || shares.some(share => share.delete_folders),
  };
}

export function canReadFile(admin: boolean, owner: boolean, rights: Rights): boolean {
  return admin || owner || rights.read;
}

export function canEditFile(admin: boolean, owner: boolean, rights: Rights): boolean {
  return admin || rights.write || (owner && rights.upload);
}

export function canDeleteFile(admin: boolean, owner: boolean, rights: Rights): boolean {
  return admin || rights.deleteFiles || (owner && rights.write);
}

export function canDeleteTree(admin: boolean, folders: Rights[], files: { owner: boolean; rights: Rights }[]): boolean {
  return admin || (
    folders.every(folder => folder.deleteFolders) &&
    files.every(file => canDeleteFile(false, file.owner, file.rights))
  );
}
