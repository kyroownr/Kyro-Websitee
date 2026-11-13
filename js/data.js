/* ==========================================================================
   Kyro — catalogue + server stats
   The Vault ships one verified tool: AppleFX. Everything the UI renders
   (browse grid, community banner, install guides) is driven from here.
   Fields:
     category: extension | script | preset | project | soundfx
     files[]:  gated downloads unlocked by Discord server membership
     aeMin:    earliest compatible After Effects year
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
    desc: 'Liquid-glass refraction, chromatic dispersion and iOS-style materials for After Effects — the Apple look, rendered fast.',
    category: 'extension',
    price: 0,
    version: '1.2.5',
    creator: 'Kyro',
    downloads: 12840,
    aeMin: 2024,
    featured: true,
    preview: 'glass',
    seed: 113,
    added: '2026-11-02',
    tags: ['glass', 'refraction', 'shader', 'ui', 'ios'],
    files: [
      { ext: '.zxp', name: 'AppleFX-1.2.5.zxp', size: '18.4 MB', label: 'CEP extension panel' },
      { ext: '.jsxbin', name: 'AppleFX-1.2.5.jsxbin', size: '6.2 MB', label: 'ScriptUI panel build' },
      { ext: '.ffx', name: 'AppleFX-1.2.5.ffx', size: '2.1 MB', label: '34 effect presets' }
    ],
    features: [
      'Raymarched glass with real edge refraction and chromatic dispersion',
      'Frosted, beveled and lensed material variants with live thumbnails',
      'Editable thickness, roughness and IOR sliders — no expressions to break',
      'Background-sampling mode that respects pre-compose depth',
      'GPU-accelerated on the 2026 and 2025 renderers, CPU fallback for 2024'
    ],
    changelog: [
      { v: '1.2.5', date: '2026-11-02', notes: 'Dispersion clamp on 8bpc comps, faster frosted roughness, AE 2026 render queue fix.' },
      { v: '1.2.0', date: '2026-09-18', notes: 'Lensed material variant, per-layer depth mask, 34-preset pack rebuilt.' },
      { v: '1.0.0', date: '2026-08-14', notes: 'First Kyro release — core glass raymarcher and CEP panel.' }
    ]
  }
];

/* --------------------------------------------------------------------------
   Installation guides — rendered in the modal’s Installation tab.
   `paths` follow whichever OS the visitor picked in the hero toggle.
   -------------------------------------------------------------------------- */
window.KYRO_INSTALL = {
  '.zxp': {
    intro: 'CEP extension — install with ZXP Installer, restart AE, open from Window ▸ Extensions.',
    steps: [
      'Download the <code>.zxp</code> archive — do not unzip it.',
      'Open <code>ZXP Installer</code> and drag the file onto its window.',
      'Wait for the green “Installed” confirmation, then restart After Effects.',
      'Launch it from <code>Window ▸ Extensions (beta) ▸ AppleFX</code>.'
    ],
    paths: {
      windows: 'C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\Scripts\\',
      macos: '/Applications/Adobe After Effects 2026/Scripts/'
    },
    note: 'First launch may warn about unsigned extensions — expected for locally installed ZXPs.'
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
