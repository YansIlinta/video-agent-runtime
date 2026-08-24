import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { runProcess } from "../../media/src/process.js";
import type {
  ASRProvider,
  ASRResult,
  OperationContext,
  StructuredTextGenerator as StructuredGenerator,
  TTSProvider,
} from "../../providers/src/contracts.js";

export type { StructuredTextGenerator } from "../../providers/src/contracts.js";

export const translatedSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  targetText: z.string().min(1),
});

export const speechTranslationSchema = z.object({
  sourceLanguage: z.string().min(1),
  targetLanguage: z.string().min(1),
  segments: z.array(translatedSegmentSchema),
});

export type SpeechTranslation = z.infer<typeof speechTranslationSchema>;

export interface TranslateOptions {
  targetLanguage: string;
  prompt?: string;
  sourceLanguage?: string;
  signal?: AbortSignal;
}

export interface SynthesizedSpeechSegment {
  index: number;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  sourceText: string;
  targetText: string;
  audioPath: string;
  generatedDurationSeconds: number;
}

export interface SpeechSynthesisManifest {
  targetLanguage: string;
  provider: string;
  model: string;
  voiceId: string;
  segments: SynthesizedSpeechSegment[];
  dubbedAudioPath: string;
}

export interface VideoDubResult extends SpeechSynthesisManifest {
  outputVideoPath: string;
}

function compactSource(result: ASRResult) {
  return result.segments.map((segment, index) => ({
    index,
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    text: segment.text,
    speaker: segment.speaker,
    language: segment.language,
  }));
}

export async function translateAsrResult(
  result: ASRResult,
  generator: StructuredGenerator,
  options: TranslateOptions,
): Promise<SpeechTranslation> {
  const source = compactSource(result);
  if (source.length === 0) throw new Error("ASR returned no segments to translate");

  const generated = await generator.generateStructured<SpeechTranslation>({
    requestId: randomUUID(),
    operation: "speech-transform",
    instructions: [
      "You translate speech for dubbing.",
      "Preserve meaning, names, numbers, and segment order.",
      "Return exactly one target segment for every input index.",
      "Do not merge, split, omit, or invent segments.",
      "Prefer concise spoken phrasing because the result will be synthesized as speech.",
      options.prompt?.trim() ? `User instruction: ${options.prompt.trim()}` : "",
    ].filter(Boolean).join("\n"),
    input: JSON.stringify({
      sourceLanguage: options.sourceLanguage ?? result.language ?? "auto",
      targetLanguage: options.targetLanguage,
      segments: source,
    }),
    schemaName: "speech_translation",
    schema: speechTranslationSchema,
    jsonSchema: zodToJsonSchema(speechTranslationSchema, { $refStrategy: "none" }) as Record<string, unknown>,
    maxRetries: 2,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const translation = speechTranslationSchema.parse(generated.value);
  if (translation.segments.length !== source.length) {
    throw new Error(`LLM changed segment count: expected ${source.length}, got ${translation.segments.length}`);
  }
  const seen = new Set<number>();
  for (const segment of translation.segments) {
    if (segment.index >= source.length || seen.has(segment.index)) {
      throw new Error(`LLM returned invalid or duplicate segment index ${segment.index}`);
    }
    seen.add(segment.index);
  }
  return {
    ...translation,
    sourceLanguage: options.sourceLanguage ?? result.language ?? translation.sourceLanguage,
    targetLanguage: options.targetLanguage,
    segments: [...translation.segments].sort((a, b) => a.index - b.index),
  };
}

function concatEscape(filePath: string) {
  return filePath.replace(/'/gu, "'\\''");
}

export async function synthesizeTranslation(
  source: ASRResult,
  translation: SpeechTranslation,
  tts: TTSProvider,
  options: {
    outputDirectory: string;
    voiceId: string;
    ffmpeg?: string;
    speed?: number;
    signal?: AbortSignal;
    onProgress?: OperationContext["onProgress"];
  },
): Promise<SpeechSynthesisManifest> {
  if (translation.segments.length !== source.segments.length) {
    throw new Error("Translation/source segment count mismatch");
  }
  await mkdir(options.outputDirectory, { recursive: true });
  const generated: SynthesizedSpeechSegment[] = [];

  for (let index = 0; index < translation.segments.length; index += 1) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Cancelled");
    const translated = translation.segments[index]!;
    const sourceSegment = source.segments[translated.index];
    if (!sourceSegment) throw new Error(`Missing source segment ${translated.index}`);
    options.onProgress?.(
      0.05 + (0.75 * index) / Math.max(1, translation.segments.length),
      "tts",
      `Synthesizing segment ${index + 1}/${translation.segments.length}`,
    );
    const audioPath = path.join(options.outputDirectory, `segment-${String(index).padStart(4, "0")}.wav`);
    const ttsInput = {
      text: translated.targetText,
      voiceId: options.voiceId,
      language: translation.targetLanguage,
      ...(options.speed === undefined ? {} : { speed: options.speed }),
    };
    const context = { ...(options.signal ? { signal: options.signal } : {}) };
    let generatedDurationSeconds: number;
    if (tts.synthesizeToFile) {
      const result = await tts.synthesizeToFile({ ...ttsInput, outputUri: audioPath }, context);
      generatedDurationSeconds = result.durationSeconds;
    } else {
      const result = await tts.synthesize(ttsInput, context);
      await writeFile(audioPath, result.audio, { flag: "wx" });
      generatedDurationSeconds = result.durationSeconds;
    }
    generated.push({
      index: translated.index,
      sourceStartSeconds: sourceSegment.startSeconds,
      sourceEndSeconds: sourceSegment.endSeconds,
      sourceText: sourceSegment.text,
      targetText: translated.targetText,
      audioPath,
      generatedDurationSeconds,
    });
  }

  const ffmpeg = options.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const listPath = path.join(options.outputDirectory, "concat.txt");
  await writeFile(listPath, generated.map((segment) => `file '${concatEscape(path.resolve(segment.audioPath))}'`).join("\n") + "\n", "utf8");
  const dubbedAudioPath = path.join(options.outputDirectory, "dubbed.wav");
  const concat = await runProcess(ffmpeg, [
    "-y", "-f", "concat", "-safe", "0", "-i", listPath,
    "-ac", "2", "-ar", "48000", dubbedAudioPath,
  ], { timeoutMs: 30 * 60_000, maxOutputBytes: 2 * 1024 * 1024, ...(options.signal ? { signal: options.signal } : {}) });
  if (concat.exitCode !== 0) throw new Error(`Failed to concatenate synthesized speech: ${concat.stderr.slice(-4000)}`);
  options.onProgress?.(0.9, "tts-concat", "Built translated speech track");

  return {
    targetLanguage: translation.targetLanguage,
    provider: tts.id,
    model: tts.model,
    voiceId: options.voiceId,
    segments: generated,
    dubbedAudioPath,
  };
}

export async function muxTranslatedAudio(
  sourceVideoPath: string,
  manifest: SpeechSynthesisManifest,
  outputVideoPath: string,
  options: { ffmpeg?: string; signal?: AbortSignal } = {},
): Promise<VideoDubResult> {
  await mkdir(path.dirname(outputVideoPath), { recursive: true });
  const ffmpeg = options.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const mux = await runProcess(ffmpeg, [
    "-y", "-i", path.resolve(sourceVideoPath), "-i", path.resolve(manifest.dubbedAudioPath),
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
    "-af", "apad", "-shortest", outputVideoPath,
  ], { timeoutMs: 60 * 60_000, maxOutputBytes: 4 * 1024 * 1024, ...(options.signal ? { signal: options.signal } : {}) });
  if (mux.exitCode !== 0) throw new Error(`Failed to mux translated audio: ${mux.stderr.slice(-4000)}`);
  return { ...manifest, outputVideoPath };
}

export async function extractSpeechAudio(
  sourcePath: string,
  outputPath: string,
  options: { ffmpeg?: string; signal?: AbortSignal } = {},
): Promise<string> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const ffmpeg = options.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const result = await runProcess(ffmpeg, [
    "-y", "-i", path.resolve(sourcePath), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath,
  ], { timeoutMs: 30 * 60_000, maxOutputBytes: 2 * 1024 * 1024, ...(options.signal ? { signal: options.signal } : {}) });
  if (result.exitCode !== 0) throw new Error(`Failed to extract speech audio: ${result.stderr.slice(-4000)}`);
  return outputPath;
}

export async function transcribeSpeech(
  provider: ASRProvider,
  inputPath: string,
  options: { language?: string; prompt?: string; signal?: AbortSignal; onProgress?: OperationContext["onProgress"] } = {},
): Promise<ASRResult> {
  return provider.transcribe(inputPath, {
    ...(options.language ? { language: options.language } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
  }, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}
