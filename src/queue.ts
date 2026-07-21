import { createSchema, openDb } from "./db.ts";

const db = openDb();
createSchema(db);

type Row = {
  candidateId: string;
  companyName: string;
  city: string | null;
  state: string | null;
  employees: number | null;
  classification: string;
  matchScore: number;
  researchCompleteness: number;
  publicationReady: number;
  blockingReasonsJson: string;
  priority: number;
  reviewStatus: string;
};

const rows = db.query(`
  SELECT
    q.candidate_id AS candidateId,
    c.company_name AS companyName,
    c.city,
    c.state,
    c.employee_count_estimate AS employees,
    q.match_classification AS classification,
    ROUND(q.match_score, 3) AS matchScore,
    ROUND(q.completeness_score, 3) AS researchCompleteness,
    q.publication_ready AS publicationReady,
    q.publication_blocking_reasons_json AS blockingReasonsJson,
    ROUND(q.review_priority, 3) AS priority,
    q.review_status AS reviewStatus
  FROM review_queue q
  JOIN candidates c ON c.id = q.candidate_id
  ORDER BY q.review_priority DESC, q.match_score DESC
`).all() as Row[];

// Four separate concepts, kept visibly separate: entity resolution
// (classification/matchScore), research completeness, publication readiness
// (rule-based, not a percentage), and review priority. None of them implies
// approval — a human still has to review and approve every record.
const table = rows.map((row) => {
  const blockingReasons = JSON.parse(row.blockingReasonsJson) as string[];
  return {
    candidateId: row.candidateId,
    companyName: row.companyName,
    city: row.city,
    state: row.state,
    employees: row.employees,
    classification: row.classification,
    matchScore: row.matchScore,
    researchCompleteness: row.researchCompleteness,
    publicationReady: row.publicationReady ? "yes" : "no",
    blockingReasons: blockingReasons.length > 0 ? blockingReasons.join(", ") : "-",
    priority: row.priority,
    reviewStatus: row.reviewStatus
  };
});

console.table(table);
db.close();
