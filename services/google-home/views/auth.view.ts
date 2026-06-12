import config from '../config/env.config';

export const renderAuthPage = (
  actionUrl: string,
  hiddenParams: Record<string, string>,
  error: string | null = null,
): string => {
  const hiddenFields = Object.entries(hiddenParams)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`)
    .join('\n        ');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Lattice Smart Home — Account Linking</title>
    <style>
      body { font-family: 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f0f2f5; }
      .card { background: #fff; padding: 40px; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,.1); max-width: 360px; width: 100%; box-sizing: border-box; text-align: center; }
      h2 { margin-top: 0; color: #333; } p { color: #666; font-size: 14px; margin-bottom: 24px; }
      .group { text-align: left; margin-bottom: 16px; }
      .group label { display: block; margin-bottom: 6px; color: #444; font-size: 14px; font-weight: 500; }
      .group input { width: 100%; padding: 12px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; font-size: 15px; }
      .group input:focus { border-color: #0056b3; outline: none; }
      .btn { padding: 12px; width: 100%; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; }
      .btn-primary { background: #0056b3; color: #fff; }
      .btn-primary:hover { background: #004494; }
      .divider { display: flex; align-items: center; margin: 24px 0; color: #888; font-size: 13px; }
      .divider::before, .divider::after { content: ''; flex: 1; border-bottom: 1px solid #ddd; }
      .divider::before { margin-right: 10px; } .divider::after { margin-left: 10px; }
      .btn-google { background: #fff; color: #444; border: 1px solid #ccc; display: flex; align-items: center; justify-content: center; }
      .btn-google:hover { background: #f9f9f9; }
      .btn-google img { width: 20px; height: 20px; margin-right: 10px; }
      .error { background: #ffebee; color: #d93025; padding: 10px; border-radius: 6px; font-size: 14px; margin-bottom: 16px; border: 1px solid #ffcdd2; }
    </style>
    <script src="https://accounts.google.com/gsi/client" async defer></script>
  </head>
  <body>
    <div class="card">
      <h2>Link Your Account</h2>
      <p>Sign in to connect Lattice with Google Home</p>
      ${error ? `<div class="error">${error}</div>` : ''}
      <form id="loginForm" action="${actionUrl}" method="POST">
        ${hiddenFields}
        <input type="hidden" name="googleCode" id="googleCode">
        <div class="group"><label>Username</label><input type="text" name="username" placeholder="Username" required></div>
        <div class="group"><label>Password</label><input type="password" name="password" placeholder="Password" required></div>
        <button type="submit" class="btn btn-primary">Sign In</button>
      </form>
      <div class="divider">OR</div>
      <button id="gBtn" class="btn btn-google" type="button">
        <img src="https://developers.google.com/identity/images/g-logo.png" alt="">
        Sign in with Google
      </button>
    </div>
    <script>
      window.onload = function () {
        const client = google.accounts.oauth2.initCodeClient({
          client_id: '${config.google.signInClientId}',
          scope: 'email profile',
          ux_mode: 'popup',
          callback: (r) => {
            if (r.code) {
              document.getElementById('googleCode').value = r.code;
              document.querySelector('[name=username]').removeAttribute('required');
              document.querySelector('[name=password]').removeAttribute('required');
              document.getElementById('loginForm').submit();
            }
          },
        });
        document.getElementById('gBtn').onclick = () => client.requestCode();
      };
    </script>
  </body>
</html>`;
};
