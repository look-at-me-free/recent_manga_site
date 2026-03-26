(() => {
  "use strict";

  const PageMaker = {
    runtime: Object.create(null),
    payload: null,

    async initialize(payload) {
      this.payload = payload || {};
      this.runtime = Object.create(null);

      const works = Array.isArray(payload?.works) ? payload.works : [];
      for (const work of works) {
        try {
          const runtime = this.buildWorkRuntime(work);
          if (runtime) {
            this.runtime[work.slug] = runtime;
            this.runtime[String(work.slug).toLowerCase()] = runtime;
          }
        } catch (err) {
          console.error("[PageMaker] Failed to build runtime for", work?.slug, err);
        }
      }
    },

    async init(payload) {
      return this.initialize(payload);
    },

    async buildRuntime(payload) {
      return this.initialize(payload);
    },

    async prepare(payload) {
      return this.initialize(payload);
    },

    getWorkRuntime(work) {
      const slug = typeof work === "string" ? work : work?.slug;
      if (!slug) return null;
      return this.runtime[slug] || this.runtime[String(slug).toLowerCase()] || null;
    },

    getRuntimeForWork(work) {
      return this.getWorkRuntime(work);
    },

    getVisibleEntries(work) {
      return this.getWorkRuntime(work)?.visibleEntries || [];
    },

    getChapterEntries(work) {
      return this.getWorkRuntime(work)?.chapterEntries || [];
    },

    getEntryBySlug(work, slug) {
      const runtime = this.getWorkRuntime(work);
      if (!runtime || !slug) return null;
      return runtime.entryLookup[String(slug).toLowerCase()] || null;
    },

    getFirstChapterForVolume(work, volumeSlug) {
      const runtime = this.getWorkRuntime(work);
      if (!runtime || !volumeSlug) return null;
      const key = String(volumeSlug).toLowerCase();
      const val = runtime.volumeToFirstChapter[key];
      if (!val) return null;
      return typeof val === "string"
        ? runtime.entryLookup[String(val).toLowerCase()] || null
        : val;
    },

    getEntryMeta(work, entry) {
      const runtime = this.getWorkRuntime(work);
      if (!runtime || !entry) return null;
      return runtime.metaLookup[String(entry.slug).toLowerCase()] || null;
    },

    getDisplayLabel(work, entry) {
      const runtime = this.getWorkRuntime(work);
      if (!runtime || !entry) return "";
      const meta = runtime.metaLookup[String(entry.slug).toLowerCase()];
      return (
        meta?.display_label ||
        entry?.display_label ||
        entry?.map_display_label ||
        entry?.subtitle ||
        ""
      );
    },

    getSearchRows(work) {
      const runtime = this.getWorkRuntime(work);
      if (!runtime) return [];
      return runtime.searchRows || [];
    },

    getManifest(work, entry) {
      const runtime = this.getWorkRuntime(work);
      if (!runtime || !entry) return null;
      return runtime.manifests[String(entry.slug).toLowerCase()] || null;
    },

    buildWorkRuntime(work) {
      if (!this.shouldUseMap(work)) return null;

      const map = this.getMap(work);
      if (!map || typeof map !== "object") return null;

      const chapterLocations = map.chapter_locations;
      if (!chapterLocations || typeof chapterLocations !== "object") return null;

      const visibleEntries = [];
      const chapterEntries = [];
      const searchRows = [];
      const entryLookup = Object.create(null);
      const volumeToFirstChapter = Object.create(null);
      const manifests = Object.create(null);
      const metaLookup = Object.create(null);

      const volumeSlugs = Object.keys(chapterLocations).sort((a, b) => this.sortVolumeSlug(a, b));
      const workLabel = work?.display || this.titleCaseSlug(work?.slug || "");

      for (const volumeSlug of volumeSlugs) {
        const volumeMeta = chapterLocations[volumeSlug] || {};
        const volumeNumber = Number(this.extractNumber(volumeSlug)) || null;
        const volumeDisplay = volumeMeta.display_label || this.makeVolumeDisplay(volumeSlug, volumeMeta);
        const chapterNumbers = Array.isArray(volumeMeta.chapter_numbers)
          ? volumeMeta.chapter_numbers.map(n => Number(n)).filter(n => Number.isFinite(n))
          : [];
        const volumeSearchTerms = Array.isArray(volumeMeta.search_terms) ? volumeMeta.search_terms : [];
        const chaptersObj = volumeMeta.chapters && typeof volumeMeta.chapters === "object" ? volumeMeta.chapters : {};
        const chapterSlugs = Object.keys(chaptersObj).sort((a, b) => this.sortChapterSlug(a, b));

        if (!chapterSlugs.length) continue;

        const volumeEntry = {
          slug: volumeSlug,
          type: "mapped_volume",
          subtitle: volumeDisplay,
          display_label: volumeDisplay,
          map_display_label: volumeDisplay,
          volume_slug: volumeSlug,
          map_first_chapter_slug: chapterSlugs[0],
          chapter_numbers: chapterNumbers.slice(),
          search_terms: volumeSearchTerms.slice()
        };

        visibleEntries.push(volumeEntry);
        entryLookup[String(volumeEntry.slug).toLowerCase()] = volumeEntry;
        metaLookup[String(volumeEntry.slug).toLowerCase()] = {
          display_label: volumeDisplay,
          chapter_numbers: chapterNumbers.slice(),
          search_terms: volumeSearchTerms.slice(),
          type: "mapped_volume",
          volume_slug: volumeSlug
        };

        searchRows.push({
          type: "entry",
          workSlug: work.slug,
          workLabel,
          entrySlug: volumeEntry.slug,
          entryLabel: volumeDisplay,
          subLabel: "Mapped volume",
          searchKey: this.makeVolumeSearchKey({
            workLabel,
            workSlug: work.slug,
            volumeSlug,
            volumeNumber,
            volumeDisplay,
            chapterNumbers,
            extraTerms: volumeSearchTerms
          })
        });

        let firstChapterEntry = null;

        for (const chapterSlug of chapterSlugs) {
          const chapterMeta = chaptersObj[chapterSlug] || {};
          const chapterPages = Array.isArray(chapterMeta.pages) ? chapterMeta.pages : [];
          if (!chapterPages.length) continue;

          const chapterNumber = Number(chapterMeta.chapter_number ?? this.extractNumber(chapterSlug)) || null;
          const chapterDisplay =
            chapterMeta.display_label ||
            chapterMeta.subtitle ||
            (chapterNumber ? `Chapter ${chapterNumber}` : this.titleCaseSlug(chapterSlug));

          const syntheticSlug =
            chapterMeta.synthetic_slug ||
            `${volumeSlug}__${chapterSlug}`;

          const chapterEntry = {
            slug: syntheticSlug,
            type: "mapped_chapter",
            subtitle: chapterDisplay,
            display_label: chapterDisplay,
            map_display_label: chapterDisplay,
            map_parent_label: volumeDisplay,
            volume_slug: volumeSlug,
            chapter_slug: chapterSlug,
            chapter_number: chapterNumber,
            page_count: chapterPages.length,
            map_pages: chapterPages
          };

          chapterEntries.push(chapterEntry);
          entryLookup[String(chapterEntry.slug).toLowerCase()] = chapterEntry;

          const chapterSearchTerms = Array.isArray(chapterMeta.search_terms) ? chapterMeta.search_terms : [];
          const partsUsed = Array.isArray(chapterMeta.parts_used) ? chapterMeta.parts_used : [];

          metaLookup[String(chapterEntry.slug).toLowerCase()] = {
            display_label: chapterDisplay,
            chapter_number: chapterNumber,
            search_terms: chapterSearchTerms.slice(),
            parts_used: partsUsed.slice(),
            volume_slug: volumeSlug,
            chapter_slug: chapterSlug,
            type: "mapped_chapter"
          };

          if (!firstChapterEntry) firstChapterEntry = chapterEntry;

          const resolvedImageUrls = chapterPages
            .map(page => this.resolvePageUrl({ work, map, volumeSlug, volumeMeta, chapterSlug, chapterMeta, page }))
            .filter(Boolean);

          const manifest = this.makeManifest({
            work,
            map,
            volumeSlug,
            volumeMeta,
            chapterSlug,
            chapterMeta,
            chapterEntry,
            imageUrls: resolvedImageUrls
          });

          manifests[String(chapterEntry.slug).toLowerCase()] = manifest;

          searchRows.push({
            type: "chapter",
            workSlug: work.slug,
            workLabel,
            entrySlug: chapterEntry.slug,
            entryLabel: chapterDisplay,
            subLabel: volumeDisplay,
            searchKey: this.makeChapterSearchKey({
              workLabel,
              workSlug: work.slug,
              volumeSlug,
              volumeNumber,
              volumeDisplay,
              chapterSlug,
              chapterNumber,
              chapterDisplay,
              chapterEntrySlug: chapterEntry.slug,
              extraTerms: chapterSearchTerms,
              pageTerms: chapterPages.map(p => p?.local_name || p?.title || p?.name || "")
            })
          });
        }

        if (firstChapterEntry) {
          volumeToFirstChapter[String(volumeSlug).toLowerCase()] = firstChapterEntry.slug;
        }
      }

      if (!visibleEntries.length && !chapterEntries.length) return null;

      return {
        visibleEntries,
        chapterEntries,
        searchRows,
        entryLookup,
        volumeToFirstChapter,
        manifests,
        metaLookup
      };
    },

    makeManifest({ work, map, volumeSlug, volumeMeta, chapterSlug, chapterMeta, chapterEntry, imageUrls }) {
      const inheritedSubids =
        this.cloneObject(chapterMeta?.subids) ||
        this.cloneObject(volumeMeta?.subids) ||
        this.cloneObject(map?.subids) ||
        null;

      const inheritedAds =
        this.cloneObject(chapterMeta?.ads) ||
        this.cloneObject(volumeMeta?.ads) ||
        this.cloneObject(map?.ads) ||
        null;

      const imageCount = imageUrls.length;

      return {
        id: chapterMeta.id || `${work.slug}-${volumeSlug}-${chapterSlug}`,
        parent_work_id: work.id ?? null,
        parent_work_slug: work.slug,
        slug: chapterSlug,
        type: "chapter",
        title: chapterMeta.title || work.display || this.titleCaseSlug(work.slug),
        subtitle: chapterMeta.display_label || chapterEntry.display_label || chapterMeta.subtitle || this.titleCaseSlug(chapterSlug),
        base_url: chapterMeta.base_url || null,
        pages: imageCount,
        images: imageUrls,
        padding: Number(chapterMeta.padding) || 0,
        extension: chapterMeta.extension || this.guessExtensionFromImages(imageUrls) || "jpg",
        subids: inheritedSubids || {
          work: 1101,
          top: 5865232,
          left: 5865238,
          right: 5865240,
          between: 5867482
        },
        ads: inheritedAds || {
          between_every: 0,
          between_slots: 0,
          final_block: 0
        }
      };
    },

    resolvePageUrl({ work, map, volumeSlug, volumeMeta, chapterSlug, chapterMeta, page }) {
      if (!page) return "";

      const direct =
        page.url ||
        page.r2_url ||
        page.src ||
        page.image ||
        page.href;

      if (direct && this.isAbsoluteUrl(direct)) return direct;

      const publicBase =
        chapterMeta.public_base_url ||
        volumeMeta.public_base_url ||
        map.public_base_url ||
        map.base_url ||
        this.getSourceBaseByKey(work?.source);

      const relative =
        page.r2_path ||
        page.path ||
        page.relative_path ||
        page.file ||
        page.name ||
        "";

      if (this.isAbsoluteUrl(relative)) return relative;

      if (publicBase && relative) {
        return `${String(publicBase).replace(/\/+$/, "")}/${String(relative).replace(/^\/+/, "")}`;
      }

      return "";
    },

    makeVolumeDisplay(volumeSlug, volumeMeta) {
      const volumeNumber = Number(this.extractNumber(volumeSlug)) || null;
      const nums = Array.isArray(volumeMeta?.chapter_numbers)
        ? volumeMeta.chapter_numbers.map(n => Number(n)).filter(n => Number.isFinite(n))
        : [];

      if (volumeNumber && nums.length) {
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        if (min === max) return `Volume ${volumeNumber} - Chapter ${min}`;
        return `Volume ${volumeNumber} - Chapters ${min}-${max}`;
      }

      if (volumeNumber) return `Volume ${volumeNumber}`;
      return this.titleCaseSlug(volumeSlug);
    },

    makeVolumeSearchKey({ workLabel, workSlug, volumeSlug, volumeNumber, volumeDisplay, chapterNumbers, extraTerms }) {
      const terms = [];
      const add = (...vals) => {
        for (const v of vals.flat()) {
          const s = String(v ?? "").trim().toLowerCase();
          if (s) terms.push(s);
        }
      };

      add(workLabel, workSlug, volumeSlug, volumeDisplay);

      if (volumeNumber) {
        add(
          `volume ${volumeNumber}`,
          `${workLabel} volume ${volumeNumber}`,
          `${workSlug} volume ${volumeNumber}`,
          `${workLabel} vol ${volumeNumber}`,
          `${workSlug} vol ${volumeNumber}`
        );
      }

      if (chapterNumbers.length) {
        add(
          `${workLabel} chapters ${chapterNumbers.join(" ")}`,
          `${volumeDisplay} chapters ${chapterNumbers.join(" ")}`
        );
        for (const n of chapterNumbers) {
          add(
            `chapter ${n}`,
            `${workLabel} chapter ${n}`,
            `${workSlug} chapter ${n}`,
            volumeNumber ? `volume ${volumeNumber} chapter ${n}` : "",
            volumeNumber ? `${workLabel} volume ${volumeNumber} chapter ${n}` : "",
            volumeNumber ? `${workLabel} vol ${volumeNumber} chapter ${n}` : ""
          );
        }
      }

      add(extraTerms || []);

      return this.compactJoin(terms);
    },

    makeChapterSearchKey({ workLabel, workSlug, volumeSlug, volumeNumber, volumeDisplay, chapterSlug, chapterNumber, chapterDisplay, chapterEntrySlug, extraTerms, pageTerms }) {
      const terms = [];
      const add = (...vals) => {
        for (const v of vals.flat()) {
          const s = String(v ?? "").trim().toLowerCase();
          if (s) terms.push(s);
        }
      };

      add(workLabel, workSlug, volumeSlug, volumeDisplay, chapterSlug, chapterDisplay, chapterEntrySlug);

      if (chapterNumber) {
        add(
          `chapter ${chapterNumber}`,
          `${workLabel} chapter ${chapterNumber}`,
          `${workSlug} chapter ${chapterNumber}`,
          `${chapterDisplay} chapter ${chapterNumber}`,
          `chapter_${chapterNumber}`,
          `chapter-${chapterNumber}`,
          `${workLabel} ${chapterNumber}`,
          `${workSlug} ${chapterNumber}`
        );
      }

      if (volumeNumber) {
        add(
          `volume ${volumeNumber}`,
          `${workLabel} volume ${volumeNumber}`,
          `${workSlug} volume ${volumeNumber}`,
          `${workLabel} vol ${volumeNumber}`,
          `${workSlug} vol ${volumeNumber}`
        );

        if (chapterNumber) {
          add(
            `volume ${volumeNumber} chapter ${chapterNumber}`,
            `${workLabel} volume ${volumeNumber} chapter ${chapterNumber}`,
            `${workSlug} volume ${volumeNumber} chapter ${chapterNumber}`,
            `${workLabel} vol ${volumeNumber} chapter ${chapterNumber}`,
            `${workSlug} vol ${volumeNumber} chapter ${chapterNumber}`
          );
        }
      }

      add(extraTerms || []);
      add(pageTerms || []);

      return this.compactJoin(terms);
    },

    shouldUseMap(work) {
      const fn = this.payload?.helpers?.shouldUseMap;
      if (typeof fn === "function") return fn(work);
      return work?.use_map === true;
    },

    getMap(work) {
      const fn = this.payload?.helpers?.getMap;
      if (typeof fn === "function") return fn(work);
      const maps = this.payload?.maps;
      if (!maps || !work?.slug) return null;
      return maps.get(work.slug) || null;
    },

    getSourceBaseByKey(sourceKey) {
      const fn = this.payload?.helpers?.getSourceBaseByKey;
      if (typeof fn === "function") return fn(sourceKey);
      return "";
    },

    titleCaseSlug(slug) {
      const fn = this.payload?.helpers?.titleCaseSlug;
      if (typeof fn === "function") return fn(slug);
      return String(slug || "")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase());
    },

    sortVolumeSlug(a, b) {
      const ma = String(a).match(/^volume_(\d+)$/i);
      const mb = String(b).match(/^volume_(\d+)$/i);
      if (ma && mb) return Number(ma[1]) - Number(mb[1]);
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    },

    sortChapterSlug(a, b) {
      const ma = String(a).match(/^chapter_(\d+)$/i);
      const mb = String(b).match(/^chapter_(\d+)$/i);
      if (ma && mb) return Number(ma[1]) - Number(mb[1]);
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    },

    extractNumber(str) {
      const m = String(str || "").match(/(\d+)/);
      return m ? Number(m[1]) : 0;
    },

    guessExtensionFromImages(images) {
      const first = Array.isArray(images) ? images.find(Boolean) : "";
      const m = String(first || "").match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
      return m ? m[1].toLowerCase() : "";
    },

    cloneObject(obj) {
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
      return JSON.parse(JSON.stringify(obj));
    },

    isAbsoluteUrl(value) {
      return /^https?:\/\//i.test(String(value || ""));
    },

    compactJoin(parts) {
      return parts
        .flat()
        .map(v => String(v ?? "").trim())
        .filter(Boolean)
        .join(" ");
    }
  };

  window.PageMaker = PageMaker;
})();
