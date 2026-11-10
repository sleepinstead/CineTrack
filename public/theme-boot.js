// Applies the last-used theme before first paint so dark themes don't flash
// light while settings load from the local database. Written by
// src/lib/theme.ts; every value is re-validated here before use.
;(function () {
  var THEMES = { paper: '#ffffff', noir: '#0e0e10' }
  // Themes retired in earlier redesigns map to the light or dark theme.
  var RETIRED = {
    porcelain: 'paper', frost: 'paper', dawn: 'paper', matinee: 'paper', gallery: 'paper', blueprint: 'paper', custom: 'paper',
    nocturne: 'noir', dusk: 'noir', projector: 'noir', midnight: 'noir', velvet: 'noir', nitrate: 'noir', halide: 'noir', black: 'noir',
  }
  try {
    var raw = window.localStorage.getItem('cinetrack.theme')
    if (!raw) return
    var hint = JSON.parse(raw)
    var root = document.documentElement
    var theme = hint && typeof hint.theme === 'string' ? hint.theme : ''
    // "system" follows the OS: Noir in dark mode, Paper otherwise.
    if (theme === 'system') {
      theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'noir' : 'paper'
    }
    if (!Object.prototype.hasOwnProperty.call(THEMES, theme)) {
      theme = Object.prototype.hasOwnProperty.call(RETIRED, theme) ? RETIRED[theme] : ''
    }
    if (theme) {
      root.setAttribute('data-theme', theme)
      var meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', THEMES[theme])
    }
    if (hint && hint.round === true) root.setAttribute('data-round-posters', 'true')
  } catch (e) {
    // Storage unavailable or hint unreadable: the app applies the theme itself.
  }
})()
