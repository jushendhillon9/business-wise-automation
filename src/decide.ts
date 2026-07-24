import { createSchema, openDb } from "./db.ts";
import { isReviewDecisionAction, recordReviewDecision, REVIEW_DECISION_ACTIONS } from "./review-decisions.ts";

/**
 * Minimal manual-testing CLI for recording a reviewer decision. No auth, no
 * UI -- this is a thin wrapper over `recordReviewDecision()` for local
 * experimentation, matching the `ingest`/`queue` scripts' style. Field
 * corrections are not accepted here (audit-only, structured input is
 * awkward from a flag-based CLI); use `recordReviewDecision()` directly in
 * a test or script if you need to attach them.
 */
function argValue(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

const candidateId = argValue("candidate");
const reviewer = argValue("reviewer");
const actionArg = argValue("action");
const selectedBwiRecordId = argValue("selected");
const notes = argValue("note");

function printUsage(): void {
  console.error("Usage: bun run decide --candidate=<locationCandidateId> --reviewer=<name> --action=<action> [--selected=<bwiRecordId>] [--note=\"...\"]");
  console.error(`Actions: ${REVIEW_DECISION_ACTIONS.join(", ")}`);
}

if (!candidateId || !reviewer || !actionArg) {
  printUsage();
  process.exit(1);
}

if (!isReviewDecisionAction(actionArg)) {
  console.error(`Unknown action "${actionArg}".`);
  printUsage();
  process.exit(1);
}

const db = openDb();
createSchema(db);

try {
  const decision = recordReviewDecision(db, {
    locationCandidateId: candidateId,
    reviewer,
    action: actionArg,
    selectedBwiRecordId,
    notes
  });

  console.log(`Recorded decision #${decision.sequence} for candidate ${decision.locationCandidateId}`);
  console.log(`  action: ${decision.action}`);
  console.log(`  status: ${decision.previousStatus} -> ${decision.newStatus}`);
  if (decision.selectedBwiRecordId) console.log(`  selected BWI record: ${decision.selectedBwiRecordId}`);
  if (decision.machineRecommendation.machineSelectedExistingCompanyId) {
    console.log(`  machine-recommended BWI record: ${decision.machineRecommendation.machineSelectedExistingCompanyId}`);
  }
  if (decision.notes) console.log(`  notes: ${decision.notes}`);
} catch (error) {
  console.error(`Failed to record decision: ${(error as Error).message}`);
  process.exit(1);
} finally {
  db.close();
}
