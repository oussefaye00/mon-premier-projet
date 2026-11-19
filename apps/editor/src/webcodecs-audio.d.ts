// Déclarations WebCodecs audio absentes de lib.dom (TypeScript 5.6).
interface AudioDataInit {
  format: "f32-planar" | "f32" | "s16" | "s16-planar";
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: BufferSource;
}
declare class AudioData {
  constructor(init: AudioDataInit);
  close(): void;
}
interface AudioEncoderConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate?: number;
}
declare class EncodedAudioChunk {
  readonly byteLength: number;
  readonly timestamp: number;
}
declare class AudioEncoder {
  constructor(init: { output: (chunk: EncodedAudioChunk, meta?: { decoderConfig?: { codec: string; sampleRate: number; numberOfChannels: number; description?: BufferSource } }) => void; error: (e: DOMException) => void });
  readonly state: "unconfigured" | "configured" | "closed";
  configure(config: AudioEncoderConfig): void;
  encode(data: AudioData): void;
  flush(): Promise<void>;
  close(): void;
  static isConfigSupported(config: AudioEncoderConfig): Promise<{ supported: boolean }>;
}
