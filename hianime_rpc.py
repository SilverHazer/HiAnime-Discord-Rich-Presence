"""
HiAnime Discord Rich Presence — Desktop RPC Server
Bridges a Tampermonkey userscript running on hianime.to / hianime.do
with Discord Rich Presence via pypresence.

Usage:
    pip install -r requirements.txt
    python hianime_rpc.py

Requirements: pypresence, flask, flask-cors
"""

import time
import threading
import logging
from datetime import datetime

from pypresence import Presence
from flask import Flask, request, jsonify
from flask_cors import CORS

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────

CLIENT_ID = "CLIENT_ID_HERE"        # Create a new application, copy Discord Application ID @ https://discord.com/developers/applications
PORT = 5555                         # Local server port
RECONNECT_INTERVAL = 15             # Seconds between reconnect attempts
IDLE_TIMEOUT = 60                   # Clear presence after N seconds of silence

# ─────────────────────────────────────────────
# Logging setup
# ─────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("hianime-rpc")

# Suppress noisy Flask / Werkzeug request logs
logging.getLogger("werkzeug").setLevel(logging.WARNING)


# ─────────────────────────────────────────────
# Discord RPC Manager
# ─────────────────────────────────────────────

class DiscordRPC:
    """Manages the Discord Rich Presence connection with auto-reconnect."""

    def __init__(self, client_id: str):
        self.client_id = client_id
        self.rpc: Presence | None = None
        self.connected = False
        self.current_anime: dict | None = None
        self.last_update_time: float = 0.0  # unix timestamp of last /update call

        # Lock to protect concurrent access
        self._lock = threading.Lock()

    # ── Connection ──────────────────────────

    def connect(self) -> bool:
        """Attempt to connect to Discord IPC."""
        with self._lock:
            if self.connected:
                return True
            try:
                self.rpc = Presence(self.client_id)
                self.rpc.connect()
                self.connected = True
                log.info("✅  Connected to Discord RPC")
                return True
            except Exception as exc:
                log.warning("❌  Discord connection failed: %s", exc)
                self.connected = False
                return False

    def disconnect(self):
        """Cleanly close the Discord connection."""
        with self._lock:
            if self.connected and self.rpc:
                try:
                    self.rpc.close()
                except Exception:
                    pass
                self.connected = False
                log.info("🔌  Disconnected from Discord")

    # ── Presence ────────────────────────────

    def update_presence(self, anime_data: dict) -> bool:
        """Push Rich Presence data to Discord.

        Args:
            anime_data: dict with keys:
                title, episode, duration, current_time,
                is_playing, url, image_url
        """
        if not self.connected:
            if not self.connect():
                return False

        try:
            title       = anime_data.get("title", "Unknown Anime")
            episode     = anime_data.get("episode", "??")
            duration    = float(anime_data.get("duration", 0))
            current_time = float(anime_data.get("current_time", 0))
            is_playing  = bool(anime_data.get("is_playing", False))
            url         = anime_data.get("url", "")
            image_url   = anime_data.get("image_url", "")

            # ── Timestamps ──
            start_ts = None
            end_ts = None
            if is_playing and duration > 0 and current_time >= 0:
                now = int(time.time())
                start_ts = now - int(current_time)
                end_ts = now + int(duration - current_time)

            # ── Build payload ──
            presence: dict = {
                "details": title[:128],                         # Discord limits to 128 chars
                "state": f"Episode {episode}" if episode != "??" else "Watching",
                "large_image": image_url if image_url else "anime_logo",
                "large_text": title[:128],
                "small_image": "https://i.imgur.com/4OLcnLB.png" if is_playing else "https://i.imgur.com/dpVHxIa.png",
                "small_text": "Playing" if is_playing else "Paused",
            }

            if start_ts and end_ts and is_playing:
                presence["start"] = start_ts
                presence["end"] = end_ts

            if url:
                presence["buttons"] = [
                    {"label": "Watch on HiAnime", "url": url[:512]},
                ]

            with self._lock:
                if not self.connected:
                    return False
                self.rpc.update(**presence)

            self.current_anime = anime_data
            self.last_update_time = time.time()

            log.info("🎌  %s — Ep %s  %s",
                     title, episode,
                     "▶ Playing" if is_playing else "⏸ Paused")
            return True

        except BrokenPipeError:
            log.warning("⚠️  Discord pipe broken — will reconnect")
            self.connected = False
            return False
        except Exception as exc:
            log.error("❌  Error updating presence: %s", exc)
            self.connected = False
            return False

    def clear_presence(self):
        """Clear the Rich Presence activity."""
        with self._lock:
            if self.connected and self.rpc:
                try:
                    self.rpc.clear()
                    log.info("🧹  Presence cleared")
                except Exception:
                    pass
        self.current_anime = None


# ─────────────────────────────────────────────
# Background threads
# ─────────────────────────────────────────────

def reconnect_loop(rpc: DiscordRPC):
    """Periodically try to re-establish the Discord connection."""
    while True:
        time.sleep(RECONNECT_INTERVAL)
        if not rpc.connected:
            log.info("🔄  Attempting to reconnect to Discord …")
            rpc.connect()


def idle_watchdog(rpc: DiscordRPC):
    """Clear presence if no update has been received for IDLE_TIMEOUT seconds
    AND the last known state was paused (not actively playing)."""
    while True:
        time.sleep(10)
        if (rpc.current_anime
                and rpc.last_update_time
                and time.time() - rpc.last_update_time > IDLE_TIMEOUT
                and not rpc.current_anime.get("is_playing", False)):
            log.info("💤  No update for %ds (paused) — clearing presence", IDLE_TIMEOUT)
            rpc.clear_presence()


# ─────────────────────────────────────────────
# Flask API
# ─────────────────────────────────────────────

app = Flask(__name__)
CORS(app)  # Allow Tampermonkey cross-origin requests

discord_rpc = DiscordRPC(CLIENT_ID)


@app.route("/health", methods=["GET"])
def health():
    """Health-check / status endpoint."""
    return jsonify({
        "status": "running",
        "discord_connected": discord_rpc.connected,
        "current_anime": discord_rpc.current_anime,
        "timestamp": datetime.now().isoformat(),
    })


@app.route("/update", methods=["POST"])
def update():
    """Receive anime data from the userscript and push to Discord."""
    data = request.get_json(silent=True)
    if not data or "title" not in data:
        return jsonify({"success": False, "error": "Missing anime data"}), 400

    success = discord_rpc.update_presence(data)
    return jsonify({
        "success": success,
        "message": "Presence updated" if success else "Failed to update — will retry",
    })


@app.route("/clear", methods=["POST"])
def clear():
    """Clear Discord presence (called when user navigates away)."""
    discord_rpc.clear_presence()
    return jsonify({"success": True, "message": "Presence cleared"})


@app.route("/status", methods=["GET"])
def status():
    """Return current anime data (useful for debugging)."""
    return jsonify({
        "connected": discord_rpc.connected,
        "anime": discord_rpc.current_anime,
        "last_update": discord_rpc.last_update_time,
    })


# ─────────────────────────────────────────────
# Entrypoint
# ─────────────────────────────────────────────

def main():
    banner = (
        "\n"
        "╔══════════════════════════════════════════════╗\n"
        "║     🎌  HiAnime Discord RPC Server  🎌      ║\n"
        "╠══════════════════════════════════════════════╣\n"
        f"║  Server   ➜  http://localhost:{PORT:<13}  ║\n"
        f"║  App ID   ➜  {CLIENT_ID}    ║\n"
        "╚══════════════════════════════════════════════╝\n"
        "\n"
        "  📌  Make sure Discord Desktop is running\n"
        "  📌  Install the Tampermonkey userscript\n"
        "  📌  Navigate to hianime.to/watch/...\n"
        "\n"
        "  Press Ctrl+C to stop\n"
    )
    print(banner)

    # Initial connection attempt
    discord_rpc.connect()

    # Start background threads
    threading.Thread(target=reconnect_loop, args=(discord_rpc,), daemon=True).start()
    threading.Thread(target=idle_watchdog, args=(discord_rpc,), daemon=True).start()

    # Start Flask (blocking)
    app.run(host="localhost", port=PORT, debug=False, use_reloader=False)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n🛑  Shutting down …")
        discord_rpc.disconnect()
        print("👋  Goodbye!")
