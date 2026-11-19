import { collectMediaRequests, type MediaSource } from "@amai/renderer";
import type { Asset, AssetKind, ChangeSource, EditorEngine, Project } from "@amai/core";
import { uid } from "@amai/core";
import { db } from "../storage/db";

/**
 * Gestion des médias dans le navigateur : stockage des fichiers (IndexedDB), URL objets,
 * décodage des images, pilotage des éléments <video>/<audio> pour la prévisualisation
 * (lecture synchronisée) et l'export (positionnement image par image).
 */
export class MediaManager implements MediaSource {
  private urls = new Map<string, string>();
  private loadingUrls = new Map<string, Promise<string | null>>();
  private images = new Map<string, HTMLImageElement>();
  private previewVideos = new Map<string, HTMLMediaElement>();
  private exportVideos = new Map<string, HTMLVideoElement>();
  private audioBuffers = new Map<string, Promise<AudioBuffer | null>>();
  private exporting = false;
  /** Appelé quand une image/frame devient disponible : la vue doit se redessiner. */
  onReady: () => void = () => {};

  constructor(private engine: EditorEngine) {}

  // ------------------------------------------------------------- import

  static kindOf(mime: string, name: string): AssetKind | null {
    if (mime === "image/svg+xml" || /\.svg$/i.test(name)) return "svg";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/") || /\.(mp4|webm|mov|m4v|mkv)$/i.test(name)) return "video";
    if (mime.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(name)) return "audio";
    return null;
  }

  async importBlob(blob: Blob, name: string, source: ChangeSource = "user"): Promise<Asset> {
    const mime = blob.type || guessMime(name);
    const kind = MediaManager.kindOf(mime, name);
    if (!kind) throw new Error(`Format non pris en charge : ${name} (${mime || "type inconnu"})`);
    const id = uid("asset");
    const url = URL.createObjectURL(blob);
    const meta = await probe(url, kind).catch((e) => {
      URL.revokeObjectURL(url);
      throw new Error(`Impossible de lire « ${name} » : ${(e as Error).message}`);
    });
    await db.putMedia(id, blob);
    this.urls.set(id, url);
    return this.engine.addAsset({ id, name, kind, mimeType: mime, size: blob.size, src: `idb:${id}`, ...meta }, source);
  }

  async importFromUrl(url: string, name?: string, source: ChangeSource = "user"): Promise<Asset> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Téléchargement impossible (${res.status})`);
    const blob = await res.blob();
    const n = name ?? decodeURIComponent(url.startsWith("data:") ? `media.${extFor(blob.type)}` : url.split("/").pop()?.split("?")[0] || "media");
    return this.importBlob(blob, n, source);
  }

  // ------------------------------------------------------------- accès

  /** URL utilisable pour un asset (charge depuis IndexedDB si nécessaire). */
  async resolveUrl(asset: Asset): Promise<string | null> {
    const cached = this.urls.get(asset.id);
    if (cached) return cached;
    if (!asset.src.startsWith("idb:")) return asset.src;
    let p = this.loadingUrls.get(asset.id);
    if (!p) {
      p = db.getMedia(asset.src.slice(4)).then((b) => {
        if (!b) return null;
        const u = URL.createObjectURL(b);
        this.urls.set(asset.id, u);
        return u;
      });
      this.loadingUrls.set(asset.id, p);
    }
    return p;
  }

  async getBlob(asset: Asset): Promise<Blob | null> {
    if (asset.src.startsWith("idb:")) return (await db.getMedia(asset.src.slice(4))) ?? null;
    const r = await fetch(asset.src);
    return r.ok ? r.blob() : null;
  }

  private asset(id: string): Asset | undefined {
    return this.engine.project.assets.find((a) => a.id === id);
  }

  getImage(assetId: string): CanvasImageSource | null {
    const img = this.images.get(assetId);
    if (img) return img.complete && img.naturalWidth > 0 ? img : null;
    const a = this.asset(assetId);
    if (!a) return null;
    const el = new Image();
    el.decoding = "async";
    this.images.set(assetId, el);
    void this.resolveUrl(a).then((u) => {
      if (!u) return;
      el.onload = () => this.onReady();
      el.src = u;
    });
    return null;
  }

  private videoFor(map: Map<string, HTMLMediaElement>, key: string, asset: Asset, kind: "video" | "audio"): HTMLMediaElement {
    let v = map.get(key);
    if (!v) {
      v = document.createElement(kind);
      v.preload = "auto";
      v.crossOrigin = "anonymous";
      if (v instanceof HTMLVideoElement) v.playsInline = true;
      v.muted = true;
      v.addEventListener("seeked", () => this.onReady());
      v.addEventListener("loadeddata", () => this.onReady());
      map.set(key, v);
      const el = v;
      void this.resolveUrl(asset).then((u) => u && (el.src = u));
    }
    return v;
  }

  getVideoFrame(assetId: string, _mediaTime: number, layerId: string): CanvasImageSource | null {
    const map = this.exporting ? this.exportVideos : this.previewVideos;
    const v = map.get(layerId);
    if (!v) {
      const a = this.asset(assetId);
      if (a) this.videoFor(map as Map<string, HTMLMediaElement>, layerId, a, "video");
      return null;
    }
    return v instanceof HTMLVideoElement && v.readyState >= 2 ? v : null;
  }

  // ------------------------------------------------------------- prévisualisation

  /**
   * Synchronise les éléments média avec la tête de lecture. En lecture : les éléments
   * jouent nativement (son compris) et sont recalés en cas de dérive. À l'arrêt : seek précis.
   */
  syncPreview(project: Project, time: number, playing: boolean) {
    const reqs = collectMediaRequests(project, project.activeCompositionId, time);
    const active = new Set<string>();
    for (const r of reqs) {
      if (r.kind === "image") continue;
      const asset = this.asset(r.assetId);
      if (!asset) continue;
      active.add(r.layerId);
      const el = this.videoFor(this.previewVideos, r.layerId, asset, r.kind === "audio" ? "audio" : "video");
      const layer = findLayerDeep(project, r.layerId);
      const vol = layer && !layer.props.muted ? Math.max(0, Math.min(1, ((layer.props.volume?.value as number) ?? 100) / 100)) : 0;
      el.volume = vol;
      el.muted = !playing || vol === 0;
      el.playbackRate = Math.max(0.0625, Math.min(16, r.rate));
      const target = Math.max(0, r.mediaTime);
      if (playing) {
        if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target;
        if (el.paused && el.readyState >= 2) void el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - target) > 1 / 120 && !el.seeking) el.currentTime = target;
      }
    }
    for (const [id, el] of this.previewVideos) {
      if (!active.has(id) && !el.paused) el.pause();
    }
  }

  pauseAll() {
    for (const el of this.previewVideos.values()) el.pause();
  }

  // ------------------------------------------------------------- export

  beginExport() {
    this.exporting = true;
  }

  endExport() {
    this.exporting = false;
    for (const v of this.exportVideos.values()) {
      v.removeAttribute("src");
      v.load();
    }
    this.exportVideos.clear();
  }

  /** Positionne chaque vidéo nécessaire exactement au bon instant (attend le décodage). */
  async prepareExportFrame(project: Project, compId: string, time: number) {
    const reqs = collectMediaRequests(project, compId, time);
    await Promise.all(
      reqs.map(async (r) => {
        const a = this.asset(r.assetId);
        if (!a) return;
        if (r.kind === "image") {
          if (!this.getImage(r.assetId)) await waitImage(this.images.get(r.assetId)!);
          return;
        }
        if (r.kind !== "video") return;
        const v = this.videoFor(this.exportVideos as Map<string, HTMLMediaElement>, r.layerId, a, "video") as HTMLVideoElement;
        if (v.readyState < 1) await once(v, "loadedmetadata", 15000);
        const target = Math.min(Math.max(0, r.mediaTime), Math.max(0, (v.duration || 0) - 0.001));
        if (Math.abs(v.currentTime - target) > 1e-4 || v.readyState < 2) {
          const done = once(v, "seeked", 15000);
          v.currentTime = target;
          await done;
        }
        if (v.readyState < 2) await once(v, "loadeddata", 5000);
      }),
    );
  }

  /** Décode la piste audio d'un média (pour le mixage à l'export). */
  getAudioBuffer(asset: Asset, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
    let p = this.audioBuffers.get(asset.id);
    if (!p) {
      p = (async () => {
        const blob = await this.getBlob(asset);
        if (!blob) return null;
        try {
          return await ctx.decodeAudioData(await blob.arrayBuffer());
        } catch {
          return null; // vidéo sans piste audio ou codec non décodable
        }
      })();
      this.audioBuffers.set(asset.id, p);
    }
    return p;
  }

  /** Libère les ressources des médias qui ne sont plus utilisés (mémoire sur mobile). */
  gc(project: Project) {
    const assetIds = new Set(project.assets.map((a) => a.id));
    const layerIds = new Set(project.compositions.flatMap((c) => c.layers.map((l) => l.id)));
    for (const [id, u] of this.urls) {
      if (!assetIds.has(id)) {
        URL.revokeObjectURL(u);
        this.urls.delete(id);
        this.images.delete(id);
        this.audioBuffers.delete(id);
        this.loadingUrls.delete(id);
      }
    }
    for (const [id, el] of this.previewVideos) {
      if (!layerIds.has(id)) {
        el.pause();
        el.removeAttribute("src");
        el.load();
        this.previewVideos.delete(id);
      }
    }
  }
}

function findLayerDeep(project: Project, layerId: string) {
  for (const c of project.compositions) {
    const l = c.layers.find((x) => x.id === layerId);
    if (l) return l;
  }
  return undefined;
}

function once(el: EventTarget, ev: string, timeout: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, timeout);
    function done() {
      clearTimeout(t);
      el.removeEventListener(ev, done);
      resolve();
    }
    el.addEventListener(ev, done);
  });
}

function waitImage(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth) return Promise.resolve();
  return once(img, "load", 10000);
}

function probe(url: string, kind: AssetKind): Promise<{ width?: number; height?: number; duration?: number }> {
  return new Promise((resolve, reject) => {
    if (kind === "image" || kind === "svg") {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth || 512, height: img.naturalHeight || 512 });
      img.onerror = () => reject(new Error("image illisible"));
      img.src = url;
      return;
    }
    const el = document.createElement(kind === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.muted = true;
    const timer = setTimeout(() => reject(new Error("métadonnées indisponibles (délai dépassé)")), 20000);
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      const v = el as HTMLVideoElement;
      resolve({ duration: isFinite(el.duration) ? el.duration : undefined, width: v.videoWidth || undefined, height: v.videoHeight || undefined });
    };
    el.onerror = () => {
      clearTimeout(timer);
      reject(new Error("codec ou format non pris en charge par ce navigateur"));
    };
    el.src = url;
  });
}

function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      mp4: "video/mp4",
      m4v: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      m4a: "audio/mp4",
    } as Record<string, string>
  )[ext] ?? "";
}

function extFor(mime: string) {
  return mime.split("/")[1]?.replace("svg+xml", "svg").replace("jpeg", "jpg").replace("mpeg", "mp3") || "bin";
}
