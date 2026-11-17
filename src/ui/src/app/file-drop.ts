import { HttpErrorResponse } from '@angular/common/http';
import { errorMessage } from './api';

export const MOVE_FILE_TYPE = 'application/x-medconemy-file';
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function dragKind(types: readonly string[]): 'external' | 'internal' | null {
  if (types.includes('Files')) return 'external';
  if (types.includes(MOVE_FILE_TYPE)) return 'internal';
  return null;
}

export function droppedFiles(transfer: DataTransfer) {
  const folders: string[] = [];
  const files: File[] = [];
  const items = Array.from(transfer.items).filter(item => item.kind === 'file');
  if (!items.length) return { files: Array.from(transfer.files), folders };
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) folders.push(entry.name);
    else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return { files, folders };
}

export async function uploadBatch(files: readonly File[], upload: (file: File) => Promise<unknown>) {
  let uploaded = 0;
  const failures: string[] = [];
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      failures.push(file.name + ' (größer als 10 MiB)');
      continue;
    }
    try {
      await upload(file);
      uploaded++;
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) throw error;
      failures.push(file.name + ' (' + errorMessage(error) + ')');
    }
  }
  return { uploaded, failures };
}
