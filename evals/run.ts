import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { editingStrategySchema, editPlanSchema, type Transcript } from "../packages/core/src/index.js";
import { FakeLLMProvider, OpenAILLMProvider, type LLMProvider } from "../packages/providers/src/index.js";

interface Fixture { id: string; category: string; source: { durationUs: number; speakers: number; features: string[] }; segments: Array<{ id: string; startUs: number; endUs: number; speakerId?: string; text: string }>; request: string; expected: { structures: string[]; protected: string[]; duration: { minUs: number; maxUs: number }; hookKeywords: string[]; topics: string[] } }
const fixtures = JSON.parse(await readFile(path.resolve("evals/fixtures/corpus.json"), "utf8")) as Fixture[];

function transcript(fixture: Fixture): Transcript {
  const words: Transcript["words"] = []; const segments: Transcript["segments"] = [];
  for (const source of fixture.segments) { const tokens = source.text.split(/\s+/u); const duration = Math.floor((source.endUs - source.startUs) / tokens.length); const wordIds: string[] = []; tokens.forEach((rawText, index) => { const id = randomUUID(); wordIds.push(id); words.push({ id, rawText, normalizedText: rawText.normalize("NFKC"), displayText: rawText, startUs: source.startUs + index * duration, endUs: index === tokens.length - 1 ? source.endUs : source.startUs + (index + 1) * duration, timingSource: "estimated", ...(source.speakerId ? { speakerId: source.speakerId } : {}), confidence: 0.95 }); }); segments.push({ id: source.id, startUs: source.startUs, endUs: source.endUs, rawText: source.text, normalizedText: source.text.normalize("NFKC"), displayText: source.text, wordIds, ...(source.speakerId ? { speakerId: source.speakerId } : {}), confidence: 0.95, language: "en" }); }
  const text = fixture.segments.map((segment) => segment.text).join(" "); return { schemaVersion: 1, id: randomUUID(), assetId: "asset", provider: "fixture", model: "golden-v1", language: "en", languageConfidence: 1, rawTranscript: text, normalizedTranscript: text, displayTranscript: text, words, segments, speakers: [...new Set(fixture.segments.map((segment) => segment.speakerId).filter(Boolean))].map((id) => ({ id: id! })), silenceRegions: [], quality: { lowConfidenceWordIds: [], unmappedWordIds: [], failedAlignmentSegmentIds: [], speakerOverlapRanges: [], unknownLanguageSegmentIds: [], musicHeavyRanges: [], longSilenceRanges: [], warnings: [] }, cacheKey: fixture.id, createdAt: new Date().toISOString() };
}

async function evaluate(provider: LLMProvider) {
  const results: Array<{ id: string; structured: boolean; strategyConsistency: boolean; durationCompliance: boolean; protectedRetention: number; duplicateRemoval: boolean; hookQualityProxy: boolean; semanticCoverage: number; unnecessaryEditCount: number }> = [];
  for (const fixture of fixtures) {
    const source = transcript(fixture); const strategy = await provider.proposeStrategy({ projectId: fixture.id, prompt: fixture.request, transcript: source, targetDurationUs: fixture.expected.duration.maxUs });
    const plan = await provider.createEditPlan({ projectId: fixture.id, strategy: { ...strategy, status: "approved" }, transcript: source, assetId: "asset", basedOnVersion: 0 });
    const selectedText = plan.segments.flatMap((segment) => source.segments.filter((item) => segment.transcriptSegmentIds.includes(item.id)).map((item) => item.normalizedText)).join(" "); const durationUs = plan.segments.reduce((sum, segment) => sum + Math.round((segment.sourceOutUs - segment.sourceInUs) / segment.speed), 0); const firstText = selectedText.split(/(?<=[.!?])\s/u)[0] ?? selectedText;
    const sourceRanges = plan.segments.map((segment) => `${segment.assetId}:${segment.sourceInUs}:${segment.sourceOutUs}`);
    results.push({ id: fixture.id, structured: editingStrategySchema.safeParse(strategy).success && editPlanSchema.safeParse(plan).success, strategyConsistency: fixture.expected.structures.includes(strategy.structure), durationCompliance: durationUs >= fixture.expected.duration.minUs && durationUs <= fixture.expected.duration.maxUs, protectedRetention: fixture.expected.protected.filter((text) => selectedText.toLocaleLowerCase().includes(text.toLocaleLowerCase())).length / fixture.expected.protected.length, duplicateRemoval: new Set(sourceRanges).size === sourceRanges.length, hookQualityProxy: fixture.expected.hookKeywords.some((word) => firstText.toLocaleLowerCase().includes(word.toLocaleLowerCase())), semanticCoverage: fixture.expected.topics.filter((topic) => selectedText.toLocaleLowerCase().includes(topic.toLocaleLowerCase())).length / fixture.expected.topics.length, unnecessaryEditCount: Math.max(0, plan.segments.length - fixture.segments.length) });
  }
  const average = (field: "protectedRetention" | "semanticCoverage") => results.reduce((sum, item) => sum + item[field], 0) / results.length;
  return { provider: provider.id, fixtures: results, summary: { validStructuredOutputRate: results.filter((item) => item.structured).length / results.length, strategyConsistencyRate: results.filter((item) => item.strategyConsistency).length / results.length, durationComplianceRate: results.filter((item) => item.durationCompliance).length / results.length, protectedContentRetention: average("protectedRetention"), duplicateRemovalRate: results.filter((item) => item.duplicateRemoval).length / results.length, hookQualityProxyRate: results.filter((item) => item.hookQualityProxy).length / results.length, semanticCoverage: average("semanticCoverage"), unnecessaryEditCount: results.reduce((sum, item) => sum + item.unnecessaryEditCount, 0) } };
}

const reports = [await evaluate(new FakeLLMProvider())];
if (process.env.VIDEO_AGENT_EVAL_REAL === "true") { if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for real-provider eval"); reports.push(await evaluate(new OpenAILLMProvider(process.env.OPENAI_MODEL ?? "gpt-5.4-mini", process.env.OPENAI_API_KEY))); }
process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)}\n`);
