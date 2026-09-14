// Console용 읽기 전용 진단. 요소에 남아 있는 연결 정보와 클릭 리스너의 형태만 출력해요.
/* global getEventListeners */
(() => {
    const host = document.querySelector(".chzzk_player.type_live");
    if (!host) return console.log("라이브 플레이어를 찾지 못했어요.");
    const nodes = Array.from(
        new Set([
            host,
            ...host.querySelectorAll(
                ".pzp-pc, .pzp-setting-quality-pane, .pzp-ui-setting-quality-item, video.webplayer-internal-video"
            ),
        ])
    ).slice(0, 10);
    const read = (obj, key) => {
        try {
            return obj?.[key];
        } catch {
            return undefined;
        }
    };
    const keys = ["_corePlayer", "corePlayer", "_player", "player", "_controller", "controller"];
    const describe = (node) => {
        const links = keys
            .map((key) => {
                const value = read(node, key);
                return value == null
                    ? null
                    : {
                          key,
                          type: typeof value,
                          trackCount: read(read(value, "videoTracks"), "length") ?? null,
                          hasAddEventListener: typeof read(value, "addEventListener") === "function",
                      };
            })
            .filter(Boolean);
        let clicks = [];
        if (typeof getEventListeners === "function") {
            try {
                clicks = (getEventListeners(node).click || []).slice(0, 2).map(({ listener }) => ({
                    name: listener.name,
                    keys: Object.getOwnPropertyNames(listener).slice(0, 12),
                    source: Function.prototype.toString.call(listener).slice(0, 500),
                }));
            } catch {
                clicks = [{ unavailable: true }];
            }
        }
        return {
            tag: node.tagName,
            class: node.className,
            hasVueRef: Boolean(read(node, "__vue__")),
            ownKeys: Object.getOwnPropertyNames(node).slice(0, 30),
            trackCount: read(read(node, "videoTracks"), "length") ?? null,
            links,
            clicks,
        };
    };
    console.log(JSON.stringify({ probe: "quality-choice-links", nodes: nodes.map(describe) }, null, 2));
})();
