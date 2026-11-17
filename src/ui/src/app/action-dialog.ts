import { HlmButton } from '@spartan-ng/helm/button';
import { Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { Account, DirectShare, Folder, StoredFile, ObjectShare, FileVersion } from './workspace';

export type Action =
  | { kind: 'folder'; parentId: string | null }
  | { kind: 'upload'; folder: Folder }
  | { kind: 'rename' | 'replace' | 'move' | 'copy' | 'delete'; file: StoredFile }
  | { kind: 'edit-text'; file: StoredFile; text: string; lockToken: string }
  | { kind: 'versions'; file: StoredFile; canRestore: boolean }
  | { kind: 'delete-folder'; folder: Folder }
  | { kind: 'share'; target: Folder | StoredFile; isFolder: boolean }
  | { kind: 'object-share-edit' | 'object-share-revoke'; target: Folder | StoredFile; isFolder: boolean; share: ObjectShare }
  | { kind: 'accounts' | 'revoke' }
  | { kind: 'account-access' | 'account-grant'; account: Account }
  | { kind: 'account-share-edit' | 'account-share-revoke'; account: Account; share: DirectShare };

const titles: Record<Action['kind'], string> = {
  folder: 'Ordner erstellen', upload: 'Datei hochladen', rename: 'Datei umbenennen',
  replace: 'Dateiinhalt ersetzen', 'edit-text': 'Textdatei bearbeiten', move: 'Datei verschieben', copy: 'Datei kopieren',
  delete: 'Datei löschen', 'delete-folder': 'Ordner löschen', share: 'Freigabe erteilen',
  accounts: 'Konten verwalten', revoke: 'Freigabe widerrufen',
  'account-access': 'Kontotyp und Freigaben', 'account-grant': 'Freigabe hinzufügen',
  'account-share-edit': 'Freigabe ändern', 'account-share-revoke': 'Freigabe widerrufen',
  'object-share-edit': 'Freigabe ändern', 'object-share-revoke': 'Freigabe widerrufen',
  versions: 'Versionsverlauf',
};

@Component({
  selector: 'app-action-dialog',
  imports: [HlmButton, NgTemplateOutlet],
  templateUrl: './action-dialog.html',
})
export class ActionDialog {
  readonly action = input.required<Action>();
  readonly users = input<Account[]>([]);
  readonly folders = input<Folder[]>([]);
  readonly shares = input<DirectShare[]>([]);
  readonly objectShares = input<ObjectShare[]>([]);
  readonly versions = input<FileVersion[]>([]);
  readonly targets = input<{ folders: { id: string; label: string }[]; files: { id: string; label: string }[] }>({ folders: [], files: [] });
  readonly changeView = output<Action>();
  readonly invite = output<Account>();
  readonly promote = output<Account>();
  readonly changeActive = output<Account>();
  readonly revokeSessions = output<Account>();
  readonly restoreVersion = output<FileVersion>();
  readonly downloadVersion = output<FileVersion>();
  protected readonly formatDate = (value: string) => new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  protected readonly targetNames = computed(() => new Map(
    [...this.targets().folders, ...this.targets().files].map(target => [target.id, target.label]),
  ));
  protected readonly accountType = linkedSignal<string>(() => {
    const action = this.action();
    return action.kind === 'account-access' ? action.account.account_type ?? '' : '';
  });
  protected readonly chosenFolder = signal(false);
  protected readonly selectedPermission = linkedSignal(() => {
    const action = this.action();
    return action.kind === 'account-share-edit' || action.kind === 'object-share-edit' ? action.share.permission : 'read';
  });
  protected readonly selectedDeleteFiles = linkedSignal(() => {
    const action = this.action();
    return action.kind === 'account-share-edit' || action.kind === 'object-share-edit' ? action.share.deleteFiles : false;
  });
  protected readonly selectedDeleteFolders = linkedSignal(() => {
    const action = this.action();
    return action.kind === 'account-share-edit' || action.kind === 'object-share-edit' ? action.share.deleteFolders : false;
  });
  protected readonly selectedExpiry = linkedSignal(() => {
    const action = this.action();
    const value = action.kind === 'account-share-edit' || action.kind === 'object-share-edit' ? action.share.expiresAt : null;
    if (!value) return '';
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  protected readonly accountTypes = { internal: 'Intern', external: 'Extern' };
  protected readonly permissions = { read: 'Lesen', upload: 'Hochladen und eigene Dateien bearbeiten', write: 'Schreiben' };
  readonly busy = input(false);
  readonly error = input('');
  readonly notice = input('');
  protected hasObjectShare(id: string) { return this.objectShares().some(share => share.userId === id); }
  readonly close = output<void>();
  readonly submitAction = output<FormData>();
  protected readonly titles = titles;

  protected submit(event: SubmitEvent) {
    event.preventDefault();
    if (!this.busy()) this.submitAction.emit(new FormData(event.target as HTMLFormElement));
  }
}
