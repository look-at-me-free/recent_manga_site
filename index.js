(() => {
  "use strict";

  const CONFIG = {
    libraryFile: "library.json",
    mapsBasePath: "search_maps",
    defaultWorksBase: "https://pub-cd01009a7c6c464aa0b093e33aa5ae51.r2.dev/works",
    fallbackWorkBlockBase: "https://pub-f78ac228b8f14431804e721a35484412.r2.dev/works",
    itemJsonName: "item.json",
    searchResultsLimit: 12,
    prefetchThreshold: 0.7,
    toastMs: 1800
  };

  const STATE = {
    works: [],
    sourceMap: {},
    maps: new Map(),
    searchRows: [],
    currentWork: null,
    currentEntry: null,
    currentManifest: null,
    nextPrefetch: null,
    isMobileReader: document.body?.dataset?.readerMode === "mobile",
    searchWired: false,
    navWired: false,
    progressWired: false
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function createEl(tag, className = "", text = "") {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  function normalizeKey(v) {
    return String(v ?? "").trim().toLowerCase();
  }

  function normalizeBaseUrl(url) {
    return String(url || "").replace(/\/+$/, "");
  }

  function titleCaseSlug(slug) {
    return String(slug ?? "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  async function loadLibrary() {
    const data = await fetchJson(CONFIG.libraryFile);
    STATE.works = data.works || [];
    STATE.sourceMap = data.sources || {};
  }

  function shouldUseMap(work) {
    return work?.use_map === true;
  }

  function getMapFile(work) {
    if (!shouldUseMap(work)) return null;
    return `${CONFIG.mapsBasePath}/${work.map_file || `${work.slug}.json`}`;
  }

  function getMap(workOrSlug) {
    const slug = typeof workOrSlug === "string" ? workOrSlug : workOrSlug?.slug;
    return slug ? (STATE.maps.get(slug) || null) : null;
  }

  async function loadWorkMap(work) {
    if (!shouldUseMap(work)) return null;
    if (STATE.maps.has(work.slug)) return STATE.maps.get(work.slug);
    const path = getMapFile(work);
    try {
      const map = await fetchJson(path);
      STATE.maps.set(work.slug, map);
      return map;
    } catch {
      STATE.maps.set(work.slug, null);
      return null;
    }
  }

  async function loadAllMaps() {
    await Promise.all(STATE.works.filter(shouldUseMap).map(loadWorkMap));
  }

  function sortVolumeSlug(a, b) {
    const ma = String(a).match(/^volume_(\d+)$/i);
    const mb = String(b).match(/^volume_(\d+)$/i);
    if (ma && mb) return Number(ma[1]) - Number(mb[1]);
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  function sortChapterSlug(a, b) {
    const ma = String(a).match(/^chapter_(\d+)$/i);
    const mb = String(b).match(/^chapter_(\d+)$/i);
    if (ma && mb) return Number(ma[1]) - Number(mb[1]);
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  function getMapVolumeEntries(work) {
    const map = getMap(work);
    const chapterLocations = map?.chapter_locations;
    if (!chapterLocations) return [];

    return Object.keys(chapterLocations)
      .sort(sortVolumeSlug)
      .map(volumeSlug => {
        const volumeMeta = chapterLocations[volumeSlug] || {};
        const chaptersObj = volumeMeta.chapters || {};
        const chapterKeys = Object.keys(chaptersObj).sort(sortChapterSlug);
        const firstChapterSlug = chapterKeys[0] || "";

        return {
          slug: volumeSlug,
          type: "mapped_volume",
          subtitle: volumeMeta.display_label || titleCaseSlug(volumeSlug),
          map_display_label: volumeMeta.display_label || titleCaseSlug(volumeSlug),
          volume_slug: volumeSlug,
          map_first_chapter_slug: firstChapterSlug
        };
      });
  }

  function getMapChapterEntries(work) {
    const map = getMap(work);
    const chapterLocations = map?.chapter_locations;
    if (!chapterLocations) return [];

    const out = [];

    for (const volumeSlug of Object.keys(chapterLocations).sort(sortVolumeSlug)) {
      const volumeMeta = chapterLocations[volumeSlug] || {};
      const chaptersObj = volumeMeta.chapters || {};

      for (const chapterSlug of Object.keys(chaptersObj).sort(sortChapterSlug)) {
        const chapterMeta = chaptersObj[chapterSlug] || {};
        const pages = Array.isArray(chapterMeta.pages) ? chapterMeta.pages : [];
        if (!pages.length) continue;

        out.push({
          slug: `${volumeSlug}__${chapterSlug}`,
          type: "mapped_chapter",
          subtitle: chapterMeta.display_label || titleCaseSlug(chapterSlug),
          map_display_label: chapterMeta.display_label || titleCaseSlug(chapterSlug),
          map_parent_label: volumeMeta.display_label || titleCaseSlug(volumeSlug),
          volume_slug: volumeSlug,
          chapter_slug: chapterSlug,
          chapter_number: Number(chapterMeta.chapter_number ?? 0) || null,
          page_count: pages.length,
          map_pages: pages
        });
      }
    }

    return out;
  }

  function getVisibleEntries(work) {
    if (!shouldUseMap(work)) {
      return Array.isArray(work.entries) ? work.entries : [];
    }
    return getMapVolumeEntries(work);
  }

  function getChapterSequenceEntries(work) {
    if (!shouldUseMap(work)) {
      return Array.isArray(work.entries) ? work.entries : [];
    }
    return getMapChapterEntries(work);
  }

  function getEntryDisplayLabel(work, entry) {
    return entry?.map_display_label || entry?.subtitle || titleCaseSlug(entry?.slug || "");
  }

  function getFirstChapterEntryForVolume(work, volumeSlug) {
    return getChapterSequenceEntries(work).find(
      entry => normalizeKey(entry.volume_slug) === normalizeKey(volumeSlug)
    ) || null;
  }

  function getEntryBySlug(work, slug) {
    if (!work || !slug) return null;

    if (shouldUseMap(work)) {
      const chapterHit = getChapterSequenceEntries(work).find(
        e => normalizeKey(e.slug) === normalizeKey(slug)
      );
      if (chapterHit) return chapterHit;

      const volumeHit = getVisibleEntries(work).find(
        e => normalizeKey(e.slug) === normalizeKey(slug)
      );
      if (volumeHit) {
        return getFirstChapterEntryForVolume(work, volumeHit.volume_slug || volumeHit.slug) || volumeHit;
      }
    }

    return (Array.isArray(work.entries) ? work.entries : []).find(
      e => normalizeKey(e.slug) === normalizeKey(slug)
    ) || null;
  }

  function renderWorksNav() {
    const nav = $("#worksNav");
    if (!nav) return;

    let html = "";

    for (const work of STATE.works.filter(w => w.top_pill !== false)) {
      const isActive = normalizeKey(work.slug) === normalizeKey(STATE.currentWork?.slug);
      const entries = getVisibleEntries(work);

      html += `
        <div class="topworks-item${isActive ? " active" : ""}">
          <button class="topworks-trigger" type="button" data-work-toggle="${escapeHtml(work.slug)}">
            ${escapeHtml(work.display || titleCaseSlug(work.slug))}
          </button>
          <div class="topworks-flyout">
      `;

      for (const entry of entries) {
        html += `
          <button class="topworks-link" type="button" data-dir="${escapeHtml(work.slug)}" data-file="${escapeHtml(entry.slug)}">
            ${escapeHtml(getEntryDisplayLabel(work, entry))}
          </button>
        `;
      }

      html += `</div></div>`;
    }

    nav.innerHTML = html;
  }

  function resolveSelection(dir, file) {
    const work = STATE.works.find(w => normalizeKey(w.slug) === normalizeKey(dir));
    if (!work) return null;
    const entry = getEntryBySlug(work, file);
    if (!entry) return null;
    return { work, entry };
  }

  function resolveDefaultSelection() {
    const work = STATE.works[0];
    if (!work) return null;
    const entries = shouldUseMap(work) ? getChapterSequenceEntries(work) : (work.entries || []);
    const entry = entries[0];
    return work && entry ? { work, entry } : null;
  }

  function setQueryState(dir, file, replace = false) {
    const url = new URL(window.location.href);
    url.searchParams.set("dir", dir);
    url.searchParams.set("file", file);
    if (replace) history.replaceState({}, "", url);
    else history.pushState({}, "", url);
  }

  function buildImageList(manifest) {
    if (Array.isArray(manifest.images)) return manifest.images;
    if (Array.isArray(manifest.pages)) return manifest.pages;
    return [];
  }

  function getMappedManifest(selection) {
    const pages = selection.entry.map_pages || [];
    return {
      id: selection.entry.slug,
      title: selection.work.display || titleCaseSlug(selection.work.slug),
      subtitle: getEntryDisplayLabel(selection.work, selection.entry),
      pages: pages.length,
      images: pages.map(p => p.url || p.r2_url || p.r2_path || "")
    };
  }

  async function buildReader() {
    const reader = $("#reader");
    if (!reader) return;

    let selection = resolveSelectionFromQuery();
    if (!selection) selection = resolveDefaultSelection();
    if (!selection) return;

    STATE.currentWork = selection.work;
    STATE.currentEntry = selection.entry;

    let manifestRaw;

    if (selection.entry.type === "mapped_chapter") {
      manifestRaw = getMappedManifest(selection);
    } else if (selection.entry.type === "mapped_volume") {
      const firstChapter = getFirstChapterEntryForVolume(selection.work, selection.entry.volume_slug || selection.entry.slug);
      if (!firstChapter) return;
      STATE.currentEntry = firstChapter;
      setQueryState(selection.work.slug, firstChapter.slug, true);
      manifestRaw = getMappedManifest({ work: selection.work, entry: firstChapter });
    } else {
      return;
    }

    const images = buildImageList(manifestRaw);

    renderWorksNav();

    reader.innerHTML = "";

    for (let i = 0; i < images.length; i++) {
      const pageNumber = i + 1;
      const wrap = createEl("article", "image-wrap");
      wrap.dataset.page = String(pageNumber);

      const img = new Image();
      img.loading = i < 2 ? "eager" : "lazy";
      img.decoding = "async";
      img.src = images[i];
      wrap.appendChild(img);

      reader.appendChild(wrap);
    }
  }

  function resolveSelectionFromQuery() {
    const url = new URL(window.location.href);
    const dir = url.searchParams.get("dir");
    const file = url.searchParams.get("file");
    if (!dir || !file) return null;
    return resolveSelection(dir, file);
  }

  async function switchEntry(dir, file) {
    const selection = resolveSelection(dir, file);
    if (!selection) return;

    const finalEntry =
      selection.entry.type === "mapped_volume"
        ? (getFirstChapterEntryForVolume(selection.work, selection.entry.volume_slug || selection.entry.slug) || selection.entry)
        : selection.entry;

    setQueryState(selection.work.slug, finalEntry.slug);
    STATE.currentWork = selection.work;
    STATE.currentEntry = finalEntry;

    await buildReader();
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function wireNavClicks() {
    if (STATE.navWired) return;
    STATE.navWired = true;

    document.addEventListener("click", async (e) => {
      const jump = e.target.closest("[data-dir][data-file]");
      if (!jump) return;
      await switchEntry(jump.dataset.dir, jump.dataset.file);
    });
  }

  async function boot() {
    await loadLibrary();
    await loadAllMaps();
    wireNavClicks();
    await buildReader();
  }

  boot();
})();
