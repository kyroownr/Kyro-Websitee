/* ==========================================================================
   Kyro — catalogue + server stats
   The Vault ships verified tools: AppleFX and SaaSor Plus. Everything the UI
   renders (browse grid, community banner, install guides) is driven from here.
   Fields:
     category: extension | script | preset | project | soundfx
     kind:     'software' — an editor the vault hands out, or 'tool' — an
               extension, script or pack that runs inside one. The OS pages
               split on this: Software first, Tools under it.
     os:       ['windows','macos'] — which browse categories list this tool
     files[]:  gated downloads unlocked by Discord server membership
     files[].url: set for externally hosted archives; the row then links out
                  instead of running the in-page transfer
     files[].pass: archive password, shown next to the unlocked download
     aeMin:    earliest compatible After Effects year — omit until it is known
               and the compatibility badge simply does not render
     version / creator / price: same rule — an absent value hides its chip,
               it is never filled in with a guess
     gallery:  real screenshot paths, shown in the modal stage instead of the
               generated canvas preview
   files[].sha256 is optional and powers the VirusTotal link: paste the real
   hash of the shipped artifact (64 hex chars) and the report button appears on
   that file's row. Anything malformed or absent renders no link at all, so a
   guessed hash is worse than none — it would point at somebody else's file.
   ========================================================================== */

/* Server stats shown on the community banner. The domain and invite live with
   the auth config: `kyro.new.tg` and DISCORD_INVITE_URL in js/app.js. */
window.KYRO_SITE = {
  domain: 'kyro.new.tg',
  online: 13,
  members: 81
};

window.KYRO_SEED = [
  {
    id: 'applefx',
    title: 'AppleFX',
    desc: 'AppleFX by 8bitbrain is a flagship After Effects extension/panel designed to give your edits Apple-grade, high-end motion and aesthetics in just one click.',
    category: 'extension',
    kind: 'tool',
    os: ['windows', 'macos'],
    price: null,
    version: '1.2.5',
    creator: '8bitbrain',
    downloads: 0,
    aeMin: 2022,
    featured: true,
    preview: 'glass',
    seed: 113,
    added: '2026-11-02',
    tags: ['glass', 'refraction', 'shader', 'ui', 'ios'],
    gallery: [
      '/assets/applefx-panel.webp',
      '/assets/applefx-layers.webp',
      '/assets/applefx-tutorial.webp'
    ],
    files: [
      {
        ext: '.zxp',
        name: 'AppleFX-1.2.5.zxp',
        size: '',
        label: 'Signed CEP extension panel',
        url: 'https://1024terabox.com/s/1sxC_pFYaOWc7dpeTkzRUsw',
        pass: 'Kyro'
      }
    ],
    features: [
      'What it is: A native After Effects panel packed with over 70+ handcrafted presets and tools styled after Apple\u2019s clean, smooth UI and presentation design.',
      'Easing & Springs: Gives your animations organic, smooth bounce and snap curves that feel expensive and native to iOS/macOS.',
      'Text & Transitions: Instant text animations with direction controls and fluid transitions.',
      'Liquid Glass & Styles: Frosted glass effects, gradients, and clean styling options.',
      'Shakes & Expressions: Built-in motion dynamics without needing manual, complex scripting.',
      'Workflow: It features live browser-like previews right inside the panel, real-time control sliders (for duration, scale, blur, etc.), and a one-click apply button that targets your active composition.',
      'License: One-time purchase with a lifetime license (compatible with Mac & Windows for After Effects 2022+), which includes free monthly updates.'
    ],
    changelog: [
      { v: '1.2.5', date: '2026-11-02', notes: 'Dispersion clamp on 8bpc comps, faster frosted roughness, AE 2026 render queue fix.' }
    ]
  },
  {
    id: 'saasor',
    title: 'SaaSor Plus',
    desc: 'SaaSor is an all-in-one After Effects toolkit and extension designed for creating SaaS, app, and startup promo videos.',
    category: 'extension',
    kind: 'tool',
    os: ['windows', 'macos'],
    price: null,
    version: '',
    creator: '',
    downloads: 0,
    featured: true,
    added: '2026-11-13',
    tags: ['saas', 'promo', '3d', 'mockup', 'panel'],
    gallery: [
      '/assets/saasor-scenes.webp',
      '/assets/saasor-motion.webp',
      '/assets/saasor-workflow.webp',
      '/assets/saasor-projects.webp'
    ],
    files: [
      {
        ext: 'archive',
        name: 'SaaSor Plus — full toolkit',
        size: '',
        label: 'Scenes, 3D assets, GLB models and the extension panel',
        url: 'https://1024terabox.com/s/1ELxpFUwyeCCeXc_mdkIpsw',
        pass: 'Kyro'
      }
    ],
    features: [
      'Ready-to-Use Scenes: Over 125 customizable scenes available in both 16:9 (horizontal) and 9:16 (vertical) formats.',
      '3D Assets & Mockups: Includes animated 3D mockups, 3D characters, GLB models, icons, and emojis.',
      'Workflow Tools: A built-in panel with 13+ one-click tools and 11 add-ons to speed up animation, organization, and design tasks.',
      'Lifetime Access: A one-time purchase that includes all future asset updates.',
      'It essentially turns After Effects into a plug-and-play studio so creators can build professional product promos in a fraction of the usual time.'
    ]
  }
];

/* --------------------------------------------------------------------------
   Installation guides — rendered in the modal’s Installation tab.
   `paths` follow whichever OS the visitor picked in the hero toggle.
   A guide may instead ship `title` + `sections` (heading, paragraph pairs),
   which is how the externally hosted SaaSor toolkit is documented.
   -------------------------------------------------------------------------- */
window.KYRO_INSTALL = {
  archive: {
    title: '🚀 SaaSor Quick Start Guide',
    sections: [
      {
        h: 'Use the Built-In Guides',
        p: 'Every scene comes with labels (like Change Text or Change Media) right inside After Effects to show you what to edit. Use the Preview button to turn these guide labels ON or OFF whenever you want a clean look at your video.'
      },
      {
        h: 'Control Everything from One Place',
        p: 'Every scene includes a Control Layer. Use it to quickly change colors, animation settings, and other options without digging through complex layers.'
      },
      {
        h: 'How to Edit Text',
        p: 'Scroll to the bottom of the composition, open the Change Text layer, replace the placeholder text with your own, and go back to the main composition. It updates automatically!'
      },
      {
        h: 'How to Replace Media',
        p: 'Find the Change Media layer. For the fastest workflow, hold Alt and drag your new image or video directly onto the old media layer to swap it instantly while keeping all animations intact.'
      }
    ]
  },
  '.zxp': {
    title: 'AppleFX 1.2.5 — Installation Guide',
    blocks: [
      { p: '<b>Package:</b> <code>AppleFX-1.2.5.zxp</code> (signed)<br/><b>Host:</b> After Effects 2022 (22.0) or newer, Windows and macOS' },
      { p: 'The package is signed with a self-signed certificate (<code>CN=kyro</code>, valid until 2036-11-10). Because Adobe does not trust that certificate, After Effects only loads the panel when CEP <b>PlayerDebugMode</b> is enabled. Do step 1 before installing.' },

      { h: '1. Enable PlayerDebugMode' },
      { sub: 'Windows' },
      { p: 'Open PowerShell and run:' },
      { code: 'reg add "HKCU\\Software\\Adobe\\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f\nreg add "HKCU\\Software\\Adobe\\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f', lang: 'powershell' },
      { sub: 'macOS' },
      { p: 'Open Terminal and run:' },
      { code: 'defaults write com.adobe.CSXS.11 PlayerDebugMode 1\ndefaults write com.adobe.CSXS.12 PlayerDebugMode 1', lang: 'bash' },
      { p: 'Setting both keys is harmless — AE reads the one that matches its CEP version.' },

      { h: '2. Install the panel' },
      { sub: 'Option A — ZXP installer (recommended)' },
      { ol: [
        'Install <b>ZXP/UXP Installer</b> (Anastasiy): <a class="prose-link" href="https://install.anastasiy.com" target="_blank" rel="noopener noreferrer">https://install.anastasiy.com</a>',
        'Drag <code>AppleFX-1.2.5.zxp</code> onto the installer window (or use <i>File → Install Extension</i>).',
        'Fully quit and restart After Effects.',
        'Open the panel from <b>Window → Extensions → AppleFX</b>.'
      ] },
      { sub: 'Option B — manual install' },
      { ol: [
        'Make a copy of <code>AppleFX-1.2.5.zxp</code>, rename the copy to <code>AppleFX-1.2.5.zip</code>, and extract it.',
        'Copy the extracted folder — the one containing <code>CSXS</code>, <code>dist</code>, <code>extendscript</code>, <code>mimetype</code> — into the CEP extensions directory:<ul class="install-list"><li><b>Windows:</b> <code>%APPDATA%\\Adobe\\CEP\\extensions\\AppleFX</code></li><li><b>macOS:</b> <code>~/Library/Application Support/Adobe/CEP/extensions/AppleFX</code></li></ul>Create the <code>extensions</code> folder if it does not exist.',
        'Fully quit and restart After Effects.',
        'Open the panel from <b>Window → Extensions → AppleFX</b>.'
      ] },
      { p: 'Do not add, delete, or edit files inside the installed folder — the signature covers the exact file list, and a modified folder will be rejected.' },
      { quote: 'If Windows marks the downloaded <code>.zxp</code> as blocked, right-click the file → <b>Properties</b> → tick <b>Unblock</b> → <b>OK</b> before installing.' },

      { h: '3. Confirm it installed' },
      { p: 'Open the panel, click the gear (Settings) and check the <b>About</b> section. It should show:' },
      { code: 'AppleFX                         1.2.5\nHost                            After Effects\nDeveloper                       by kyro\nhttps://discord.gg/5ch7XeNg98' },
      { p: '<code>by kyro</code> opens <a class="prose-link" href="https://kyro.new.tg/" target="_blank" rel="noopener noreferrer">https://kyro.new.tg/</a> in your browser.' },

      { h: '4. Uninstall' },
      { ol: [
        'Quit After Effects.',
        'Delete the <code>AppleFX</code> folder from the CEP extensions directory shown in Option B.',
        'Optional — revert PlayerDebugMode:'
      ] },
      { p: '<b>Windows (PowerShell):</b>' },
      { code: 'reg delete "HKCU\\Software\\Adobe\\CSXS.11" /v PlayerDebugMode /f\nreg delete "HKCU\\Software\\Adobe\\CSXS.12" /v PlayerDebugMode /f', lang: 'powershell' },
      { p: '<b>macOS:</b>' },
      { code: 'defaults delete com.adobe.CSXS.11 PlayerDebugMode\ndefaults delete com.adobe.CSXS.12 PlayerDebugMode', lang: 'bash' },

      { h: 'Troubleshooting' },
      { table: {
        head: ['Symptom', 'Fix'],
        rows: [
          ['AppleFX missing from Window → Extensions', 'PlayerDebugMode not set for your AE build, or AE was not fully restarted. Check both registry/defaults keys and relaunch AE.'],
          ['"The extension could not be loaded" / signature error', 'The extension folder was modified or incompletely extracted. Reinstall from the original <code>.zxp</code>.'],
          ['Installed but panel is blank', 'Close the panel, reopen it from the Window menu. If it stays blank, enable remote debugging (below) and check the console.'],
          ['Nothing happens after double-clicking the <code>.zxp</code>', '<code>.zxp</code> files are not executable — install with ZXP/UXP Installer or use the manual method.']
        ]
      } },
      { p: '<b>Remote debugging:</b> the package ships a <code>.debug</code> config exposing Chrome DevTools at <a class="prose-link" href="http://localhost:8088" target="_blank" rel="noopener noreferrer">http://localhost:8088</a> while the panel is open. Open that URL in Chrome to inspect errors.' },

      { h: 'Rebuilding the signed package (development)' },
      { p: 'Signing uses Adobe\u2019s <code>ZXPSignCmd</code> (CEP-Resources 4.1.1), stored at <code>.tools/ZXPSignCmd.exe</code>.' },
      { p: 'Certificate (keep this file for future updates so the signer stays the same):' },
      { code: 'build/certs/applefx-signing.p12\npassword: applefx-kyro\nCN=kyro, valid 2026-11-13 to 2036-11-10, no timestamp server' },
      { p: 'Rebuild steps:' },
      { ol: [
        'Stage only the runtime files — <code>CSXS/</code>, <code>Public/</code>, <code>dist/</code>, <code>extendscript/</code>, <code>index.html</code>, <code>mimetype</code>, <code>.debug</code>. Do <b>not</b> include <code>src/</code>, <code>build/</code>, <code>.tools/</code>, or backups.',
        '<code>mimetype</code> and <code>.debug</code> are read-only in the repo; clear that on the staged copies before signing (<code>mimetype</code> in particular makes ZXPSignCmd fail with "Could not create pointer to file"):<pre class="install-code"><code>chmod -R u+w build/staging</code></pre>',
        'Sign:<pre class="install-code"><code>./.tools/ZXPSignCmd.exe -sign build/staging AppleFX-1.2.5.zxp build/certs/applefx-signing.p12 applefx-kyro</code></pre>',
        'Verify:<pre class="install-code"><code>./.tools/ZXPSignCmd.exe -verify AppleFX-1.2.5.zxp -skipOnlineRevocationChecks</code></pre>Expected: <code>Signature verified successfully</code>.'
      ] },
      { p: 'After re-signing, also refresh the in-repo <code>META-INF/signatures.xml</code> by extracting it from the new <code>.zxp</code>. Extra files (like <code>src/</code>) in the working folder make a folder-level <code>-verify</code> fail by design; only the extracted package contents are signed.' }
    ]
  },
  '.jsxbin': {
    intro: 'Compiled ExtendScript panel — drop it into ScriptUI Panels and restart.',
    steps: [
      'Copy the <code>.jsxbin</code> file into your <span class="path">ScriptUI Panels</span> folder.',
      'Restart After Effects and open it from <code>Window ▸ AppleFX</code>.',
      'Allow script file writes in <code>Preferences ▸ Scripting &amp; Components</code> if the panel reports an error.'
    ],
    paths: {
      windows: 'C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\Scripts\\ScriptUI Panels\\',
      macos: '/Applications/Adobe After Effects 2026/Scripts/ScriptUI Panels/'
    },
    note: 'The compiled build behaves identically to the .zxp panel — use it when CEP is disabled.'
  },
  '.ffx': {
    intro: 'Effect presets — drop them in User Presets and apply from the Effects & Presets panel.',
    steps: [
      'Copy the <code>.ffx</code> into your <span class="path">User Presets</span> folder.',
      'Refresh the panel, then drag any AppleFX preset onto a layer.',
      'Sliders stay fully editable — nothing is baked or expression-locked.'
    ],
    paths: {
      windows: '%AppData%\\Adobe\\After Effects 2026\\User Presets\\',
      macos: '~/Documents/Adobe/After Effects 2026/User Presets/'
    },
    note: 'Presets are additive: they never overwrite the panel’s own defaults.'
  }
};

/* Human-readable labels shared across UI surfaces */
window.KYRO_CATEGORY_LABEL = {
  extension: 'Extension', script: 'Script', preset: 'Preset',
  project: 'Project File', soundfx: 'Sound FX'
};
