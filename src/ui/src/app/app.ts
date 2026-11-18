import { FitActionMenu } from './fit-action-menu';
import { OfficeEditor, type EditorSession } from './office-editor';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmCard } from '@spartan-ng/helm/card';
import { Component, computed, inject, signal, viewChild, ElementRef, DestroyRef } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArchive, lucideArrowDownToLine, lucideChevronRight, lucideFile, lucideFileBadge, lucideFiles, lucideFileSpreadsheet,
  lucideFileText, lucideInfo, lucideFolder, lucideFolderOpen, lucideFolderPlus, lucideImage, lucideLogOut, lucideMusic,
  lucidePresentation, lucideRefreshCw, lucideSearch, lucideUpload, lucideUsers, lucideVideo,
} from '@ng-icons/lucide';
import { Api, errorMessage } from './api';
import { ActionDialog, type Action } from './action-dialog';
import { dragKind, droppedFiles, uploadBatch, MOVE_FILE_TYPE, MAX_UPLOAD_BYTES } from './file-drop';
import { canMoveTo, canOpenOffice, breadcrumb, folderUrl, folderFromUrl, fileActions, fileType, formatSize, formatDate, visibleContents, searchWorkspace, type Account, type DirectShare, type ObjectShare, type FileVersion, type Folder, type StoredFile } from './workspace';

@Component({
  selector: 'app-root',
  imports: [NgIcon, ActionDialog, HlmButton, HlmCard, OfficeEditor, FitActionMenu],
  providers: [provideIcons({
    lucideArchive, lucideArrowDownToLine, lucideChevronRight, lucideFile, lucideFileBadge, lucideFiles, lucideFileSpreadsheet,
    lucideFileText, lucideInfo, lucideFolder, lucideFolderOpen, lucideFolderPlus, lucideImage, lucideLogOut, lucideMusic,
    lucidePresentation, lucideRefreshCw, lucideSearch, lucideUpload, lucideUsers, lucideVideo,
  })],
  templateUrl: './app.html',
  host: {
    '(window:dragover)': 'preventExternalNavigation($event)',
    '(window:drop)': 'preventExternalNavigation($event)',
    '(window:popstate)': 'restoreRoute()',
  },
})
export class App {
  private readonly api = inject(Api);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly conflictDialog = viewChild.required<ElementRef<HTMLDialogElement>>('conflictDialog');
  private conflictResolve?: (choice: 'rename' | 'replace' | 'keep' | 'cancel') => void;
  protected readonly uploadConflict = signal<{ name: string; candidates: StoredFile[] } | null>(null);
  protected readonly conflictName = signal('');
  protected readonly conflictTarget = signal('');
  protected readonly user = signal<Account | null>(null);
  protected readonly invitationToken = signal(location.pathname === '/passwort-setzen' ? new URLSearchParams(location.hash.slice(1)).get('token') ?? '' : '');
  protected readonly invitationPage = signal(location.pathname === '/passwort-setzen');
  protected readonly newPassword = signal('');
  protected readonly passwordConfirmation = signal('');
  protected readonly passwordLengthValid = computed(() => this.newPassword().length >= 12 && this.newPassword().length <= 72);
  protected readonly passwordsMatch = computed(() => !!this.passwordConfirmation() && this.newPassword() === this.passwordConfirmation());
  protected readonly restoring = signal(this.api.hasToken());
  protected readonly page = signal<'files' | 'accounts' | 'trash' | 'activity'>('files');
  protected readonly trash = signal<Array<{ id: string; name: string; kind: 'file' | 'folder'; deleted_at: string; expires_at: string }>>([]);
  protected readonly activity = signal<Array<{ id: string; object_name: string; action: string; actor_email: string | null; occurred_at: string }>>([]);

  constructor() {
    if (this.api.hasToken() && !this.invitationPage()) void this.restoreSession();
    const timer = setInterval(() => {
      if (!this.user() || this.busy() || this.action() || this.office()) return;
      const oldFolder = this.currentId();
      void this.reload().then(() => {
        if (oldFolder && !this.folders().some(folder => folder.id === oldFolder)) {
          this.notice.set('Der bisherige Ordner ist nicht mehr verfügbar. Deine Zugriffsrechte könnten geändert worden sein.');
        }
      }).catch(error => {
        if (error instanceof HttpErrorResponse && error.status === 401) {
          this.signOut();
          this.error.set('Die Sitzung ist abgelaufen. Bitte erneut anmelden.');
        }
      });
    }, 30_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  private async restoreSession() {
    try {
      await this.loadSession();
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) this.api.setToken('');
      this.error.set(errorMessage(error));
    } finally { this.restoring.set(false); }
  }

  private async loadSession() {
    const account = await this.api.request<Account>('GET', '/me');
    const features = await this.api.request<{ officeEditing: boolean }>('GET', '/features');
    await this.reload();
    this.officeEnabled.set(features.officeEditing);
    this.user.set(account);
    await this.restoreRoute();
  }
  protected readonly folders = signal<Folder[]>([]);
  protected readonly officeEnabled = signal(false);
  protected readonly office = signal<{ session: EditorSession; name: string } | null>(null);
  protected readonly canOpenOffice = canOpenOffice;
  protected readonly files = signal<StoredFile[]>([]);
  protected readonly users = signal<Account[]>([]);
  protected readonly managedShares = signal<DirectShare[]>([]);
  protected readonly objectShares = signal<ObjectShare[]>([]);
  protected readonly versions = signal<FileVersion[]>([]);
  protected readonly currentId = signal<string | null>(null);
  protected readonly search = signal('');
  protected readonly searchType = signal('');
  protected readonly searchSince = signal('');
  protected readonly searchEditor = signal('');
  protected readonly searching = computed(() => !!(this.search().trim() || this.searchType() || this.searchSince() || this.searchEditor().trim()));
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly action = signal<Action | null>(null);
  protected readonly dialogError = signal('');
  protected readonly dialogNotice = signal('');
  protected readonly uploadOver = signal(false);
  protected readonly moveTarget = signal<HTMLElement | null>(null);
  private readonly draggedFileId = signal<string | null>(null);
  private editLockTimer?: ReturnType<typeof setInterval>;
  protected readonly current = computed(() => this.folders().find(folder => folder.id === this.currentId()));
  protected readonly crumbs = computed(() => breadcrumb(this.folders(), this.currentId()));
  protected readonly tree = computed(() => this.folders().map(folder => {
    const path = breadcrumb(this.folders(), folder.id);
    return { folder, depth: path.length - 1, label: path.map(item => item.name).join(' / ') };
  }).sort((a, b) => a.label.localeCompare(b.label, 'de')));
  protected readonly writable = computed(() => this.tree().filter(item => item.folder.rights.write)
    .map(item => ({ ...item.folder, name: item.label })));
  protected readonly shareTargets = computed(() => {
    const folders = this.tree().map(({ folder, label }) => ({ id: folder.id, label }));
    const paths = new Map(folders.map(folder => [folder.id, folder.label]));
    const files = this.files().map(file => ({
      id: file.id, label: [paths.get(file.folder_id ?? ''), file.name].filter(Boolean).join(' / '),
    }));
    return { folders, files: files.sort((a, b) => a.label.localeCompare(b.label, 'de')) };
  });
  protected readonly listing = computed(() => {
    if (this.searching()) return searchWorkspace(this.folders(), this.files(), this.search(), this.searchType(), this.searchSince(), this.searchEditor());
    return visibleContents(this.folders(), this.files(), this.currentId());
  });
  protected readonly itemCount = computed(() => this.listing().folders.length + this.listing().files.length);
  protected readonly fileActions = fileActions;
  protected readonly fileType = fileType;
  protected readonly formatSize = formatSize;
  protected readonly formatDate = formatDate;
  protected filePath(file: StoredFile) {
    return breadcrumb(this.folders(), file.folder_id).map(folder => folder.name).join(' / ') || 'Übersicht';
  }

  private async reload() {
    const data = await this.api.workspace();
    this.folders.set(data.folders);
    this.files.set(data.files);
    if (this.currentId() && !this.current()) this.navigate(null);
  }

  private async run(work: () => Promise<void>, target = this.error) {
    if (this.busy()) return;
    this.busy.set(true);
    target.set('');
    this.notice.set('');
    try {
      await work();
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401 && this.user()) {
        this.signOut();
        this.error.set('Die Sitzung ist abgelaufen. Bitte erneut anmelden.');
      } else {
        target.set(errorMessage(error));
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected async setInvitationPassword(event: SubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    if (form.get('password') !== form.get('confirm')) { this.error.set('Die Passwörter stimmen nicht überein.'); return; }
    await this.run(async () => {
      await this.api.request('POST', '/auth/accept-invitation', { token: this.invitationToken(), password: form.get('password') });
      this.api.setToken('');
      this.user.set(null);
      this.invitationToken.set('');
      this.invitationPage.set(false);
      history.replaceState(null, '', '/');
      this.notice.set('Passwort festgelegt. Du kannst dich jetzt anmelden.');
    });
  }

  protected sendInvitation(account: Account) {
    return this.run(async () => {
      const result = await this.api.request<{ notified: boolean }>('POST', '/users/' + account.id + '/invitation');
      if (!result.notified) throw new HttpErrorResponse({ status: 502, error: { error: 'Der Link zum Zurücksetzen konnte nicht versendet werden. Bitte erneut versuchen.' } });
      this.notice.set('Link zum Zurücksetzen des Passworts an ' + account.email + ' gesendet.');
    });
  }

  protected promoteAccount(account: Account) {
    return this.run(async () => {
      await this.api.request('POST', '/users/' + account.id + '/admin');
      const updated = { ...account, is_admin: true };
      this.users.update(users => users.map(user => user.id === account.id ? updated : user));
      this.action.set({ kind: 'account-access', account: updated });
      this.dialogNotice.set('Konto ist jetzt Administrator.');
    }, this.dialogError);
  }
  protected changeAccountActive(account: Account) {
    const isActive = account.is_active === false;
    return this.run(async () => {
      await this.api.request('PATCH', '/users/' + account.id + '/status', { isActive });
      if (!isActive && this.user()?.id === account.id) {
        this.signOut();
        this.notice.set('Dein Konto wurde deaktiviert.');
        return;
      }
      const updated = { ...account, is_active: isActive };
      this.users.update(users => users.map(user => user.id === account.id ? updated : user));
      this.action.set({ kind: 'account-access', account: updated });
      this.dialogNotice.set(isActive ? 'Konto aktiviert.' : 'Konto deaktiviert und Sitzungen widerrufen.');
    }, this.dialogError);
  }
  protected revokeAccountSessions(account: Account) {
    return this.run(async () => {
      await this.api.request('POST', '/users/' + account.id + '/sessions/revoke');
      if (this.user()?.id === account.id) {
        this.signOut();
        this.notice.set('Deine Sitzungen wurden widerrufen.');
      } else this.dialogNotice.set('Sitzungen widerrufen.');
    }, this.dialogError);
  }

  protected async login(event: SubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    await this.run(async () => {
      const result = await this.api.request<{ token: string }>('POST', '/auth/login', {
        email: form.get('email'), password: form.get('password'),
      });
      this.api.setToken(result.token);
      try {
        await this.loadSession();
      } catch (error) {
        this.api.setToken('');
        throw error;
      }
    });
  }

  protected signOut() {
    this.closeAction(true);
    this.api.setToken('');
    this.user.set(null);
    this.office.set(null);
    this.folders.set([]);
    this.files.set([]);
    this.users.set([]);
    this.page.set('files');
    this.currentId.set(null);
    this.error.set('');
    this.notice.set('');
  }

  protected navigate(id: string | null) {
    this.page.set('files');
    const url = folderUrl(this.folders(), id);
    if (location.pathname !== url) history.pushState(null, '', url);
    this.setFolder(id);
  }

  protected async showAccounts() {
    if (!this.user()?.is_admin) return;
    await this.run(async () => {
      this.users.set(await this.api.request<Account[]>('GET', '/users'));
      this.page.set('accounts');
      if (location.pathname !== '/verwaltung/konten') history.pushState(null, '', '/verwaltung/konten');
    });
  }

  protected showTrash() {
    return this.run(async () => {
      this.trash.set(await this.api.request('GET', '/trash'));
      this.currentId.set(null);
      this.page.set('trash');
      history.pushState(null, '', '/papierkorb');
    });
  }
  protected showActivity() {
    return this.run(async () => {
      this.activity.set(await this.api.request('GET', '/activity'));
      this.currentId.set(null);
      this.page.set('activity');
      history.pushState(null, '', '/aktivitaet');
    });
  }
  protected restoreTrash(id: string) {
    return this.run(async () => {
      await this.api.request('POST', '/trash/' + id + '/restore');
      this.trash.set(await this.api.request('GET', '/trash'));
      await this.reload();
      this.notice.set('Element wiederhergestellt.');
    });
  }

  protected async restoreRoute() {
    if (!this.user()) return;
    if (location.pathname === '/aktivitaet') {
      this.activity.set(await this.api.request('GET', '/activity'));
      this.currentId.set(null);
      this.page.set('activity');
      return;
    }
    if (location.pathname === '/papierkorb') {
      this.trash.set(await this.api.request('GET', '/trash'));
      this.currentId.set(null);
      this.page.set('trash');
      return;
    }
    if (location.pathname === '/verwaltung/konten' && this.user()?.is_admin) {
      this.users.set(await this.api.request<Account[]>('GET', '/users'));
      this.page.set('accounts');
      return;
    }
    this.page.set('files');
    const id = folderFromUrl(this.folders(), location.pathname);
    if (id === undefined) {
      this.setFolder(null);
      this.error.set('Dieser Ordner ist nicht verfügbar.');
      return;
    }
    this.setFolder(id);
    const url = folderUrl(this.folders(), id);
    if (location.pathname !== url) history.replaceState(null, '', url);
  }

  private setFolder(id: string | null) {
    this.uploadOver.set(false);
    this.endFileDrag();
    this.currentId.set(id);
    this.search.set('');
    this.searchType.set('');
    this.searchSince.set('');
    this.searchEditor.set('');
  }

  protected preventExternalNavigation(event: DragEvent) {
    if (dragKind(event.dataTransfer?.types ?? []) === 'external') event.preventDefault();
  }

  protected dragOverWorkspace(event: DragEvent) {
    const transfer = event.dataTransfer;
    if (!transfer || dragKind(transfer.types) !== 'external') return;
    event.preventDefault();
    const allowed = !!this.current()?.rights.upload && !this.busy();
    transfer.dropEffect = allowed ? 'copy' : 'none';
    this.uploadOver.set(allowed);
  }

  protected leaveWorkspace(event: DragEvent) {
    if (!this.stillInside(event)) this.uploadOver.set(false);
  }

  protected dropOnWorkspace(event: DragEvent) {
    const transfer = event.dataTransfer;
    if (!transfer || dragKind(transfer.types) !== 'external') return;
    event.preventDefault();
    this.uploadOver.set(false);
    const folder = this.current();
    if (this.busy()) return;
    if (!folder?.rights.upload) {
      this.notice.set('');
      this.error.set(folder ? 'In diesem Ordner darfst du keine Dateien hochladen.' : 'Öffne zum Hochladen einen Ordner.');
      return;
    }

    const { files, folders } = droppedFiles(transfer);
    return this.run(async () => {
      const result = await uploadBatch(files, file => this.uploadTo(folder, file));
      if (result.uploaded) {
        this.notice.set(result.uploaded === 1 ? '1 Datei hochgeladen.' : result.uploaded + ' Dateien hochgeladen.');
        await this.reloadAfterChange();
      }
      const failures = [...result.failures, ...folders.map(name => name + ' (Ordner werden nicht hochgeladen)')];
      if (failures.length) {
        this.error.set([this.error(), 'Nicht hochgeladen: ' + failures.join(' · ')].filter(Boolean).join(' '));
      } else if (!result.uploaded) {
        this.error.set('Der Drop enthält keine lesbaren Dateien.');
      }
    });
  }

  protected startFileDrag(event: DragEvent, file: StoredFile) {
    const transfer = event.dataTransfer;
    if (!transfer || this.busy() || !this.folders().some(folder => canMoveTo(file, folder))) {
      event.preventDefault();
      return;
    }
    transfer.setData(MOVE_FILE_TYPE, file.id);
    transfer.effectAllowed = 'move';
    this.draggedFileId.set(file.id);
  }

  protected endFileDrag() {
    this.draggedFileId.set(null);
    this.moveTarget.set(null);
  }

  protected dragOverFolder(event: DragEvent, folder: Folder) {
    const transfer = event.dataTransfer;
    if (!transfer || dragKind(transfer.types) !== 'internal') return;
    event.preventDefault();
    const source = this.moveSource(folder);
    transfer.dropEffect = source ? 'move' : 'none';
    this.moveTarget.set(source ? event.currentTarget as HTMLElement : null);
  }

  protected leaveFolder(event: DragEvent) {
    if (this.moveTarget() === event.currentTarget && !this.stillInside(event)) this.moveTarget.set(null);
  }

  protected dropOnFolder(event: DragEvent, folder: Folder) {
    const transfer = event.dataTransfer;
    if (!transfer || dragKind(transfer.types) !== 'internal') return;
    event.preventDefault();
    const source = this.moveSource(folder);
    this.endFileDrag();
    if (!source || transfer.getData(MOVE_FILE_TYPE) !== source.id) return;
    return this.run(async () => {
      await this.changeFile(source, { folderId: folder.id });
      this.notice.set('Datei verschoben.');
      await this.reloadAfterChange();
    });
  }

  private moveSource(folder: Folder) {
    if (this.busy()) return undefined;
    const file = this.files().find(item => item.id === this.draggedFileId());
    return file && canMoveTo(file, folder) ? file : undefined;
  }

  private stillInside(event: DragEvent) {
    return event.relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(event.relatedTarget);
  }

  protected refresh() { return this.run(() => this.reload()); }

  protected openAction(action: Action) {
    return this.run(async () => {
      if (action.kind === 'accounts' && this.page() === 'accounts') { this.closeAction(); this.users.set(await this.api.request<Account[]>('GET', '/users')); return; }
      if (action.kind === 'accounts') {
        this.users.set(await this.api.request<Account[]>('GET', '/users'));
      }
      if (action.kind === 'share') {
        this.users.set(await this.api.request<Account[]>('GET', '/share-recipients'));
        this.objectShares.set(await this.api.request<ObjectShare[]>('GET', `/${action.isFolder ? 'folders' : 'files'}/${action.target.id}/shares`));
      }
      if (action.kind === 'account-access') await this.loadAccountShares(action.account.id);
      if (action.kind === 'versions') this.versions.set(await this.api.request<FileVersion[]>('GET', '/files/' + action.file.id + '/versions'));
      this.dialogError.set('');
      this.dialogNotice.set('');
      this.action.set(action);
      if (!this.dialog().nativeElement.open) this.dialog().nativeElement.showModal();
    }, this.action() ? this.dialogError : this.error);
  }

  private async loadAccountShares(id: string) {
    this.managedShares.set(await this.api.request<DirectShare[]>('GET', '/users/' + id + '/shares'));
  }
  protected restoreVersion(version: FileVersion) {
    const action = this.action();
    if (action?.kind !== 'versions' || !action.canRestore) return;
    return this.run(async () => {
      await this.api.request('POST', `/files/${action.file.id}/versions/${version.id}/restore`);
      this.versions.set(await this.api.request<FileVersion[]>('GET', '/files/' + action.file.id + '/versions'));
      await this.reloadAfterChange();
      this.dialogNotice.set('Version wiederhergestellt. Der vorherige Stand bleibt im Versionsverlauf.');
    }, this.dialogError);
  }
  protected downloadVersion(version: FileVersion) {
    const action = this.action();
    if (action?.kind !== 'versions') return;
    return this.run(async () => {
      await this.downloadFile(action.file, version.id);
    }, this.dialogError);
  }

  protected closeAction(force = false) {
    const action = this.action();
    const text = this.dialog().nativeElement.querySelector<HTMLTextAreaElement>('textarea[name=text]');
    if (!force && action?.kind === 'edit-text' && text && text.value !== action.text.replace(/\r\n?/g, '\n')
      && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
    if (action?.kind === 'edit-text') {
      clearInterval(this.editLockTimer);
      this.editLockTimer = undefined;
      void this.api.request('DELETE', '/files/' + action.file.id + '/edit-lock', { token: action.lockToken }).catch(() => {});
    }
    this.dialog().nativeElement.close();
    this.action.set(null);
  }

  protected async apply(form: FormData) {
    const action = this.action();
    if (!action) return;
    await this.run(async () => {
      this.dialogNotice.set('');
      const message = await this.execute(action, form);
      if ('account' in action) {
        const account = action.kind === 'account-access'
          ? { ...action.account, account_type: form.get('accountType') as Account['account_type'] }
          : action.account;
        try {
          await this.loadAccountShares(account.id);
          this.action.set({ kind: 'account-access', account });
          this.dialogNotice.set(message);
        } catch (error) {
          if (error instanceof HttpErrorResponse && error.status === 401) throw error;
          this.closeAction();
          this.notice.set(message);
          this.error.set('Die Freigabeliste konnte nicht aktualisiert werden.');
        }
      } else {
        this.closeAction(true);
        this.notice.set(message);
        await this.reloadAfterChange();
      }
    }, this.dialogError);
  }

  protected createAccount(form: FormData) {
    return this.run(async () => {
      const message = await this.execute({ kind: 'accounts' }, form);
      this.users.set(await this.api.request<Account[]>('GET', '/users'));
      this.notice.set(message);
    });
  }

  private async reloadAfterChange() {
    try {
      await this.reload();
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) throw error;
      this.error.set('Die Aktion wurde ausgeführt. Die Liste konnte nicht aktualisiert werden.');
    }
  }

  private async uploadTo(folder: Folder, file: File): Promise<unknown> {
    const path = '/folders/' + folder.id + '/files';
    try { return await this.api.upload('POST', path, file); }
    catch (error) {
      if (!(error instanceof HttpErrorResponse) || error.status !== 409 || error.error?.error !== 'Eine Datei mit diesem Namen existiert bereits.') throw error;
      await this.reload();
      const candidates = this.files().filter(item => item.folder_id === folder.id && item.name === file.name.trim());
      if (!candidates.length) return this.api.upload('POST', path, file);
      this.uploadConflict.set({ name: file.name, candidates });
      this.conflictName.set(file.name);
      this.conflictTarget.set(candidates.length === 1 ? candidates[0].id : '');
      this.conflictDialog().nativeElement.showModal();
      const choice = await new Promise<'rename' | 'replace' | 'keep' | 'cancel'>(resolve => { this.conflictResolve = resolve; });
      if (choice === 'cancel') throw new HttpErrorResponse({ status: 400, error: { error: 'Upload abgebrochen.' } });
      if (choice === 'keep') return this.api.upload('POST', path, file, undefined, { keep: true });
      if (choice === 'replace') return this.api.upload('POST', path, file, undefined, { replaceId: this.conflictTarget() });
      return this.uploadTo(folder, new File([file], this.conflictName().trim(), { type: file.type, lastModified: file.lastModified }));
    }
  }
  protected chooseUploadConflict(choice: 'rename' | 'replace' | 'keep' | 'cancel') {
    if (choice === 'rename' && !this.conflictName().trim()) return;
    if (choice === 'replace' && !this.conflictTarget()) return;
    this.conflictDialog().nativeElement.close();
    this.uploadConflict.set(null);
    const resolve = this.conflictResolve;
    this.conflictResolve = undefined;
    resolve?.(choice);
  }

  private changeFile(file: StoredFile, changes: { name?: string; folderId?: string; copy?: boolean }) {
    return this.api.request('PATCH', '/files/' + file.id, changes);
  }

  private async execute(action: Action, form: FormData): Promise<string> {
    const file = form.get('file') as File;
    if (file?.size > MAX_UPLOAD_BYTES) throw new HttpErrorResponse({ status: 400, error: { error: 'Die Datei ist größer als 10 MiB.' } });
    switch (action.kind) {
      case 'versions': return '';
      case 'folder':
        await this.api.request('POST', '/folders', { name: form.get('name'), parentId: action.parentId });
        return 'Ordner erstellt.';
      case 'upload':
        await this.uploadTo(action.folder, file);
        return 'Datei hochgeladen.';
      case 'edit-text': {
        const text = String(form.get('text') ?? '');
        const content = new File([text], action.file.name, { type: action.file.content_type || 'text/plain' });
        if (content.size > MAX_UPLOAD_BYTES) throw new HttpErrorResponse({ status: 400, error: { error: 'Die Datei ist größer als 10 MiB.' } });
        await this.api.upload('PUT', '/files/' + action.file.id + '/content', content, action.lockToken);
        return 'Datei gespeichert.';
      }
      case 'replace':
        await this.api.upload('PUT', '/files/' + action.file.id + '/content', file);
        return 'Dateiinhalt ersetzt.';
      case 'rename':
      case 'move':
      case 'copy':
        await this.changeFile(action.file, {
          name: String(form.get('name') ?? '') || undefined, folderId: String(form.get('folderId') ?? '') || undefined, copy: action.kind === 'copy',
        });
        return { rename: 'Datei umbenannt.', move: 'Datei verschoben.', copy: 'Datei kopiert.' }[action.kind];
      case 'delete':
        await this.api.request('DELETE', '/files/' + action.file.id);
        return 'Datei in den Papierkorb verschoben.';
      case 'delete-folder':
        await this.api.request('DELETE', '/folders/' + action.folder.id);
        return 'Ordner in den Papierkorb verschoben.';
      case 'accounts':
        const result = await this.api.request<{ notified: boolean }>('POST', '/users/invite', {
          email: form.get('email'), isAdmin: form.has('isAdmin'), accountType: form.get('accountType'),
        });
        return result.notified ? 'Konto angelegt und Einladung gesendet.' : 'Konto angelegt, aber die Einladung konnte nicht versendet werden. Bitte einen Link zum Zurücksetzen senden.';
      case 'account-access':
        await this.api.request('PATCH', '/users/' + action.account.id, { accountType: form.get('accountType') });
        if (this.user()?.id === action.account.id) {
          this.user.set({ ...action.account, account_type: form.get('accountType') as Account['account_type'] });
        }
        return 'Kontotyp gespeichert.';
      case 'account-share-edit':
        await this.api.request('PATCH', '/shares/' + action.share.id, this.shareRights(form));
        return 'Freigabe geändert.';
      case 'account-share-revoke':
        await this.api.request('DELETE', '/shares/' + action.share.id);
        return 'Freigabe widerrufen.';
      case 'object-share-edit':
        await this.api.request('PATCH', '/shares/' + action.share.id, this.shareRights(form));
        return 'Freigabe geändert.';
      case 'object-share-revoke':
        await this.api.request('DELETE', '/shares/' + action.share.id);
        return 'Freigabe widerrufen.';
      case 'account-grant': {
        const [kind, id] = String(form.get('target')).split(':');
        return this.grantShare(action.account.id, kind === 'folder', id, form);
      }
      case 'share':
        return this.grantShare(String(form.get('userId')), action.isFolder, action.target.id, form);
      case 'revoke':
        await this.api.request('DELETE', '/shares/' + encodeURIComponent(String(form.get('id')).trim()));
        return 'Freigabe widerrufen.';
    }
  }

  private shareRights(form: FormData) {
    const expiry = String(form.get('expiresAt') ?? '');
    return {
      permission: form.get('permission'), deleteFiles: form.has('deleteFiles'), deleteFolders: form.has('deleteFolders'),
      expiresAt: expiry ? new Date(expiry).toISOString() : null,
    };
  }

  private async grantShare(userId: string, isFolder: boolean, id: string, form: FormData) {
    const share = await this.api.request<{ id: string; notified: boolean | null }>('POST', '/shares', {
      userId, [isFolder ? 'folderId' : 'fileId']: id, ...this.shareRights(form),
    });
    return 'Freigabe erteilt. ID: ' + share.id + (share.notified === false ? ' · E-Mail-Versand fehlgeschlagen.' : '');
  }

  protected editText(file: StoredFile) {
    return this.run(async () => {
      const { token } = await this.api.request<{ token: string }>('POST', '/files/' + file.id + '/edit-lock');
      let text: string;
      try {
        const blob = await this.api.download(file);
        if (blob.size > MAX_UPLOAD_BYTES) throw new HttpErrorResponse({ status: 400, error: { error: 'Die Datei ist größer als 10 MiB.' } });
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await blob.arrayBuffer()); }
        catch { throw new HttpErrorResponse({ status: 400, error: { error: 'Die Datei ist kein gültiger UTF-8-Text.' } }); }
      } catch (error) {
        await this.api.request('DELETE', '/files/' + file.id + '/edit-lock', { token }).catch(() => {});
        throw error;
      }
      this.dialogError.set('');
      this.dialogNotice.set('');
      this.action.set({ kind: 'edit-text', file, text, lockToken: token });
      this.editLockTimer = setInterval(() => {
        void this.api.request('PUT', '/files/' + file.id + '/edit-lock', { token }).catch(() => {
          this.dialogError.set('Die Bearbeitungssperre konnte nicht erneuert werden. Bitte den Text sichern und die Datei erneut öffnen.');
        });
      }, 30_000);
      this.dialog().nativeElement.showModal();
    });
  }

  protected startOffice(file: StoredFile) {
    return this.run(async () => {
      const session = await this.api.request<EditorSession>('POST', '/files/' + file.id + '/editor');
      this.office.set({ session, name: file.name });
    });
  }

  protected closeOffice(message: string) {
    this.office.set(null);
    return this.run(async () => {
      this.notice.set(message);
      await this.reload();
    });
  }

  protected download(file: StoredFile) {
    return this.run(() => this.downloadFile(file));
  }

  private async downloadFile(file: StoredFile, versionId?: string) {
    const url = URL.createObjectURL(await this.api.download(file, versionId));
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
