# JARVIS

A home AI companion with robot eyes, a natural voice, and a camera that learns who is in front of it.
Claude is the brain, ElevenLabs is the voice.

**Contents:**
[Setup](#setup) ·
[Talking to it](#talking-to-it) ·
[Faces and memory](#faces-and-memory) ·
[Expressions and gestures](#expressions-and-gestures) ·
[Wake word](#wake-word) ·
[Languages](#languages) ·
[Music](#music) ·
[Web search](#web-search) ·
[Message board](#message-board) ·
[Games, timers and lists](#games-kitchen-mode-timers-and-lists) ·
[Privacy](#privacy) ·
[Configuration](#configuration)

---

## Setup

1. Create a `.env` file in the project folder with at least:

   ```env
   ANTHROPIC_API_KEY=...
   ELEVENLABS_API_KEY=...
   ```

   Optional keys for extra features are listed under [Configuration](#configuration).

2. Install and start:

   ```bash
   npm install
   npm run dev
   ```

3. Open http://localhost:5173 and tap the page once (browsers block sound until you do).

---

## Talking to it

| Action | How |
| --- | --- |
| Wake it | Tap anywhere or press **Space** |
| Talk | Hold **Space** or the mic button |
| Type | Use the text box |
| Hands-free | Turn on **Hands-free** in the top bar, then say its name |

### Name

Set it under **Voice → My name**, or with `COMPANION_NAME` in `.env`.
The name is passed to speech recognition so push-to-talk hears it correctly.

### Hands-free mode

Say the name (optionally with "hey") followed by your request:

> "Vesper, set a timer for ten minutes"

- Say the name alone and it listens for the next sentence.
- For a few seconds after it answers, you can keep talking without the name.
- It ignores the microphone while speaking, so it can't answer itself.
- Names are matched loosely (one letter off, or the same consonants). Add extra spellings in **Voice → also answer to**.
- Off by default. Push-to-talk is still the most accurate.

**Who does the listening** (choose in the Voice panel):

- **Automatic**: uses the browser's speech service (Chrome/Edge send audio to their cloud, Safari uses Apple's). Falls back to ElevenLabs if that service is unavailable, e.g. in Brave or behind some firewalls.
- **ElevenLabs**: the mic is watched locally and only short clips of speech are sent for transcription. Uses a little credit, and pauses for two minutes if the room is noisy enough to send more than 16 clips in 5 minutes.

### Voice

The Voice panel lists every voice on your ElevenLabs account (the API key needs the **Voices: read** permission; otherwise paste a voice ID).
Picking one saves it for everyone in `data/settings.json`. The voice in `.env` is just the default.

### Memory of past chats

- Keeps the last ~30 exchanges word for word and folds older ones into a short summary (`data/memory.json`).
- Uses it quietly for continuity. It doesn't recite it back, and it won't pass one person's private things to another.
- **People → Forget our past chats** wipes it.

---

## Faces and memory

- Click **Camera off** (top left) to turn the camera on.
- When it sees someone new, it says hi and asks who they are. If they give a name **and agree**, it learns the face. You can also use **People → Teach me a new face**.
- Known people are greeted by name, at most once per 10 minutes each, and only after they've been away a while (12 minutes by default, adjustable in People).
- The eyes follow whoever is in view.
- It saves lasting facts as private notes per person (e.g. "Kim loves cardamom buns"). Say **"forget that"** to delete one.
- **People** shows everyone it knows and their notes, and lets you delete notes or people. A checkbox shows a small camera preview with face boxes.

---

## Expressions and gestures

### Expressions

A small model reads each recognised face as happy, sad, surprised, angry, scared, disgusted or neutral.

- The eyes mirror smiles and surprise.
- The model is crude and often wrong, so the companion never states it as fact.
- It does **not** comment on how you look unless you tick **People → Comment out loud on how I look** (at most once per person per 5 minutes).

### Gestures

Hand tracking (MediaPipe Hands, bundled in `public/mediapipe`) recognises:

- **Wave**: raise an open hand and move it side to side a few times
- **Thumbs up / thumbs down**
- **Peace sign**

Hold still gestures for about half a second. Your hand needs to be clearly in view and reasonably lit.

---

## Wake word

With **Hands-free** on and the engine set to **Automatic**, a small wake word model runs locally (`public/wakeword/`, via onnxruntime-web). Nothing is sent anywhere until it hears the wake word.

- **Default model:** "hey Jarvis" (pretrained openWakeWord, non-commercial licence, fine for home use). While it's selected, the companion's name is Jarvis.
- **Tuning:** Sensitivity (lower = triggers more easily) is in the Voice panel. Adjust it if it misses you or fires on the TV.
- A very weak computer may drop audio.

### Training a custom wake word (e.g. "Halcyon")

Takes under an hour:

1. Open the [openWakeWord training notebook](https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb?usp=sharing).
2. Set the target phrase (e.g. `halcyon` or `hey halcyon`) and run all cells.
3. Download the `.onnx` file, rename it (e.g. `halcyon.onnx`) and put it in `public/wakeword/` (or `dist/wakeword/` if serving the build).
4. Reload. It appears under **Voice → Hands-free → Wake word model** and is preferred over the default.

---

## Languages

Under **Voice → Speech recognition**, tick the languages you speak (default: English, Svenska, Русский, Suomi).

- **One language ticked:** speech is transcribed in that language only.
- **Several ticked:** the language is detected automatically. Unsure clips are retried in each language and the best result wins.
- Recognition gets hint words: everyone's names, list items, and anything in **Words I often mishear**.
- The companion interprets odd words generously from context and only asks when it truly can't tell.

---

## Music

> "play Dancing Queen by Abba" · "play some jazz" · "next" · "turn it down" · "stop the music"

Or use the small player at the bottom left.

- **Songs** play from YouTube (may include ads; videos that won't embed are skipped). Requires a `YOUTUBE_API_KEY` (see [Configuration](#configuration)). Free quota is about 100 searches a day.
- **Radio** works with no key, via the free Radio Browser directory.
- The video square must stay visible per YouTube's rules. The **▣** button tucks it away while music keeps playing.
- Music ducks to ~15% while someone talks, while it speaks, and when a timer rings.
- Use the wake word or push-to-talk while music plays, since the browser speech service would also hear the lyrics.

---

## Web search

For local, niche or recent questions it can search with the Brave Search API. Add `BRAVE_API_KEY` to `.env` (the free plan works) and restart.

- Only search words are sent, never faces, memory or lists.
- Results are treated as information only, so web pages can't give it instructions.
- At most two searches per question. Repeats within 10 minutes come from a cache.
- Without a key it answers from what it knows and says when it isn't sure.

The server's startup log shows whether search and songs are enabled.

---

## Message board

> "say hello to Kristina" · "tell Kim dinner is at six"

- The message goes on the board (**Board** button) and is delivered the next time that person appears on camera, along with who it's from.
- **Private** messages are only said when that person is alone in view.
- The recipient's face must be known (People).
- If interrupted mid-message, it stays on the board and is retried.
- Stored in `data/board.json`. Delivered messages are kept for a week.

---

## Games, kitchen mode, timers and lists

Just ask, by voice or typing.

| Feature | Example | Notes |
| --- | --- | --- |
| **Games** | "let's play rock paper scissors", "Simon says", "let's make faces" | Camera must be on. **Skip** ends a game. For the face game, exaggerate. |
| **Kitchen mode** | "give me a pasta recipe" | One big step at a time. 👍 next, 👎 back, wave to repeat, or say "next". |
| **Timers** | "set a timer for 10 minutes for the pasta" | Shown as chips at the top (click to cancel). Stop a ringing timer with a wave, 👍, or a click. Only rings while the page is open. |
| **Shared lists** | "add milk and eggs to the shopping list", "what's on the todo list?" | Everyone sees the same lists (**Lists** button). Saved in `data/lists.json`. |
| **Sleep** | | With the camera on and nobody around for 5 minutes, the eyes close. They open when someone appears. |

There are no smart-home integrations: it doesn't control any devices.

---

## Privacy

- Face recognition runs **in the browser** (face-api, models in `public/models`). No video or photos are stored or sent anywhere.
- Only face *descriptors* (128 numbers per sample, not images) are saved, in `data/profiles.json`. Delete the file or use People to wipe them.
- The chat model only receives the **names** of who is in view, their saved notes, and short text like "Kim waved". It never receives video.
- Recognition is a fun gimmick, not security. Don't use it to protect anything.

All local data lives in `data/`, which is git-ignored.

---

## Configuration

### `.env` keys

| Key | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | Claude, the brain |
| `ELEVENLABS_API_KEY` | Yes | Voice and transcription |
| `YOUTUBE_API_KEY` | No | Song search. In Google Cloud Console, enable "YouTube Data API v3" and create an API key |
| `BRAVE_API_KEY` | No | Web search |
| `COMPANION_NAME` | No | Default name |
| `COMPANION_MODEL` | No | Chat model (default `claude-sonnet-5-5`) |
| `HOUSEHOLD_NOTE` | No | A sentence about your home added to the prompt, e.g. "Kim and Anna live in Stockholm" |
| `ELEVENLABS_VOICE_ID` | No | Default voice |
| `PORT` | No | Server port |

### Other tuning

- Add `?thresh=0.45` to the URL for stricter face matching (default `0.5`; lower means fewer false matches but more "who are you?").
- Faces work best looking roughly at the camera. Strongly tilted or very close faces can be missed.
- If hand tracking can't start, you get a notice and everything else keeps working.
