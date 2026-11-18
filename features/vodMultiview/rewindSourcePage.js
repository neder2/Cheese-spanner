// Chrome needs distinct script paths for MAIN and isolated. Keep both rewind validators identical.
(() => {
    "use strict";

    const CDN_ORIGIN = "https://ex-nlive-slitvod-streaming.navercdn.com";
    const trackTextFields = [
        "encodingTrackId",
        "videoProfile",
        "audioProfile",
        "videoCodec",
        "videoFrameRate",
        "videoDynamicRange",
    ];
    const trackNumberFields = [
        "videoBitRate",
        "audioBitRate",
        "videoWidth",
        "videoHeight",
        "audioSamplingRate",
        "audioChannel",
    ];

    function readTrack(input) {
        const track = {};
        for (const field of trackTextFields) {
            const value = input?.[field];
            if (typeof value === "string" && value.length <= 80) track[field] = value;
        }
        for (const field of trackNumberFields) {
            const value = input?.[field];
            if (Number.isSafeInteger(value) && value >= 0) track[field] = value;
        }
        return track.encodingTrackId && track.videoWidth > 0 && track.videoHeight > 0 ? track : null;
    }

    function readRewindSource(value, videoId, duration) {
        if (typeof value !== "string" || value.length > 65536) return null;
        try {
            const { meta, media } = JSON.parse(value);
            if (
                meta?.liveRewind !== true ||
                meta.videoId !== videoId ||
                meta.paidLive !== false ||
                meta.playbackAuthType !== "NONE" ||
                typeof meta.liveId !== "string" ||
                !/^\d{1,20}$/.test(meta.liveId) ||
                !Number.isSafeInteger(meta.streamSeq) ||
                meta.streamSeq < 0 ||
                !Number.isFinite(meta.duration) ||
                meta.duration <= 0 ||
                Math.abs(meta.duration - duration) > 2 ||
                typeof meta.cdnInfo?.cdnType !== "string" ||
                !/^[A-Z0-9_-]{1,24}$/.test(meta.cdnInfo.cdnType) ||
                !Array.isArray(media) ||
                media.length !== 1
            )
                return null;

            const [hls] = media;
            if (
                hls?.protocol !== "HLS" ||
                hls.mediaId !== "HLS" ||
                typeof hls.path !== "string" ||
                !Array.isArray(hls.encodingTrack) ||
                !hls.encodingTrack.length ||
                hls.encodingTrack.length > 16
            )
                return null;
            const url = new URL(hls.path);
            if (
                url.origin !== CDN_ORIGIN ||
                url.username ||
                url.password ||
                url.hash ||
                !url.pathname.startsWith("/chzzk/") ||
                !url.pathname.endsWith(".m3u8")
            )
                return null;
            const encodingTrack = hls.encodingTrack.map(readTrack);
            if (encodingTrack.includes(null)) return null;

            // Forward only the VOD playlist and track descriptions to the native provider.
            const { liveId, streamSeq } = meta;
            return {
                meta: {
                    videoId,
                    liveId,
                    streamSeq,
                    liveRewind: true,
                    paidLive: false,
                    playbackAuthType: "NONE",
                    duration: meta.duration,
                    cdnInfo: { cdnType: meta.cdnInfo.cdnType },
                },
                api: [],
                media: [{ protocol: "HLS", mediaId: "HLS", path: url.href, encodingTrack }],
            };
        } catch {
            return null;
        }
    }

    window.CheeseSpannerVodRewind = Object.freeze({ readRewindSource });
})();
