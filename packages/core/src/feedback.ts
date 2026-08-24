import { portableId } from "./identity.js";
import type { Diagnosis, Feedback, Project } from "./schemas.js";
import { secondsToUs } from "./time.js";

const categoryPatterns: Array<[Feedback["category"], RegExp]> = [
  ["hook", /开头|hook|opening|抓人|冲击/iu],
  ["pace", /节奏|太慢|拖|pace|slow|fast/iu],
  ["story_structure", /结构|没意思|很平|story|structure|boring|flat/iu],
  ["length", /太长|太短|长度|long|short/iu],
  ["caption", /字幕|caption|subtitle/iu],
  ["audio", /声音|音频|audio|sound/iu],
  ["tts", /tts|合成语音/iu],
  ["narration", /旁白|narration|voiceover/iu],
  ["segment_selection", /这段|选段|segment|选错/iu],
  ["ordering", /顺序|ordering|move/iu],
  ["transition", /转场|transition/iu],
];

function inferCategory(message: string): Feedback["category"] {
  return categoryPatterns.find(([, pattern]) => pattern.test(message))?.[0] ?? "other";
}

function inferRange(message: string): Feedback["range"] | undefined {
  const match = message.match(/(\d+(?:\.\d+)?)\s*(?:~|～|-|到)\s*(\d+(?:\.\d+)?)\s*秒?/u);
  if (!match?.[1] || !match[2]) return undefined;
  const startUs = secondsToUs(Number(match[1]));
  const endUs = secondsToUs(Number(match[2]));
  return endUs > startUs ? { startUs, endUs } : undefined;
}

export function normalizeFeedback(project: Project, rawMessage: string, category?: Feedback["category"], range?: Feedback["range"], severity: Feedback["severity"] = "medium"): Feedback {
  const inferredRange = range ?? inferRange(rawMessage);
  return {
    id: portableId(),
    projectId: project.id,
    version: project.activeVersion,
    category: category ?? inferCategory(rawMessage),
    rawMessage,
    message: rawMessage.trim(),
    ...(inferredRange ? { range: inferredRange } : {}),
    severity,
    createdAt: new Date().toISOString(),
  };
}

export function diagnoseFeedback(projectId: string, feedback: Feedback[], currentStructure?: string): Diagnosis {
  if (feedback.length === 0) throw new Error("At least one feedback item is required");
  const recent = feedback.slice(-4);
  const categories = recent.map((item) => item.category);
  const structuralSignals = recent.filter((item) => ["hook", "story_structure"].includes(item.category) || /没意思|很平|不抓人|boring|flat/iu.test(item.rawMessage));
  const repeatedPace = recent.filter((item) => item.category === "pace");
  const localRanges = recent.filter((item) => item.range);
  let rootCause: Diagnosis["rootCause"] = recent.at(-1)!.category;
  let recommendedAction: Diagnosis["recommendedAction"] = "PATCH";
  let confidence = 0.68;
  const strategyChanges: Diagnosis["strategyChanges"] = [];
  if (structuralSignals.length >= 3) {
    rootCause = "story_structure";
    recommendedAction = "REPLAN";
    confidence = 0.88;
    strategyChanges.push({ field: "structure", from: currentStructure ?? "chronological-summary", to: "hook-first", reason: "Repeated hook/flatness feedback indicates a strategy-level narrative mismatch" });
  } else if (repeatedPace.length >= 2 && localRanges.length === 0) {
    rootCause = "story_structure";
    recommendedAction = "REPLAN";
    confidence = 0.78;
    strategyChanges.push({ field: "pace", from: "current", to: "faster with higher information density", reason: "Repeated global pacing feedback did not identify a local range" });
  } else if (localRanges.length > 0) {
    recommendedAction = "PATCH";
    confidence = 0.9;
  } else if (categories.every((category) => category === "other")) {
    recommendedAction = "ASK_USER";
    confidence = 0.55;
  }
  return {
    id: portableId(),
    projectId,
    feedbackIds: recent.map((item) => item.id),
    rootCause,
    confidence,
    evidence: recent.map((item) => `v${item.version} ${item.category}: ${item.rawMessage}`),
    recommendedAction,
    strategyChanges,
    createdAt: new Date().toISOString(),
  };
}
