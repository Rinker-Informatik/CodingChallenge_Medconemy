import { Component, DestroyRef, inject, input, output, signal, afterNextRender } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { Api, errorMessage } from './api';

export interface EditorSession {
  id: string;
  apiScript: string;
  config: object;
}
interface DocsApi {
  DocEditor: new (id: string, config: object) => { destroyEditor(): void };
}
type State = { status: 'editing' | 'saving' | 'saved' | 'unchanged' | 'failed'; message?: string };
const browser = window as Window & { DocsAPI?: DocsApi };

function loadEditor(src: string): Promise<DocsApi> {
  if (browser.DocsAPI) return Promise.resolve(browser.DocsAPI);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => finish(false), 15_000);
    function finish(loaded: boolean) {
      clearTimeout(timer);
      if (loaded && browser.DocsAPI) {
        // Docs uses its script tag to resolve the iframe and assets when a session opens.
        resolve(browser.DocsAPI);
      } else {
        script.remove();
        reject(new Error('Editor konnte nicht geladen werden.'));
      }
    }
    script.src = src;
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    document.head.append(script);
  });
}

@Component({
  selector: 'app-office-editor',
  imports: [HlmButton],
  template: `
    <section class="office-editor" aria-label="Office-Editor">
      <header>
        <strong>{{ name() }}</strong>
        <span role="status">{{ message() }}</span>
        <button hlmBtn variant="outline" [disabled]="phase() === 'saving'" (click)="closeEditor()">
          {{ phase() === 'ready' ? 'Speichern und schließen' : 'Schließen' }}
        </button>
      </header>
      @if (phase() === 'failed' || phase() === 'saving') { <p class="office-message">{{ message() }}</p> }
      <div class="office-frame"><div id="office-mount"></div></div>
    </section>
  `,
})
export class OfficeEditor {
  private readonly api = inject(Api);
  private readonly lifetime = inject(DestroyRef);
  private editor?: { destroyEditor(): void };
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  readonly session = input.required<EditorSession>();
  readonly name = input.required<string>();
  readonly done = output<string>();
  protected readonly phase = signal<'loading' | 'ready' | 'saving' | 'failed'>('loading');
  protected readonly message = signal('Editor wird geladen …');

  constructor() {
    afterNextRender(() => void this.start());
    this.heartbeat = setInterval(() => {
      if (this.phase() !== 'loading' && this.phase() !== 'ready') return;
      void this.api.request('POST', '/editor/' + this.session().id + '/heartbeat').catch(() => {
        if (this.phase() === 'loading' || this.phase() === 'ready') this.fail('Die Bearbeitungssperre konnte nicht erneuert werden. Bitte sichere deine Änderungen anderweitig und öffne die Datei erneut.');
      });
    }, 30_000);
    this.lifetime.onDestroy(() => {
      clearTimeout(this.timer);
      clearInterval(this.heartbeat);
      this.editor?.destroyEditor();
    });
  }

  private async start() {
    this.timer = setTimeout(() => {
      if (this.phase() === 'loading') this.fail('Der Editor antwortet noch nicht. Bitte später erneut öffnen.');
    }, 35_000);
    try {
      const session = this.session();
      const editor = await loadEditor(session.apiScript);
      if (this.lifetime.destroyed || this.phase() !== 'loading') return;
      this.editor = new editor.DocEditor('office-mount', {
        ...session.config, width: '100%', height: '100%', type: innerWidth < 700 ? 'mobile' : 'desktop',
        events: {
          onDocumentReady: () => {
            clearTimeout(this.timer);
            this.phase.set('ready');
            this.message.set('Änderungen werden beim Schließen übernommen.');
          },
          onError: () => this.fail('Der Editor konnte das Dokument nicht öffnen oder bearbeiten.'),
          onRequestClose: () => void this.closeEditor(),
        },
      });
    } catch { this.fail('ONLYOFFICE ist nicht erreichbar. Bitte Compose-Start prüfen.'); }
  }

  protected async closeEditor() {
    const phase = this.phase();
    if (phase === 'saving') return;
    if (phase === 'loading' || phase === 'failed') {
      await this.api.request('POST', '/editor/' + this.session().id + '/close').catch(() => {});
      this.done.emit('');
      return;
    }
    this.phase.set('saving');
    this.message.set('Änderungen werden gespeichert …');
    this.editor?.destroyEditor();
    this.editor = undefined;
    const deadline = Date.now() + 45_000;
    try {
      while (!this.lifetime.destroyed && Date.now() < deadline) {
        const state = await this.api.request<State>('GET', '/editor/' + this.session().id);
        if (state.status === 'saved' || state.status === 'unchanged') {
          this.done.emit(state.status === 'saved' ? 'Datei gespeichert.' : 'Keine Änderungen zu speichern.');
          return;
        }
        if (state.status === 'failed') {
          this.fail(state.message ?? 'Die Datei wurde nicht gespeichert.');
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      this.fail('Speichern konnte noch nicht bestätigt werden. Bitte prüfe die Datei nach dem Schließen erneut.');
    } catch (error) { this.fail(errorMessage(error)); }
  }

  private fail(message: string) {
    clearTimeout(this.timer);
    if (this.lifetime.destroyed) return;
    this.phase.set('failed');
    this.message.set(message);
    void this.api.request('POST', '/editor/' + this.session().id + '/close').catch(() => {});
  }
}
