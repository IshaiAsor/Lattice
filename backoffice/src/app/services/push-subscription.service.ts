import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api.config';

export type PushSubscriptionState = 'subscribed' | 'unsubscribed' | 'unsupported';

// Browser-side capture of a web-push subscription — distinct from NotificationsService
// (which owns inbox/badge/preference state): this is a one-shot device-registration action,
// not ongoing app state.
@Injectable({ providedIn: 'root' })
export class PushSubscriptionService {
  private base = `${apiUrl()}/api/notifications`;
  private http = inject(HttpClient);

  isSupported(): boolean {
    return 'serviceWorker' in navigator && 'PushManager' in window;
  }

  async getSubscriptionState(): Promise<PushSubscriptionState> {
    if (!this.isSupported()) return 'unsupported';
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub ? 'subscribed' : 'unsubscribed';
  }

  async enable(): Promise<void> {
    const reg = await navigator.serviceWorker.register('/service-worker.js');
    const { publicKey } = await firstValueFrom(
      this.http.get<{ publicKey: string | null }>(`${this.base}/push/public-key`),
    );
    if (!publicKey) {
      throw new Error('Push notifications are not configured on the server yet.');
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await firstValueFrom(this.http.post(`${this.base}/push/subscribe`, sub.toJSON()));
  }

  async disable(): Promise<void> {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await firstValueFrom(
      this.http.delete(`${this.base}/push/subscribe`, { body: { endpoint: sub.endpoint } }),
    );
    await sub.unsubscribe();
  }
}

// VAPID public keys are base64url; the Push API needs a raw Uint8Array backed by a concrete
// ArrayBuffer (not the wider ArrayBufferLike that `new Uint8Array(length)` infers).
function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
