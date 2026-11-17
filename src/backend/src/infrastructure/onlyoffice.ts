import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { fail } from '../application/errors.js';
import { OFFICE_LIMIT, type EditorGateway } from '../application/office.js';

const callback = z.object({ key: z.string().uuid(), status: z.number().int(), url: z.string().optional() });

export class OnlyOffice implements EditorGateway {
  readonly apiScript: string;

  constructor(
    private readonly secret: string,
    private readonly backendOrigin: string,
    private readonly editorOrigin: string,
    browserOrigin: string,
  ) {
    this.apiScript = new URL('/web-apps/apps/api/documents/api.js', browserOrigin).href;
  }

  sourceUrl(id: string) { return this.backendOrigin + '/office/' + id + '/source'; }
  callbackUrl(id: string) { return this.backendOrigin + '/office/' + id + '/callback'; }
  signConfig(config: object) { return jwt.sign(config, this.secret, { algorithm: 'HS256', expiresIn: '2h' }); }

  verifySource(token: string | undefined, id: string) {
    const signed = this.verify(token, 'download');
    if (!signed.payload || signed.payload.url !== this.sourceUrl(id)) fail(403, 'Ungültige Dokumentanforderung.');
  }

  readCallback(token: string | undefined) {
    const result = callback.safeParse(this.verify(token, 'callback').payload);
    if (!result.success) return fail(400, 'Ungültige Editorantwort.');
    return result.data;
  }

  async fetchResult(url: string, key: string, extension: 'docx' | 'xlsx') {
    let result: URL;
    try { result = new URL(url); } catch { return fail(400, 'Ungültige Speicheradresse.'); }
    const [, cache, files, directory, cacheKey, output, filename, ...extra] = result.pathname.split('/');
    const expected = 'output.' + extension;
    const suffix = cacheKey?.slice(key.length) ?? '';
    // Take the path from the signed message and the origin exclusively from server configuration.
    if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password ||
        cache !== 'cache' || files !== 'files' || directory !== 'data' || !cacheKey?.startsWith(key) ||
        !/^(?:_\d+)*$/.test(suffix) || output !== expected || filename !== expected || extra.length) {
      return fail(400, 'Ungültige Speicheradresse.');
    }
    const response = await fetch(new URL(result.pathname + result.search, this.editorOrigin), {
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok || !response.body) return fail(502, 'Datei konnte nicht vom Editor abgerufen werden.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > OFFICE_LIMIT) {
          await reader.cancel();
          return fail(413, 'Die bearbeitete Datei überschreitet 10 MiB.');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const data = Buffer.concat(chunks, size);
    if (data.subarray(0, 4).toString('hex') !== '504b0304') return fail(502, 'Der Editor lieferte kein Office-Dokument.');
    return data;
  }

  private verify(token: string | undefined, operation: string) {
    if (!token) return fail(401, 'Editorsignatur fehlt.');
    try {
      const signed = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
      if (typeof signed === 'string' || (signed.operation !== undefined && signed.operation !== operation)) throw new Error();
      return signed;
    } catch { return fail(401, 'Editorsignatur ungültig.'); }
  }
}
