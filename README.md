# Captify AI MVP

Captify is a local-first video caption editor. Upload a video, transcribe it when a provider is configured, edit words and styles in the browser, preview captions live, and render an MP4 with captions burned in.

## Requirements

- Node.js 20 or newer (Node 24 is fine)
- [FFmpeg](https://ffmpeg.org/download.html) on your PATH for video export
- Optional: an `OPENAI_API_KEY` for automatic transcription. Without it, the editor still works with manually created captions.

## Run locally

1. Copy `.env.example` to `.env` and set only the services you want.
2. Start the app with `node server.js` (or `npm run dev` when npm is working on your machine).
3. Open `http://localhost:3000`.

No packages are required: the server uses only Node's built-in modules. Uploads and renders are stored locally in `uploads/` and `exports/`, which are ignored by Git.

## Transcription

`OPENAI_API_KEY` uses the audio transcription endpoint with `verbose_json` and a word-timestamp request. If word data is unavailable, Captify falls back to segment timing. Do not expose this key in the browser or commit it.

For local speech-to-text, set `WHISPER_COMMAND` to a command template that consumes `%INPUT%` and writes JSON to `%OUTPUT%`. This makes it possible to use an installed Whisper/WhisperX wrapper without coupling the app to a particular model or GPU. The JSON should be either `{ "words": [{ "word": "Hello", "start": 0, "end": 0.4 }] }` or `{ "segments": [{ "text": "Hello", "start": 0, "end": 0.4 }] }`.

## Deployment notes

The current server writes uploaded media and runs FFmpeg, so it is intended for a persistent Node host, container, or worker. Vercel serverless functions are not a suitable production renderer for long-lived video work. For a Vercel frontend, move upload storage to object storage and submit transcription/render jobs to a separate worker.

Firebase is optional for this MVP; it can later provide Authentication, Firestore project metadata, and Cloud Storage. No Firebase project has been linked or modified.
