import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { Account, Folder, StoredFile } from './workspace';

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);
  private token = typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem('medconemy.token') ?? '';

  hasToken() { return !!this.token; }

  setToken(token: string) {
    this.token = token;
    if (typeof sessionStorage !== 'undefined') {
      if (token) sessionStorage.setItem('medconemy.token', token);
      else sessionStorage.removeItem('medconemy.token');
    }
  }

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return firstValueFrom(this.http.request<T>(method, '/api' + path, {
      body, headers: this.token ? { Authorization: 'Bearer ' + this.token } : {},
    }));
  }

  async workspace() {
    const [folders, files] = await Promise.all([
      this.request<Folder[]>('GET', '/folders'), this.request<StoredFile[]>('GET', '/files'),
    ]);
    return { folders, files };
  }

  upload(method: 'POST' | 'PUT', path: string, file: File, lockToken?: string, conflict?: { keep?: boolean; replaceId?: string }) {
    const body = new FormData();
    body.append('file', file);
    return firstValueFrom(this.http.request(method, '/api' + path, { body, headers: {
      ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
      ...(lockToken ? { 'X-Edit-Lock': lockToken } : {}),
      ...(conflict?.keep ? { 'X-Upload-Keep': 'true' } : {}),
      ...(conflict?.replaceId ? { 'X-Upload-Replace': conflict.replaceId } : {}),
    } }));
  }

  download(file: StoredFile, versionId?: string) {
    const path = '/api/files/' + file.id + (versionId ? '/versions/' + versionId : '') + '/download';
    return firstValueFrom(this.http.get(path, {
      headers: { Authorization: 'Bearer ' + this.token }, responseType: 'blob',
    })).catch(async error => {
      if (error instanceof HttpErrorResponse && error.error instanceof Blob) {
        try {
          const body = JSON.parse(await error.error.text());
          throw new HttpErrorResponse({ error: body, status: error.status, statusText: error.statusText, url: error.url ?? undefined });
        } catch (parsed) {
          if (parsed instanceof HttpErrorResponse) throw parsed;
        }
      }
      throw error;
    });
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) return 'Der Server ist gerade nicht erreichbar.';
    if (typeof error.error?.error === 'string') return error.error.error;
    if (error.status === 401) return 'Bitte erneut anmelden.';
  }
  return 'Die Aktion konnte nicht abgeschlossen werden.';
}
