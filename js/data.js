/* ==========================================================================
   Kyro — catalogue + server stats
   The Vault ships verified tools: AppleFX and SaaSor Plus. Everything the UI
   renders (browse grid, community banner, install guides) is driven from here.
   Fields:
     category: extension | script | preset | project | soundfx
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
    desc: 'Liquid-glass refraction, chromatic dispersion and iOS-style materials for After Effects — the Apple look, rendered fast.',
    category: 'extension',
    os: ['windows', 'macos'],
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
  },
  {
    id: 'saasor',
    title: 'SaaSor Plus',
    desc: 'SaaSor is an all-in-one After Effects toolkit and extension designed for creating SaaS, app, and startup promo videos.',
    category: 'extension',
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
