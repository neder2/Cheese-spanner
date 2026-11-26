/**
 * Adds comment chapters to the current VOD's native comment menu and player.
 * Runs in the isolated world and keeps the selection for the current video in memory.
 */
(() => {
    "use strict";

    const root = window.CheeseSpanner;
    const namespace = root.vodComments;
    if (namespace.chapters) return;

    const { compactText, MIN_AUTOMATIC_CHAPTERS, parseCommentChapters, selectAutomaticChapterComment } =
        namespace.model;
    const { normalizeChzzkVideoNo, storageGet, storageSet } = root.utils;
    const DISMISSAL_KEY_PREFIX = "cheese-spanner:vod-comment-auto-chapters-dismissed:";
    const COMMENT_ROW = "[id^='commentBox-']";
    const COMMENT_MENU = "div[class*='_more_'] > ul[class*='_layer_']";
    const MENU_ITEM = "data-bcvc-chapter-menu-item";
    const SLIDER = ".pzp-pc__bottom > .pzp-pc__progress-slider";
    const SLIDER_MARKER = "data-bcvc-chapter-slider";
    const MASK = "--bcvc-chapter-mask";
    const CONTROLS = "data-bcvc-chapter-controls";
    const PREVIEW_DESCRIPTION = ".pzp-pc__seeking-preview > .pzp-seeking-preview__description";
    const PREVIEW_TITLE = "data-bcvc-chapter-preview-title";
    const OFFICIAL = ".pzp-pc--chapter, .pzp-chapter-slider";
    const STYLE_ID = "cheese-spanner-vod-comment-chapters-style";
    const STYLE = `
.pzp-pc:not(.pzp-pc--chapter, .pzp-pc--adbreak) .pzp-pc__progress-slider[${SLIDER_MARKER}] > .pzp-ui-slider__wrap
  > :is(.pzp-ui-progress__wrap, .pzp-ui-progress__entire-background) {
  mask-image:var(--bcvc-chapter-mask);
  mask-size:100% calc(100% + 32px);
  mask-position:center;
  mask-repeat:no-repeat;
  mask-clip:no-clip;
}
.pzp-pc .pzp-pc__bottom > [${CONTROLS}] {
  --bcvc-chapter-rail-gap:8px;
  position:absolute;
  inset-inline:0;
  z-index:1;
  height:18px;
  display:none;
  transform:translateY(calc(-100% - var(--bcvc-chapter-rail-gap)));
  pointer-events:none;
  direction:ltr;
}
.pzp-pc--controls.pzp-pc--seekable:not(.pzp-pc--chapter, .pzp-pc--adbreak, .pzp-pc--dialog, .pzp-pc--beforeplay, .pzp-pc--ended)
  .pzp-pc__bottom > [${SLIDER_MARKER}] + [${CONTROLS}] { display:flex; }
[${CONTROLS}] button {
  appearance:none;
  border:0;
  margin:0;
  cursor:pointer;
  color:#fff;
  font:inherit;
  pointer-events:auto;
}
.bcvc-chapter-segment {
  min-width:0;
  padding:0;
  background:transparent;
}
.bcvc-chapter-segment:is(:hover, :focus-visible) {
  --bcvc-chapter-highlight:rgba(255,255,255,.18);
  background:var(--bcvc-chapter-highlight);
  box-shadow:0 var(--bcvc-chapter-rail-gap) 0 var(--bcvc-chapter-highlight);
  border-radius:3px 3px 0 0;
}
.bcvc-chapter-segment:focus-visible {
  outline:2px solid #fff;
  outline-offset:-2px;
}
.bcvc-chapter-tooltip {
  position:absolute;
  bottom:calc(100% + 7px);
  padding:5px 9px;
  border-radius:6px;
  background:rgba(19,20,23,.94);
  color:#fff;
  font-size:12px;
  line-height:1.5;
  left:clamp(min(9rem, 35%), var(--bcvc-chapter-middle), max(calc(100% - 9rem), 65%));
  max-width:min(18rem, 70%);
  transform:translateX(-50%);
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  pointer-events:none;
  visibility:hidden;
}
.bcvc-chapter-segment:is(:hover, :focus-visible) > .bcvc-chapter-tooltip { visibility:visible; }
.pzp-pc--thumbnail:not(.pzp-pc--setting):has(.pzp-pc__seeking-preview:not(.pzp-seeking-preview--disable) > [${PREVIEW_TITLE}])
  .bcvc-chapter-segment:hover > .bcvc-chapter-tooltip { visibility:hidden; }
.pzp-pc:not(.pzp-pc--chapter) ${PREVIEW_DESCRIPTION}[${PREVIEW_TITLE}]::before {
  content:attr(${PREVIEW_TITLE});
  display:block;
  max-width:180px;
  margin-inline:auto;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  font-size:13px;
  font-weight:600;
  line-height:1.4;
  text-shadow:0 0 4px rgba(0,0,0,.6);
}
.pzp-pc:is(.pzp-pc--size-small, .pzp-pc--size-s) ${PREVIEW_DESCRIPTION}[${PREVIEW_TITLE}]::before { max-width:100px; }
button[data-bcvc-chapter-action]::before {
  content:"";
  flex:none;
  width:20px;
  height:20px;
  margin-right:6px;
  background:repeating-linear-gradient(to bottom,currentColor 0 1px,transparent 1px 4px) center/11px 9px no-repeat;
}
.bcvc-chapter-storage-error {
  display:block;
  padding:4px;
  color:var(--color-content-02,inherit);
  font-size:13px;
}
`;

    function makeSliderMask(chapters, duration) {
        const stops = ["#000 0%"];
        for (let index = 1; index < chapters.length; index += 1) {
            const seconds = chapters[index].seconds;
            const percent = (seconds / duration) * 100;
            const neighbor = Math.min(
                seconds - chapters[index - 1].seconds,
                (chapters[index + 1]?.seconds ?? duration) - seconds
            );
            const halfGap = `min(1.5px, ${(neighbor / duration) * 25}%)`;
            stops.push(`#000 calc(${percent}% - ${halfGap})`, `transparent calc(${percent}% - ${halfGap})`);
            stops.push(`transparent calc(${percent}% + ${halfGap})`, `#000 calc(${percent}% + ${halfGap})`);
        }
        return `linear-gradient(to right,${stops.join(",")},#000 100%)`;
    }

    function readNativeComment(row, area) {
        if (!row?.isConnected || row.closest("#commentArea") !== area) return null;
        const body = row.querySelector(":scope > [class*='_content_'] > [class*='_text_']");
        if (!body || body.matches("[class*='_is_dimmed_'], [class*='_is_report_']")) return null;
        // CHZZK renders a shortened string while the body has its own More button.
        const expander = body.querySelector(":scope > button[type='button'][class*='_button_more_']");
        if (expander) return { expander, chapters: [] };
        const text = body.innerText ?? body.textContent;
        return { expander: null, chapters: parseCommentChapters(text) };
    }

    function chaptersInVideo(chapters, duration) {
        return Number.isFinite(duration) && duration > 0
            ? chapters.filter(({ seconds }) => seconds < duration)
            : chapters;
    }

    function getDismissalKey(videoNo) {
        const id = normalizeChzzkVideoNo(videoNo);
        return id && !globalThis.chrome?.extension?.inIncognitoContext ? DISMISSAL_KEY_PREFIX + id : "";
    }

    function createCommentChapters({ getMainVideoElement, getVideoNo, injectStyleOnce, seek }) {
        let videoNo = "";
        let commentArea = null;
        let layout = null;
        let player = null;
        let slider = null;
        let media = null;
        let selection = null;
        let automaticEnabled = true;
        let automaticAllowed = true;
        let dismissalReady = true;
        let dismissalGeneration = 0;
        let pendingPopularComments = null;
        let previousVideoMedia = null;
        let pendingExpansion = null;
        let controls = null;
        let previewSlider = null;
        let previewDescription = null;
        let renderedSelection = null;
        let renderedDuration = 0;
        const menus = new Map();
        const menuVideos = new WeakMap();
        const emptyChapterMenus = new WeakSet();
        const pendingDismissals = new Set();
        const menuObserver = new MutationObserver(syncMenuMutations);
        const layoutObserver = new MutationObserver((mutations) => {
            if (
                !player?.isConnected ||
                !slider?.isConnected ||
                (controls && !controls.isConnected) ||
                mutations.some(changesPlayerControls)
            )
                syncPlayer();
        });
        const playerObserver = new MutationObserver(updateControls);
        const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(positionControls) : null;
        const mediaEvents = ["durationchange", "emptied", "loadedmetadata"];

        function changesPlayerControls({ addedNodes, removedNodes }) {
            const selector = ".pzp-pc, .pzp-pc__bottom, .pzp-pc__progress-slider, video";
            return [...addedNodes, ...removedNodes].some(
                (node) => node instanceof Element && (node.matches(selector) || node.querySelector(selector))
            );
        }

        function hasOfficialChapters() {
            return Boolean(player?.matches(OFFICIAL) || slider?.matches(OFFICIAL));
        }

        function showChapterPreview(event, title) {
            if (
                event.buttons ||
                event.currentTarget.parentElement !== controls ||
                videoNo !== getVideoNo() ||
                !slider?.isConnected ||
                hasOfficialChapters()
            )
                return;
            const description = player.querySelector(PREVIEW_DESCRIPTION);
            if (previewDescription !== description) {
                previewDescription?.removeAttribute(PREVIEW_TITLE);
                previewDescription = description;
            }
            if (previewDescription && previewDescription.getAttribute(PREVIEW_TITLE) !== title) {
                previewDescription.setAttribute(PREVIEW_TITLE, title);
            }
            const mouse = { clientX: event.clientX, clientY: event.clientY, view: window };
            if (previewSlider !== slider) {
                previewSlider = slider;
                // The native slider measures its track on mouseover before reading X on mousemove.
                slider.dispatchEvent(new MouseEvent("mouseover", mouse));
            }
            slider.dispatchEvent(new MouseEvent("mousemove", mouse));
        }

        function hideChapterPreview(relatedTarget = null) {
            previewDescription?.removeAttribute(PREVIEW_TITLE);
            previewDescription = null;
            const previousSlider = previewSlider;
            previewSlider = null;
            if (
                previousSlider?.isConnected &&
                !(relatedTarget instanceof Node && previousSlider.contains(relatedTarget))
            ) {
                previousSlider.dispatchEvent(new MouseEvent("mouseleave", { view: window }));
            }
        }

        function clearControls() {
            hideChapterPreview();
            controls?.remove();
            controls = null;
            renderedSelection = null;
            slider?.removeAttribute(SLIDER_MARKER);
            slider?.style.removeProperty(MASK);
        }

        function positionControls() {
            if (controls) controls.style.top = `${slider.offsetTop}px`;
        }

        function hasChapterStart(chapters) {
            return chaptersInVideo(chapters, media?.duration).some(({ seconds }) => seconds > 0);
        }

        function stopAutomaticSelection() {
            automaticAllowed = false;
            pendingPopularComments = null;
            previousVideoMedia = null;
        }

        function readAutomaticDismissal() {
            const generation = ++dismissalGeneration;
            const targetVideoNo = videoNo;
            const key = getDismissalKey(targetVideoNo);
            const local = globalThis.chrome?.storage?.local;
            dismissalReady = !key || !local;
            if (dismissalReady) return;
            if (pendingDismissals.has(key)) {
                stopAutomaticSelection();
                dismissalReady = true;
                return;
            }
            const finish = (dismissed) => {
                if (generation !== dismissalGeneration || targetVideoNo !== getVideoNo()) return;
                if (dismissed) stopAutomaticSelection();
                dismissalReady = true;
                updateControls();
            };
            storageGet(local, key).then(
                (values) => finish(values[key] === true),
                () => finish(true)
            );
        }

        function rememberAutomaticDismissal(menu) {
            const targetVideoNo = videoNo;
            const key = getDismissalKey(targetVideoNo);
            const local = globalThis.chrome?.storage?.local;
            if (!key || !local || pendingDismissals.has(key)) return;
            const item = menus.get(menu);
            pendingDismissals.add(key);
            storageSet(local, { [key]: true })
                .catch(() => {
                    if (videoNo !== targetVideoNo || videoNo !== getVideoNo() || !item?.isConnected) return;
                    const status = document.createElement("span");
                    status.className = "bcvc-chapter-storage-error";
                    status.setAttribute("role", "status");
                    status.textContent = "자동 챕터 해제 저장 실패";
                    item.append(status);
                })
                .finally(() => pendingDismissals.delete(key));
        }

        function offerPopularComments(resultVideoNo, items) {
            if (!automaticAllowed || videoNo !== resultVideoNo || videoNo !== getVideoNo()) return;
            pendingPopularComments = items;
            updateControls();
        }

        function setAutomaticEnabled(enabled) {
            if (automaticEnabled === enabled) return;
            automaticEnabled = enabled;
            updateControls();
        }

        function getActiveSelection() {
            return selection?.automatic && !automaticEnabled ? null : selection;
        }

        function applyChapters(rowId, chapters) {
            selection = { rowId, chapters };
            updateControls();
        }

        function completeExpansion() {
            if (!pendingExpansion) return;
            const { row, rowId, menu } = pendingExpansion;
            const comment = readNativeComment(row, commentArea);
            if (row.id !== rowId || videoNo !== getVideoNo() || !comment || hasOfficialChapters()) {
                pendingExpansion = null;
                return;
            }
            if (comment.expander) return;
            pendingExpansion = null;
            if (hasChapterStart(comment.chapters)) {
                applyChapters(rowId, comment.chapters);
            } else {
                emptyChapterMenus.add(menu);
                if (menu.isConnected) syncMenu(menu);
            }
        }

        function updateControls() {
            const duration = media?.duration;
            const official = hasOfficialChapters();
            const canShow =
                videoNo === getVideoNo() &&
                slider?.isConnected &&
                media?.isConnected &&
                !official &&
                !player.matches(".pzp-pc--adbreak") &&
                Number.isFinite(duration) &&
                duration > 0;
            const stillPreviousVideo =
                previousVideoMedia?.element === media && previousVideoMedia?.source === media?.currentSrc;
            if (media && !stillPreviousVideo) previousVideoMedia = null;
            if (official && selection?.automatic) selection = null;
            if (
                automaticEnabled &&
                dismissalReady &&
                canShow &&
                !stillPreviousVideo &&
                pendingPopularComments &&
                !player.matches(".pzp-pc--beforeplay")
            ) {
                const candidate = selectAutomaticChapterComment(pendingPopularComments, duration);
                stopAutomaticSelection();
                if (candidate)
                    selection = {
                        rowId: `commentBox-${candidate.commentId}`,
                        chapters: candidate.chapters,
                        automatic: true,
                    };
            }

            const activeSelection = getActiveSelection();
            for (const menu of menus.keys()) syncMenu(menu);
            if (!activeSelection || !canShow) {
                if (controls) clearControls();
                return;
            }
            if (controls?.isConnected && renderedSelection === activeSelection && renderedDuration === duration) {
                positionControls();
                return;
            }
            clearControls();
            const chapters = chaptersInVideo(activeSelection.chapters, duration);
            if (
                !chapters.some(({ seconds }) => seconds > 0) ||
                (activeSelection.automatic && chapters.length < MIN_AUTOMATIC_CHAPTERS)
            )
                return;
            if (chapters[0].seconds > 0) chapters.unshift({ seconds: 0, timecode: "0:00", title: "영상 시작" });

            controls = document.createElement("div");
            controls.setAttribute(CONTROLS, "");
            controls.setAttribute("role", "group");
            controls.setAttribute("aria-label", "댓글 챕터");
            controls.addEventListener("keydown", stopPlayerActivationKey);
            controls.addEventListener("keyup", stopPlayerActivationKey);
            controls.addEventListener("mouseleave", (event) => hideChapterPreview(event.relatedTarget));
            for (const [index, chapter] of chapters.entries()) {
                const segment = document.createElement("button");
                const end = chapters[index + 1]?.seconds ?? duration;
                const label = chapter.title ? `${chapter.timecode} ${chapter.title}` : chapter.timecode;
                segment.type = "button";
                segment.className = "bcvc-chapter-segment";
                segment.style.flex = `${(end - chapter.seconds) / duration} 1 0%`;
                segment.style.setProperty("--bcvc-chapter-middle", `${((chapter.seconds + end) / duration) * 50}%`);
                segment.setAttribute("aria-label", label);
                const tooltip = document.createElement("span");
                tooltip.className = "bcvc-chapter-tooltip";
                tooltip.setAttribute("aria-hidden", "true");
                tooltip.textContent = label;
                segment.append(tooltip);
                segment.addEventListener("mousemove", (event) =>
                    showChapterPreview(event, chapter.title || chapter.timecode)
                );
                segment.addEventListener("click", (event) => {
                    event.stopPropagation();
                    if (
                        segment.isConnected &&
                        videoNo === getVideoNo() &&
                        !hasOfficialChapters() &&
                        !player.matches(".pzp-pc--adbreak") &&
                        media === getMainVideoElement()
                    ) {
                        seek(chapter.seconds);
                    }
                });
                controls.append(segment);
            }
            slider.setAttribute(SLIDER_MARKER, "");
            slider.style.setProperty(MASK, makeSliderMask(chapters, duration));
            slider.after(controls);
            renderedSelection = activeSelection;
            renderedDuration = duration;
            positionControls();
        }

        function stopPlayerActivationKey(event) {
            if (event.key === " " || event.key === "Enter") event.stopPropagation();
        }

        function syncPlayer() {
            const nextPlayer = layout?.querySelector(":scope > .pzp-pc") ?? null;
            const nextSlider = nextPlayer?.querySelector(SLIDER) ?? null;
            const mainVideo = nextPlayer ? getMainVideoElement() : null;
            const nextMedia = nextPlayer?.contains(mainVideo) ? mainVideo : null;
            if (player !== nextPlayer) {
                playerObserver.disconnect();
                player = nextPlayer;
                if (player) playerObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
            }
            if (slider !== nextSlider) {
                clearControls();
                resizeObserver?.disconnect();
                slider = nextSlider;
                if (slider) resizeObserver?.observe(slider);
            }
            if (media !== nextMedia) {
                for (const event of mediaEvents) media?.removeEventListener(event, updateControls);
                media = nextMedia;
                for (const event of mediaEvents) media?.addEventListener(event, updateControls);
            }
            updateControls();
        }

        function syncMenu(menu) {
            const menuVideoNo = menuVideos.get(menu) ?? videoNo;
            if (!menu.isConnected || menuVideoNo !== videoNo) {
                menus.get(menu)?.remove();
                menus.delete(menu);
                return;
            }
            menuVideos.set(menu, menuVideoNo);
            if (!menus.has(menu)) menus.set(menu, null);
            const row = menu.closest(COMMENT_ROW);
            const rowId = row?.id;
            const comment = readNativeComment(row, commentArea);
            let item = menus.get(menu);
            const active = row?.closest("#commentArea") === commentArea && getActiveSelection()?.rowId === rowId;
            const available =
                comment && (comment.expander ? !comment.expander.disabled : hasChapterStart(comment.chapters));
            const empty = comment && !available && emptyChapterMenus.has(menu);
            if (!active && !available && !empty) {
                item?.remove();
                menus.set(menu, null);
                return;
            }
            if (!item?.isConnected) {
                const options = [...menu.querySelectorAll(":scope > li > button[class*='_option_']")];
                const report = options.find((button) => /^신고(?:하기)?$/.test(compactText(button.textContent)));
                const nativeOption = report ?? options.at(-1);
                if (!nativeOption) return;
                item = document.createElement("li");
                item.setAttribute(MENU_ITEM, "");
                const button = document.createElement("button");
                button.type = "button";
                button.className = [...nativeOption.classList].find((name) => name.startsWith("_option_"));
                button.setAttribute("data-bcvc-chapter-action", "");
                button.addEventListener("click", (event) => {
                    if (
                        !button.isConnected ||
                        videoNo !== menuVideoNo ||
                        videoNo !== getVideoNo() ||
                        button.closest(COMMENT_MENU) !== menu ||
                        menu.closest(COMMENT_ROW) !== row ||
                        row.id !== rowId ||
                        row.closest("#commentArea") !== commentArea
                    )
                        return;
                    stopAutomaticSelection();
                    pendingExpansion = null;
                    const activeSelection = getActiveSelection();
                    if (activeSelection?.rowId === rowId) {
                        if (activeSelection.automatic && event.isTrusted) rememberAutomaticDismissal(menu);
                        selection = null;
                        updateControls();
                        return;
                    }
                    if (!automaticEnabled && selection?.automatic) selection = null;
                    const latest = readNativeComment(row, commentArea);
                    if (!latest || hasOfficialChapters()) return;
                    if (latest.expander && !latest.expander.disabled) {
                        pendingExpansion = { row, rowId, menu };
                        latest.expander.click();
                        completeExpansion();
                    } else if (hasChapterStart(latest.chapters)) {
                        applyChapters(rowId, latest.chapters);
                    }
                });
                item.append(button);
                nativeOption.parentElement.after(item);
                menus.set(menu, item);
            }
            const button = item.firstElementChild;
            const official = !active && hasOfficialChapters();
            const label = active
                ? "챕터 해제"
                : official
                  ? "공식 챕터 사용 중"
                  : empty
                    ? "표시할 챕터 없음"
                    : "챕터 추가";
            if (button.textContent !== label) button.textContent = label;
            button.disabled = !active && (official || empty);
        }

        function syncMenuMutations(mutations) {
            completeExpansion();
            const candidates = new Set();
            for (const { target, addedNodes } of mutations) {
                if (target instanceof Element && target.closest(`[${MENU_ITEM}]`)) continue;
                const menu = target instanceof Element ? target.closest(COMMENT_MENU) : null;
                if (menu) candidates.add(menu);
                for (const node of addedNodes) {
                    if (!(node instanceof Element) || node.hasAttribute(MENU_ITEM)) continue;
                    if (node.matches(COMMENT_MENU)) candidates.add(node);
                    for (const child of node.querySelectorAll(COMMENT_MENU)) candidates.add(child);
                }
            }
            for (const [menu] of menus) if (!menu.isConnected) menus.delete(menu);
            for (const menu of candidates) syncMenu(menu);
        }

        function refresh(nextVideoNo) {
            if (videoNo !== nextVideoNo) {
                previousVideoMedia =
                    videoNo && nextVideoNo && media ? { element: media, source: media.currentSrc } : null;
                pendingExpansion = null;
                selection = null;
                automaticAllowed = true;
                pendingPopularComments = null;
                clearControls();
                videoNo = nextVideoNo;
                readAutomaticDismissal();
            }
            const nextArea = videoNo ? document.getElementById("commentArea") : null;
            if (commentArea !== nextArea) {
                pendingExpansion = null;
                menuObserver.disconnect();
                for (const item of menus.values()) item?.remove();
                menus.clear();
                commentArea = nextArea;
                if (commentArea) {
                    for (const menu of commentArea.querySelectorAll(COMMENT_MENU)) syncMenu(menu);
                    menuObserver.observe(commentArea, { childList: true, subtree: true });
                }
            }
            const nextLayout = videoNo ? document.getElementById("player_layout") : null;
            if (layout !== nextLayout) {
                layoutObserver.disconnect();
                layout = nextLayout;
                if (layout) layoutObserver.observe(layout, { childList: true, subtree: true });
            }
            if (videoNo) injectStyleOnce(STYLE_ID, STYLE);
            else document.getElementById(STYLE_ID)?.remove();
            syncPlayer();
        }

        return Object.freeze({ offerPopularComments, refresh, setAutomaticEnabled });
    }

    namespace.chapters = Object.freeze({ createCommentChapters });
})();
