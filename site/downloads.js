// Points the download buttons at the files of the latest GitHub release, with this visitor's
// platform first. Until there is a release (or if GitHub can't be reached), they stay pointing
// at the releases page.
(async () => {
  const buttons = document.querySelectorAll('[data-asset]');
  if (!buttons.length) return;
  const p = navigator.userAgentData?.platform || navigator.platform || '';
  const first = /win/i.test(p) ? 'windows' : /linux/i.test(p) ? 'appimage' : 'mac-arm64';
  const target = document.querySelector(`[data-asset="${first}"]`);
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
    };
    for (const b of buttons) {
      const asset = release.assets.find((a) => patterns[b.dataset.asset].test(a.name));
      if (asset) b.href = asset.browser_download_url;
    }
    const v = document.querySelector('[data-version]');
    if (v) v.textContent = `Version ${release.tag_name.replace(/^v/, '')}`;
  } catch {
    // keep the releases-page links
  }
})();
