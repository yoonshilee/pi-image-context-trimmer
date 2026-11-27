import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gradeAnswer, searchRecords, type RetrievalCorpus } from "./fixtures/retrieval-case.ts";

const corpus = JSON.parse(await readFile(new URL("./fixtures/retrieval-corpus.json", import.meta.url), "utf8")) as RetrievalCorpus;

test("linked retrieval filters distractors and never reveals image-only fields in search results", () => {
  const order = searchRecords(corpus.documents, { lot: "A17", kind: "order" });
  assert.deepEqual(order, [{ id: "doc-201", lot: "A17", kind: "order", reference: "PO-17" }]);
  assert.deepEqual(searchRecords(corpus.documents, { reference: "4831" }).map(item => item.id), ["doc-317", "doc-835"]);
  assert.deepEqual(searchRecords(corpus.documents, { lot: "A17", reference: "4831" }).map(item => item.id), ["doc-317"]);
  assert.deepEqual(searchRecords(corpus.documents, {}), []);
  assert(!JSON.stringify(order).includes("1250"));
});

test("frozen scenario answers include arithmetic, exact codes, and order-independent evidence", () => {
  for (const round of corpus.rounds) assert(gradeAnswer(JSON.stringify(round.expected), round.expected).correct);
  const expected = corpus.rounds[0].expected;
  assert(gradeAnswer(JSON.stringify({ ...expected, evidence: ["doc-509", "doc-201", "doc-317"] }), expected).correct);
  assert(!gradeAnswer(JSON.stringify({ ...expected, evidence: ["doc-201", "doc-317", "doc-835"] }), expected).correct);
  assert(!gradeAnswer(JSON.stringify({ ...expected, shortage: 99 }), expected).correct);
  assert(!gradeAnswer(JSON.stringify({ ...expected, evidence: ["doc-201", "doc-201", "doc-317"] }), expected).correct);
  assert(!gradeAnswer("not JSON", expected).correct);
  assert(!gradeAnswer(JSON.stringify({ ...expected, other: 1 }), expected).correct);
});


test("frozen expected answers agree with the linked document fields and arithmetic", () => {
  const order = corpus.documents.find(document => document.id === "doc-201")!;
  const receipt = corpus.documents.find(document => document.id === "doc-317")!;
  const inspection = corpus.documents.find(document => document.id === "doc-509")!;
  const adjustment = corpus.documents.find(document => document.id === "doc-624")!;
  assert.equal(order.lower, receipt.reference);
  assert.equal(receipt.lower, inspection.reference);
  const ordered = Number(order.upper), received = Number(receipt.upper), rejected = Number(inspection.upper), accepted = received - rejected;
  const shortage = ordered - accepted;
  assert.deepEqual(corpus.rounds[0].expected, { ordered, received, rejected, accepted, shortage, receiptRef: order.lower, inspectionRef: receipt.lower, evidence: [order.id, receipt.id, inspection.id] });
  assert.deepEqual(corpus.rounds[1].expected, { acceptedRate: accepted / ordered * 100, shortageRate: shortage / ordered * 100, shortage });
  assert.deepEqual(corpus.rounds[2].expected, { inspectorCode: inspection.lower, rejected, evidence: [inspection.id] });
  const additional = Number(adjustment.upper);
  assert.deepEqual(corpus.rounds[3].expected, { additional, accepted: accepted + additional, shortage: shortage - additional, authorization: adjustment.lower, evidence: [order.id, receipt.id, inspection.id, adjustment.id] });
});
