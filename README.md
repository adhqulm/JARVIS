# AI Companion

A chat companion with robot eyes, a natural voice, and a camera that learns who is in front of it.
Same engine as the language tutor (ElevenLabs voice, Claude as the brain), minus the lessons.

## Run it
```bash
cd companion          # this folder
cp ../.env .env       # reuse the keys from the tutor (ANTHROPIC_API_KEY, ELEVENLABS_API_KEY)
npm install
npm run dev           # then open http://localhost:5173
```
Tap anywhere or press Space to wake it, hold Space (or the mic button) to talk, or type.

## Faces and memory
- Click **Camera off** (top left) to turn the camera on. The browser asks for permission once.
- If it sees someone it doesn't know it says hi and asks who they are. If they give a name **and agree**, it learns the face.
  You can also open **People → Teach me a new face**.
- Known people are greeted by name when they walk up (at most once per 10 minutes each). The eyes follow whoever is in view.
- While chatting it quietly saves lasting facts ("Kim loves cardamom buns") as private notes per person. Say "forget that" to delete one.
- **People** (top left) shows everyone it knows, their notes, and lets you delete a note or a whole person. A checkbox shows a small camera preview with face boxes.

When someone comes back into view it only says hi if they have been away for a while (12 minutes by default; change it under People), so stepping out for a moment doesn't get a greeting. Messages on the board are still passed on.

## Expressions and gestures
- **Expressions:** a small model reads each recognised person's face as happy, sad, surprised, angry, scared, disgusted or neutral, smoothed over a few frames.
  The eyes mirror smiles and surprise, and the model is told the (rough) label as context. It is a crude model that is often wrong (a posed or serious face can read as "sad"), so the companion is told never to state it as fact.
  By default it does **not** comment out loud on how you look; tick *Comment out loud on how I look* in **People** to turn that on (at most once per person per 5 minutes).
- **Gestures:** hand tracking (MediaPipe Hands, bundled in `public/mediapipe`) spots **waving**, **thumbs up**, **thumbs down** and a **peace sign**. The companion reacts and waves back with its eyes and voice.
  Hold still gestures for about half a second, and wave a raised open hand side to side a few times.
- Both run in the browser with the same privacy rules as faces: no video leaves the machine, only short text like "Kim waved" or "Kim looks happy" is sent to the chat model.

## Name, voice and memory

- **Name**: Voice button, then "My name". The name is also given to speech recognition so push-to-talk hears it right. You can also set `COMPANION_NAME` in `.env`.
- **Hands-free**: switch on **Hands-free** in the top bar and just say the name, optionally with "hey", then your request ("Vesper, set a timer for ten minutes"). Say the name alone and it listens for the next sentence. For a few seconds after it answers you can keep talking without the name. It ignores the microphone while it speaks, so it can't answer itself. Names are matched loosely (one letter off, or the same consonants), and the Voice panel has an "also answer to" box for spellings your browser keeps producing, plus the language it listens in. Who does the listening: **automatic** uses the browser's own speech service (Chrome and Edge send the audio to their cloud for it, Safari uses Apple's) and switches to **ElevenLabs** by itself if that service can't be reached, which is what happens in Brave, in the desktop app's built-in browser, or behind some firewalls. With ElevenLabs the microphone is watched locally and only short clips of someone speaking are sent for transcription (uses a little credit; it pauses for two minutes if the room is so noisy that it would send more than 16 clips in 5 minutes). You can force either one in the Voice panel. It is off by default and push-to-talk stays the most accurate way to talk.
- **Voice**: the same panel lists every voice on your ElevenLabs account (the key needs the "Voices: read" permission; otherwise paste a voice ID). Picking one saves it for everyone and it says a line in the new voice. Stored in `data/settings.json`; the `.env` voice is just the default.
- **Memory of past chats**: it keeps its last ~30 exchanges word for word and folds older ones into a short running summary (`data/memory.json`, mode 600), then uses that quietly so it doesn't feel like a new conversation each time. Nothing is recited back, and it is told not to pass one person's private things to another. People, then "Forget our past chats" wipes it. App events and greetings are not stored.

## Hands-free on this computer (wake word) and training "Halcyon"

With **Hands-free** on and the engine on Automatic, a small wake word model runs on this computer (`public/wakeword/`, using onnxruntime-web). It listens in real time and nothing is sent anywhere until it hears the wake word, which removes the latency and the credit use of sending every phrase to be transcribed. Run `npm install` after updating (new dependency).

- **Today**: the starter model is "hey Jarvis" (pretrained, openWakeWord, non-commercial licence, fine for home use). The companion takes that as its name automatically while that model is selected.
- **Halcyon (or any name you choose)**: train it once, it takes under an hour:
  1. Open the openWakeWord training notebook: https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb?usp=sharing
  2. Set the target phrase to `halcyon` (or "hey halcyon"), run all cells, and wait for it to finish.
  3. Download the resulting `.onnx` file, name it `halcyon.onnx` and put it in `public/wakeword/` (or `dist/wakeword/` if you serve the build).
  4. Reload. It shows up in Voice, Hands-free, Wake word model, and is preferred over the pretrained one.
- **Tuning**: the Sensitivity select (lower = triggers more easily), the "also answer to" box, and the engine choice are in the Voice panel. It was tested on synthetic speech only, so adjust Sensitivity if it misses you or fires on the TV.
- Audio processing runs in the browser next to the eyes; a very weak computer may drop audio.

## Speech recognition for Swedish, Russian and Finnish

Voice panel, Speech recognition: tick the languages you speak (default English, Svenska, Русский, Suomi). With one ticked, speech is transcribed in that language only. With several, the language is detected and, when the result looks unsure, the clip is retried in each ticked language and the best transcript wins (a few extra transcription calls, only for unsure clips). It is also given hint words: everyone's names, what is on the shopping and to-do lists, and whatever you add in "Words I often mishear". The companion is told that recognition is imperfect in those languages and interprets odd words generously from context, asking only if it truly can't tell.

The "Heard:" preview under the eyes is gone; what you say is trusted and not echoed back (typed messages still show). The tutor app keeps its own.

## Music

Say "play Dancing Queen by Abba", "play some jazz", "next", "turn it down", "stop the music" (or use the small player at the bottom left).

- **Songs** come from YouTube and play in YouTube's own embedded player, so they can include ads and a few videos refuse to embed (it skips to the next one). Searching needs a free **YouTube Data API key**: in Google Cloud Console create a project, enable "YouTube Data API v3", create an API key, and add `YOUTUBE_API_KEY=...` to `.env` (not shared anywhere else). The free quota is about 100 searches a day. Without a key it offers radio instead.
- **Radio** uses the free Radio Browser directory (no key): genres, countries or station names, https streams only.
- The player has a small video square, because YouTube's rules want the player visible; the ▣ button tucks it out of sight and the music keeps playing.
- The music drops to about 15% while someone is talking to it, while it thinks and speaks, and when a timer rings, then comes back. Volume is saved.
- Tip: use the on-device wake word (or push to talk) while music is playing. The browser speech service would also hear the lyrics.
- Browsers refuse sound before the page has been tapped once, so tap the page after opening it.

## Web search (Brave)

For niche, local or recent questions ("is the pharmacy in Hötorget open on Sundays", "what does this Finnish word mean", "who won last night") the companion can look things up with the Brave Search API. Add `BRAVE_API_KEY=...` to `.env` (from the Brave Search API dashboard; the free plan works) and restart the server. The key stays on the server.

- Only the search words are sent to Brave, never faces, memory or lists, and it is told not to put private household details in a query. Results are treated as information only, so a web page can't give it instructions.
- It says a short "let me check" first, searches at most twice per question, and answers in your language with a source mention when useful. Same query within 10 minutes is answered from a small cache, and requests are spaced out to fit the free plan's one-per-second limit.
- Without a key it answers from what it knows and says when it isn't sure. The server's start-up lines show whether search and songs are on.

## Message board

Say "say hello to Kristina" or "tell Kim dinner is at six". It goes on the board (Board button) and is passed on by itself the next time that person appears in front of the camera, spoken naturally and with who it is from. Then it is ticked off. If they are already in view it just says it. "Private" messages are only said when that person is alone in view. It needs to know the person's face (People), checks every 15 seconds for people already in view, and if you interrupt it mid-message the message stays on the board and is tried again. Stored in `data/board.json`; delivered ones are kept for a week.

## Games, kitchen mode, timers and lists

Just ask for them, by voice or typing.

- **Games** (the camera must be on): *"let's play rock paper scissors"*, *"Simon says"*, *"let's make faces"*. The games run in the browser, so they are quick and the camera never leaves it. Skip ends a game. Hand games use hand tracking, the face game uses the expression guess, which is crude: exaggerate.
- **Kitchen mode**: *"give me a pasta recipe"* shows one big step at a time. Thumbs up = next step, thumbs down = back, wave = repeat it, or use the buttons, or say "next". Ask for a timer when a step needs waiting.
- **Timers**: *"set a timer for 10 minutes for the pasta"*. They show as chips at the top (click one to cancel). When one rings, the eyes react, it beeps and says its line; wave, thumbs up, click the banner or send a message to stop it. Timers survive a page reload but only ring while the page is open.
- **Shared lists**: *"add milk and eggs to the shopping list"*, *"what's on the todo list?"*, *"take milk off"*. Everyone in the house sees the same lists (Lists button to view or tick things off). Saved in `data/lists.json` on this machine. The companion notes who added what when only one person is in view.
- **Sleep and wake**: with the camera on and nobody in view for five minutes, the eyes close; they open when someone appears or waves. It also knows the time, so it can notice a late night.

There are no smart-home integrations: nothing here controls devices.

## Privacy
- Face recognition runs **in the browser** (face-api, models are in `public/models`). No video or photo is ever stored or sent anywhere.
- Only face *descriptors* (128 numbers per sample, not images) are saved, in `data/profiles.json` on this machine (file mode 600). Delete the file, or use People, to wipe everything. Shared lists live in `data/lists.json`, the board in `data/board.json`.
- The chat model only receives the **names** of who is in view and the saved notes about them, never video.
- Recognition is a fun gimmick, not security: don't use it to protect anything.

## Tuning
- `?thresh=0.45` on the URL makes matching stricter (default 0.5; lower means fewer false matches but more "who are you?").
- `.env`: `COMPANION_MODEL` (default claude-sonnet-5-5), `HOUSEHOLD_NOTE` (a sentence about your home that is added to the prompt, e.g. "Kim and Anna live in Stockholm; Anna is learning Georgian").
  Voice options (`ELEVENLABS_*`) are the same as in the tutor.
- Gestures need your hand clearly in view and reasonably lit; if hand tracking can't start you get a notice and everything else keeps working.
- Works best with a face looking roughly at the camera. Strongly tilted or very close faces can be missed.
#   J A R V I S  
 