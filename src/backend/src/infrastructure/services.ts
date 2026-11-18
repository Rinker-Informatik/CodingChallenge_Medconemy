import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Credentials, Notifier, ObjectStore } from '../application/ports.js';
import type { Upload } from '../domain/models.js';

export class JwtCredentials implements Credentials {
  constructor(private readonly secret: string) {}
  hash(password: string) { return bcrypt.hash(password, 12); }
  verify(password: string, hash: string) { return bcrypt.compare(password, hash); }
  issueToken(userId: string, sessionVersion = 0) { return jwt.sign({ sessionVersion }, this.secret, { subject: userId, expiresIn: '8h', algorithm: 'HS256' }); }
  verifyToken(token: string) {
    const payload = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || typeof payload.sub !== 'string') throw new Error('Invalid token');
    return payload.sub;
  }
  verifySession(token: string) {
    const payload = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || typeof payload.sub !== 'string') throw new Error('Invalid token');
    const sessionVersion = payload.sessionVersion ?? 0;
    if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) throw new Error('Invalid session version');
    return { userId: payload.sub, sessionVersion };
  }
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  constructor(private readonly bucket: string, endpoint: string, accessKeyId: string, secretAccessKey: string) {
    this.client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  }
  async ensureBucket() {
    for (let i = 0; ; i++) {
      try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); return; }
      catch {
        try { await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })); return; }
        catch (error) { if (i === 20) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
      }
    }
  }
  async put(key: string, upload: Upload) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: upload.buffer, ContentType: upload.contentType }));
  }
  async get(key: string) {
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await object.Body!.transformToByteArray());
  }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
}

export type MailConfig = { host: string; port: number; secure: boolean; requireTLS: boolean; from: string; user?: string; password?: string };
export class MailNotifier implements Notifier {
  private readonly transport;
  constructor(private readonly config: MailConfig) {
    if (!!config.user !== !!config.password) throw new Error('SMTP_USER und SMTP_PASSWORD müssen zusammen gesetzt sein.');
    this.transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure,
      requireTLS: config.requireTLS, ...(config.user && config.password ? { auth: { user: config.user, pass: config.password } } : {}) });
  }
  async invite(email: string, link: string, reset = false) {
    await this.transport.sendMail({ from: this.config.from, to: email, subject: reset ? 'Passwort für Medconemy zurücksetzen' : 'Einladung zu Medconemy', text: `${reset ? 'Für dein Medconemy-Konto wurde ein Zurücksetzen des Passworts angefordert. Lege über diesen Link ein neues Passwort fest:' : 'Du wurdest zu Medconemy eingeladen. Lege dein Passwort über diesen Link fest:'}\n\n${link}\n\nDer Link ist 24 Stunden gültig und einmal verwendbar.` });
  }
  async folderShared(email: string, folderName: string) {
    await this.transport.sendMail({ from: this.config.from, to: email, subject: 'Bereich freigegeben', text: `Der Ordner „${folderName}“ wurde für Sie freigegeben.` });
  }
}
