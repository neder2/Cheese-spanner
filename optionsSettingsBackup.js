/**
 * optionsSettingsBackup.js — 옵션 페이지의 설정 파일 저장·불러오기 UI.
 *
 * 실행 컨텍스트: options.html(액션 팝업·옵션 페이지). shared/settingsBackup.js 다음에 로드한다.
 * 하는 일: 헤더 더보기의 두 버튼으로 설정 파일을 내려받고, 고른 파일을 워커에 미리보기 요청해 바뀌는 구역을
 *   보여 준 뒤, 사용자의 적용 클릭에서 필요한 선택 권한을 요청하고 워커에 적용을 요청한다.
 *   파일 읽기·검증·현재 값 비교·쓰기·되돌리기는 모두 워커의 설정 저장 큐(shared/settingsStore.js)가 소유한다.
 * 통신: chrome.runtime 메시지 betterchzzk:settings-backup(export·preview·apply), chrome.permissions.request.
 */
(() => {
    "use strict";
    const catalog = globalThis.BetterChzzkSettingsBackup;
    const page = globalThis.BetterChzzkOptionsPage;
    const exportButton = document.getElementById("exportSettingsFile");
    const importButton = document.getElementById("importSettingsFile");
    const fileInput = document.getElementById("settingsFileInput");
    const panel = document.getElementById("settingsBackupPanel");
    const headerMenu = document.getElementById("headerMenu");
    if (!catalog || !page || !exportButton || !importButton || !fileInput || !panel) return;

    const PERMISSION_SPECS = {
        notifications: { permissions: ["notifications"] },
        previewHosts: { origins: ["https://*.pstatic.net/*"] },
    };
    const ERROR_TEXT = {
        "invalid-file": "치즈 스패너 설정 파일이 아니거나 내용이 올바르지 않아요.",
        "invalid-json": "JSON 형식의 설정 파일이 아니에요.",
        "too-large": "설정 파일이 너무 커요. 1MB 이하 파일만 불러올 수 있어요.",
        "unsupported-version": "이 버전에서 읽을 수 없는 설정 파일이에요. 확장을 업데이트한 뒤 다시 시도해 주세요.",
        "storage-read-failed": "현재 설정을 읽지 못했어요. 잠시 후 다시 시도해 주세요.",
        "storage-write-failed": "설정을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.",
        "untrusted-sender": "이 화면에서는 설정 파일을 처리할 수 없어요.",
        unavailable: "확장 백그라운드와 연결하지 못했어요. 확장을 다시 로드한 뒤 시도해 주세요.",
    };
    const SECTION_TEXT = {
        options: "옵션",
        pinnedChannelIds: "팔로잉 고정",
        followingFolders: "팔로잉 폴더",
        panelSizes: "채팅·사이드바 크기",
        liveStartChannels: "방송 알림 대상",
        multiview: "멀티뷰 딜레이·화질",
        chatMultiview: "채팅 멀티뷰 구성",
    };
    const OMITTED_TEXT = {
        pinnedChannelIds: "팔로잉 고정",
        followingFolders: "팔로잉 폴더",
        liveStartChannels: "방송 알림 대상",
        chatMultiview: "채팅 멀티뷰 구성",
        multiviewDelays: "멀티뷰 딜레이",
        multiviewQualities: "멀티뷰 화질",
    };
    const FEATURE_TEXT = {
        liveStartNotificationsEnabled: "방송 시작 데스크톱 알림",
        followingPreviewTooltipEnabled: "방송 목록 호버 미리보기",
        liveMultiviewEnabled: "라이브 멀티뷰",
    };
    const STAGE_TEXT = {
        "effects-off": "기록·알림 등 끄는 기능",
        sync: "옵션·고정·폴더",
        local: "크기·멀티뷰·채팅 멀티뷰",
        "live-start": "방송 알림 대상",
        "effects-on": "기록·알림 등 켜는 기능",
    };
    let current = null;
    let busy = false;

    function failure(code) {
        const error = new Error(code);
        error.code = code;
        return error;
    }
    function errorText(error) {
        return ERROR_TEXT[error?.code] || ERROR_TEXT["storage-write-failed"];
    }
    function send(message) {
        return new Promise((resolve, reject) => {
            const runtime = globalThis.chrome?.runtime;
            if (typeof runtime?.sendMessage !== "function") {
                reject(failure("unavailable"));
                return;
            }
            try {
                runtime.sendMessage({ type: catalog.BACKUP_MESSAGE_TYPE, version: 1, ...message }, (response) => {
                    if (runtime.lastError || !response) reject(failure("unavailable"));
                    else if (response.ok) resolve(response);
                    else reject(failure(response.error));
                });
            } catch (_) {
                reject(failure("unavailable"));
            }
        });
    }
    function closeMenu() {
        if (headerMenu) headerMenu.open = false;
    }
    // Both file buttons sit in the header menu, which is closed by now; Chrome cannot focus a control inside a
    // closed <details>, so focus returns to the menu's always visible summary, as the defaults reset does.
    function restoreFocusTo(fallback) {
        (headerMenu?.querySelector("summary") || fallback).focus({ preventScroll: true });
    }
    function setBusy(value) {
        busy = value;
        exportButton.disabled = value;
        importButton.disabled = value;
        for (const button of panel.querySelectorAll("button")) button.disabled = value;
    }
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function button(text, className, onClick) {
        const node = el("button", className, text);
        node.type = "button";
        node.addEventListener("click", onClick);
        return node;
    }
    function dateText(value) {
        const date = new Date(value);
        return Number.isFinite(date.getTime())
            ? date.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })
            : "알 수 없음";
    }
    function stamp(value) {
        const date = new Date(value);
        const pad = (number) => String(number).padStart(2, "0");
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
            date.getMinutes()
        )}`;
    }

    function closePanel({ restoreFocus = false } = {}) {
        current = null;
        panel.hidden = true;
        panel.replaceChildren();
        // Editing the option form resumes only after the restore flow is gone.
        page.setExternalBusy(false);
        if (restoreFocus) restoreFocusTo(importButton);
    }
    function sectionList(ids) {
        const names = [...new Set((ids || []).map((id) => SECTION_TEXT[catalog.sectionOf(id)] || "기타"))];
        return names.join("·");
    }
    function setStatus(text, type = "info") {
        const status = panel.querySelector(".settings-backup-status");
        if (!status) return;
        status.textContent = text;
        status.dataset.type = type;
    }

    function summaryRows(summary) {
        const rows = [];
        const state = (changed) => (changed ? "바뀜" : "같음");
        if (summary.options.total)
            rows.push(["옵션", `파일 ${summary.options.total}개 중 ${summary.options.changed}개 바뀜`]);
        if (summary.pinnedChannelIds)
            rows.push([
                "팔로잉 고정",
                `${summary.pinnedChannelIds.count}개 채널 · ${state(summary.pinnedChannelIds.changed)}`,
            ]);
        if (summary.followingFolders)
            rows.push([
                "팔로잉 폴더",
                `${summary.followingFolders.count}개 폴더 · ${state(summary.followingFolders.changed)}`,
            ]);
        if (summary.panelSizes) rows.push(["채팅·사이드바 크기", state(summary.panelSizes.changed)]);
        if (summary.liveStartChannels)
            rows.push([
                "방송 알림 대상",
                `${summary.liveStartChannels.count}개 채널 · ${state(summary.liveStartChannels.changed)}`,
            ]);
        if (summary.multiview)
            rows.push([
                "멀티뷰 딜레이·화질",
                `${summary.multiview.count}개 채널 · ${state(summary.multiview.changed)}`,
            ]);
        if (summary.chatMultiview)
            rows.push([
                "채팅 멀티뷰 구성",
                `${summary.chatMultiview.count}개 채널 · ${state(summary.chatMultiview.changed)}`,
            ]);
        return rows;
    }

    // Only features the file turns on (as the worker computed) need a permission; ones the user already chose
    // to keep off in this flow are not asked again.
    function permissionKeys(flow) {
        return (flow.preview.summary?.permissionOptionKeys || []).filter(
            (key) => !flow.disabledOptionKeys.includes(key)
        );
    }
    function permissionNeeds(keys) {
        return Object.keys(PERMISSION_SPECS).filter((name) =>
            catalog.PERMISSION_OPTION_KEYS[name].some((key) => keys.includes(key))
        );
    }
    function featureList(keys) {
        return keys.map((key) => FEATURE_TEXT[key] || key).join("·");
    }

    function render() {
        const { preview, fileName, createdAt, extensionVersion } = current;
        panel.replaceChildren();
        const heading = el("h2", "settings-backup-title", "설정 파일 불러오기");
        heading.id = "settingsBackupTitle";
        heading.tabIndex = -1;
        const meta = el(
            "p",
            "settings-backup-meta",
            `${fileName} · ${dateText(createdAt)} 저장${extensionVersion ? ` · v${extensionVersion}` : ""}`
        );
        const list = el("dl", "settings-backup-summary");
        for (const [term, value] of summaryRows(preview.summary)) list.append(el("dt", "", term), el("dd", "", value));
        const notes = el("ul", "settings-backup-notes");
        notes.append(
            el("li", "", "파일에 없는 구역은 지금 설정을 그대로 둬요. 멀티뷰 값은 파일에 있는 채널만 바꿔요."),
            el("li", "", "시청 기록·카테고리 제외·로그인 정보는 바뀌지 않아요."),
            el("li", "", "지금 진행 중인 방송은 알림·자동 입장 없이 기준으로만 기억해요.")
        );
        if (preview.ignoredOptionKeys?.length)
            notes.append(el("li", "", `이 버전에 없는 옵션 ${preview.ignoredOptionKeys.length}개는 무시해요.`));
        // After a re-confirmation the worker reports exactly which features the user's choice keeps off.
        const keptOff = preview.summary?.keptOffOptionKeys || [];
        if (keptOff.length)
            notes.append(el("li", "", `권한을 받지 못한 ${featureList(keptOff)} 기능은 켜지 않고 불러와요.`));
        const needs = permissionNeeds(permissionKeys(current));
        if (needs.length)
            notes.append(
                el(
                    "li",
                    "",
                    `적용할 때 ${needs
                        .map((name) => (name === "notifications" ? "데스크톱 알림" : "미리보기·멀티뷰 영상"))
                        .join("·")} 권한을 요청할 수 있어요.`
                )
            );
        const status = el("p", "settings-backup-status");
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        const actions = el("div", "settings-backup-actions");
        const apply = button("불러오기 적용", "primary-button", () => void applyImport());
        apply.disabled = preview.changes === 0;
        const cancel = button("취소", "secondary-button", () => closePanel({ restoreFocus: true }));
        actions.append(apply, cancel);
        panel.append(heading, meta, list, notes, status, actions);
        if (preview.changes === 0) setStatus("현재 설정과 같아서 바꿀 내용이 없어요.");
        panel.hidden = false;
        heading.focus({ preventScroll: false });
    }

    function requestPermissions(needs) {
        if (!needs.length) return Promise.resolve(true);
        const permissions = globalThis.chrome?.permissions;
        if (typeof permissions?.request !== "function") return Promise.resolve(false);
        const spec = { permissions: [], origins: [] };
        for (const name of needs) {
            spec.permissions.push(...(PERMISSION_SPECS[name].permissions || []));
            spec.origins.push(...(PERMISSION_SPECS[name].origins || []));
        }
        if (!spec.permissions.length) delete spec.permissions;
        if (!spec.origins.length) delete spec.origins;
        return new Promise((resolve) => {
            try {
                // Called directly from the apply click so the browser keeps the user gesture.
                permissions.request(spec, (granted) => {
                    const error = globalThis.chrome?.runtime?.lastError;
                    resolve(!error && Boolean(granted));
                });
            } catch (_) {
                resolve(false);
            }
        });
    }

    async function applyImport() {
        if (!current || busy) return;
        if (page.hasUnsavedChanges()) {
            setStatus("저장하지 않은 옵션 변경이 있어 적용하지 않았어요. 취소한 뒤 저장하거나 되돌려 주세요.", "error");
            return;
        }
        const flow = current;
        const disabledOptionKeys = flow.disabledOptionKeys;
        const keys = permissionKeys(flow);
        const granted = requestPermissions(permissionNeeds(keys));
        setBusy(true);
        setStatus("설정을 불러오는 중이에요…");
        try {
            if (!(await granted)) {
                setBusy(false);
                setStatus("권한이 거부되어 아무것도 바꾸지 않았어요.", "error");
                const fallback = button(
                    `${featureList(keys)} 기능은 켜지 않고 불러오기`,
                    "secondary-button settings-backup-fallback",
                    () => {
                        // The choice belongs to this confirmation flow and survives a re-confirmation. It keeps off
                        // only the features this file would turn on; the worker leaves other current choices alone.
                        if (current !== flow) return;
                        flow.disabledOptionKeys = [...new Set([...flow.disabledOptionKeys, ...keys])];
                        void applyImport();
                    }
                );
                // A repeated denial replaces the earlier offer instead of adding another button.
                panel.querySelector(".settings-backup-fallback")?.remove();
                panel.querySelector(".settings-backup-actions")?.prepend(fallback);
                fallback.focus();
                return;
            }
            const response = await send({
                action: "apply",
                backup: flow.backup,
                fingerprint: flow.preview.fingerprint,
                ...(disabledOptionKeys.length ? { disabledOptionKeys } : {}),
            });
            if (current !== flow) return;
            await finishApply(response.result);
        } catch (error) {
            setBusy(false);
            setStatus(errorText(error), "error");
        }
    }

    async function finishApply(result) {
        if (result?.status === "reconfirm") {
            // The worker plans again against the newer values, including how many keys would still change.
            current.preview = {
                ...current.preview,
                fingerprint: result.fingerprint,
                summary: result.summary,
                changes: Number.isInteger(result.changes) ? result.changes : current.preview.changes,
            };
            setBusy(false);
            render();
            if (current.preview.changes === 0)
                setStatus("미리보기 뒤에 설정이 바뀌어 이제 현재 설정과 같아요. 바꿀 내용이 없어요.");
            else setStatus("미리보기 뒤에 설정이 바뀌었어요. 바뀐 내용을 다시 확인한 뒤 적용해 주세요.", "error");
            return;
        }
        if (result?.status === "failed") {
            await page.reloadSavedOptions();
            setBusy(false);
            const stage = STAGE_TEXT[result.stage] || "일부 구역";
            const parts = [`${stage}을 저장하지 못했어요.`];
            if (result.rolledBack) parts.push("앞서 바꾼 값을 모두 되돌려 설정은 불러오기 전과 같아요.");
            if (result.failed?.length)
                parts.push(`되돌리기도 실패해 불러온 값이 남은 구역: ${sectionList(result.failed)}.`);
            if (result.conflicted?.length)
                parts.push(`다른 곳에서 바뀌어 되돌리지 않은 구역: ${sectionList(result.conflicted)}.`);
            if (!result.rolledBack) parts.push("해당 구역의 설정을 확인해 주세요.");
            setStatus(parts.join(" "), "error");
            return;
        }
        await page.reloadSavedOptions();
        setBusy(false);
        closePanel({ restoreFocus: true });
        const conflicts = result?.conflicts?.length
            ? ` 적용 중 다른 곳에서 바뀐 값이 감지된 구역(${sectionList(result.conflicts)})은 확인해 주세요.`
            : "";
        // The worker's plan for this write names the features that really stayed off.
        const keptOff = result?.summary?.keptOffOptionKeys || [];
        const disabled = keptOff.length ? ` 권한을 받지 못한 ${featureList(keptOff)} 기능은 켜지 않았어요.` : "";
        page.showMessage(
            result?.status === "unchanged"
                ? `바뀐 설정이 없어요.${disabled}`
                : `설정 파일을 불러왔어요. 열린 치지직 화면은 새로고침하면 모두 반영돼요.${disabled}${conflicts}`
        );
    }

    function exportMessage(omitted) {
        if (!omitted.length) return "설정 파일을 만들었어요. 시청 기록·로그인 정보는 들어 있지 않아요.";
        const names = (list) => list.map((name) => OMITTED_TEXT[name] || "기타").join("·");
        const tooMany = omitted.filter((name) => name === "multiviewDelays" || name === "multiviewQualities");
        const unreadable = omitted.filter((name) => !tooMany.includes(name));
        const parts = ["설정 파일을 만들었어요."];
        if (unreadable.length) parts.push(`저장값을 읽지 못한 ${names(unreadable)} 구역은 빠졌어요.`);
        if (tooMany.length)
            parts.push(
                `${names(tooMany)} 구역은 저장한 채널이 ${catalog.MAX_MULTIVIEW_CHANNELS.toLocaleString(
                    "ko-KR"
                )}개를 넘어 파일에 넣지 않았어요.`
            );
        return parts.join(" ");
    }

    exportButton.addEventListener("click", async () => {
        if (busy) return;
        closeMenu();
        setBusy(true);
        try {
            const response = await send({ action: "export" });
            const text = JSON.stringify(response.backup, null, 2);
            const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = `cheese-spanner-settings-${stamp(response.backup.createdAt)}.json`;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            page.showMessage(exportMessage(response.omitted || []));
        } catch (error) {
            page.showMessage(errorText(error), "error");
        } finally {
            setBusy(false);
            restoreFocusTo(exportButton);
        }
    });

    importButton.addEventListener("click", () => {
        if (busy) return;
        closeMenu();
        // Keeps focus visible when the import stops here, the picker is cancelled or the file is rejected.
        restoreFocusTo(importButton);
        if (!page.isReady() || page.hasUnsavedChanges()) {
            page.showMessage("저장하지 않은 변경이 있어요. 저장하거나 되돌린 뒤 불러와 주세요.", "error");
            return;
        }
        fileInput.value = "";
        fileInput.click();
    });

    fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file || busy) return;
        // The form stays editable while the picker is open; check again before taking it over.
        if (!page.isReady() || page.hasUnsavedChanges()) {
            fileInput.value = "";
            page.showMessage("저장하지 않은 변경이 있어요. 저장하거나 되돌린 뒤 불러와 주세요.", "error");
            return;
        }
        page.setExternalBusy(true);
        setBusy(true);
        try {
            if (file.size > catalog.MAX_FILE_BYTES) throw failure("too-large");
            let value;
            try {
                value = JSON.parse(await file.text());
            } catch (_) {
                throw failure("invalid-json");
            }
            const preview = await send({ action: "preview", backup: value });
            current = {
                backup: value,
                preview,
                disabledOptionKeys: [],
                fileName: file.name.slice(0, 80),
                createdAt: value?.createdAt,
                extensionVersion:
                    typeof value?.extensionVersion === "string" ? value.extensionVersion.slice(0, 32) : "",
            };
            setBusy(false);
            render();
        } catch (error) {
            setBusy(false);
            closePanel();
            page.showMessage(errorText(error), "error");
        } finally {
            fileInput.value = "";
        }
    });

    panel.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || busy) return;
        event.preventDefault();
        closePanel({ restoreFocus: true });
    });
})();
