import { z } from "zod";

import { strictObject } from "@/shared/validation/zod";

const optionalName = z
  .string()
  .trim()
  .max(100)
  .nullable()
  .optional()
  .transform((value) => value ?? null);

export const CreateAdminInvitationBodySchema = strictObject({
  requestKey: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  firstName: optionalName,
  lastName: optionalName,
});
