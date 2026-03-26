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

  const ERROR = {
    LIBRARY_FETCH_FAILED: "LIBRARY_FETCH_FAILED",
    LIBRARY_INVALID: "LIBRARY_INVALID",
    NO_WORKS_FOUND: "NO_WORKS_FOUND",
    MAP_FETCH_FAILED: "MAP_FETCH_FAILED",
    MAP_INVALID: "MAP_INVALID",
    WORK_BLOCK_FETCH_FAILED: "WORK_BLOCK_FETCH_FAILED",
    SEARCH_INDEX_BUILD_FAILED: "SEARCH_INDEX_BUILD_FAILED",
    SELECTION_NOT_FOUND: "SELECTION_NOT_FOUND",
    MANIFEST_FETCH_FAILED: "MANIFEST_FETCH_FAILED",
    MANIFEST_INVALID: "MANIFEST_INVALID",
    MANIFEST_NO_BASE_URL: "MANIFEST_NO_BASE_URL",
    MANIFEST_NO_IMAGES: "MANIFEST_NO_IMAGES",
    SWITCH_ENTRY_FAILED: "SWITCH_ENTRY_FAILED",
    BUILD_READER_FAILED: "BUILD_READER_FAILED",
    BOOT_FAILED: "BOOT_FAILED"
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
    progressWired: false,
    dialWired: false,
    stickyWired: false,
    mobileOpenWorkSlug: ""
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

  function appError(code, message, details = {}) {
    const err = new Error(message);
    err.code = code;
    err.details = details;
    return err;
  }

  function logError(err, context = "") {
    const code = err?.code || "UNEXPECTED_ERROR";
    const message = err?.message || "Unexpected error";
    console.error(`[${code}]${context ? ` ${context}` : ""}: ${message}`, err?.details || {}, err);
    return { code, message, details: err?.details || null };
  }

  function showFatalError(err) {
    const payload = logError(err, "Fatal");
    const title = $("#workTitle");
    const reader = $("#reader");
    const stat = $("#chapterSearchStat");

    if (title) title.textContent = `Failed to load (${payload.code})`;
    if (stat) stat.textContent = `Error: ${payload.code}`;

    if (reader) {
      reader.innerHTML = `
        <div class="note">
          <strong>Error code:</strong> ${escapeHtml(payload.code)}<br>
          <strong>Message:</strong> ${escapeHtml(payload.message)}<br>
          Check library.json, search_maps, item.json, base_url, and image paths.
        </div>
      `;
    }
  }

  async function loadLibrary() {
    let data;
    try {
      data = await fetchJson(CONFIG.libraryFile);
    } catch (e) {
      throw appError(ERROR.LIBRARY_FETCH_FAILED, "Failed to fetch library.json", { cause: e.message });
    }

    if (!data || typeof data !== "object" || !Array.isArray(data.works)) {
      throw appError(ERROR.LIBRARY_INVALID, "library.json is invalid");
    }

    if (!data.works.length) {
      throw appError(ERROR.NO_WORKS_FOUND, "library.json has no works");
    }

    STATE.works = data.works.filter(Boolean);
    STATE.sourceMap = data.sources && typeof data.sources === "object" ? data.sources : {};
  }

  function getSourceBaseByKey(sourceKey) {
    return sourceKey ? normalizeBaseUrl(STATE.sourceMap[sourceKey] || "") : "";
  }

  function workNeedsBlockFallback(work) {
    if (!work) return true;
    if (!Array.isArray(work.entries)) return true;
    if (work.entries.length === 0) return true;
    return false;
  }

  function getPrimaryWorkBlockUrl(work) {
    const sourceBase = getSourceBaseByKey(work.source) || CONFIG.defaultWorksBase;
    const slug = work.slug;
    return `${sourceBase}/${encodeURIComponent(slug)}/manifest_work_block_${encodeURIComponent(slug)}.json`;
  }

  function getFallbackWorkBlockUrl(work) {
    if (!CONFIG.fallbackWorkBlockBase) return null;
    const slug = work.slug;
    return `${CONFIG.fallbackWorkBlockBase}/${encodeURIComponent(slug)}/manifest_work_block_${encodeURIComponent(slug)}.json`;
  }

  function mergeWorkData(libraryWork, blockWork) {
    return {
      id: libraryWork?.id ?? blockWork?.id ?? null,
      slug: libraryWork?.slug || blockWork?.slug || "",
      display: libraryWork?.display || blockWork?.display || titleCaseSlug(blockWork?.slug || ""),
      top_pill: libraryWork?.top_pill ?? blockWork?.top_pill ?? true,
      source: libraryWork?.source || blockWork?.source || "",
      use_map: libraryWork?.use_map === true,
      map_file: libraryWork?.map_file || null,
      entries: Array.isArray(libraryWork?.entries) && libraryWork.entries.length
        ? libraryWork.entries
        : (Array.isArray(blockWork?.entries) ? blockWork.entries : [])
    };
  }

  async function loadWorkBlockWithFallback(work) {
    const primaryUrl = getPrimaryWorkBlockUrl(work);
    const fallbackUrl = getFallbackWorkBlockUrl(work);

    try {
      return await fetchJson(primaryUrl);
    } catch (primaryErr) {
      if (!fallbackUrl) {
        throw appError(ERROR.WORK_BLOCK_FETCH_FAILED, "Primary work block fetch failed", {
          slug: work.slug,
          primaryUrl,
          cause: primaryErr.message
        });
      }

      try {
        return await fetchJson(fallbackUrl);
      } catch (fallbackErr) {
        throw appError(ERROR.WORK_BLOCK_FETCH_FAILED, "Primary and fallback work block fetch failed", {
          slug: work.slug,
          primaryUrl,
          fallbackUrl,
          primaryCause: primaryErr.message,
          fallbackCause: fallbackErr.message
        });
      }
    }
  }

  async function hydrateWorksFromBlocksIfNeeded() {
    const resolved = [];

    for (const work of STATE.works) {
      if (!workNeedsBlockFallback(work)) {
        resolved.push(work);
        continue;
      }

      try {
        const blockWork = await loadWorkBlockWithFallback(work);
        resolved.push(mergeWorkData(work, blockWork));
      } catch (err) {
        logError(err, `Work block fallback failed for ${work.slug}`);
        resolved.push(work);
      }
    }

    STATE.works = resolved;
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
      if (!map || typeof map !== "object" || Array.isArray(map)) {
        throw appError(ERROR.MAP_INVALID, `Invalid map for ${work.slug}`, { path });
      }
      STATE.maps.set(work.slug, map);
      return map;
    } catch (e) {
      logError(
        appError(
          e.code || ERROR.MAP_FETCH_FAILED,
          `Failed to load map for ${work.slug}`,
          { work: work.slug, path, cause: e.message }
        ),
        "Map"
      );
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
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }

  function sortChapterSlug(a, b) {
    const ma = String(a).match(/^chapter_(\d+)$/i);
    const mb = String(b).match(/^chapter_(\d+)$/i);
    if (ma && mb) return Number(ma[1]) - Number(mb[1]);
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }

  function getMapVolumeEntries(work) {
    const map = getMap(work);
    const chapterLocations = map?.chapter_locations;
    if (!chapterLocations || typeof chapterLocations !== "object") return [];

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
          map_first_chapter_slug: firstChapterSlug,
          chapter_numbers: Array.isArray(volumeMeta.chapter_numbers) ? volumeMeta.chapter_numbers : [],
          search_terms: Array.isArray(volumeMeta.search_terms) ? volumeMeta.search_terms : []
        };
      });
  }

  function getMapChapterEntries(work) {
    const map = getMap(work);
    const chapterLocations = map?.chapter_locations;
    if (!chapterLocations || typeof chapterLocations !== "object") return [];

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

    const mappedVolumes = getMapVolumeEntries(work);
    return mappedVolumes.length ? mappedVolumes : (Array.isArray(work.entries) ? work.entries : []);
  }

  function getChapterSequenceEntries(work) {
    if (!shouldUseMap(work)) {
      return Array.isArray(work.entries) ? work.entries : [];
    }

    const mappedChapters = getMapChapterEntries(work);
    return mappedChapters.length ? mappedChapters : (Array.isArray(work.entries) ? work.entries : []);
  }

  function getMappedChapterMeta(work, entry) {
    if (!shouldUseMap(work) || !entry) return null;
    const map = getMap(work);
    if (!map?.chapter_locations) return null;

    if (entry.type === "mapped_volume") {
      return map.chapter_locations?.[entry.volume_slug || entry.slug] || null;
    }

    if (entry.type === "mapped_chapter") {
      return map.chapter_locations?.[entry.volume_slug]?.chapters?.[entry.chapter_slug] || null;
    }

    return map.chapter_locations?.[entry.slug] || null;
  }

  function getChapterMeta(work, entry) {
    return getMappedChapterMeta(work, entry);
  }

  function getEntryDisplayLabel(work, entry) {
    if (entry?.map_display_label) return entry.map_display_label;
    const meta = getChapterMeta(work, entry);
    return meta?.display_label || entry?.subtitle || titleCaseSlug(entry?.slug || "");
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

  function isVisibleEntryCurrent(work, visibleEntry) {
    if (!work || !visibleEntry || !STATE.currentEntry) return false;

    if (visibleEntry.type === "mapped_volume") {
      return normalizeKey(visibleEntry.volume_slug || visibleEntry.slug) ===
             normalizeKey(STATE.currentEntry.volume_slug || STATE.currentEntry.slug);
    }

    return normalizeKey(visibleEntry.slug) === normalizeKey(STATE.currentEntry.slug);
  }

  function makeSearchRow(row) {
    return {
      type: row.type || "entry",
      workSlug: row.workSlug,
      workLabel: row.workLabel,
      entrySlug: row.entrySlug || "",
      entryLabel: row.entryLabel || "",
      subLabel: row.subLabel || "",
      page: row.page ?? null,
      zoneId: row.zoneId ?? null,
      searchKey: normalizeKey(row.searchKey || "")
    };
  }

  function buildSearchIndex() {
    try {
      const rows = [];

      for (const work of STATE.works) {
        const workLabel = work.display || titleCaseSlug(work.slug);
        const map = getMap(work);

        if (shouldUseMap(work)) {
          const volumeEntries = getVisibleEntries(work);
          const chapterEntries = getChapterSequenceEntries(work);

          for (const entry of volumeEntries) {
            const volumeMeta = getMappedChapterMeta(work, entry);

            rows.push(makeSearchRow({
              type: "entry",
              workSlug: work.slug,
              workLabel,
              entrySlug: entry.slug,
              entryLabel: getEntryDisplayLabel(work, entry),
              subLabel: "Mapped volume",
              searchKey: [
                workLabel,
                entry.slug,
                entry.subtitle || "",
                entry.map_display_label || "",
                ...(volumeMeta?.search_terms || []),
                ...(volumeMeta?.chapter_numbers || []).map(n => `chapter ${n}`)
              ].join(" ")
            }));
          }

          for (const entry of chapterEntries) {
            rows.push(makeSearchRow({
              type: "chapter",
              workSlug: work.slug,
              workLabel,
              entrySlug: entry.slug,
              entryLabel: getEntryDisplayLabel(work, entry),
              subLabel: entry.map_parent_label || "Mapped chapter",
              searchKey: [
                workLabel,
                entry.slug,
                entry.subtitle || "",
                entry.map_display_label || "",
                entry.map_parent_label || "",
                String(entry.chapter_number || ""),
                ...(entry.map_pages || []).map(p => p.local_name || "")
              ].join(" ")
            }));
          }
        } else {
          for (const entry of work.entries || []) {
            const chapterMeta = getChapterMeta(work, entry);

            rows.push(makeSearchRow({
              type: "entry",
              workSlug: work.slug,
              workLabel,
              entrySlug: entry.slug,
              entryLabel: getEntryDisplayLabel(work, entry),
              subLabel: entry.subtitle || "",
              searchKey: [
                workLabel,
                entry.slug,
                entry.subtitle || "",
                chapterMeta?.display_label || "",
                ...(chapterMeta?.search_terms || [])
              ].join(" ")
            }));
          }
        }

        if (!map) continue;

        for (const arc of (map.arcs || [])) {
          rows.push(makeSearchRow({
            type: "arc",
            workSlug: work.slug,
            workLabel,
            entrySlug: arc.target_entry_slug || arc.entry_slugs?.[0] || "",
            entryLabel: arc.label || "Arc",
            subLabel: `Arc · Chapters ${arc.chapter_start ?? "?"}-${arc.chapter_end ?? "?"}`,
            searchKey: [
              workLabel,
              arc.label || "",
              ...(arc.search_terms || [])
            ].join(" ")
          }));
        }

        for (const semantic of (map.semantic_links || [])) {
          rows.push(makeSearchRow({
            type: semantic.type || "tag_cluster",
            workSlug: work.slug,
            workLabel,
            entrySlug: semantic.entry_slug || "",
            entryLabel: semantic.label || "Semantic cluster",
            subLabel: semantic.summary || "Semantic cluster",
            searchKey: [
              workLabel,
              semantic.label || "",
              semantic.summary || "",
              ...(semantic.tags || []),
              ...(semantic.search_terms || [])
            ].join(" ")
          }));
        }

        for (const anno of (map.image_annotations || [])) {
          rows.push(makeSearchRow({
            type: "annotation",
            workSlug: work.slug,
            workLabel,
            entrySlug: anno.entry_slug || "",
            entryLabel: anno.label || "Annotation",
            subLabel: `Page ${anno.page ?? "?"}${anno.layer ? ` · ${anno.layer}` : ""}`,
            page: anno.page ?? null,
            zoneId: anno.id || null,
            searchKey: [
              workLabel,
              anno.label || "",
              anno.summary || "",
              ...(anno.tags || []),
              ...(anno.search_terms || [])
            ].join(" ")
          }));
        }
      }

      STATE.searchRows = rows;
    } catch (e) {
      throw appError(ERROR.SEARCH_INDEX_BUILD_FAILED, "Failed to build search index", { cause: e.message });
    }
  }

  function renderSearchResults(items) {
    const results = $("#chapterSearchResults");
    const stat = $("#chapterSearchStat");
    if (!results || !stat) return;

    if (!items.length) {
      results.innerHTML = "";
      stat.textContent = STATE.isMobileReader ? "Type to search" : "No matches";
      return;
    }

    stat.textContent = `${items.length} result${items.length === 1 ? "" : "s"}`;

    results.innerHTML = items.map(item => `
      <button
        class="search-result-pill search-result-pill--${escapeHtml(item.type)}"
        type="button"
        data-dir="${escapeHtml(item.workSlug)}"
        data-file="${escapeHtml(item.entrySlug)}"
        data-page="${item.page ?? ""}"
        data-zone="${escapeHtml(item.zoneId || "")}"
      >
        <span class="search-result-main">${escapeHtml(item.workLabel)} · ${escapeHtml(item.entryLabel)}</span>
        ${item.subLabel ? `<span class="search-result-sub">${escapeHtml(item.subLabel)}</span>` : ""}
      </button>
    `).join("");
  }

  function syncSearchSeed() {
    const input = $("#chapterSearchInput");
    const stat = $("#chapterSearchStat");
    const results = $("#chapterSearchResults");
    if (!input || !stat || !results) return;
    if (input.value.trim()) return;

    if (STATE.isMobileReader) {
      results.innerHTML = "";
      stat.textContent = "Type to search";
      return;
    }

    const seeded = STATE.searchRows
      .filter(item => item.workSlug === STATE.currentWork?.slug)
      .slice(0, CONFIG.searchResultsLimit);

    renderSearchResults(seeded);
    stat.textContent = seeded.length ? `Showing ${seeded.length} in this work` : "Ready to jump";
  }

  function wireSearch() {
    if (STATE.searchWired) return;
    STATE.searchWired = true;

    const input = $("#chapterSearchInput");
    const results = $("#chapterSearchResults");
    const stat = $("#chapterSearchStat");
    if (!input || !results || !stat) return;

    const refresh = () => {
      const query = normalizeKey(input.value);

      if (!query) {
        if (STATE.isMobileReader) {
          results.innerHTML = "";
          stat.textContent = "Type to search";
          return;
        }

        const seeded = STATE.searchRows
          .filter(item => item.workSlug === STATE.currentWork?.slug)
          .slice(0, CONFIG.searchResultsLimit);

        renderSearchResults(seeded);
        stat.textContent = seeded.length ? `Showing ${seeded.length} in this work` : "Ready to jump";
        return;
      }

      const matched = STATE.searchRows
        .filter(item => item.searchKey.includes(query))
        .slice(0, CONFIG.searchResultsLimit);

      renderSearchResults(matched);
      stat.textContent = matched.length ? `${matched.length} result${matched.length === 1 ? "" : "s"}` : "No matches";
    };

    input.addEventListener("input", refresh);

    results.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-dir][data-file]");
      if (!btn) return;

      input.value = "";
      if (STATE.isMobileReader) {
        results.innerHTML = "";
        stat.textContent = "Type to search";
        setMobileOpenWork(btn.dataset.dir);
      }

      await switchEntry(btn.dataset.dir, btn.dataset.file, false, { actionSource: "search" });

      const page = Number(btn.dataset.page || "");
      if (Number.isFinite(page) && page > 0) {
        setTimeout(() => scrollToPageIndex(page), 50);
      }
    });

    refresh();
  }

  function resolveSourceKey(work, entry) {
    return entry?.source || work?.source || "";
  }

  function getWorkBase(work, entry) {
    return normalizeBaseUrl(
      entry?.base_url ||
      getSourceBaseByKey(resolveSourceKey(work, entry)) ||
      work?.base_url ||
      CONFIG.defaultWorksBase
    );
  }

  function getItemJsonUrl(work, entry) {
    if (entry?.item_url) return entry.item_url;

    const path = String(entry?.path || entry?.slug || "");
    const safeParts = path.split("/").filter(Boolean).map(part => encodeURIComponent(part));
    return `${getWorkBase(work, entry)}/${encodeURIComponent(work.slug)}/${safeParts.join("/")}/${CONFIG.itemJsonName}`;
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

  function resolveSelectionFromQuery() {
    const url = new URL(window.location.href);
    const dir = url.searchParams.get("dir");
    const file = url.searchParams.get("file");
    if (!dir || !file) return null;
    return resolveSelection(dir, file);
  }

  function setQueryState(dir, file, replace = false) {
    const url = new URL(window.location.href);
    url.searchParams.set("dir", dir);
    url.searchParams.set("file", file);
    if (replace) history.replaceState({}, "", url);
    else history.pushState({}, "", url);
  }

  function getEntryIndex(work, entry) {
    const entries = shouldUseMap(work) ? getChapterSequenceEntries(work) : (work?.entries || []);
    return entries.findIndex(e => normalizeKey(e.slug) === normalizeKey(entry?.slug));
  }

  function getEntryByOffset(work, entry, offset) {
    const entries = shouldUseMap(work) ? getChapterSequenceEntries(work) : (work?.entries || []);
    const currentIndex = getEntryIndex(work, entry);
    if (currentIndex < 0) return null;
    return entries[currentIndex + offset] || null;
  }

  function getSubids(manifest) {
    const subids = manifest?.subids || {};
    return {
      work: Number(subids.work) || 1101,
      top: Number(subids.top) || 5865232,
      left: Number(subids.left) || 5865238,
      right: Number(subids.right) || 5865240,
      between: Number(subids.between) || 5867482
    };
  }

  function makeIns(zoneId) {
    const ins = document.createElement("ins");
    ins.className = "eas6a97888e2";
    ins.dataset.zoneid = String(zoneId);
    ins.style.display = "block";
    return ins;
  }

  function serveAdsSafe() {
    try {
      window.AdProvider = window.AdProvider || [];
      window.AdProvider.push({ serve: {} });
    } catch (err) {
      console.warn("Ad serve failed", err);
    }
  }

  function buildTopBanner(manifest) {
    const shell = document.getElementById("topBannerSlot") || document.querySelector(".top-banner-inner");
    if (!shell) return;

    const subids = getSubids(manifest);
    shell.innerHTML = "";
    shell.appendChild(makeIns(subids.top));
  }

  function fillRail(slotId, zoneId) {
    const slot = document.getElementById(slotId);
    if (!slot) return;

    slot.innerHTML = "";
    slot.classList.add("slot");
    slot.appendChild(makeIns(zoneId));
  }

  function buildRails(manifest) {
    const subids = getSubids(manifest);

    const LEFT_RAIL_IDS = [
      "leftRailSlot1","leftRailSlot2","leftRailSlot3","leftRailSlot4","leftRailSlot5","leftRailSlot6",
      "leftRailSlot7","leftRailSlot8","leftRailSlot9","leftRailSlot10","leftRailSlot11","leftRailSlot12"
    ];

    const RIGHT_RAIL_IDS = [
      "rightRailSlot1","rightRailSlot2","rightRailSlot3","rightRailSlot4","rightRailSlot5","rightRailSlot6",
      "rightRailSlot7","rightRailSlot8","rightRailSlot9","rightRailSlot10","rightRailSlot11","rightRailSlot12"
    ];

    for (const id of LEFT_RAIL_IDS) fillRail(id, subids.left);
    for (const id of RIGHT_RAIL_IDS) fillRail(id, subids.right);
  }

  function betweenAd(manifest, groupNumber, betweenSlots) {
    const subids = getSubids(manifest);
    const wrap = createEl("section", "between-grid");
    const count = Math.max(1, Number(betweenSlots) || 3);

    for (let i = 0; i < count; i += 1) {
      const slot = createEl("div", "slot between-slot");
      slot.dataset.group = String(groupNumber);
      slot.dataset.index = String(i + 1);
      slot.appendChild(makeIns(subids.between));
      wrap.appendChild(slot);
    }

    return wrap;
  }

  function endAds(manifest, finalBlock) {
    const subids = getSubids(manifest);
    const wrap = createEl("section", "end-grid");
    const count = Math.max(1, Number(finalBlock) || 6);

    for (let i = 0; i < count; i += 1) {
      const slot = createEl("div", "slot end-slot");
      slot.dataset.final = "1";
      slot.dataset.index = String(i + 1);
      slot.appendChild(makeIns(subids.between));
      wrap.appendChild(slot);
    }

    return wrap;
  }

  function setMobileOpenWork(workSlug) {
    STATE.mobileOpenWorkSlug = normalizeKey(workSlug || "");

    $$(".mobile-work-item").forEach(item => {
      const isOpen = normalizeKey(item.dataset.workSlug) === STATE.mobileOpenWorkSlug;
      item.classList.toggle("open", isOpen);
      item.classList.toggle("active", isOpen);
    });
  }

  function syncDialThumb() {
    if (!STATE.isMobileReader) return;

    const scrollEl = $("#worksNav");
    const track = $("#dialTrack");
    const thumb = $("#dialThumb");
    if (!scrollEl || !track || !thumb) return;

    const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    const thumbH = thumb.offsetHeight || 32;
    const maxTop = Math.max(0, track.clientHeight - thumbH);
    const ratio = maxScroll > 0 ? scrollEl.scrollTop / maxScroll : 0;
    thumb.style.top = `${maxTop * ratio}px`;
  }

  function renderWorksNav() {
    const nav = $("#worksNav");
    if (!nav) return;

    if (STATE.isMobileReader) {
      let html = "";

      for (const work of STATE.works.filter(w => w.top_pill !== false)) {
        const isActiveWork = normalizeKey(work.slug) === normalizeKey(STATE.currentWork?.slug);
        const isOpen = normalizeKey(work.slug) === normalizeKey(STATE.mobileOpenWorkSlug || STATE.currentWork?.slug);
        const entries = getVisibleEntries(work);

        html += `
          <section class="mobile-work-item${isActiveWork ? " active" : ""}${isOpen ? " open" : ""}" data-work-slug="${escapeHtml(work.slug)}">
            <button class="mobile-work-trigger" type="button" data-work-toggle="${escapeHtml(work.slug)}">
              <span class="label">${escapeHtml(work.display || titleCaseSlug(work.slug))}</span>
              <span class="count">${entries.length} ${entries.length === 1 ? "entry" : "entries"}</span>
            </button>
            <div class="mobile-chapters">
        `;

        for (const entry of entries) {
          const current = isActiveWork && isVisibleEntryCurrent(work, entry) ? " current" : "";

          html += `
            <button class="mobile-chapter-link${current}" type="button" data-dir="${escapeHtml(work.slug)}" data-file="${escapeHtml(entry.slug)}">
              ${escapeHtml(getEntryDisplayLabel(work, entry))}
            </button>
          `;
        }

        html += `</div></section>`;
      }

      nav.innerHTML = html;
      syncDialThumb();
      return;
    }

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
        const current = isActive && isVisibleEntryCurrent(work, entry) ? " current" : "";

        html += `
          <button class="topworks-link${current}" type="button" data-dir="${escapeHtml(work.slug)}" data-file="${escapeHtml(entry.slug)}">
            ${escapeHtml(getEntryDisplayLabel(work, entry))}
          </button>
        `;
      }

      html += `</div></div>`;
    }

    nav.innerHTML = html;
  }

  function wireNavClicks() {
    if (STATE.navWired) return;
    STATE.navWired = true;

    document.addEventListener("click", async (e) => {
      const workToggle = e.target.closest("[data-work-toggle]");
      if (workToggle) {
        const slug = workToggle.dataset.workToggle;
        if (STATE.isMobileReader) {
          const willOpen = normalizeKey(slug) !== STATE.mobileOpenWorkSlug;
          setMobileOpenWork(willOpen ? slug : "");
          syncDialThumb();
        }
        return;
      }

      const jump = e.target.closest("[data-dir][data-file]");
      if (!jump) return;
      await switchEntry(jump.dataset.dir, jump.dataset.file);
    });
  }

  function wireDial() {
    if (!STATE.isMobileReader || STATE.dialWired) return;
    STATE.dialWired = true;

    const scrollEl = $("#worksNav");
    const track = $("#dialTrack");
    const thumb = $("#dialThumb");
    if (!scrollEl || !track || !thumb) return;

    let dragging = false;
    let startY = 0;
    let startTop = 0;

    const onMove = (clientY) => {
      const thumbH = thumb.offsetHeight || 32;
      const maxTop = Math.max(0, track.clientHeight - thumbH);
      let nextTop = startTop + (clientY - startY);
      nextTop = Math.max(0, Math.min(maxTop, nextTop));
      thumb.style.top = `${nextTop}px`;

      const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      const ratio = maxTop > 0 ? nextTop / maxTop : 0;
      scrollEl.scrollTop = ratio * maxScroll;
    };

    thumb.addEventListener("pointerdown", (e) => {
      dragging = true;
      startY = e.clientY;
      startTop = parseFloat(thumb.style.top || "0");
      thumb.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    thumb.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      onMove(e.clientY);
    });

    thumb.addEventListener("pointerup", (e) => {
      dragging = false;
      thumb.releasePointerCapture?.(e.pointerId);
    });

    thumb.addEventListener("pointercancel", (e) => {
      dragging = false;
      thumb.releasePointerCapture?.(e.pointerId);
    });

    track.addEventListener("click", (e) => {
      if (e.target === thumb) return;
      const rect = track.getBoundingClientRect();
      const thumbH = thumb.offsetHeight || 32;
      const maxTop = Math.max(0, track.clientHeight - thumbH);
      let nextTop = e.clientY - rect.top - thumbH / 2;
      nextTop = Math.max(0, Math.min(maxTop, nextTop));
      thumb.style.top = `${nextTop}px`;

      const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      const ratio = maxTop > 0 ? nextTop / maxTop : 0;
      scrollEl.scrollTop = ratio * maxScroll;
    });

    scrollEl.addEventListener("scroll", syncDialThumb, { passive: true });
  }

  function getMappedImageList(entry) {
    return Array.isArray(entry?.map_pages) ? entry.map_pages : [];
  }

  function getMappedManifest(selection) {
    const pages = getMappedImageList(selection.entry);
    if (!pages.length) return null;

    return {
      id: selection.entry.slug,
      title: selection.work.display || titleCaseSlug(selection.work.slug),
      subtitle: getEntryDisplayLabel(selection.work, selection.entry),
      type: "chapter",
      pages: pages.length,
      images: pages.map((p) => p.url || p.r2_url || p.r2_path || ""),
      ads: {
        between_every: 0,
        between_slots: 0,
        final_block: 0
      },
      subids: {}
    };
  }

  function buildImageList(manifest) {
    if (Array.isArray(manifest.images) && manifest.images.length) return manifest.images;
    if (Array.isArray(manifest.files) && manifest.files.length) return manifest.files;
    if (Array.isArray(manifest.pages) && manifest.pages.length) {
      return manifest.pages.map(page => {
        if (typeof page === "string") return page;
        return page?.src || page?.file || page?.name || "";
      }).filter(Boolean);
    }
    if (Number.isInteger(manifest.pages) && manifest.pages > 0) {
      const pad = Number(manifest.padding) || 3;
      const ext = String(manifest.extension || "jpg").replace(/^\./, "");
      return Array.from({ length: manifest.pages }, (_, i) => `${String(i + 1).padStart(pad, "0")}.${ext}`);
    }
    return [];
  }

  function validateManifest(manifest, itemUrl) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw appError(ERROR.MANIFEST_INVALID, "item.json is not a valid object", { itemUrl });
    }

    const images = buildImageList(manifest);
    if (!images.length) {
      throw appError(ERROR.MANIFEST_NO_IMAGES, "No images found in item.json", { itemUrl });
    }

    const hasAbsoluteImages = images.every(img => /^https?:\/\//i.test(String(img || "")));
    const baseUrl = hasAbsoluteImages ? "" : normalizeBaseUrl(manifest.base_url);

    if (!hasAbsoluteImages && !baseUrl) {
      throw appError(ERROR.MANIFEST_NO_BASE_URL, "item.json missing base_url", { itemUrl });
    }

    return { manifest, baseUrl, images, hasAbsoluteImages };
  }

  function buildChapterMeta(manifest, imageCount) {
    const wrap = createEl("section", "chapter-meta");
    const title = createEl("h2", "chapter-meta-title", manifest.subtitle || manifest.title || "Reader");
    const sub = createEl("div", "chapter-meta-sub");
    sub.textContent = `${imageCount} page${imageCount === 1 ? "" : "s"}`;
    wrap.appendChild(title);
    wrap.appendChild(sub);
    return wrap;
  }

  function buildTraversal(position) {
    const nav = createEl("nav", `chapter-traversal chapter-traversal--${position}`);
    const prev = getEntryByOffset(STATE.currentWork, STATE.currentEntry, -1);
    const next = getEntryByOffset(STATE.currentWork, STATE.currentEntry, 1);

    const prevBtn = createEl("button", "chapter-traversal-btn");
    prevBtn.type = "button";
    prevBtn.textContent = prev ? `← ${getEntryDisplayLabel(STATE.currentWork, prev)}` : "← Previous";
    prevBtn.disabled = !prev;
    if (prev) {
      prevBtn.dataset.dir = STATE.currentWork.slug;
      prevBtn.dataset.file = prev.slug;
    }

    const cur = createEl("div", "chapter-traversal-current", getEntryDisplayLabel(STATE.currentWork, STATE.currentEntry));

    const nextBtn = createEl("button", "chapter-traversal-btn");
    nextBtn.type = "button";
    nextBtn.textContent = next ? `${getEntryDisplayLabel(STATE.currentWork, next)} →` : "Next →";
    nextBtn.disabled = !next;
    if (next) {
      nextBtn.dataset.dir = STATE.currentWork.slug;
      nextBtn.dataset.file = next.slug;
    }

    nav.append(prevBtn, cur, nextBtn);
    return nav;
  }

  function getImageAnnotationMap(work, entry) {
    const map = getMap(work);
    if (!map?.image_annotations?.length) return new Map();

    const targetSlug = entry?.type === "mapped_chapter"
      ? `${entry.volume_slug}__${entry.chapter_slug}`
      : entry?.slug;

    const lookup = new Map();
    for (const anno of map.image_annotations) {
      if (normalizeKey(anno.entry_slug || "") !== normalizeKey(targetSlug || "")) continue;
      const page = Number(anno.page || 0);
      if (!page) continue;
      if (!lookup.has(page)) lookup.set(page, []);
      lookup.get(page).push(anno);
    }
    return lookup;
  }

  function buildImageAnnotationBadge(pageNumber) {
    const annotations = getImageAnnotationMap(STATE.currentWork, STATE.currentEntry).get(pageNumber) || [];
    if (!annotations.length) return null;

    const badge = createEl("button", "image-annotation-badge", `+${annotations.length}`);
    badge.type = "button";
    badge.title = annotations.map(a => a.label || a.summary || "Annotation").join(" · ");
    badge.addEventListener("click", () => {
      const message = annotations.map(a => a.label || a.summary || "Annotation").join("\n");
      showToast(message);
    });
    return badge;
  }

  function updatePageProgressBar(percent) {
    const bar = $("#readerProgressBar");
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }

  function updateChapterProgress(pageNumber) {
    const stat = $("#chapterProgress");
    const total = buildImageList(STATE.currentManifest || {}).length || 0;
    if (!stat || !total) return;
    stat.textContent = `Page ${pageNumber}/${total}`;
  }

  function scrollToPageIndex(page) {
    const target = $(`.image-wrap[data-page="${page}"]`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function maybePrefetchNext() {
    if (STATE.nextPrefetch) return;

    const next = getEntryByOffset(STATE.currentWork, STATE.currentEntry, 1);
    if (!next) return;

    try {
      if (next.type === "mapped_chapter" && Array.isArray(next.map_pages) && next.map_pages.length) {
        const firstUrl = next.map_pages[0]?.url || next.map_pages[0]?.r2_url || "";
        if (firstUrl) {
          STATE.nextPrefetch = fetch(firstUrl, { cache: "force-cache" }).catch(() => null);
        }
        return;
      }

      const url = getItemJsonUrl(STATE.currentWork, next);
      STATE.nextPrefetch = fetch(url, { cache: "force-cache" }).catch(() => null);
    } catch {
      // ignore
    }
  }

  async function buildReader() {
    const reader = $("#reader");
    if (!reader) return;

    let selection = resolveSelectionFromQuery();
    if (!selection) {
      selection = resolveDefaultSelection();
    }

    if (!selection) {
      throw appError(ERROR.SELECTION_NOT_FOUND, "Could not resolve current work/entry");
    }

    STATE.currentWork = selection.work;
    STATE.currentEntry = selection.entry;
    STATE.nextPrefetch = null;

    let manifestRaw;
    let itemUrl = "";

    if (selection.entry.type === "mapped_chapter" && Array.isArray(selection.entry.map_pages)) {
      manifestRaw = getMappedManifest(selection);
    } else if (selection.entry.type === "mapped_volume") {
      const firstChapter = getFirstChapterEntryForVolume(selection.work, selection.entry.volume_slug || selection.entry.slug);
      if (!firstChapter) {
        throw appError(ERROR.SELECTION_NOT_FOUND, "Mapped volume has no chapter target", {
          work: selection.work.slug,
          entry: selection.entry.slug
        });
      }

      STATE.currentEntry = firstChapter;
      setQueryState(selection.work.slug, firstChapter.slug, true);
      manifestRaw = getMappedManifest({ work: selection.work, entry: firstChapter });
    } else {
      itemUrl = getItemJsonUrl(selection.work, selection.entry);

      try {
        manifestRaw = await fetchJson(itemUrl);
      } catch (e) {
        throw appError(ERROR.MANIFEST_FETCH_FAILED, "Failed to fetch item.json", {
          itemUrl,
          work: selection.work.slug,
          entry: selection.entry.slug,
          cause: e.message
        });
      }
    }

    const { manifest, baseUrl, images, hasAbsoluteImages } = validateManifest(manifestRaw, itemUrl);
    STATE.currentManifest = manifest;

    const workTitle = $("#workTitle");
    if (workTitle) {
      workTitle.textContent = `${selection.work.display || titleCaseSlug(selection.work.slug)} · ${getEntryDisplayLabel(selection.work, STATE.currentEntry)}`;
    }

    renderWorksNav();
    syncSearchSeed();

    buildTopBanner(manifest);
    buildRails(manifest);

    reader.innerHTML = "";
    reader.appendChild(buildTraversal("top"));
    reader.appendChild(buildChapterMeta(manifest, images.length));

    const betweenEvery = Number(manifest?.ads?.between_every) || 0;
    const betweenSlots = Number(manifest?.ads?.between_slots) || 3;
    const finalBlock = Number(manifest?.ads?.final_block) || 0;

    let groupNumber = 0;

    for (let i = 0; i < images.length; i += 1) {
      const pageNumber = i + 1;
      const wrap = createEl("article", "image-wrap");
      wrap.dataset.page = String(pageNumber);

      const img = new Image();
      img.loading = i < 2 ? "eager" : "lazy";
      img.decoding = "async";
      img.src = hasAbsoluteImages ? String(images[i]) : `${baseUrl}/${images[i]}`;
      img.alt = `${selection.work.display || selection.work.slug} · ${getEntryDisplayLabel(selection.work, STATE.currentEntry)} · Page ${pageNumber}`;
      wrap.appendChild(img);

      const badge = buildImageAnnotationBadge(pageNumber);
      if (badge) wrap.appendChild(badge);

      reader.appendChild(wrap);

      if (betweenEvery > 0 && pageNumber % betweenEvery === 0 && pageNumber < images.length) {
        groupNumber += 1;
        reader.appendChild(betweenAd(manifest, groupNumber, betweenSlots));
      }
    }

    if (finalBlock > 0) {
      reader.appendChild(endAds(manifest, finalBlock));
    }

    reader.appendChild(buildTraversal("bottom"));

    updatePageProgressBar(0);
    updateChapterProgress(0);

    setTimeout(() => {
      serveAdsSafe();
    }, 100);

    maybePrefetchNext();
  }

  async function switchEntry(dir, file, replace = false, meta = {}) {
    try {
      const selection = resolveSelection(dir, file);
      if (!selection) {
        throw appError(ERROR.SELECTION_NOT_FOUND, "Selection not found", { dir, file });
      }

      const finalEntry =
        selection.entry.type === "mapped_volume"
          ? (getFirstChapterEntryForVolume(selection.work, selection.entry.volume_slug || selection.entry.slug) || selection.entry)
          : selection.entry;

      setQueryState(selection.work.slug, finalEntry.slug, replace);
      STATE.currentWork = selection.work;
      STATE.currentEntry = finalEntry;

      if (STATE.isMobileReader) {
        setMobileOpenWork(selection.work.slug);
      }

      await buildReader();

      if (!meta.keepScroll) {
        window.scrollTo({ top: 0, behavior: "instant" });
      }
    } catch (e) {
      throw appError(ERROR.SWITCH_ENTRY_FAILED, "Failed to switch entry", {
        dir,
        file,
        cause: e.message
      });
    }
  }

  function wireProgress() {
    if (STATE.progressWired) return;
    STATE.progressWired = true;

    const onScroll = () => {
      const wraps = $$(".image-wrap");
      if (!wraps.length) return;

      const viewportH = window.innerHeight || document.documentElement.clientHeight || 1;
      let activePage = 1;
      let bestDelta = Infinity;

      wraps.forEach((wrap, idx) => {
        const rect = wrap.getBoundingClientRect();
        const delta = Math.abs(rect.top - 80);
        if (delta < bestDelta) {
          bestDelta = delta;
          activePage = idx + 1;
        }
      });

      const total = wraps.length;
      const percent = total > 1 ? ((activePage - 1) / (total - 1)) * 100 : 100;
      updatePageProgressBar(percent);
      updateChapterProgress(activePage);

      const doc = document.documentElement;
      const scrollTop = window.scrollY || doc.scrollTop || 0;
      const scrollHeight = Math.max(doc.scrollHeight - viewportH, 1);
      const nearBottom = scrollTop / scrollHeight >= CONFIG.prefetchThreshold;
      if (nearBottom) maybePrefetchNext();
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    onScroll();
  }

  function wireStickyBits() {
    if (STATE.stickyWired) return;
    STATE.stickyWired = true;

    const hero = $(".hero");
    const body = document.body;
    if (!hero || !body) return;

    const onScroll = () => {
      const rect = hero.getBoundingClientRect();
      body.classList.toggle("hero-past", rect.bottom <= 24);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    onScroll();
  }

  function showToast(message) {
    let shell = $("#toastShell");
    if (!shell) {
      shell = createEl("div");
      shell.id = "toastShell";
      document.body.appendChild(shell);
    }

    const toast = createEl("div", "toast");
    toast.textContent = message;
    shell.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 220);
    }, CONFIG.toastMs);
  }

  function wireHistory() {
    window.addEventListener("popstate", async () => {
      try {
        await buildReader();
      } catch (e) {
        showFatalError(e);
      }
    });
  }

  async function boot() {
    try {
      await loadLibrary();
      await hydrateWorksFromBlocksIfNeeded();
      await loadAllMaps();
      buildSearchIndex();

      wireNavClicks();
      wireSearch();
      wireDial();
      wireProgress();
      wireStickyBits();
      wireHistory();

      if (STATE.isMobileReader && !STATE.mobileOpenWorkSlug && STATE.works[0]) {
        setMobileOpenWork(STATE.works[0].slug);
      }

      await buildReader();
    } catch (e) {
      throw appError(ERROR.BOOT_FAILED, "Boot failed", { cause: e.message, inner: e.code || null });
    }
  }

  boot().catch(showFatalError);
})();
