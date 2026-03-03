# SillyTavern OpenRouter TTS

A SillyTavern extension that adds Text-to-Speech via OpenRouter's audio-capable models.

Since SillyTavern doesn't have a built-in way to use OpenRouter for TTS, this extension bridges that gap — fully client-side, no server plugin required.

## Features

- **3 Models**: GPT-4o Mini TTS, TTS-1, TTS-1 HD
- **11 Voices**: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse
- **6 Audio Formats**: MP3, WAV, Opus, AAC, FLAC, PCM16
- **Speed Control**: 0.25x – 4.0x
- **Auto-speak**: Automatically speaks new assistant messages
- **Per-message speak button**: 🔊 icon on each message for on-demand playback
- **Sequential queue**: Messages play one at a time
- **Text cleaning**: Strips HTML, markdown, and code blocks before sending
- **Connection status**: Green/red/amber indicator showing API health

## Installation

### Option A: Install via URL (Recommended)

1. Open SillyTavern
2. Go to **Extensions** → **Install Extension**
3. Paste this repo URL and click Install

### Option B: Manual Install

1. Clone or download this repo into:
   ```
   SillyTavern/public/scripts/extensions/third-party/sillytavern-openrouter-tts/
   ```
2. Restart SillyTavern

## Setup

1. Open **Extensions** panel in SillyTavern
2. Find **OpenRouter TTS** and expand it
3. Enter your [OpenRouter API key](https://openrouter.ai/keys)
4. Select a model, voice, and audio format
5. Enable TTS with the toggle
6. Click **Test Voice** to verify everything works
7. Start chatting — responses will be spoken automatically!

## How It Works

| Model | API Approach |
|-------|-------------|
| TTS-1 / TTS-1 HD | `/api/v1/audio/speech` — direct audio response |
| GPT-4o Mini TTS | `/api/v1/chat/completions` with `modalities: ["text", "audio"]` — base64 audio in response |

## Requirements

- SillyTavern (latest release)
- An [OpenRouter](https://openrouter.ai) API key with credits

## License

AGPLv3
