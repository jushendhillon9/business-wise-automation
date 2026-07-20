import { createSchema, openDb } from "./db.ts";

const db = openDb();
createSchema(db);

const rows = db.query(`
  SELECT
    q.candidate_id AS candidateId,
    c.company_name AS companyName,
    c.city,
    c.state,
    c.employee_count_estimate AS employees,
    q.match_classification AS classification,
    ROUND(q.match_score, 3) AS matchScore,
    ROUND(q.completeness_score, 3) AS completeness,
    ROUND(q.review_priority, 3) AS priority,
    q.review_status AS reviewStatus
  FROM review_queue q
  JOIN candidates c ON c.id = q.candidate_id
  ORDER BY q.review_priority DESC, q.match_score DESC
`).all();

console.table(rows);
db.close();
