import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { googleHomeUrl } from './api.config';

// Google Home account linking. The google-home service parks the OAuth request from Google and
// redirects here with an opaque id; once the user has a session we trade that id for the Google
// redirect that carries the authorization code.
@Injectable({ providedIn: 'root' })
export class GoogleLinkService {
  private http = inject(HttpClient);

  authorize(requestId: string) {
    return this.http.post<{ redirectUrl: string }>(
      `${googleHomeUrl()}/api/google/auth/authorize`,
      { requestId },
    );
  }
}
