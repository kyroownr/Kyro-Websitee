/* Dev-only: rebuilds popup.preview.html from popup.html with the mock harness
 * injected. Not shipped in the Chrome Web Store zip.
 *
 * Usage: node tools/build-preview.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const tag = '<script src="popup.js" type="module"></script>';

if (!source.includes(tag)) {
  throw new Error('popup.html is missing the popup.js script tag.');
}

const preview = source.replace(
  tag,
  '<script src="preview-mock.js"></script>\n  ' + tag
);

fs.writeFileSync(path.join(root, 'popup.preview.html'), preview, 'utf8');
console.log('rebuilt popup.preview.html');
