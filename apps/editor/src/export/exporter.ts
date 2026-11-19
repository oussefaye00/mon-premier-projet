import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from "mp4-muxer";
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from "webm-muxer";
import { evaluate, type Composition, type ExportOptions, type ExportResult, type Layer, type Project } from "@amai/core";
import { Renderer, mediaTimeFor } from "@amai/renderer";
import type { MediaManager } from "../media/MediaManager";

/**
 * Système d'exportation : rendu image par image (déterministe, indépendant du temps réel)
 * puis encodage matériel/logiciel via WebCodecs et multiplexage MP4 (H.264 + AAC/Opus) ou
 * WebM (VP9/VP8 + Opus). L'audio est mixé hors-ligne (OfflineAudioContext).
 */

export interface ExportCapabilities {
  webcodecs: boolean;
  mp4: string | null;
  webm: string | null;
  audioMp4: "aac" | "opus" | null;
  audioWebm: boolean;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

async function pickVideoCodec(format: "mp4" | "webm", width: number, height: number, fps: number, bitrate: number): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const candidates =
    format === "mp4"
      ? ["avc1.640033", "avc1.640028", "avc1.4d0028", "avc1.42003e", "avc1.42001f"]
      : ["vp09.00.10.08", "vp8"];
  for (const codec of candidates) {
    const cfg: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, latencyMode: "quality" };
    if (format === "mp4") (cfg as VideoEncoderConfig & { avc?: { format: "avc" } }).avc = { format: "avc" };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return cfg;
    } catch {
      /* suivant */
    }
  }
  return null;
}

async function pickAudioCodec(format: "mp4" | "webm"): Promise<{ codec: string; muxer: "aac" | "opus" } | null> {
  if (typeof AudioEncoder === "undefined") return null;
  const list = format === "mp4" ? [{ codec: "mp4a.40.2", muxer: "aac" as const }, { codec: "opus", muxer: "opus" as const }] : [{ codec: "opus", muxer: "opus" as const }];
  for (const c of list) {
    try {
      const r = await AudioEncoder.isConfigSupported({ codec: c.codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 });
      if (r.supported) return c;
    } catch {
      /* suivant */
    }
  }
  return null;
}

export async function exportCapabilities(): Promise<ExportCapabilities> {
  const mp4 = await pickVideoCodec("mp4", 1280, 720, 30, 5e6);
  const webm = await pickVideoCodec("webm", 1280, 720, 30, 5e6);
  const a1 = await pickAudioCodec("mp4");
  const a2 = await pickAudioCodec("webm");
  return { webcodecs: typeof VideoEncoder !== "undefined", mp4: mp4?.codec ?? null, webm: webm?.codec ?? null, audioMp4: a1?.muxer ?? null, audioWebm: !!a2 };
}

function audioLayers(project: Project, comp: Composition, offset = 0, depth = 0): { layer: Layer; offset: number }[] {
  const out: { layer: Layer; offset: number }[] = [];
  if (depth > 8) return out;
  for (const l of comp.layers) {
    if (!l.visible) continue;
    if ((l.type === "audio" || l.type === "video") && l.props.assetId && !l.props.muted) out.push({ layer: l, offset });
    if (l.type === "composition") {
      const sub = project.compositions.find((c) => c.id === l.props.compositionId);
      if (sub) out.push(...audioLayers(project, sub, offset + l.inPoint, depth + 1));
    }
  }
  return out;
}

/** Mixe toutes les pistes audio de la plage exportée. */
async function mixAudio(project: Project, comp: Composition, media: MediaManager, start: number, end: number, sampleRate = 48000): Promise<AudioBuffer | null> {
  const layers = audioLayers(project, comp);
  if (!layers.length || typeof OfflineAudioContext === "undefined") return null;
  const length = Math.max(1, Math.ceil((end - start) * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  let any = false;
  for (const { layer, offset } of layers) {
    const asset = project.assets.find((a) => a.id === layer.props.assetId);
    if (!asset) continue;
    const buf = await media.getAudioBuffer(asset, ctx);
    if (!buf) continue;
    const lIn = layer.inPoint + offset;
    const lOut = layer.outPoint + offset;
    const from = Math.max(start, lIn);
    const to = Math.min(end, lOut);
    if (to <= from) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = layer.props.playbackRate ?? 1;
    const gain = ctx.createGain();
    // Volume (éventuellement animé) échantillonné à 50 Hz, + fondus des transitions « fade ».
    const step = 0.02;
    for (let t = from; t <= to + step; t += step) {
      const local = t - offset;
      let v = Math.max(0, (evaluate(layer.props.volume, local, 100) as number) / 100);
      if (layer.transitionIn?.type === "fade") v *= Math.min(1, (local - layer.inPoint) / layer.transitionIn.duration);
      if (layer.transitionOut?.type === "fade") v *= Math.min(1, (layer.outPoint - local) / layer.transitionOut.duration);
      gain.gain.setValueAtTime(Math.max(0, v), Math.max(0, t - start));
    }
    src.connect(gain).connect(ctx.destination);
    const mediaStart = mediaTimeFor(layer, from - offset);
    src.start(from - start, Math.max(0, mediaStart), (to - from) * (layer.props.playbackRate ?? 1));
    any = true;
  }
  if (!any) return null;
  return ctx.startRendering();
}

export class ExportCancelled extends Error {}

export async function exportVideo(
  project: Project,
  renderer: Renderer,
  media: MediaManager,
  opts: ExportOptions,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
): Promise<ExportResult & { blob: Blob; warnings: string[] }> {
  const comp = project.compositions.find((c) => c.id === project.activeCompositionId)!;
  const warnings: string[] = [];
  const fps = opts.fps ?? comp.fps;
  const start = Math.max(0, opts.start ?? 0);
  const end = Math.min(comp.duration, opts.end ?? comp.duration);
  if (end <= start) throw new Error("Plage d'export vide.");
  let width = even(opts.width ?? comp.width);
  let height = even(opts.height ?? (opts.width ? (opts.width * comp.height) / comp.width : comp.height));
  const quality = opts.quality ?? "high";
  const bpp = quality === "high" ? 0.2 : quality === "medium" ? 0.1 : 0.05;
  const bitrate = Math.round(width * height * fps * bpp);

  let vcfg = await pickVideoCodec(opts.format, width, height, fps, bitrate);
  if (!vcfg && opts.format === "mp4" && (width > 1920 || height > 1080)) {
    // Certains encodeurs H.264 sont limités : on réduit la résolution.
    const f = Math.min(1920 / width, 1080 / height);
    width = even(width * f);
    height = even(height * f);
    vcfg = await pickVideoCodec("mp4", width, height, fps, bitrate);
    if (vcfg) warnings.push(`Résolution réduite à ${width}×${height} (limite de l'encodeur H.264).`);
  }
  if (!vcfg) {
    throw new Error(
      typeof VideoEncoder === "undefined"
        ? "Ce navigateur ne prend pas en charge WebCodecs (encodage vidéo). Utilisez Chrome, Edge ou un navigateur Android récent."
        : `Aucun encodeur ${opts.format === "mp4" ? "H.264 (MP4)" : "VP9/VP8 (WebM)"} disponible dans ce navigateur. Essayez l'autre format.`,
    );
  }

  const acodec = opts.includeAudio === false ? null : await pickAudioCodec(opts.format);
  let audio: AudioBuffer | null = null;
  if (opts.includeAudio !== false) {
    audio = await mixAudio(project, comp, media, start, end);
    if (audio && !acodec) {
      warnings.push("Aucun encodeur audio disponible : vidéo exportée sans son.");
      audio = null;
    }
  }

  const isMp4 = opts.format === "mp4";
  const mp4 = isMp4
    ? new Mp4Muxer({
        target: new Mp4Target(),
        video: { codec: "avc", width, height, frameRate: fps },
        audio: audio && acodec ? { codec: acodec.muxer, numberOfChannels: 2, sampleRate: audio.sampleRate } : undefined,
        fastStart: "in-memory",
        firstTimestampBehavior: "offset",
      })
    : null;
  const webm = !isMp4
    ? new WebmMuxer({
        target: new WebmTarget(),
        video: { codec: vcfg.codec.startsWith("vp09") ? "V_VP9" : "V_VP8", width, height, frameRate: fps },
        audio: audio ? { codec: "A_OPUS", numberOfChannels: 2, sampleRate: audio.sampleRate } : undefined,
        firstTimestampBehavior: "offset",
      })
    : null;

  let encodeError: Error | null = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => (mp4 ? mp4.addVideoChunk(chunk, meta) : webm!.addVideoChunk(chunk, meta)),
    error: (e) => (encodeError = e as Error),
  });
  venc.configure(vcfg);

  const scale = width / comp.width;
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const totalFrames = Math.max(1, Math.round((end - start) * fps));
  const audioShare = audio ? 0.05 : 0;
  media.beginExport();
  try {
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new ExportCancelled("Export annulé.");
      if (encodeError) throw encodeError;
      const t = start + i / fps;
      await media.prepareExportFrame(project, comp.id, t);
      renderer.render(ctx, project, comp.id, t, media, { scale, motionBlur: true });
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      venc.encode(frame, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
      onProgress?.(((i + 1) / totalFrames) * (1 - audioShare) * 0.98);
    }
    await venc.flush();
    venc.close();
    if (encodeError) throw encodeError;

    if (audio && acodec) {
      let aerr: Error | null = null;
      const aenc = new AudioEncoder({
        output: (chunk, meta) => (mp4 ? mp4.addAudioChunk(chunk, meta) : webm!.addAudioChunk(chunk, meta)),
        error: (e) => (aerr = e as Error),
      });
      aenc.configure({ codec: acodec.codec, sampleRate: audio.sampleRate, numberOfChannels: 2, bitrate: 192000 });
      const chunk = 4800;
      const L = audio.getChannelData(0);
      const R = audio.numberOfChannels > 1 ? audio.getChannelData(1) : L;
      for (let off = 0; off < audio.length; off += chunk) {
        const n = Math.min(chunk, audio.length - off);
        const data = new Float32Array(n * 2);
        data.set(L.subarray(off, off + n), 0);
        data.set(R.subarray(off, off + n), n);
        const ad = new AudioData({ format: "f32-planar", sampleRate: audio.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((off / audio.sampleRate) * 1e6), data });
        aenc.encode(ad);
        ad.close();
      }
      await aenc.flush();
      aenc.close();
      if (aerr) warnings.push(`Audio ignoré : ${(aerr as Error).message}`);
      onProgress?.(0.99);
    }

    let buffer: ArrayBuffer;
    if (mp4) {
      mp4.finalize();
      buffer = mp4.target.buffer;
    } else {
      webm!.finalize();
      buffer = webm!.target.buffer;
    }
    const mimeType = isMp4 ? "video/mp4" : "video/webm";
    const blob = new Blob([buffer], { type: mimeType });
    onProgress?.(1);
    const base = (opts.fileName ?? project.name ?? "export").replace(/\.(mp4|webm)$/i, "");
    return {
      blob,
      warnings,
      fileName: `${base}.${isMp4 ? "mp4" : "webm"}`,
      mimeType,
      size: blob.size,
      duration: end - start,
      frames: totalFrames,
      codec: vcfg.codec + (audio && acodec ? ` + ${acodec.codec}` : ""),
    };
  } finally {
    if (venc.state !== "closed") venc.close();
    media.endExport();
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode(...buf.subarray(i, i + CH));
  return btoa(s);
}
