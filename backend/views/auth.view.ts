import config from '../config/env.config';

export const renderAuthPage = (
  actionUrl: string,
  hiddenParams: Record<string, string>,
  error: string | null = null,
) => {
  const hiddenFields = Object.entries(hiddenParams)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`)
    .join('\n        ');

  return `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Google Smart Home Auth</title>
    <style>
      body {
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background-color: #f0f2f5;
      }
      .login-card {
        background: #ffffff;
        padding: 40px;
        border-radius: 10px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        max-width: 360px;
        width: 100%;
        box-sizing: border-box;
        text-align: center;
      }
      .login-card h2 { margin-top: 0; color: #333; font-weight: 600; }
      .login-card p { color: #666; margin-bottom: 24px; font-size: 14px; }
      .input-group { text-align: left; margin-bottom: 16px; }
      .input-group label { display: block; margin-bottom: 6px; color: #444; font-size: 14px; font-weight: 500; }
      .input-group input { width: 100%; padding: 12px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; font-size: 15px; transition: border-color 0.2s; }
      .input-group input:focus { border-color: #0056b3; outline: none; }
      .btn-primary { background-color: #0056b3; color: white; padding: 12px; width: 100%; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background-color 0.2s; }
      .btn-primary:hover { background-color: #004494; }
      .divider { display: flex; align-items: center; margin: 24px 0; color: #888; font-size: 13px; }
      .divider::before, .divider::after { content: ''; flex: 1; border-bottom: 1px solid #ddd; }
      .divider::before { margin-right: 10px; }
      .divider::after { margin-left: 10px; }
      .btn-google { background-color: #fff; color: #444; padding: 10px 12px; width: 100%; border: 1px solid #ccc; border-radius: 6px; font-size: 15px; font-weight: 500; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background-color 0.2s; }
      .btn-google:hover { background-color: #f9f9f9; }
      .btn-google img { width: 20px; height: 20px; margin-right: 10px; }
      .error { background-color: #ffebee; color: #d93025; padding: 10px; border-radius: 6px; font-size: 14px; margin-bottom: 16px; border: 1px solid #ffcdd2; }
    </style>
    <script src="https://accounts.google.com/gsi/client" async defer></script>
  </head>
  <body>
    <div class="login-card">
      <h2>Welcome Back</h2>
      <p>Sign in to link your Smart Home account</p>
      
      ${error ? `<div class="error">${error}</div>` : ''}
      
      <form id="loginForm" action="${actionUrl}" method="POST">
        ${hiddenFields}
        <input type="hidden" name="googleCode" id="googleCode">
        
        <div class="input-group">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" placeholder="Enter your username" required>
        </div>
        <div class="input-group">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" placeholder="Enter your password" required>
        </div>
        
        <button type="submit" class="btn-primary">Sign In</button>
      </form>

      <div class="divider">OR</div>

      <button id="googleSignInBtn" class="btn-google" type="button">
        <img src="https://developers.google.com/identity/images/g-logo.png" alt="Google Logo">
        Sign in with Google
      </button>
    </div>

    <script>
      window.onload = function () {
        const client = google.accounts.oauth2.initCodeClient({
          client_id: '${config.googleSignIn.signInClientId}',
          scope: 'email profile',
          ux_mode: 'popup',
          callback: (response) => {
            if (response.code) {
              document.getElementById('googleCode').value = response.code;
              // Allow bypass of native required fields
              document.getElementById('username').removeAttribute('required');
              document.getElementById('password').removeAttribute('required');
              document.getElementById('loginForm').submit();
            }
          },
        });
        
        document.getElementById('googleSignInBtn').onclick = function() {
          client.requestCode();
        };
      };
    </script>
  </body>
</html>
`;
};
