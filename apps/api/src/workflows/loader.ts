import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { workflows } from '../db/schema.js';
import type { CachedWorkflow, WorkflowLoader } from './cache.js';

export function makeDbWorkflowLoader(db: Db): WorkflowLoader {
  return async (): Promise<CachedWorkflow[]> => {
    const rows = await db.select().from(workflows).where(eq(workflows.status, 'active'));
    const result: CachedWorkflow[] = [];
    for (const w of rows) {
      // Active workflows are guaranteed complete by the workflows_active_complete
      // DB CHECK; this guard narrows the nullable content columns for the type
      // system and defends against any unexpectedly incomplete active row.
      if (
        w.eventName === null ||
        w.metricType === null ||
        w.ratingType === null ||
        w.ratingScaleMax === null ||
        w.headerText === null ||
        w.positiveThreshold === null
      ) {
        continue;
      }
      result.push({
        id: w.id,
        accountId: w.accountId,
        eventName: w.eventName,
        // numeric(4,3) comes back as a string from postgres-js; coerce to number.
        samplingRate: Number(w.samplingRate),
        minSessionAgeDays: w.minSessionAgeDays,
        metricType: w.metricType,
        ratingType: w.ratingType,
        ratingScaleMax: w.ratingScaleMax,
        headerText: w.headerText,
        positiveThreshold: w.positiveThreshold,
        chipsOnNegative: w.chipsOnNegative,
        otherRequiresText: w.otherRequiresText,
        otherAllowsImage: w.otherAllowsImage,
        positiveAction: w.positiveAction,
        negativeAction: w.negativeAction,
        askFrequency: w.askFrequency,
        createdAt: w.createdAt,
      });
    }
    return result;
  };
}
