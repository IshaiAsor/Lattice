module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // History uses scopes like feat(backoffice), fix(ci) — keep free-form scopes,
    // and allow longer bodies/footers than the 100-char default.
    'body-max-line-length': [1, 'always', 200],
    'footer-max-line-length': [0, 'always'],
  },
};
