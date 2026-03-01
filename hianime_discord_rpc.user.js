// ==UserScript==
// @name         HiAnime Discord Rich Presence
// @namespace    https://hianime.to/
// @version      3.0.0
// @description  Show your currently watching anime on Discord Rich Presence
// @author       HiAnime RPC
// @match        *://hianime.to/watch/*
// @match        *://hianime.do/watch/*
// @match        *://hianimez.to/watch/*
// @match        *://megacloud.blog/embed-2/*
// @match        *://megacloud.tv/embed-2/*
// @match        *://rapid-cloud.co/embed-6/*
// @match        *://megacloud.club/embed-2/*
// @match        *://megacloud.store/embed-2/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

/*
 * HiAnime Discord Rich Presence — Tampermonkey Userscript v3
 *
 * Architecture:
 *   - On HiAnime watch pages: scrapes anime title, episode, poster.
 *     Listens for playback data from the video player iframe via postMessage.
 *   - On video player iframes (megacloud, rapid-cloud): finds the <video>
 *     element and posts playback state back to the parent HiAnime page.
 *
 * Setup:
 *   1. Install Tampermonkey (Firefox/Chrome)
 *   2. Import this file as a new userscript
 *   3. Run  python hianime_rpc.py  in a terminal
 *   4. Open any anime watch page on hianime.to / hianime.do
 */

(function () {
    "use strict";

    // ─── Configuration ────────────────────────────────────────────
    const SERVER_URL        = "http://localhost:5555";
    const UPDATE_INTERVAL_MS = 5000;   // how often to push updates (ms)
    const VIDEO_POLL_MS      = 1000;   // how often to poll for <video> in iframe context
    const DEBUG = false;

    // ─── Logging helpers ──────────────────────────────────────────
    const TAG = "[HiAnime RPC]";
    const info  = (...a) => console.log(TAG, ...a);
    const debug = (...a) => { if (DEBUG) console.log(TAG, "[debug]", ...a); };
    const warn  = (...a) => console.warn(TAG, ...a);

    // ─── Detect which context we are in ───────────────────────────
    const isWatchPage = /hianime\.(to|do)|hianimez\.to/.test(location.hostname)
                        && /\/watch\//.test(location.pathname);
    const isPlayerIframe = /megacloud\.|rapid-cloud\./.test(location.hostname)
                           && /\/embed/.test(location.pathname);

    if (isWatchPage) {
        initWatchPage();
    } else if (isPlayerIframe) {
        initPlayerIframe();
    } else {
        debug("Not a recognized page, doing nothing.");
    }


    // ═══════════════════════════════════════════════════════════════
    //  CONTEXT A:  HiAnime Watch Page (parent)
    //  Scrapes metadata + receives playback data from iframe
    // ═══════════════════════════════════════════════════════════════

    function initWatchPage() {
        info("🎌  HiAnime watch page detected — starting RPC");

        let playbackData = {
            duration:     0,
            current_time: 0,
            is_playing:   false,
        };
        let serverAvailable = true;
        let failLogTime     = 0;
        let bgWorker        = null;

        // ── Listen for playback data from the video player iframe ──
        window.addEventListener("message", (event) => {
            if (event.data && event.data.type === "HIANIME_RPC_PLAYBACK") {
                playbackData = {
                    duration:     event.data.duration     || 0,
                    current_time: event.data.current_time || 0,
                    is_playing:   event.data.is_playing   || false,
                };
                debug("Received playback from iframe:", playbackData);
            }
        });

        // ── DOM Scraping ───────────────────────────────────────────

        function getAnimeTitle() {
            // Strategy 1: <title> tag — usually "Title Episode N - HiAnime"
            const docTitle = document.title || "";
            const titleMatch = docTitle.match(/^(.+?)(?:\s+Episode\s+\d+|\s+Ep\s+\d+|\s*-\s*HiAnime)/i);
            if (titleMatch && titleMatch[1].trim().length > 1) {
                return titleMatch[1].trim();
            }

            // Strategy 2: DOM elements
            const selectors = [
                ".film-name a",
                "h2.film-name",
                ".film-name",
                ".anime-title",
                ".anis-watch-detail .film-name",
                ".breadcrumb li:nth-last-child(2) a",
                "h1",
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const text = el.textContent.trim();
                    if (text.length > 1 && text.length < 200) return text;
                }
            }

            // Strategy 3: URL path fallback
            const pathMatch = window.location.pathname.match(/\/watch\/([^?]+)/);
            if (pathMatch) {
                return pathMatch[1]
                    .replace(/-\d+$/, "")
                    .replace(/-/g, " ")
                    .replace(/\b\w/g, c => c.toUpperCase());
            }

            return "Unknown Anime";
        }

        function getEpisodeNumber() {
            // Strategy 1: Active episode button
            const activeEp = document.querySelector(
                ".ssl-item.ep-item.active, .ep-item.active, " +
                ".episodes-list .active, .ss-list a.active, " +
                "a[data-number].active"
            );
            if (activeEp) {
                const num = activeEp.getAttribute("data-number")
                         || activeEp.getAttribute("data-ep")
                         || activeEp.textContent.match(/\d+/)?.[0];
                if (num) return num;
            }

            // Strategy 2: URL  ?ep=3
            const urlEpMatch = window.location.href.match(/[?&]ep=(\d+)/i)
                            || window.location.href.match(/episode[/-](\d+)/i)
                            || window.location.href.match(/ep[/-](\d+)/i);
            if (urlEpMatch) return urlEpMatch[1];

            // Strategy 3: Document title "… Episode 5 …"
            const titleEpMatch = (document.title || "").match(/Episode\s+(\d+)/i);
            if (titleEpMatch) return titleEpMatch[1];

            // Strategy 4: Heading text
            const headings = document.querySelectorAll("h2, h3, .ep-name, .episode-label");
            for (const h of headings) {
                const m = h.textContent.match(/Episode\s+(\d+)/i);
                if (m) return m[1];
            }

            return "??";
        }

        function getAnimeImage() {
            const posterSelectors = [
                ".film-poster img",
                ".anime-poster img",
                ".anis-watch-detail .film-poster img",
                ".anis-content .film-poster img",
                ".detail-poster img",
            ];
            for (const sel of posterSelectors) {
                const img = document.querySelector(sel);
                if (img) {
                    const src = img.getAttribute("src") || img.getAttribute("data-src");
                    if (src && src.startsWith("http")) return src;
                }
            }

            const ogImage = document.querySelector('meta[property="og:image"]');
            if (ogImage) {
                const content = ogImage.getAttribute("content");
                if (content && content.startsWith("http")) return content;
            }

            return "";
        }

        // ── Send update to server ──────────────────────────────────

        function sendUpdate() {
            const title    = getAnimeTitle();
            const episode  = getEpisodeNumber();
            const imageUrl = getAnimeImage();

            const payload = {
                title:        title,
                episode:      episode,
                duration:     playbackData.duration,
                current_time: playbackData.current_time,
                is_playing:   playbackData.is_playing,
                url:          window.location.href,
                image_url:    imageUrl,
            };

            const json = JSON.stringify(payload);
            debug("Sending:", payload);

            if (typeof GM_xmlhttpRequest !== "undefined") {
                GM_xmlhttpRequest({
                    method: "POST",
                    url: `${SERVER_URL}/update`,
                    headers: { "Content-Type": "application/json" },
                    data: json,
                    timeout: 3000,
                    onload(res) {
                        if (res.status === 200) {
                            serverAvailable = true;
                            debug("Server responded OK");
                        } else {
                            warn("Server error:", res.status, res.responseText);
                        }
                    },
                    onerror()   { logFail(); },
                    ontimeout() { logFail(); },
                });
            } else {
                fetch(`${SERVER_URL}/update`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: json,
                })
                .then(r => { if (r.ok) serverAvailable = true; })
                .catch(() => logFail());
            }
        }

        function sendClear() {
            const doReq = (url) => {
                if (typeof GM_xmlhttpRequest !== "undefined") {
                    GM_xmlhttpRequest({ method: "POST", url, timeout: 2000 });
                } else {
                    fetch(url, { method: "POST" }).catch(() => {});
                }
            };
            doReq(`${SERVER_URL}/clear`);
            info("📤  Sent clear request");
        }

        function logFail() {
            const now = Date.now();
            if (now - failLogTime > 60000) {
                warn("⚠️  Desktop server not reachable. Is hianime_rpc.py running?");
                failLogTime = now;
            }
            serverAvailable = false;
        }

        // ── Web Worker timer (background-tab safe) ─────────────────

        function createWorkerTimer(intervalMs) {
            const code = `setInterval(() => postMessage("tick"), ${intervalMs});`;
            const blob = new Blob([code], { type: "application/javascript" });
            return new Worker(URL.createObjectURL(blob));
        }

        function startMonitoring() {
            info("📡  Monitoring started (background-safe timer)");

            bgWorker = createWorkerTimer(UPDATE_INTERVAL_MS);
            bgWorker.onmessage = () => sendUpdate();

            // Initial update
            setTimeout(sendUpdate, 1500);
        }

        function stopMonitoring() {
            if (bgWorker) {
                bgWorker.terminate();
                bgWorker = null;
            }
            sendClear();
            info("🛑  Monitoring stopped");
        }

        // ── SPA navigation ─────────────────────────────────────────
        let lastUrl = location.href;
        const urlObserver = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                debug("URL changed:", lastUrl, "→", location.href);
                lastUrl = location.href;
                playbackData = { duration: 0, current_time: 0, is_playing: false };

                if (/\/watch\//.test(location.href)) {
                    setTimeout(sendUpdate, 1500);
                } else {
                    sendClear();
                }
            }
        });
        if (document.body) {
            urlObserver.observe(document.body, { childList: true, subtree: true });
        }

        // ── Boot ───────────────────────────────────────────────────
        startMonitoring();
        window.addEventListener("beforeunload", stopMonitoring);
        window.addEventListener("unload", stopMonitoring);
    }


    // ═══════════════════════════════════════════════════════════════
    //  CONTEXT B:  Video Player Iframe (megacloud / rapid-cloud)
    //  Finds <video> and posts playback state to parent HiAnime page
    // ═══════════════════════════════════════════════════════════════

    function initPlayerIframe() {
        info("🎬  Video player iframe detected — bridging playback data");

        let video = null;
        let lastState = "";

        function postPlaybackState() {
            if (!video) return;
            const state = {
                type:         "HIANIME_RPC_PLAYBACK",
                duration:     video.duration     || 0,
                current_time: video.currentTime  || 0,
                is_playing:   !video.paused && !video.ended,
            };

            // Only post if something changed (reduce noise)
            const key = `${state.is_playing}|${Math.floor(state.current_time)}`;
            if (key === lastState) return;
            lastState = key;

            try {
                window.parent.postMessage(state, "*");
                debug("Posted playback:", state);
            } catch {
                // parent might not be accessible — ignore
            }
        }

        function attachListeners(v) {
            const events = ["play", "pause", "seeked", "ended", "timeupdate"];
            for (const evt of events) {
                v.addEventListener(evt, postPlaybackState);
            }
            info("✅  Attached to <video> element");
        }

        // Poll for the video element (it may be injected dynamically)
        const poll = setInterval(() => {
            const v = document.querySelector("video");
            if (v) {
                video = v;
                clearInterval(poll);
                attachListeners(v);
                postPlaybackState();
            }
        }, VIDEO_POLL_MS);

        // Also use a regular heartbeat to keep posting state
        setInterval(() => {
            if (video) postPlaybackState();
        }, UPDATE_INTERVAL_MS);
    }

})();
