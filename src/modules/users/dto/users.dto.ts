import { z } from "zod";

import { strictObject } from "@/shared/validation/zod";

export const UpdateMeSchema = strictObject({
  firstName: z.string().trim().min(1, "firstName must not be empty").optional(),
  lastName: z.string().trim().min(1, "lastName must not be empty").optional(),
}).refine((body) => body.firstName !== undefined || body.lastName !== undefined, {
  message: "At least one profile field is required",
});

export type UpdateMeBody = z.infer<typeof UpdateMeSchema>;
