/**
 * Adds the review round counter: corrections a review pass starts count against their own
 * `maxRepairRounds` budget, so a checks stage that needed both repair rounds does not leave a
 * reproduced review finding without a correction (mdrefs 8531a4f0, #928).
 */
export const migration013 = `ALTER TABLE runs ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 0 CHECK(review_rounds >= 0);
`;
