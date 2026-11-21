# Twitch & YouTube Streams to Shorts

Give it a **Twitch** stream link or a finished **YouTube** live stream link. It gives you back up to **30 finished YouTube Shorts**:

- Full quality: 1080x1920 (vertical, 1080p)
- **Split screen:** gameplay on top (60%), the streamer's facecam below (40%), captions on the line between them
- **AI voiceover intro:** every short opens on its first frame, paused, while an AI voice says a hook line about the clip (about 5 seconds, free, no account needed), then a whoosh and a quick zoom into the clip
- **Progress bar** along the top, so viewers see how much is left and stay to the end
- **Only the best:** it makes about 30% more shorts than you ask for and keeps the ones the AI rates most viral (the rest go to `final\extra`)
- 35 to 45 seconds of clip each (plus the intro)
- Captions burned into the video, no watermark
- A ready-made **title, description and tags** for every short

**How it finds the good moments:** it reads the stream's chat. When chat suddenly goes crazy, something funny or hype just happened, so those moments become your shorts. If a YouTube stream has its chat replay turned off, it listens for the loudest moments instead (the streamer yelling, big reactions).

---

## What you need

| | |
|---|---|
| Computer | Windows 10 or Windows 11 |
| Memory (RAM) | 8 GB minimum, 16 GB recommended |
| Free disk space | About 25 GB for the programs + about 3 GB per stream |
| Internet | Any normal connection |
| Google account | To get a free Gemini API key |

You will install **3 free programs**:

| Program | What it does here |
|---|---|
| **Docker Desktop** | Runs OpenShorts, the part that makes the video vertical and adds captions |
| **Node.js** | Runs the main script |
| **FFmpeg** | Checks and handles the video files |

---

## Step 1: Install the 3 programs (only once)

1. Press the **Windows key** on your keyboard, type **powershell**, and click **Windows PowerShell**. A blue or black window opens.
2. Copy this line, paste it into that window (right-click pastes), and press **Enter**:

   ```
   winget install Docker.DockerDesktop OpenJS.NodeJS.LTS Gyan.FFmpeg
   ```

3. If it asks `Do you agree to all the source agreements terms?`, type **Y** and press **Enter**.
4. If a window pops up asking "Do you want to allow this app to make changes?", click **Yes**. This can happen a few times.
5. Wait until it finishes (5 to 15 minutes).
6. **Restart your computer.**

> **"winget is not recognized"?** Your Windows is missing the App Installer. Install the 3 programs from their websites instead, using the default options:
> - Docker Desktop: https://www.docker.com/products/docker-desktop/
> - Node.js (pick the **LTS** version): https://nodejs.org/
> - FFmpeg: open the Microsoft Store, search **App Installer**, install or update it, then run the winget line above again.

### Check that everything installed

Open PowerShell again (same way as before) and paste these one at a time, pressing **Enter** after each:

```
node -v
```
```
ffmpeg -version
```
```
docker --version
```

Each one should print a version number. If one says **"is not recognized"**, that program didn't install. Restart the computer and try again, or install it from the website links above.

## Step 2: Set up Docker Desktop (only once)

1. Press the **Windows key**, type **Docker Desktop**, and open it.
2. Accept the terms. When it asks you to sign in, you can click **Skip**.
3. If it says **WSL needs updating**, click the button it shows to update, then restart the computer when it asks.
4. Wait until the bottom-left corner of Docker Desktop says **Engine running** (green).

> **Docker says "Virtualization not enabled"?** Virtualization has to be turned on in your PC's BIOS. Search YouTube for "enable virtualization" plus your laptop or motherboard brand. It takes 2 minutes.

## Step 3: Get your free Gemini API key (only once)

This is the AI that writes the titles and picks the best part of each moment.

1. Go to **https://aistudio.google.com/apikey**
2. Sign in with your Google account.
3. Click **Create API key**.
4. Click the copy button next to the key. Paste it into Notepad for now so you don't lose it.

**Keep this key private.** Don't post it online or send it to anyone. Anyone with your key can use your quota.

## Step 4: Download this project (only once)

**Easy way (no git):**

1. On this GitHub page, click the green **Code** button.
2. Click **Download ZIP**.
3. Right-click the downloaded ZIP and click **Extract All**. Choose a drive with plenty of free space (for example `D:\`).

**If you use git:**

```
git clone https://github.com/ammar-2408/twitch-to-shorts.git
```

## Step 5: Make your shorts (every time)

1. Open **Docker Desktop** and wait for **Engine running**.
2. Open the project folder and double-click **`start.bat`**.
   - If Windows shows **"Windows protected your PC"**, click **More info**, then **Run anyway**.
3. **First time only:** it asks for your Gemini key. Paste it (right-click) and press **Enter**. It's saved, so it won't ask again.
4. It asks for the stream link. Paste it and press **Enter** (see the next section for which link).
5. Leave the window open and let it work. You can use your PC, but it will be slower than usual.

> **The very first run takes an extra 15 to 30 minutes** because Docker builds OpenShorts. Every run after that starts right away.

### Which link to use: Twitch

It needs a **video link**, which looks like this:

```
https://www.twitch.tv/videos/2932305259
```

How to find it:

1. Go to the streamer's Twitch page (for example `twitch.tv/kaicenat`).
2. Click the **Videos** tab.
3. Click the stream you want. Copy the link from the address bar.

A stream that is **still live** works too. It will show at the top of the Videos tab while it's running.

**These will NOT work:** a channel link like `twitch.tv/kaicenat`, or a clip link like `clips.twitch.tv/...`.

### Which link to use: YouTube

Use the link of a live stream that has **ended**. Any of these work:

```
https://www.youtube.com/watch?v=3QjXNSf6keg
https://youtu.be/3QjXNSf6keg
https://www.youtube.com/live/3QjXNSf6keg
```

How to find it: go to the channel, click the **Live** tab, open a past stream, and copy the link from the address bar (or click **Share** > **Copy**).

Good to know:
- The stream must have **finished**. A stream that is still live won't work yet. Try again after it ends.
- It must be **public**. Members-only and private streams won't work.
- **Best results:** streams with **chat replay** (you can see the chat replaying next to the video). Without chat replay it still works, but it finds moments by loudness, which is a bit less accurate than chat.

## Step 6: Get your shorts

When the window says **Finished**, open this folder inside the project:

```
runs\<video number>\final\
```

(For Twitch, the video number is the number at the end of the link. For YouTube the folder is `yt_` plus the video id, for example `runs\yt_3QjXNSf6keg\final\`.)

**Split screen:** if the streamer has a facecam, every short is split screen: gameplay on top, the streamer below, captions on the line in the middle. If a clip has no facecam on screen (for example a full-screen cutscene), that short keeps the full picture instead. Each short's `.txt` says which layout it got.

Inside you'll find:

| File | What it is |
|---|---|
| `short_01.mp4` to `short_30.mp4` | Your shorts, ready to upload |
| `short_01.txt` to `short_30.txt` | Title, description and tags for each short. Open with Notepad and copy-paste into YouTube |
| `shorts.csv` | A list of all shorts in one sheet (opens in Excel), **best moments first** |
| `extra\` | The extra shorts that didn't make the cut (lower AI score). Still usable if you want more |

---

## How long does it take?

- Downloading the chat: 5 to 30 minutes (longer for big streamers). YouTube chat replays can take up to 40 minutes. Without chat replay, the audio download and check take about 5 minutes
- Making 30 shorts: about 2 to 4 hours, depending on your PC

You don't need to watch it. **`start.bat` stops your PC from going to sleep** until it's done. Keep a laptop plugged in.

## If it stops or crashes

Just double-click `start.bat` again and paste the **same link**. It picks up where it stopped. Finished shorts are kept and not made again.

## How to stop it

Close the `start.bat` window. To also stop OpenShorts running in the background, open Docker Desktop and click the **stop** button next to **openshorts**.

## Uploading to YouTube

1. Go to **https://studio.youtube.com** and click **Create** > **Upload videos**.
2. Choose a `short_XX.mp4` file.
3. Copy the **TITLE**, **DESCRIPTION** and **TAGS** from the matching `short_XX.txt`. Tags go under **Show more**.
4. **Audience:** select **"No, it's not made for kids"**. Choosing "made for kids" kills your reach.
5. **Age restriction:** select **No**.
6. **Category** (under Show more): **Gaming**.
7. **Visibility:** **Public**, or **Schedule** to post later.

Tips:
- Post **2 or 3 a day**, not all 30 at once. Start from the top of `shorts.csv`.
- Always keep the credit line to the streamer in the description.

## Problems and fixes

| What you see | What to do |
|---|---|
| `Node.js is not installed` / `FFmpeg is not installed` / `Docker Desktop is not installed` | Do Step 1 again, then restart the computer |
| `Open Docker Desktop first` | Open Docker Desktop, wait for **Engine running**, then run `start.bat` again |
| `OpenShorts failed to start` | Restart Docker Desktop (right-click its icon near the clock > Restart) and try again |
| Chat download seems stuck | It's not. Big streams have millions of messages. Give it up to 30 minutes |
| `chat download failed` | Check the link is a `twitch.tv/videos/...` link and the video is public (not subscriber-only) |
| `This stream is still live or still processing` | The YouTube stream hasn't ended yet. Run it again after it ends |
| `YouTube refused the request` / "Sign in to confirm you're not a bot" | YouTube wants a login. See **YouTube cookies** below |
| Shorts came out full frame, not split screen | The streamer has no facecam, or it's hidden in those clips. That's expected |
| `voiceover intro failed` | The free AI voice needs internet and sometimes drops a request. That short is still made, just without the intro |
| The streamer's half looks softer than the game | Normal: a facecam is small in the original stream and has to be enlarged. It's cleaned and sharpened, and YouTube streams are taken in 1440p when available, which helps |
| One short says `FAILED` | Run `start.bat` again with the same link. It retries only the missing ones |
| Wrong Gemini key / key stopped working | Delete the file `openshorts\.env`, run `start.bat` again, and paste a new key |
| PC is very slow | Normal while it's working. It uses most of your processor |
| Disk is full | Delete old folders inside `runs\` once you've uploaded those shorts |

## Getting updates

- Downloaded the ZIP: download the new ZIP and copy your `runs` folder and your `openshorts\.env` file into it.
- Used git: open PowerShell in the project folder and run `git pull`

---

## Advanced (optional)

You can run it yourself from PowerShell inside the project folder:

```
node make-shorts.mjs https://www.twitch.tv/videos/2932305259 --count 30 --min 35 --max 60 --parallel 2
```

| Option | Meaning | Default |
|---|---|---|
| `--count` | How many shorts to make | 30 |
| `--min` | Shortest length in seconds | 35 |
| `--max` | Longest length in seconds | 45 |
| `--pick` | Make this many times more shorts than `--count` and keep the best ones (1 = no extras) | 1.3 |
| `--bar` | `on` or `off`: progress bar along the top | on |
| `--punch` | `on` or `off`: whoosh + quick zoom where the intro ends and the clip starts | on |
| `--parallel` | How many shorts to make at the same time (each needs about 2 GB RAM) | 3 |
| `--layout` | `split` (gameplay top, facecam bottom when there is one) or `full` (the whole picture, no split) | split |
| `--cam` | Split screen: how much of the height the streamer's facecam gets, in percent (25 to 60). Smaller looks sharper, because the small facecam is enlarged less | 40 |
| `--intro` | `on` or `off`: the AI voiceover hook at the start of every short | on |
| `--voice` | Which AI voice says the hook. Try `en-US-GuyNeural`, `en-US-RogerNeural`, `en-US-ChristopherNeural`, `en-US-EricNeural` | `en-US-AndrewNeural` |

The link can be a Twitch video link or a YouTube link. OpenShorts must be running first. `start.bat` does this for you, or run `docker compose up -d --build backend` inside the `openshorts` folder.

### YouTube cookies (only if YouTube blocks downloads)

Sometimes YouTube asks to "confirm you're not a bot". Then it needs your browser's YouTube login:

1. In Chrome, install the extension **"Get cookies.txt LOCALLY"**.
2. Go to **youtube.com** (logged in), click the extension, and click **Export**.
3. Rename the downloaded file to **`youtube-cookies.txt`** and put it in the project folder (next to `start.bat`).
4. Run `start.bat` again.

This file is your login. **Never share it or upload it.** It's already excluded from GitHub. A spare Google account is safest.

## Credits

- [OpenShorts](https://github.com/mutonby/openshorts) (MIT license): picks the best part of each moment, transcribes it and makes the captions. A slightly modified copy is included in `openshorts/` (clips are always kept at least the minimum length; `split_render.py` adds the split-screen layout).
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (inside the OpenShorts container): downloads YouTube chat replays, audio and clips. `ytlive.py` handles very long streams that YouTube is still processing.
- [edge-tts](https://github.com/rany2/edge-tts) (inside the OpenShorts container): the free AI voice for the intro (`intro_voice.py`), using Microsoft Edge's online neural voices.
- [TwitchDownloader](https://github.com/lay295/TwitchDownloader) (MIT license): downloads the chat and video. See `COPYRIGHT.txt` and `THIRD-PARTY-LICENSES.txt`.
- `chat-clips.mjs`: the chat spike finder, from the Chat Clip Finder guide.
- The clips belong to the streamers. Always give them credit.
