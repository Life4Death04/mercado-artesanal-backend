import { z } from "zod";

import { strictObject } from "@/shared/validation/zod";

export const CreateDatabaseBackupBodySchema = strictObject({
  label: z.string().trim().max(200).nullable().optional(),
});

export type CreateDatabaseBackupBody = z.infer<typeof CreateDatabaseBackupBodySchema>;
