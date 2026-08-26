import type { NextFunction, Request, Response } from "express";

import { CreateAdminInvitationBodySchema } from "@/modules/admin/dto/admin-invitations.dto";
import { adminInvitationService } from "@/modules/admin/services/admin-invitation-recovery.service";
import { InvitationInputConflictError } from "@/modules/admin/services/admin-invitations.service";
import { AdminInvitationRequestConflictError, UnauthorizedError } from "@/shared/errors/errors";
import { validateBody } from "@/shared/validation/zod";

function requireAdminId(req: Request): string {
  if (!req.user) throw new UnauthorizedError("Admin user not found for this request");
  return req.user.id;
}

export async function createAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const createdById = requireAdminId(req);
    const input = validateBody(CreateAdminInvitationBodySchema, req.body);
    const operation = await adminInvitationService.acceptOperation({ ...input, createdById });

    res.status(202).location(operation.links.self).set("Retry-After", "2").json(operation);
  } catch (error) {
    next(
      error instanceof InvitationInputConflictError
        ? new AdminInvitationRequestConflictError(
            "Invitation request conflicts with existing input",
          )
        : error,
    );
  }
}

export async function getOperation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireAdminId(req);
    const { id } = req.params as { id: string };
    const operation = await adminInvitationService.getOperation(id);

    res.status(200).set("Cache-Control", "no-store").json(operation);
  } catch (error) {
    next(error);
  }
}
