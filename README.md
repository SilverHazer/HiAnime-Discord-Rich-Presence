# 🎌 HiAnime Discord Rich Presence

Show your currently-watching anime from **hianime.to / hianime.do** as Discord Rich Presence — complete with anime poster, episode number, and live playback progress.

![Discord Rich Presence Example](https://i.imgur.com/placeholder.png)

---

## How It Works

| Component                   | Role                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| **Tampermonkey Userscript** | Runs on HiAnime watch pages; scrapes anime title, episode, poster image, and video player state |
| **Python Desktop Server**   | Receives data from the userscript via `localhost:5555` and pushes it to Discord Rich Presence   |

```
Browser (HiAnime) ──HTTP POST──▶ Python Server ──IPC──▶ Discord Desktop
```

---

## Prerequisites

- **Python 3.9+**
- **Discord Desktop** (must be running)
- **Firefox** or **Chrome** with [Tampermonkey](https://www.tampermonkey.net/) extension
- A Discord Application

---

## Setup

### 1. Install Python Dependencies

```bash
cd "d:\Workspace\Hianime Discord"
pip install -r requirements.txt
```

### 2. Install the Tampermonkey Userscript

1. Open Tampermonkey in your browser → **Create a new script**
2. Delete the template content
3. Copy-paste the entire contents of `hianime_discord_rpc.user.js`
4. Press **Ctrl+S** to save
5. Make sure the script is **enabled** ✅

### 3. (Optional) Upload Fallback Assets to Discord

If the anime poster image can't be found, the server falls back to an asset named `anime_logo`. To set this up:

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application → **Rich Presence** → **Art Assets**
3. Upload an image and name it `anime_logo`

---

## Usage

### Start the Server

```bash
python hianime_rpc.py
```

You should see:

```
╔══════════════════════════════════════════════╗
║     🎌  HiAnime Discord RPC Server  🎌      ║
╠══════════════════════════════════════════════╣
║  Server   ➜  http://localhost:5555          ║
║  App ID   ➜              ║
╚══════════════════════════════════════════════╝

  ✅  Connected to Discord RPC
```

### Watch Anime

Open any anime on **hianime.to** or **hianime.do** (e.g. `hianime.to/watch/...`).
Your Discord status will automatically update with:

- 🎌 **Anime title**
- 📺 **Episode number**
- 🖼️ **Anime poster** as the large image
- ▶️ **Playback progress** (elapsed / remaining time)
- 🔗 **"Watch on HiAnime"** button linking to the page

When you **pause**, Discord shows "Paused" and the timer stops.
When you **navigate away** or close the tab, the presence is automatically cleared.

---

## Troubleshooting

| Problem                                      | Solution                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Discord shows nothing                        | Make sure Discord Desktop is running **before** starting the Python server                   |
| Server says "Discord connection failed"      | Close and reopen Discord, then restart the Python server                                     |
| Console shows "Desktop server not reachable" | Make sure `python hianime_rpc.py` is running                                                 |
| Wrong anime title                            | Try refreshing the page; the script uses multiple strategies but may pick up stale DOM data  |
| No poster image                              | The anime page may not have a poster; upload `anime_logo` asset as a fallback (see Setup §3) |
| Presence doesn't clear when I stop           | The idle watchdog clears it after 60s automatically                                          |

### Debug Mode

To enable verbose logging in the browser console, edit the userscript and set:

```js
const DEBUG = true;
```

### API Endpoints (for debugging)

| Endpoint  | Method | Description                              |
| --------- | ------ | ---------------------------------------- |
| `/health` | GET    | Server status + Discord connection state |
| `/status` | GET    | Currently displayed anime data           |
| `/update` | POST   | Push anime data (used by userscript)     |
| `/clear`  | POST   | Clear Discord presence                   |

Example:

```bash
curl http://localhost:5555/health
curl http://localhost:5555/status
```

---

## Project Structure

```
Hianime Discord/
├── hianime_rpc.py                  # Python RPC server (run this)
├── hianime_discord_rpc.user.js     # Tampermonkey userscript (install this)
├── requirements.txt                # Python dependencies
└── README.md                       # This file
```

---

## Privacy

- All communication happens **locally** (`localhost:5555`) — no data is sent to external servers
- Only the anime title, episode, and poster URL are shared with Discord
- You can stop sharing at any time by closing the Python server or disabling the userscript

