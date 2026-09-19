/* Device-local channel rules are written through the service worker's serial queue. */
(() => {
    const root = document.getElementById("liveStartChannels");
    if (!root) return;
    const { CHANNELS_KEY, STATUS_KEY, MAX_CHANNELS, parseChannelId, normalizeChannels } =
        globalThis.BetterChzzkLiveStart;
    const { storageGet, fetchJson } = BetterChzzk.utils;
    const input = document.getElementById("liveStartChannelInput");
    const add = document.getElementById("liveStartChannelAdd");
    const list = document.getElementById("liveStartChannelList");
    const message = document.getElementById("liveStartChannelMessage");
    const status = document.getElementById("liveStartMonitorStatus");
    const permission = document.getElementById("liveStartPermission");
    let channels = [];
    let ready = false;
    let busy = false;
    let disposed = false;
    let controller = null;
    let loadVersion = 0;

    function tell(text, error = false) {
        message.textContent = text;
        message.dataset.error = String(error);
    }

    function controls() {
        for (const control of root.querySelectorAll("input, button")) control.disabled = !ready || busy;
        add.disabled = !ready || busy || channels.length >= MAX_CHANNELS;
    }

    function render() {
        const focused = document.activeElement;
        const focusId = focused?.closest("[data-channel-id]")?.dataset.channelId;
        const focusAction = focused?.dataset.action;
        list.replaceChildren();
        if (!channels.length) {
            const empty = document.createElement("li");
            empty.textContent = "등록한 채널이 없어요.";
            list.append(empty);
        }
        for (const channel of channels) {
            const row = document.createElement("li");
            row.dataset.channelId = channel.channelId;
            const link = document.createElement("a");
            link.href = `https://chzzk.naver.com/${channel.channelId}`;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            const name = channel.channelName || channel.channelId;
            link.textContent = name;
            row.append(link);
            const actions = document.createElement("div");
            actions.className = "live-start-channel-actions";
            for (const [action, text] of [
                ["notify", "알림"],
                ["autoOpen", "자동 열기"],
            ]) {
                const label = document.createElement("label");
                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.dataset.action = action;
                checkbox.checked = channel[action];
                checkbox.setAttribute("aria-label", `${name} ${text}`);
                label.append(checkbox, document.createTextNode(text));
                actions.append(label);
            }
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "secondary-button";
            remove.dataset.action = "remove";
            remove.textContent = "삭제";
            remove.setAttribute("aria-label", `${name} 삭제`);
            actions.append(remove);
            row.append(actions);
            list.append(row);
        }
        controls();
        if (focusId && focusAction) {
            (list.querySelector(`[data-channel-id="${focusId}"] [data-action="${focusAction}"]`) || input).focus();
        }
    }

    function renderStatus(value) {
        const error = typeof value?.error === "string" ? value.error : "";
        status.dataset.error = String(Boolean(error));
        status.textContent =
            error ||
            (value?.activeChannels > 0 && value.checkedAt > 0
                ? `${value.activeChannels}개 채널 확인 · 마지막 확인 ${new Date(value.checkedAt).toLocaleTimeString("ko-KR")}`
                : "채널을 등록하고 위 옵션을 켠 뒤 옵션 저장을 눌러 주세요.");
    }

    async function updatePermission() {
        try {
            const granted = await chrome.permissions.contains({ permissions: ["notifications"] });
            if (!disposed) permission.hidden = granted;
        } catch (_) {
            if (!disposed) permission.hidden = false;
        }
    }

    async function load() {
        const version = ++loadVersion;
        try {
            if (!chrome?.storage?.local || !chrome.runtime?.sendMessage) throw new Error();
            const data = await storageGet(chrome.storage.local, [CHANNELS_KEY, STATUS_KEY]);
            if (disposed || version !== loadVersion) return;
            channels = normalizeChannels(data[CHANNELS_KEY]);
            ready = true;
            render();
            renderStatus(data[STATUS_KEY]);
            void updatePermission();
        } catch (_) {
            if (disposed) return;
            ready = false;
            controls();
            tell("채널 설정을 불러오지 못했어요. 확장 설정 화면을 다시 열어 주세요.", true);
        }
    }

    function sendChange(kind, channel) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: "betterchzzk:live-start:channels", kind, channel }, (response) => {
                const error = chrome.runtime.lastError;
                if (error || !response?.ok)
                    reject(new Error(response?.error || "채널 설정을 저장하지 못했어요. 다시 시도해 주세요."));
                else resolve(normalizeChannels(response.channels));
            });
        });
    }

    async function change(kind, channel) {
        if (!ready || busy) return;
        busy = true;
        controls();
        try {
            channels = await sendChange(kind, channel);
            if (!disposed) tell("채널 설정을 저장했어요.");
        } catch (error) {
            if (!disposed) tell(error.message, true);
        } finally {
            busy = false;
            if (!disposed) {
                render();
                const action = kind === "remove" ? "remove" : Object.hasOwn(channel, "notify") ? "notify" : "autoOpen";
                (
                    list.querySelector(`[data-channel-id="${channel.channelId}"] [data-action="${action}"]`) || input
                ).focus();
            }
        }
    }

    async function addChannel() {
        if (!ready || busy) return;
        const channelId = parseChannelId(input.value);
        if (!channelId) {
            tell("치지직 채널 주소 또는 32자리 채널 ID를 입력해 주세요.", true);
            return;
        }
        if (channels.some((channel) => channel.channelId === channelId)) {
            tell("이미 등록한 채널이에요.", true);
            return;
        }
        if (channels.length >= MAX_CHANNELS) {
            tell("채널은 최대 32개까지 등록할 수 있어요.", true);
            return;
        }
        busy = true;
        controls();
        tell("채널을 확인하고 있어요.");
        controller = new AbortController();
        try {
            const json = await fetchJson(`https://api.chzzk.naver.com/service/v1/channels/${channelId}`, {
                signal: controller.signal,
                timeoutMs: 8000,
            });
            if (disposed) return;
            if (json?.code !== 200 || json.content?.channelId !== channelId || !json.content.channelName?.trim()) {
                throw new Error("채널 정보를 확인하지 못했어요. 주소를 확인해 주세요.");
            }
            channels = await sendChange("add", {
                channelId,
                channelName: json.content.channelName,
                notify: true,
                autoOpen: false,
            });
            if (disposed) return;
            input.value = "";
            tell("채널을 추가했어요. 위 옵션을 켜고 저장하면 다음 새 방송부터 적용돼요.");
        } catch (error) {
            const detail = String(error?.message || "");
            if (!disposed)
                tell(
                    detail.startsWith("채널")
                        ? detail
                        : "채널 조회에 실패했어요. 네트워크와 주소를 확인한 뒤 다시 시도해 주세요.",
                    true
                );
        } finally {
            busy = false;
            controller = null;
            if (!disposed) {
                render();
                input.focus();
            }
        }
    }

    add.addEventListener("click", () => void addChannel());
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            void addChannel();
        }
    });
    list.addEventListener("change", (event) => {
        const action = event.target.dataset.action;
        if (!["notify", "autoOpen"].includes(action)) return;
        const channelId = event.target.closest("[data-channel-id]")?.dataset.channelId;
        void change("update", { channelId, [action]: event.target.checked });
    });
    list.addEventListener("click", (event) => {
        const button = event.target.closest('[data-action="remove"]');
        if (button) void change("remove", { channelId: button.closest("[data-channel-id]").dataset.channelId });
    });
    permission.addEventListener("click", () => {
        chrome.permissions.request({ permissions: ["notifications"] }, (granted) => {
            const error = chrome.runtime.lastError;
            if (disposed) return;
            tell(
                !error && granted
                    ? "알림 권한을 허용했어요. 위 알림 옵션도 켜고 저장해 주세요."
                    : "알림 권한을 허용하지 않았어요. 자동 탭 열기는 별도로 사용할 수 있어요.",
                Boolean(error) || !granted
            );
            void updatePermission();
        });
    });
    function onStorageChange(changes, area) {
        if (area === "local" && Object.hasOwn(changes, CHANNELS_KEY)) void load();
        else if (area === "local" && Object.hasOwn(changes, STATUS_KEY)) renderStatus(changes[STATUS_KEY].newValue);
    }
    chrome?.storage?.onChanged?.addListener(onStorageChange);
    window.addEventListener(
        "pagehide",
        () => {
            disposed = true;
            controller?.abort();
            chrome?.storage?.onChanged?.removeListener(onStorageChange);
        },
        { once: true }
    );
    void load();
})();
