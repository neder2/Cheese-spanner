(() => {
    // AdGuard 등 시스템 레벨 차단기가 네이버 QoE 수집 요청(apis.naver.com/mcollector)을
    // 변조/차단하면 치지직 플레이어의 키 명령 파이프라인이 그 실패와 함께 죽는다.
    // 수집 요청만 가로채 실제 전송은 fire-and-forget으로 시도하고,
    // 플레이어 코드에는 항상 성공한 것처럼 보고해 차단 여파를 격리한다.
    const COLLECTOR_RE = /^https?:\/\/apis\.naver\.com\/mcollector(?:\/|\?|$)/i;

    function resolveUrl(input) {
        try {
            const raw = typeof input === "string" ? input : input?.url;
            if (typeof raw !== "string") return "";
            return new URL(raw, location.href).href;
        } catch {
            return "";
        }
    }

    function isCollectorUrl(url) {
        return COLLECTOR_RE.test(url);
    }

    function makeFakeResponse() {
        return new Response("{}", {
            status: 200,
            statusText: "OK",
            headers: { "Content-Type": "application/json" },
        });
    }

    const originalFetch = window.fetch.bind(window);

    window.fetch = function (...args) {
        if (!isCollectorUrl(resolveUrl(args[0]))) return originalFetch(...args);

        return originalFetch(...args).then(
            (response) => (response.ok ? response : makeFakeResponse()),
            () => makeFakeResponse()
        );
    };

    const XHR = window.XMLHttpRequest;
    const originalOpen = XHR.prototype.open;
    const originalSetRequestHeader = XHR.prototype.setRequestHeader;
    const originalSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
        const resolved = resolveUrl(url);
        if (isCollectorUrl(resolved)) {
            this.__bcCollector = { method: String(method || "GET").toUpperCase(), url: resolved, headers: {} };
            return;
        }
        this.__bcCollector = null;
        return originalOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
        if (this.__bcCollector) {
            this.__bcCollector.headers[String(name)] = String(value);
            return;
        }
        return originalSetRequestHeader.call(this, name, value);
    };

    function defineFakeResult(xhr, props) {
        for (const [key, value] of Object.entries(props)) {
            try {
                Object.defineProperty(xhr, key, { value, configurable: true });
            } catch {}
        }
    }

    XHR.prototype.send = function (body) {
        const info = this.__bcCollector;
        if (!info) return originalSend.call(this, body);

        try {
            originalFetch(info.url, {
                method: info.method,
                headers: info.headers,
                body: body ?? undefined,
                credentials: this.withCredentials ? "include" : "same-origin",
                keepalive: true,
            }).catch(() => {});
        } catch {}

        setTimeout(() => {
            defineFakeResult(this, {
                readyState: 4,
                status: 200,
                statusText: "OK",
                response: "{}",
                responseText: "{}",
                responseURL: info.url,
            });
            try {
                this.dispatchEvent(new Event("readystatechange"));
                this.dispatchEvent(new ProgressEvent("load"));
                this.dispatchEvent(new ProgressEvent("loadend"));
            } catch {}
        }, 0);
    };
})();
