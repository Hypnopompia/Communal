// Points the download buttons at the files of the latest GitHub release, with this visitor's
// platform first. Until there is a release (or if GitHub can't be reached), they stay pointing
// at the releases page. A release can go out without an Android APK (it's only built once the
// signing key is set up), so the Android button then says so instead of pointing at nothing.
(async () => {
  const buttons = document.querySelectorAll('[data-asset]');
  if (!buttons.length) return;
  const p = navigator.userAgentData?.platform || navigator.platform || '';
  const first = /android/i.test(p + navigator.userAgent)
    ? 'android'
    : /win/i.test(p)
      ? 'windows'
      : /linux/i.test(p)
        ? 'appimage'
        : 'mac-arm64';
  const target = document.querySelector(`.downloads [data-asset="${first}"]`);
  if (target) {
    target.classList.add('primary');
    target.parentElement.prepend(target);
  }
  try {
    const res = await fetch('https://api.github.com/repos/Hypnopompia/Communal/releases/latest');
    if (!res.ok) return;
    const release = await res.json();
    const patterns = {
      'mac-arm64': /-arm64\.dmg$/,
      'mac-x64': /-x64\.dmg$/,
      windows: /\.exe$/,
      appimage: /\.AppImage$/,
      deb: /\.deb$/,
      android: /\.apk$/,
    };
    for (const b of buttons) {
      const asset = release.assets.find((a) => patterns[b.dataset.asset].test(a.name));
      if (asset) b.href = asset.browser_download_url;
      else if (b.dataset.asset === 'android') {
        const note = b.querySelector('small');
        if (note) note.textContent = 'Not in this release: see all releases';
      }
    }
    for (const v of document.querySelectorAll('[data-version]'))
      v.textContent = `Version ${release.tag_name.replace(/^v/, '')}`;
  } catch {
    // keep the releases-page links
  }
})();
