-- Read-time re-scoring (SPEC Q11): date-independent priority points from the agent
ALTER TABLE "tasks" ADD COLUMN "priority_base" SMALLINT;
