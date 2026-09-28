// @ts-check
/**
 * Construit le VSIX publiable sur le Marketplace. Le Marketplace refuse les API
 * proposées de VS Code : on retire temporairement du manifeste enabledApiProposals
 * et la contribution chatSessions (l'intégration au panneau Chat natif se désactive
 * alors d'elle-même), on empaquette, puis on restaure le manifeste.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'package.json');
const original = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(original);

delete manifest.enabledApiProposals;
delete manifest.contributes.chatSessions;

try {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const vsce = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
  // Tout est déjà dans dist/ (esbuild) : pas besoin d'embarquer node_modules.
  execFileSync(vsce, ['package', '--no-dependencies', '--out', `${manifest.name}-${manifest.version}.vsix`], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
} finally {
  fs.writeFileSync(manifestPath, original);
}
