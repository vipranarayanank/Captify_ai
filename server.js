import http from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const root = process.cwd();
const publicDir = join(root, "public");
const uploadDir = join(root, "uploads");
const exportDir = join(root, "exports");
[uploadDir, exportDir].forEach((dir) => mkdirSync(dir, { recursive: true }));
const port = Number(process.env.PORT || 3000);
const maxBytes = Number(process.env.MAX_UPLOAD_MB || 250) * 1024 * 1024;

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" };
const jobs = new Map();

function json(res, status, body) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }
function safeName(name) { return basename(name || "video.mp4").replace(/[^a-zA-Z0-9._-]/g, "_"); }
function parseMultipart(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (chunk) => { size += chunk.length; if (size > maxBytes) { reject(new Error(`Upload exceeds ${process.env.MAX_UPLOAD_MB || 250} MB`)); req.destroy(); } else chunks.push(chunk); });
    req.on("end", () => {
      const boundaryMatch = /boundary=(.+)$/.exec(req.headers["content-type"] || "");
      if (!boundaryMatch) return reject(new Error("Expected multipart upload"));
      const boundary = Buffer.from(`--${boundaryMatch[1]}`); const source = Buffer.concat(chunks); const parts = [];
      let start = source.indexOf(boundary) + boundary.length + 2;
      while (start > boundary.length) {
        const end = source.indexOf(boundary, start); if (end < 0) break;
        const part = source.subarray(start, end - 2); const split = part.indexOf("\r\n\r\n");
        if (split >= 0) { const headers = part.subarray(0, split).toString(); const data = part.subarray(split + 4); const name = /name="([^"]+)"/.exec(headers)?.[1]; const filename = /filename="([^"]*)"/.exec(headers)?.[1]; parts.push({ name, filename, data }); }
        start = end + boundary.length + 2;
      }
      resolvePromise(parts);
    });
    req.on("error", reject);
  });
}
function srtTime(seconds) { const ms = Math.max(0, Math.round(Number(seconds) * 1000)); const h = String(Math.floor(ms / 3600000)).padStart(2, "0"); const m = String(Math.floor(ms % 3600000 / 60000)).padStart(2, "0"); const s = String(Math.floor(ms % 60000 / 1000)).padStart(2, "0"); return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`; }
function toSrt(captions) { return captions.map((item, index) => `${index + 1}\n${srtTime(item.start)} --> ${srtTime(item.end)}\n${String(item.text || "").trim()}\n`).join("\n"); }
function normalizeTranscript(data) {
  const words = data.words || data.segments?.flatMap((segment) => segment.words || [{ word: segment.text, start: segment.start, end: segment.end }]) || [];
  return words.filter((word) => word.word || word.text).map((word, index) => ({ id: `${index}-${randomUUID().slice(0, 6)}`, text: String(word.word || word.text).trim(), start: Number(word.start || 0), end: Number(word.end || word.start || 0) }));
}
async function transcribe(filePath) {
  if (process.env.OPENAI_API_KEY) {
    const form = new FormData(); form.append("file", new Blob([readFileSync(filePath)]), basename(filePath)); form.append("model", "whisper-1"); form.append("response_format", "verbose_json"); form.append("timestamp_granularities[]", "word");
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
    if (!response.ok) throw new Error(`Transcription provider returned ${response.status}: ${await response.text()}`);
    return normalizeTranscript(await response.json());
  }
  if (process.env.WHISPER_COMMAND) {
    const output = join(uploadDir, `${randomUUID()}.json`); const command = process.env.WHISPER_COMMAND.replaceAll("%INPUT%", `\"${filePath}\"`).replaceAll("%OUTPUT%", `\"${output}\"`);
    await new Promise((resolvePromise, reject) => { const child = spawn(command, { shell: true, stdio: "ignore" }); child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`Local transcriber exited ${code}`))); });
    return normalizeTranscript(JSON.parse(readFileSync(output, "utf8")));
  }
  throw new Error("No transcription provider configured. Add OPENAI_API_KEY or WHISPER_COMMAND to .env, then restart the server.");
}
function runExport(input, captions, style, output) {
  const srt = join(exportDir, `${randomUUID()}.srt`); writeFileSync(srt, toSrt(captions));
  const subtitlePath = resolve(srt).replaceAll("\\", "/").replace(/^([A-Z]):/i, "$1\\:").replace(/'/g, "\\'");
  const fontSize = Math.max(16, Math.min(96, Number(style.fontSize || 44))); const color = String(style.color || "#FFFFFF").replace("#", "&H00") + "&";
  const forceStyle = `FontName=${String(style.fontFamily || "Arial").replace(/[,']/g, "")},FontSize=${fontSize},PrimaryColour=${color},Outline=2,Shadow=1,Alignment=2,MarginV=${Number(style.bottom || 56)}`;
  const filter = `subtitles='${subtitlePath}':force_style='${forceStyle}'`;
  return new Promise((resolvePromise, reject) => { const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-i", input, "-vf", filter, "-c:a", "copy", output]); let stderr = ""; child.stderr.on("data", (chunk) => stderr += chunk); child.on("error", () => reject(new Error("FFmpeg was not found. Install it or set FFMPEG_PATH."))); child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`FFmpeg failed: ${stderr.slice(-800)}`))); });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/api/upload") {
      const part = (await parseMultipart(req)).find((item) => item.name === "video" && item.filename);
      if (!part) return json(res, 400, { error: "Choose a video file." });
      const id = randomUUID(); const filename = `${id}-${safeName(part.filename)}`; writeFileSync(join(uploadDir, filename), part.data);
      return json(res, 201, { id, filename, url: `/media/${encodeURIComponent(filename)}` });
    }
    if (req.method === "POST" && url.pathname === "/api/transcribe") {
      const body = JSON.parse(await new Promise((resolvePromise, reject) => { let raw = ""; req.on("data", (c) => raw += c); req.on("end", () => resolvePromise(raw)); req.on("error", reject); }));
      const file = safeName(body.filename); if (!existsSync(join(uploadDir, file))) return json(res, 404, { error: "Uploaded video no longer exists." });
      return json(res, 200, { captions: await transcribe(join(uploadDir, file)) });
    }
    if (req.method === "POST" && url.pathname === "/api/export") {
      const body = JSON.parse(await new Promise((resolvePromise, reject) => { let raw = ""; req.on("data", (c) => raw += c); req.on("end", () => resolvePromise(raw)); req.on("error", reject); }));
      const file = safeName(body.filename); if (!existsSync(join(uploadDir, file))) return json(res, 404, { error: "Uploaded video no longer exists." });
      const id = randomUUID(); jobs.set(id, { status: "processing" }); const output = join(exportDir, `${id}.mp4`);
      runExport(join(uploadDir, file), Array.isArray(body.captions) ? body.captions : [], body.style || {}, output).then(() => jobs.set(id, { status: "done", url: `/exports/${id}.mp4` })).catch((error) => jobs.set(id, { status: "error", error: error.message }));
      return json(res, 202, { id });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/export/")) return json(res, 200, jobs.get(url.pathname.split("/").pop()) || { status: "missing" });
    const mediaMatch = /^\/(media|exports)\/(.+)$/.exec(url.pathname);
    const pathname = mediaMatch ? join(mediaMatch[1] === "media" ? uploadDir : exportDir, safeName(decodeURIComponent(mediaMatch[2]))) : join(publicDir, url.pathname === "/" ? "index.html" : safeName(url.pathname));
    if (!existsSync(pathname)) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": mime[extname(pathname)] || "application/octet-stream" }); createReadStream(pathname).pipe(res);
  } catch (error) { json(res, 500, { error: error.message || "Unexpected server error" }); }
});
server.listen(port, () => console.log(`Captify running at http://localhost:${port}`));
