/**
 * features/vodComments/nativeAdapter.js — 치지직 원본 댓글 DOM을 측정하고 동작을 위임한다.
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트.
 * 의존: BetterChzzk.vodComments.model.
 */
(() => {
    "use strict";

    const root = (window.BetterChzzk = window.BetterChzzk || {});
    const namespace = (root.vodComments = root.vodComments || {});
    if (namespace.nativeAdapter) return;

    const model = namespace.model;
    const NATIVE_ACTION_HINT_ID = "betterchzzk-vod-comment-native-action-hint";
    const NATIVE_BUFF_BUTTON_CLASS_RE = /^_buff_button_[A-Za-z0-9_-]+$/;
    const NATIVE_BUFF_ICON_CLASS_RE = /^_buff_icon_[A-Za-z0-9_-]+$/;
    const NATIVE_BUFF_COUNT_CLASS_RE = /^_buff_count_[A-Za-z0-9_-]+$/;

    function createNativeAdapter({ onMeasurements = () => {} } = {}) {
        let commentPanel = null;
        let nativeCommentObserver = null;
        let observedNativeCommentArea = null;
        let nativeAssetsFrameId = 0;
        let syncAllNativeCommentAssets = false;
        let nativeBuffIconClassNames = null;
        const dirtyNativeCommentIds = new Set();

        function getNativeCommentElementById(commentId) {
            if (commentId === undefined || commentId === null || commentId === "") return null;
            const nativeRow = document.getElementById(`commentBox-${commentId}`);
            return nativeRow instanceof HTMLElement ? nativeRow : null;
        }

        function isOwnedByNativeCommentRow(element, nativeRow) {
            if (!(element instanceof Element) || !(nativeRow instanceof HTMLElement) || !nativeRow.contains(element)) {
                return false;
            }
            if (!nativeRow.matches("[id^='commentBox-']")) return true;
            return element.closest("[id^='commentBox-']") === nativeRow;
        }

        function findOwnedNativeElement(nativeRow, selector) {
            if (!(nativeRow instanceof HTMLElement)) return null;
            return (
                Array.from(nativeRow.querySelectorAll(selector)).find((element) =>
                    isOwnedByNativeCommentRow(element, nativeRow)
                ) || null
            );
        }

        function getNativeTimecodeButtons(nativeRow) {
            if (!(nativeRow instanceof HTMLElement)) return [];
            return Array.from(nativeRow.querySelectorAll("button")).filter(
                (button) =>
                    isOwnedByNativeCommentRow(button, nativeRow) &&
                    Number.isFinite(model.parseTimecodeSeconds(model.compactText(button.textContent)))
            );
        }

        function findNativeProfileControlsInRow(nativeRow) {
            if (!(nativeRow instanceof HTMLElement)) return { author: null, avatar: null };
            const candidates = Array.from(nativeRow.querySelectorAll("button, a[href], [role='button']")).filter(
                (control) => control instanceof HTMLElement && isOwnedByNativeCommentRow(control, nativeRow)
            );
            const avatarImage = findOwnedNativeElement(
                nativeRow,
                "img[width='36'][height='36'], img[width='36px'][height='36px']"
            );
            const imageControl = avatarImage?.closest("button, a[href], [role='button']");
            const avatar =
                (imageControl instanceof HTMLElement && nativeRow.contains(imageControl) ? imageControl : null) ||
                candidates.find((control) => {
                    const className = String(control.className || "");
                    if (/(?:^|\s)_thumbnail_[A-Za-z0-9_-]+(?:\s|$)/.test(className)) return true;
                    if (control.hasAttribute("aria-pressed") || model.compactText(control.textContent)) return false;
                    return Boolean(control.querySelector(":scope > span, :scope > picture, :scope > img"));
                }) ||
                null;
            const author =
                candidates.find((control) => {
                    if (control === avatar || control.hasAttribute("aria-pressed")) return false;
                    const className = String(control.className || "");
                    return (
                        /(?:^|\s)_information_[A-Za-z0-9_-]+(?:\s|$)/.test(className) ||
                        Boolean(control.querySelector("strong"))
                    );
                }) || null;
            const shared = author || avatar;
            return { author: author || shared, avatar: avatar || shared };
        }

        function getNativeBuffButtonInRow(nativeRow) {
            if (!(nativeRow instanceof HTMLElement)) return null;
            for (const button of nativeRow.querySelectorAll("button[aria-pressed]")) {
                if (!isOwnedByNativeCommentRow(button, nativeRow)) continue;
                const accessibleText = model.compactText(
                    `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${
                        button.querySelector(".blind, [class*='blind'], [class*='sr-only']")?.textContent || ""
                    } ${button.textContent || ""}`
                );
                if (/(^|\s)버프(?:\s|$)/.test(accessibleText)) return button;
            }
            return null;
        }

        function isNativeControlAvailable(control) {
            return Boolean(
                control instanceof HTMLElement &&
                control.isConnected &&
                !control.matches(":disabled, [aria-disabled='true']")
            );
        }

        function syncMirroredControlAvailability(control, nativeControl, enabledTitle, disabledTitle) {
            if (!(control instanceof HTMLButtonElement)) return;
            const enabled = isNativeControlAvailable(nativeControl);
            control.disabled = !enabled;
            control.title = enabled ? enabledTitle : disabledTitle;
            if (enabled) control.removeAttribute("aria-describedby");
            else control.setAttribute("aria-describedby", NATIVE_ACTION_HINT_ID);
        }

        function getNativeBuffCount(nativeButton) {
            if (!(nativeButton instanceof HTMLElement)) return null;
            const siblingCount = Array.from(nativeButton.parentElement?.children || []).find(
                (element) =>
                    element !== nativeButton &&
                    [...element.classList].some((className) => NATIVE_BUFF_COUNT_CLASS_RE.test(className))
            );
            const siblingText = model.compactText(siblingCount?.textContent);
            if (/^[\d,]+$/.test(siblingText)) {
                const count = Number(siblingText.replaceAll(",", ""));
                if (Number.isSafeInteger(count) && count >= 0) return count;
            }

            const text = model.compactText(
                `${nativeButton.getAttribute("aria-label") || ""} ${nativeButton.getAttribute("title") || ""} ${
                    nativeButton.textContent || ""
                }`
            );
            const match = text.match(/버프\s*([\d,]+)/);
            if (!match) return null;
            const count = Number(match[1].replaceAll(",", ""));
            return Number.isSafeInteger(count) && count >= 0 ? count : null;
        }

        function syncMirroredBuffCount(mirroredBuff, nativeButton) {
            if (!(mirroredBuff instanceof HTMLButtonElement)) return;
            const count = getNativeBuffCount(nativeButton);
            if (count === null) return;
            mirroredBuff.setAttribute("data-bcvc-count", String(count));

            let countElement = mirroredBuff.querySelector(".bcvc-buff-count");
            if (count > 0) {
                if (!(countElement instanceof HTMLElement)) {
                    countElement = document.createElement("span");
                    countElement.className = "bcvc-buff-count";
                    countElement.setAttribute("aria-hidden", "true");
                    mirroredBuff.appendChild(countElement);
                }
                countElement.textContent = count.toLocaleString();
            } else {
                countElement?.remove();
            }
            const label = `버프 ${count.toLocaleString()}`;
            mirroredBuff.setAttribute("aria-label", label);
            if (!mirroredBuff.disabled) mirroredBuff.title = label;
        }

        function syncMirroredBuffButtonClass(mirroredBuff, nativeButton) {
            if (!(mirroredBuff instanceof HTMLButtonElement)) return;
            for (const className of [...mirroredBuff.classList]) {
                if (NATIVE_BUFF_BUTTON_CLASS_RE.test(className)) mirroredBuff.classList.remove(className);
            }
            if (!(nativeButton instanceof HTMLButtonElement)) return;
            for (const className of nativeButton.classList) {
                if (NATIVE_BUFF_BUTTON_CLASS_RE.test(className)) mirroredBuff.classList.add(className);
            }
        }

        function isNativeDefaultProfileUrl(url) {
            return /\/default_profile_(?:light|dark)\.png(?:[?#]|$)/i.test(url);
        }

        function getNativeAvatarUrlFromRow(nativeRow, avatarControl) {
            const image =
                avatarControl?.querySelector("img") ||
                findOwnedNativeElement(nativeRow, "img[width='36'][height='36'], img[width='36px'][height='36px']");
            return image instanceof HTMLImageElement
                ? model.normalizeImageUrl(image.currentSrc || image.src, location.href)
                : "";
        }

        function getNativeAvatarBackground(avatarControl) {
            if (!(avatarControl instanceof HTMLElement)) return null;
            const visual = avatarControl.querySelector(":scope > span, :scope > picture, :scope > i") || avatarControl;
            const style = getComputedStyle(visual);
            if (!style.backgroundImage || style.backgroundImage === "none") return null;
            if (/\/default_profile_(?:light|dark)\.png/i.test(style.backgroundImage)) return null;
            return {
                backgroundImage: style.backgroundImage,
                backgroundPosition: style.backgroundPosition,
                backgroundRepeat: style.backgroundRepeat,
                backgroundSize: style.backgroundSize,
            };
        }

        function showMirroredAvatarImage(avatar, url) {
            let image = avatar.querySelector(".bcvc-avatar-image");
            if (!(image instanceof HTMLImageElement)) {
                image = document.createElement("img");
                image.className = "bcvc-avatar-image";
                image.alt = "";
                image.width = 36;
                image.height = 36;
                image.loading = "lazy";
                image.draggable = false;
                avatar.prepend(image);
            }
            if (image.src !== url) image.src = url;
            avatar.querySelector(".bcvc-avatar-native-visual")?.remove();
            avatar.classList.remove("bcvc-avatar-fallback");
        }

        function restoreMirroredAvatarFallback(avatar) {
            avatar.querySelector(".bcvc-avatar-native-visual")?.remove();
            const apiUrl = model.normalizeImageUrl(avatar.getAttribute("data-bcvc-api-avatar-url"), location.href);
            if (apiUrl && !isNativeDefaultProfileUrl(apiUrl)) {
                showMirroredAvatarImage(avatar, apiUrl);
                return;
            }
            avatar.querySelector(".bcvc-avatar-image")?.remove();
            avatar.classList.add("bcvc-avatar-fallback");
        }

        function syncMirroredAvatarVisual(avatar, nativeRow, avatarControl) {
            if (!(avatar instanceof HTMLButtonElement)) return;
            const url = nativeRow instanceof HTMLElement ? getNativeAvatarUrlFromRow(nativeRow, avatarControl) : "";
            if (url && !isNativeDefaultProfileUrl(url)) {
                showMirroredAvatarImage(avatar, url);
                return;
            }

            const background = getNativeAvatarBackground(avatarControl);
            if (!background) {
                restoreMirroredAvatarFallback(avatar);
                return;
            }
            avatar.querySelector(".bcvc-avatar-image")?.remove();
            let visual = avatar.querySelector(".bcvc-avatar-native-visual");
            if (!(visual instanceof HTMLElement)) {
                visual = document.createElement("span");
                visual.className = "bcvc-avatar-native-visual";
                visual.setAttribute("aria-hidden", "true");
                avatar.prepend(visual);
            }
            for (const [property, value] of Object.entries(background)) visual.style[property] = value;
            avatar.classList.remove("bcvc-avatar-fallback");
        }

        function findNativeBuffIcon() {
            const commentArea = document.getElementById("commentArea");
            if (!(commentArea instanceof HTMLElement)) return null;
            const icon = getNativeBuffButtonInRow(commentArea)?.querySelector("i");
            return icon instanceof HTMLElement ? icon : null;
        }

        function getNativeBuffIconClassNames() {
            if (nativeBuffIconClassNames?.length) return nativeBuffIconClassNames;
            const nativeIcon = findNativeBuffIcon();
            if (!nativeIcon) return null;
            const classNames = [...nativeIcon.classList].filter((className) =>
                NATIVE_BUFF_ICON_CLASS_RE.test(className)
            );
            if (!classNames.length) return null;
            nativeBuffIconClassNames = Object.freeze(classNames);
            return nativeBuffIconClassNames;
        }

        function createNativeBuffIcon() {
            const classNames = getNativeBuffIconClassNames();
            if (!classNames?.length) return null;
            const icon = document.createElement("i");
            icon.className = `${classNames.join(" ")} bcvc-buff-icon bcvc-buff-native-icon`;
            icon.setAttribute("aria-hidden", "true");
            return icon;
        }

        function syncMirroredTimecodes(mirroredRow, nativeRow) {
            const message = Array.from(mirroredRow.children).find((child) => child.classList.contains("bcvc-message"));
            const mirrored = Array.from(message?.querySelectorAll("[data-bcvc-action='time']") || []);
            if (!mirrored.length) return;
            const native = getNativeTimecodeButtons(nativeRow);
            mirrored.forEach((button, index) => {
                const nativeButton = native[index];
                if (!(nativeButton instanceof HTMLButtonElement)) return;
                const label = model.compactText(nativeButton.textContent);
                const seconds = model.parseTimecodeSeconds(label);
                if (!Number.isFinite(seconds)) return;
                button.textContent = label;
                button.setAttribute("data-bcvc-seconds", String(seconds));
                button.setAttribute("aria-label", `${label}로 이동`);
            });
        }

        function measureNativeAppearance() {
            const firstNativeRow = document.querySelector("#commentArea [id^='commentBox-']");
            const typographyTarget = firstNativeRow || document.getElementById("commentArea");
            const measurements = {};
            if (typographyTarget instanceof HTMLElement) {
                measurements.fontFamily = getComputedStyle(typographyTarget).fontFamily;
            }
            const nativeSortButton = Array.from(document.querySelectorAll("#commentArea button")).find((button) =>
                model.SORT_OPTIONS.some((option) => option.label === model.compactText(button.textContent))
            );
            if (nativeSortButton instanceof HTMLElement) {
                measurements.toolbarFontFamily = getComputedStyle(nativeSortButton).fontFamily;
            }
            if (firstNativeRow instanceof HTMLElement) {
                const { author } = findNativeProfileControlsInRow(firstNativeRow);
                const authorTarget = author?.querySelector("strong") || author;
                const dateTarget = Array.from(author?.children || []).find(
                    (element) => element !== authorTarget && model.compactText(element.textContent)
                );
                const contentTarget = findOwnedNativeElement(firstNativeRow, ":scope > [class*='_content_']");
                const messageTarget =
                    contentTarget?.querySelector(":scope > [class*='_text_']") ||
                    contentTarget?.querySelector("[class*='_text_']") ||
                    contentTarget;
                measurements.typography = {};
                for (const [prefix, target] of [
                    ["author", authorTarget],
                    ["date", dateTarget],
                    ["message", messageTarget],
                ]) {
                    if (!(target instanceof HTMLElement)) continue;
                    const style = getComputedStyle(target);
                    measurements.typography[prefix] = {
                        fontSize: style.fontSize,
                        fontWeight: style.fontWeight,
                        letterSpacing: style.letterSpacing,
                        lineHeight: style.lineHeight,
                    };
                }
            }
            onMeasurements(measurements);
        }

        function syncNativeCommentAssets(commentIds = null) {
            if (!(commentPanel instanceof HTMLElement) || !commentPanel.isConnected) return;
            if (getNativeBuffIconClassNames()) {
                for (const fallback of commentPanel.querySelectorAll(".bcvc-buff-label")) {
                    const nativeIcon = createNativeBuffIcon();
                    if (nativeIcon) fallback.replaceWith(nativeIcon);
                }
            }

            for (const row of commentPanel.querySelectorAll("[data-bcvc-comment-id]")) {
                const commentId = row.getAttribute("data-bcvc-comment-id") || "";
                if (commentIds instanceof Set && !commentIds.has(commentId)) continue;
                const nativeRow = getNativeCommentElementById(commentId);
                syncMirroredTimecodes(row, nativeRow);
                const profileControls = findNativeProfileControlsInRow(nativeRow);
                const mirroredAvatar = row.querySelector(":scope > .bcvc-avatar[data-bcvc-action='profile']");
                if (mirroredAvatar instanceof HTMLButtonElement) {
                    const label = mirroredAvatar.getAttribute("aria-label") || "프로필 보기";
                    syncMirroredControlAvailability(
                        mirroredAvatar,
                        profileControls.avatar,
                        label,
                        "하단 원본 댓글이 표시되면 프로필을 볼 수 있습니다."
                    );
                    syncMirroredAvatarVisual(mirroredAvatar, nativeRow, profileControls.avatar);
                }
                const mirroredAuthor = row.querySelector(
                    ":scope > .bcvc-meta > .bcvc-author[data-bcvc-action='profile']"
                );
                if (mirroredAuthor instanceof HTMLButtonElement) {
                    const label = mirroredAuthor.getAttribute("aria-label") || "프로필 보기";
                    syncMirroredControlAvailability(
                        mirroredAuthor,
                        profileControls.author,
                        label,
                        "하단 원본 댓글이 표시되면 프로필을 볼 수 있습니다."
                    );
                }

                const nativeBuffButton = getNativeBuffButtonInRow(nativeRow);
                const mirroredBuff = row.querySelector(":scope > .bcvc-comment-footer .bcvc-buff");
                if (mirroredBuff instanceof HTMLButtonElement) {
                    syncMirroredBuffButtonClass(mirroredBuff, nativeBuffButton);
                    syncMirroredBuffCount(mirroredBuff, nativeBuffButton);
                    const label = mirroredBuff.getAttribute("aria-label") || "버프";
                    syncMirroredControlAvailability(
                        mirroredBuff,
                        nativeBuffButton,
                        label,
                        "하단 원본 댓글이 표시되면 버프할 수 있습니다."
                    );
                    mirroredBuff.setAttribute(
                        "aria-pressed",
                        nativeBuffButton?.getAttribute("aria-pressed") === "true" ? "true" : "false"
                    );
                }
            }
        }

        function syncAll() {
            measureNativeAppearance();
            syncNativeCommentAssets();
        }

        function scheduleSync(commentIds = null) {
            if (commentIds === null) {
                syncAllNativeCommentAssets = true;
                dirtyNativeCommentIds.clear();
            } else if (!syncAllNativeCommentAssets) {
                for (const commentId of commentIds) {
                    if (commentId) dirtyNativeCommentIds.add(String(commentId));
                }
            }
            if (nativeAssetsFrameId) return;
            nativeAssetsFrameId = requestAnimationFrame(() => {
                nativeAssetsFrameId = 0;
                const ids = syncAllNativeCommentAssets ? null : new Set(dirtyNativeCommentIds);
                syncAllNativeCommentAssets = false;
                dirtyNativeCommentIds.clear();
                if (ids === null) measureNativeAppearance();
                syncNativeCommentAssets(ids);
            });
        }

        function cancelScheduledSync() {
            if (nativeAssetsFrameId) cancelAnimationFrame(nativeAssetsFrameId);
            nativeAssetsFrameId = 0;
            syncAllNativeCommentAssets = false;
            dirtyNativeCommentIds.clear();
        }

        function addNativeCommentIdFromNode(commentIds, node, { includeDescendants = false } = {}) {
            const nodeElement = node instanceof Element ? node : null;
            const element = nodeElement || node?.parentElement;
            if (!(element instanceof Element)) return;
            const row = element.matches("[id^='commentBox-']") ? element : element.closest("[id^='commentBox-']");
            if (row?.id.startsWith("commentBox-")) commentIds.add(row.id.slice("commentBox-".length));
            if (!includeDescendants || !nodeElement) return false;
            let includesCommentRow = nodeElement.matches("[id^='commentBox-']");
            for (const descendant of nodeElement.querySelectorAll("[id^='commentBox-']")) {
                commentIds.add(descendant.id.slice("commentBox-".length));
                includesCommentRow = true;
            }
            return includesCommentRow;
        }

        function classifyNativeMutations(mutations) {
            const commentIds = new Set();
            const firstNativeRow = document.querySelector("#commentArea [id^='commentBox-']");
            let requiresFullSync = false;
            for (const mutation of mutations) {
                addNativeCommentIdFromNode(commentIds, mutation.target);
                let changesCommentRows = mutation.type === "attributes" && mutation.attributeName === "id";
                if (mutation.type === "childList") {
                    for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
                        if (addNativeCommentIdFromNode(commentIds, node, { includeDescendants: true })) {
                            changesCommentRows = true;
                        }
                    }
                }
                if (changesCommentRows || mutationCouldChangeNativeCommentTypography(mutation, firstNativeRow)) {
                    requiresFullSync = true;
                }
            }
            return { commentIds, requiresFullSync };
        }

        function mutationCouldChangeNativeCommentTypography(mutation, firstNativeRow) {
            if (!(firstNativeRow instanceof HTMLElement)) return false;
            const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
            if (!(target instanceof Element)) return false;
            const owner = target.matches("[id^='commentBox-']") ? target : target.closest("[id^='commentBox-']");
            if (owner !== firstNativeRow) return false;
            if (mutation.type === "childList") return true;
            return mutation.type === "attributes" && ["class", "style"].includes(mutation.attributeName);
        }

        function disconnectNativeCommentObserver() {
            nativeCommentObserver?.disconnect();
            nativeCommentObserver = null;
            observedNativeCommentArea = null;
        }

        function refresh() {
            const nextCommentArea = document.getElementById("commentArea");
            if (nextCommentArea === observedNativeCommentArea && nativeCommentObserver) {
                scheduleSync();
                return;
            }
            disconnectNativeCommentObserver();
            nativeBuffIconClassNames = null;
            if (!(nextCommentArea instanceof HTMLElement) || !(commentPanel instanceof HTMLElement)) {
                scheduleSync();
                return;
            }
            observedNativeCommentArea = nextCommentArea;
            nativeCommentObserver = new MutationObserver((mutations) => {
                const { commentIds, requiresFullSync } = classifyNativeMutations(mutations);
                if (requiresFullSync) {
                    nativeBuffIconClassNames = null;
                    scheduleSync();
                } else if (commentIds.size) {
                    scheduleSync(commentIds);
                } else {
                    scheduleSync();
                }
            });
            nativeCommentObserver.observe(observedNativeCommentArea, {
                attributeFilter: [
                    "aria-disabled",
                    "aria-label",
                    "aria-pressed",
                    "class",
                    "disabled",
                    "id",
                    "src",
                    "srcset",
                    "style",
                ],
                attributes: true,
                characterData: true,
                childList: true,
                subtree: true,
            });
            scheduleSync();
        }

        function attach({ panel } = {}) {
            commentPanel = panel instanceof HTMLElement ? panel : null;
            refresh();
            cancelScheduledSync();
            syncAll();
        }

        function forwardAction(control, action) {
            const row = control?.closest?.("[data-bcvc-comment-id]");
            if (!(row instanceof HTMLElement)) return false;
            const commentId = row.getAttribute("data-bcvc-comment-id") || "";
            const nativeRow = getNativeCommentElementById(commentId);
            const profileTarget = control.getAttribute("data-bcvc-profile-target") === "avatar" ? "avatar" : "author";
            const profileControls = findNativeProfileControlsInRow(nativeRow);
            const nativeControl =
                action === "profile" ? profileControls[profileTarget] : getNativeBuffButtonInRow(nativeRow);
            if (!isNativeControlAvailable(nativeControl)) {
                scheduleSync(new Set([commentId]));
                return false;
            }
            try {
                nativeControl.click();
                window.queueMicrotask(() => scheduleSync(new Set([commentId])));
                return true;
            } catch (_) {
                scheduleSync(new Set([commentId]));
                return false;
            }
        }

        function forwardTimecode(control) {
            const row = control?.closest?.("[data-bcvc-comment-id]");
            if (!(row instanceof HTMLElement)) return false;
            const message = Array.from(row.children).find((child) => child.classList.contains("bcvc-message"));
            const mirrored = Array.from(message?.querySelectorAll("[data-bcvc-action='time']") || []);
            const index = mirrored.indexOf(control);
            const native = getNativeTimecodeButtons(
                getNativeCommentElementById(row.getAttribute("data-bcvc-comment-id") || "")
            );
            const nativeControl = index >= 0 ? native[index] : null;
            if (!isNativeControlAvailable(nativeControl)) return false;
            try {
                nativeControl.click();
                return true;
            } catch (_) {
                return false;
            }
        }

        function detach() {
            disconnectNativeCommentObserver();
            cancelScheduledSync();
            nativeBuffIconClassNames = null;
            commentPanel = null;
        }

        return Object.freeze({ attach, detach, forwardAction, forwardTimecode, refresh, syncAll });
    }

    namespace.nativeAdapter = Object.freeze({ createNativeAdapter });
})();
