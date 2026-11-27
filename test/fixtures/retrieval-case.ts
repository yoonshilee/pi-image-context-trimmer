import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export interface DocumentRecord { id: string; lot: string; kind: string; reference: string; upperLabel: string; lowerLabel: string; upper: string; lower: string; width: number; height: number; seed: number }
export type AnswerValue = string | number | string[];
export interface ScenarioRound { name: string; prompt: string; maxRequests: number; expected: Record<string, AnswerValue> }
export interface RetrievalCorpus { documents: DocumentRecord[]; rounds: ScenarioRound[] }
export interface SearchFilter { lot?: string; kind?: string; reference?: string }
export interface RetrievalEvent { tool: "search_records" | "read_record"; input: SearchFilter | { id: string }; records: string[] }

export function searchRecords(documents: DocumentRecord[], filter: SearchFilter) {
  const filters = Object.entries(filter).filter(([, value]) => typeof value === "string" && value.trim());
  if (!filters.length) return [];
  return documents.filter(document => filters.every(([key, value]) => {
    if (key !== "lot" && key !== "kind" && key !== "reference") return false;
    return document[key].toLowerCase() === value.trim().toLowerCase();
  })).map(({ id, lot, kind, reference }) => ({ id, lot, kind, reference }));
}

export function gradeAnswer(text: string, expected: ScenarioRound["expected"]) {
  let actual: unknown;
  try { actual = JSON.parse(text.trim()); } catch { actual = undefined; }
  const valid = actual !== null && typeof actual === "object" && !Array.isArray(actual);
  const fields = valid ? actual as Record<string, unknown> : {};
  const grades = Object.fromEntries(Object.entries(expected).map(([key, answer]) => {
    const value = fields[key];
    const correct = Array.isArray(answer)
      ? Array.isArray(value) && value.every(item => typeof item === "string") && JSON.stringify([...value].sort()) === JSON.stringify([...answer].sort())
      : value === answer;
    return [key, correct];
  }));
  const extraKeys = Object.keys(fields).filter(key => !(key in expected));
  return { parsed: valid, fieldGrades: grades, correctFields: Object.values(grades).filter(Boolean).length, totalFields: Object.keys(expected).length, extraKeys, correct: valid && !extraKeys.length && Object.values(grades).every(Boolean) };
}

export function retrievalTools(documents: DocumentRecord[], images: Map<string, ImageContent>, trace: (event: RetrievalEvent) => void) {
  return (pi: ExtensionAPI) => {
    pi.registerTool({ name: "search_records", label: "Search document register", description: "Search the inventory document register by lot, document kind (order, receipt, inspection, adjustment), or a reference printed on another document. Returned records contain catalog metadata only; open their images to read values.",
      parameters: Type.Object({ lot: Type.Optional(Type.String()), kind: Type.Optional(Type.String()), reference: Type.Optional(Type.String()) }),
      async execute(_id, filter) {
        const records = searchRecords(documents, filter);
        trace({ tool: "search_records", input: filter, records: records.map(record => record.id) });
        return { content: [{ type: "text", text: JSON.stringify(records) }], details: {} };
      },
    });
    pi.registerTool({ name: "read_record", label: "Open original document image", description: "Open an original visual record by its exact document ID from the register. The two labeled fields are present only in the image.",
      parameters: Type.Object({ id: Type.String() }),
      async execute(_id, { id }) {
        const document = documents.find(item => item.id === id);
        const image = images.get(id);
        trace({ tool: "read_record", input: { id }, records: document && image ? [id] : [] });
        if (!document || !image) throw new Error("Unknown document ID");
        return { content: [{ type: "text", text: `Original record ${document.id} (${document.lot}, ${document.kind}). Upper white rectangle: ${document.upperLabel}. Lower white rectangle: ${document.lowerLabel}.` }, image], details: {} };
      },
    });
  };
}


export function installRequestLimit(session: AgentSession, currentRound: () => { requests: readonly unknown[]; maxRequests: number; limitReached?: boolean } | undefined) {
  const previous = session.agent.finishTurn;
  session.agent.finishTurn = async (turn, signal) => {
    const decision = await previous?.(turn, signal);
    const round = currentRound();
    if (round && round.requests.length >= round.maxRequests && turn.message.stopReason === "toolUse") {
      round.limitReached = true;
      return { action: "end" };
    }
    return decision ?? undefined;
  };
}
